import { createHash } from 'node:crypto';
import {
  ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException
} from '@nestjs/common';
import {
  ADVISOR_ADJUSTMENT_LIMIT, ConfirmIntegration, type IntegrationOperation, type ManualAction, type Proposal, type Viewer
} from '@claro/contracts';
import type { DataSource, EntityManager } from 'typeorm';
import type { z } from 'zod';
import { checkCase, clearPersonalData, customerReference, loadCase, saveCase } from './cases.js';
import { DATABASE, audit, enqueue, type CaseRow } from './database.js';
import { SimulatorFailure, simulators } from './simulator-client.js';

type OperationRow = IntegrationOperation & {
  case_revision: number; customer_ref: string; advisor: string; supervisor: string | null;
  source_proposal_id: string | null; started_at: Date | null; expires_at: Date;
};
type AgentProposal = { proposal: Proposal; run_id: string; case_revision: number; option_id: string; expires_at: Date };

const projection = ({ id, case_id, action, status, reference, failure_code }: OperationRow): IntegrationOperation =>
  ({ id, case_id, action, status, reference, failure_code });
const active = ['queued','pending_verification'];

export function invoiceForAccount<T extends { cliente_id: string }>(invoice: T, customer: string): T {
  if (invoice.cliente_id !== customer) throw new NotFoundException('Factura no encontrada');
  return invoice;
}

async function provider<T>(
  read: () => Promise<T>,
  notFound = 'Registro no encontrado en la API de origen'
) {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof SimulatorFailure)) throw error;
    if (error.status === 404) throw new NotFoundException(notFound);
    throw new ServiceUnavailableException('La API de origen no está disponible. Reintenta en unos segundos.');
  }
}

export async function readBilling(account: string, notFound?: string) {
  const [balance, invoices] = await provider(
    () => Promise.all([simulators.balance(account), simulators.invoices(account)]),
    notFound
  );
  return { balance, invoices };
}

export async function readInvoice(account: string, ref: string, notFound?: string) {
  return invoiceForAccount(await provider(() => simulators.invoice(ref), notFound), account);
}

function requireAccount(viewer: Viewer, row: CaseRow) {
  checkCase(viewer,row,true);
  const account = customerReference(row);
  if (!account) throw new ForbiddenException('Verifica la titularidad antes de consultar la cuenta');
  return account;
}

async function operation(tx: EntityManager, id: string, lock = false): Promise<OperationRow | undefined> {
  const [record] = await tx.query(`SELECT * FROM integration_operation WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  return record;
}

@Injectable()
export class IntegrationOperations {
  constructor(@Inject(DATABASE) private readonly db: DataSource) {}

  async crm(viewer: Viewer, id: string) {
    const ref = requireAccount(viewer,await loadCase(this.db.manager,id));
    const [customer, eligibility] = await provider(() => Promise.all([simulators.customer(ref),simulators.eligibility(ref)]));
    return { customer, eligibility };
  }

  async billing(viewer: Viewer, id: string) {
    const ref = requireAccount(viewer,await loadCase(this.db.manager,id));
    return readBilling(ref);
  }

  async invoice(viewer: Viewer, id: string, ref: string) {
    const account = requireAccount(viewer,await loadCase(this.db.manager,id));
    return readInvoice(account, ref);
  }

  async list(viewer: Viewer, id: string) {
    const row = await loadCase(this.db.manager,id);
    requireAccount(viewer,row);
    const rows: OperationRow[] = await this.db.query('SELECT * FROM integration_operation WHERE case_id=$1 ORDER BY created_at DESC,id LIMIT 50',[id]);
    return rows.map(record => projection(record.status === 'pending_supervisor' &&
      (row.snapshot.status !== 'open' || record.case_revision !== row.snapshot.revision || Number(record.expires_at)<=Date.now())
      ? {...record,status:'expired'} : record));
  }

  async confirm(viewer: Viewer, id: string, input: z.infer<typeof ConfirmIntegration>) {
    const row = await loadCase(this.db.manager,id);
    const account = requireAccount(viewer,row);
    const key = 'manual:' + createHash('sha256').update(JSON.stringify([viewer.id,id,input.idempotency_key])).digest('hex');
    const action = input.action;
    const replay = (record: OperationRow) => {
      // PostgreSQL canonicalizes jsonb key order. Re-parse before comparing.
      if (JSON.stringify(input.action) !== JSON.stringify(ConfirmIntegration.parse({idempotency_key:key,action:record.action}).action)) {
        throw new ConflictException('La clave ya identifica otra operación');
      }
      return projection(record);
    };
    const prior = await operation(this.db.manager,key);
    if (prior) return replay(prior);
    if (row.snapshot.status !== 'open') throw new ConflictException('El caso está cerrado');
    let status: OperationRow['status'] = 'queued';
    if (action.kind === 'adjustment') {
      const invoice = await this.invoice(viewer,id,action.invoice_id);
      if (invoice.saldo_abierto < action.adjustment.valor) throw new ConflictException('El ajuste supera el saldo abierto');
      if (invoice.total_ajustado + action.adjustment.valor > ADVISOR_ADJUSTMENT_LIMIT) status = 'pending_supervisor';
    }
    return this.db.transaction(async tx => {
      const current = await loadCase(tx,id,true);
      if (requireAccount(viewer,current) !== account || current.snapshot.status !== 'open' || current.snapshot.revision !== row.snapshot.revision) {
        throw new ConflictException('El caso cambió. Revisa los datos antes de confirmar.');
      }
      const previous = await operation(tx,key);
      if (previous) return replay(previous);
      const [record]: OperationRow[] = await tx.query(`INSERT INTO integration_operation
        (id,case_id,case_revision,customer_ref,advisor,action,status,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '30 minutes') RETURNING *`,
        [key,id,current.snapshot.revision,account,viewer.id,action,status]);
      if (status === 'queued') await enqueue(tx,`integration:${key}`,id,'integration',{operation_id:key});
      await audit(tx,id,'integration_confirmed_by_advisor',{kind:action.kind});
      return projection(record);
    });
  }

  async approvals(viewer: Viewer) {
    if (!viewer.capabilities?.includes('supervisor') && !(viewer.capabilities === undefined && viewer.role === 'admin')) throw new ForbiddenException();
    const rows: OperationRow[] = await this.db.query(`SELECT o.* FROM integration_operation o JOIN attention_case c ON c.id=o.case_id
      WHERE o.status='pending_supervisor' AND o.expires_at>now() AND c.snapshot->>'status'='open'
      AND (c.snapshot->>'revision')::integer=o.case_revision ORDER BY o.created_at LIMIT 50`);
    return rows.map(projection);
  }

  async decision(viewer: Viewer, id: string, approved: boolean) {
    if (!viewer.capabilities?.includes('supervisor') && !(viewer.capabilities === undefined && viewer.role === 'admin')) throw new ForbiddenException();
    return this.db.transaction(async tx => {
      const initial = await operation(tx,id);
      if (!initial || initial.action.kind !== 'adjustment') throw new NotFoundException('Aprobación no encontrada');
      const row = await loadCase(tx,initial.case_id,true);
      const record = (await operation(tx,id,true))!;
      if (record.status !== 'pending_supervisor') {
        if (approved && record.supervisor === viewer.id && [...active,'confirmed'].includes(record.status)) return projection(record);
        if (!approved && record.status === 'rejected' && record.supervisor === viewer.id) return projection(record);
        throw new ConflictException('Esta solicitud ya fue decidida');
      }
      if (!await authorized(tx,row,record)) throw new ConflictException('El caso cambió o la aprobación venció');
      record.status = approved ? 'queued' : 'rejected';
      record.supervisor = viewer.id;
      await tx.query('UPDATE integration_operation SET status=$2,supervisor=$3,failure_code=NULL WHERE id=$1',[id,record.status,viewer.id]);
      if (approved) {
        // A 403 at dispatch may have moved the job back to the approval queue.
        await tx.query(`INSERT INTO outbox (id,case_id,kind,payload) VALUES ($1,$2,'integration',$3)
          ON CONFLICT(id) DO UPDATE SET status='queued',available_at=now(),lease_token=NULL,lease_until=NULL,attempts=0`,
          [`integration:${id}`,row.id,{operation_id:id}]);
      }
      await audit(tx,row.id,approved ? 'integration_supervisor_approved' : 'integration_supervisor_rejected');
      return projection(record);
    });
  }
}

async function authorized(tx: EntityManager, row: CaseRow, record: OperationRow) {
  if (row.snapshot.status !== 'open' || row.snapshot.owner_id !== record.advisor ||
    row.snapshot.revision !== record.case_revision || customerReference(row) !== record.customer_ref ||
    Number(record.expires_at) <= Date.now()) return false;
  const [advisor] = await tx.query('SELECT role,enabled,capabilities FROM operator_role WHERE user_id=$1',[record.advisor]);
  if (!advisor?.enabled || !advisor.capabilities?.some((c: string) => ['n1','n2','supervisor'].includes(c))) return false;
  if (record.supervisor) {
    const [supervisor] = await tx.query('SELECT role,enabled,capabilities FROM operator_role WHERE user_id=$1',[record.supervisor]);
    if (!supervisor?.enabled || !supervisor.capabilities?.includes('supervisor')) return false;
  }
  return true;
}

async function project(tx: EntityManager, row: CaseRow, record: OperationRow) {
  await tx.query(`UPDATE integration_operation SET status=$2,reference=$3,failure_code=$4,started_at=$5 WHERE id=$1`,
    [record.id,record.status,record.reference,record.failure_code,record.started_at]);
  let agent: AgentProposal | undefined;
  if (record.source_proposal_id) {
    [agent] = await tx.query('SELECT * FROM retention_proposal WHERE id=$1 FOR UPDATE',[record.source_proposal_id]);
    if (agent) {
      agent.proposal.status = record.status === 'queued' || record.status === 'pending_supervisor' ? 'approved' : record.status;
      agent.proposal.effect_ref = record.reference ?? undefined;
      await tx.query('UPDATE retention_proposal SET proposal=$2 WHERE id=$1',[agent.proposal.id,agent.proposal]);
      if (row.snapshot.card?.proposal?.id === agent.proposal.id) row.snapshot.card.proposal = agent.proposal;
    }
  }
  if (record.status === 'confirmed') {
    if (record.action.kind === 'ticket') {
      if (agent) await tx.query(`INSERT INTO support_ticket(id,proposal_id,category,priority) VALUES ($1,$2,$3,$4)
        ON CONFLICT(proposal_id) DO NOTHING`,[record.reference,agent.proposal.id,record.action.ticket.categoria,record.action.ticket.prioridad]);
      await audit(tx,row.id,'support_ticket_confirmed');
    } else if (record.action.kind === 'offer') {
      if (agent) await tx.query('INSERT INTO crm_effect(id,proposal_id) VALUES ($1,$2) ON CONFLICT(proposal_id) DO NOTHING',
        [record.reference,agent.proposal.id]);
      await audit(tx,row.id,'retention_confirmed');
    } else {
      await audit(tx,row.id,'billing_adjustment_confirmed');
    }
  }
  if (agent && (record.status === 'confirmed' || record.status === 'rejected' || record.status === 'expired')) {
    await enqueue(tx,`resume:${agent.proposal.id}`,row.id,'resume',{
      run_id:agent.run_id, effect_id:agent.proposal.id, status:record.status,effect_ref:agent.proposal.effect_ref
    });
  }
  await saveCase(tx,row);
}

export async function executeIntegration(db: DataSource, caseId: string, id: string) {
  const reserved = await db.transaction(async tx => {
    const row = await loadCase(tx,caseId,true);
    const record = await operation(tx,id,true);
    if (!record || record.case_id !== caseId || !active.includes(record.status)) return;
    if (record.started_at) return { record, retry:true };
    if (!await authorized(tx,row,record)) {
      record.status = 'expired';
      await project(tx,row,record);
      return;
    }
    record.status = 'pending_verification';
    record.started_at = new Date();
    await project(tx,row,record);
    return { record, retry:false };
  });
  if (!reserved) return;
  const { record, retry } = reserved;
  const service = record.action.kind === 'adjustment' ? 'billing' : 'crm';
  const type = record.action.kind === 'adjustment' ? 'ajuste' : record.action.kind === 'offer' ? 'oferta' : 'ticket';
  async function getReceipt() {
    const receipt = await simulators.receipt(service,id);
    if (receipt.clave !== id || receipt.tipo !== type) throw new SimulatorFailure(503,'RECIBO_INCONSISTENTE');
    return receipt;
  }

  let receipt: Awaited<ReturnType<typeof getReceipt>> | undefined;
  let rejected: SimulatorFailure | undefined;
  if (retry) {
    try {
      receipt = await getReceipt();
    } catch (error) {
      if (!(error instanceof SimulatorFailure) || error.status !== 404) throw error;
    }
  }
  if (!receipt) {
    try {
      if (record.action.kind === 'adjustment') {
        const invoice = await simulators.invoice(record.action.invoice_id);
        if (invoice.cliente_id !== record.customer_ref) throw new SimulatorFailure(404,'FACTURA_NO_ENCONTRADA');
      }
      await simulators.send(record.customer_ref,record.action,record.advisor,record.supervisor,id);
    } catch (error) {
      if (!(error instanceof SimulatorFailure) || ![400,403,404,409].includes(error.status)) throw error;
      rejected = error;
    }
    // Only this read proves an effect. If the write timed out, the worker restarts here on its next attempt.
    if (!rejected) receipt = await getReceipt();
  }

  await db.transaction(async tx => {
    const row = await loadCase(tx,caseId,true);
    const current = await operation(tx,id,true);
    if (!current || current.status !== 'pending_verification') return;
    current.reference = receipt?.referencia ?? null;
    current.failure_code = rejected?.code ?? null;
    if (rejected?.code === 'AJUSTE_REQUIERE_APROBACION' && !current.supervisor && await authorized(tx,row,current)) {
      current.status = 'pending_supervisor';
      current.started_at = null;
    } else {
      current.status = receipt ? 'confirmed' : 'rejected';
    }
    await project(tx,row,current);
  });
}

export async function executeAgentIntegration(db: DataSource, caseId: string, proposalId: string) {
  const id = `agent:${proposalId}`;
  const exists = await db.transaction(async tx => {
    const row = await loadCase(tx,caseId,true);
    if (await operation(tx,id)) return true;
    const [p]: AgentProposal[] = await tx.query('SELECT * FROM retention_proposal WHERE id=$1 AND case_id=$2 FOR UPDATE',[proposalId,caseId]);
    if (p?.proposal.status !== 'approved') return false;
    const ref = customerReference(row);
    if (!ref || !row.snapshot.owner_id) {
      p.proposal.status = 'expired';
      await tx.query('UPDATE retention_proposal SET proposal=$2 WHERE id=$1',[proposalId,p.proposal]);
      if (row.snapshot.card?.proposal?.id === proposalId) row.snapshot.card.proposal = p.proposal;
      await saveCase(tx,row);
      return false;
    }
    const action: ManualAction = p.option_id === 'priority-ticket'
      ? { kind:'ticket', ticket:{categoria:'soporte_tecnico',descripcion:clearPersonalData(p.proposal.detail),prioridad:'prioritaria',escalar_a:'nivel2'} }
      : { kind:'offer', codigo:p.option_id === 'upgrade' ? 'RET-B' : 'RET-A', customer_accepted:true };
    await tx.query(`INSERT INTO integration_operation
      (id,case_id,case_revision,customer_ref,advisor,action,status,source_proposal_id,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8)`,
      [id,caseId,p.case_revision,ref,row.snapshot.owner_id,action,proposalId,p.expires_at]);
    return true;
  });
  if (exists) await executeIntegration(db,caseId,id);
}
