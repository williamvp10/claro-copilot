import { randomUUID } from 'node:crypto';
import { type DataSource, type EntityManager } from 'typeorm';
import { TransientReadError, type AgentPorts, type AgentTurn, type Fact, type Proposal, type Retention } from '@claro/contracts';
import { waitingForSupportVisit } from '@claro/agent';
import { clearPersonalData, confirmedCaseReceipts, loadCase, stillCurrent, customerReference } from './cases.js';
import { audit, type CaseRow } from './database.js';
import { fact, planFacts } from './demo-accounts.js';
import { isTransientSimulatorRead, SimulatorFailure, simulators } from './simulator-client.js';

const policy = {
  id: 'retention-policy-2026', title: 'Política de retención y descuentos', version: 'POL-RET-2026 v3.1',
  excerpt: 'Hasta 30 días de mora, máximo una oferta por cliente en 12 meses y beneficios según antigüedad. Las fallas recurrentes requieren visita técnica prioritaria.'
};
async function retention(ref: string | null): Promise<Retention> {
  if (!ref) return { eligible:false,reason:'Sin elegibilidad acreditada.',facts:[],policy,options:[] };
  const [customer, eligibility] = await Promise.all([simulators.customer(ref),simulators.eligibility(ref)]);
  return { ...eligibility, facts:[
    fact('tenure','Antigüedad en meses',String(customer.antiguedad_meses)),
    fact('days-past-due','Días de mora',String(customer.dias_mora)),
    fact('days-limit','Límite de mora','30'),
    fact('offers-year','Ofertas en los últimos 12 meses',String(customer.ofertas_retencion_12m.length))
  ], policy };
}

async function availableFacts(service: string, read: () => Promise<Fact[]>) {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof SimulatorFailure)) throw error;
    if (isTransientSimulatorRead(error)) throw new TransientReadError();
    return [fact(service.toLowerCase()+'-unavailable',service,'API temporalmente indisponible')];
  }
}

export async function runContext(tx: EntityManager, runId: string, lock: boolean) {
  const [run]: { case_id: string; turn: AgentTurn }[] = await tx.query('SELECT case_id,turn FROM agent_run WHERE id=$1', [runId]);
  if (!run) throw new Error('unknown run');
  return { turn: run.turn, row: await loadCase(tx, run.case_id, lock) };
}

export async function assertActiveCaseOperator(tx:EntityManager, row:CaseRow) {
  const owner=row.snapshot.owner_id;
  if (!owner) throw new Error('scope denied');
  const [operator] = await tx.query('SELECT role,capabilities,enabled FROM operator_role WHERE user_id=$1',[owner]);
  const capabilities=operator?.capabilities;
  if (!operator?.enabled || !(Array.isArray(capabilities) ? capabilities.some((c:unknown)=>typeof c === 'string' && ['n1','n2','supervisor'].includes(c)) : operator.role === 'asesor')) throw new Error('scope denied');
}
export function businessPorts(db: DataSource): AgentPorts {
  async function scoped<T>(runId: string, verified: boolean, read: (tx: EntityManager, row: CaseRow, turn: AgentTurn) => Promise<T>) {
    const { turn, row } = await runContext(db.manager,runId,false);
    if (!stillCurrent(row,turn)) throw new Error('stale run');
    if (verified && (!row.snapshot.verified || turn.audience !== 'asesor' || !row.snapshot.owner_id)) throw new Error('scope denied');
    if (verified) await assertActiveCaseOperator(db.manager,row);
    return read(db.manager,row,turn);
  }
  return {
    readCaseForRun: (runId) => scoped(runId, false, async (tx, row, turn) => {
      const [support]=turn.actor==='cliente' && waitingForSupportVisit(turn.text) ? await tx.query(`SELECT EXISTS(SELECT 1 FROM escalation WHERE case_id=$1
        AND destination='soporte_tecnico' AND status IN ('en_cola','tomado')) AS pending`,[row.id]) : [];
      return {
        messages: row.snapshot.messages.filter(m => !m.verification_input).map(m => ({ ...m, text: clearPersonalData(m.text) })),
        verified: row.snapshot.verified, pending: row.handoff_pending, handoff_reason:row.snapshot.handoff_reason, intake: row.snapshot.intake, conversation_memory: row.snapshot.conversation_memory,
        public_route: row.snapshot.public_route,
        conversation_context: row.snapshot.conversation_context,
        pending_support_handoff:support?.pending===true,
        confirmed_receipts: turn.audience === 'asesor' && row.snapshot.verified ? await confirmedCaseReceipts(tx,row.id) : []
      };
    }),
    async getAgentConfig(revision) {
      const [row] = await db.query('SELECT revision,prompts FROM prompt_revision WHERE revision=$1', [revision]);
      if (!row) throw new Error('unknown config');
      return row;
    },
    getCustomerContext: (runId) => scoped(runId, true, async (tx, row) => {
      const ref = customerReference(row);
      if (!ref) return [];
      await audit(tx, row.id, 'crm_read',{run_id:runId});
      return availableFacts('CRM',async () => planFacts((await simulators.customer(ref)).servicios));
    }),
    listServices: (runId) => scoped(runId, true, async (tx, row) => {
      const ref = customerReference(row);
      if (!ref) return [];
      await audit(tx, row.id, 'crm_services_read', {run_id:runId});
      return availableFacts('CRM', async () => planFacts(await simulators.services(ref)));
    }),
    getBilling: (runId) => scoped(runId, true, async (tx, row) => {
      const ref = customerReference(row);
      if (!ref) return [];
      await audit(tx, row.id, 'billing_read',{run_id:runId});
      return availableFacts('Facturación',async () => { const balance=await simulators.balance(ref); return [fact('invoice-balance','Saldo',new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(balance.saldo_pendiente)),...(balance.proxima_fecha_limite ? [fact('invoice-due','Vencimiento',balance.proxima_fecha_limite)] : [])]; });
    }),
    listInvoices: (runId) => scoped(runId,true,async (tx,row) => {
      const ref=customerReference(row); if (!ref) return []; await audit(tx,row.id,'billing_invoice_read',{run_id:runId});
      return availableFacts('Facturación',async()=> (await simulators.invoices(ref)).map(invoice=>fact(invoice.factura_id,`Factura ${invoice.periodo}`,`${invoice.estado} · ${new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(invoice.valor_total)} · vence ${invoice.fecha_limite_pago}`)));
    }),
    getInvoiceDetail: (runId,id) => scoped(runId,true,async (tx,row) => {
      const ref=customerReference(row); if (!ref || !/^F-\d{4,10}$/.test(id)) throw new Error('scope denied');
      return availableFacts('Facturación',async()=> {
        const invoices=await simulators.invoices(ref);
        if (!invoices.some(invoice=>invoice.factura_id===id)) throw new Error('scope denied');
        await audit(tx,row.id,'billing_invoice_detail_read',{run_id:runId});
        return (await simulators.invoice(id)).detalle.map((item,index)=>fact(`${id}-item-${index}`,item.concepto,new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(item.valor)));
      });
    }),
    getTickets: (runId) => scoped(runId, true, async (tx, row) => {
      const ref = customerReference(row);
      if (!ref) return [];
      await audit(tx,row.id,'tickets_read',{run_id:runId});
      return availableFacts('CRM',async () => [fact('technical-tickets-90d','Tickets técnicos en 90 días',
        String((await simulators.tickets(ref)).filter(ticket => ticket.categoria === 'soporte_tecnico').length))]);
    }),
    evaluateRetention: (runId) => scoped(runId,true,async (tx,row) => {
      await audit(tx,row.id,'retention_read',{run_id:runId});
      return retention(customerReference(row)).catch(error => {
        if (!(error instanceof SimulatorFailure)) throw error;
        if (isTransientSimulatorRead(error)) throw new TransientReadError();
        return {eligible:false,reason:'CRM temporalmente indisponible. Verifica la elegibilidad antes de ofrecer beneficios.',
          facts:[fact('crm-unavailable','CRM','API temporalmente indisponible')],policy,options:[]};
      });
    }),
    createProposal: (runId, input) => scoped(runId, true, async (_tx, row, turn) => {
      const urgent = input.option_id === 'priority-ticket';
      const ref = customerReference(row);
      if (!ref) throw new Error('missing account');
      if (urgent && (!input.citation_ids.includes('retention-recurrent-faults') ||
        (await simulators.tickets(ref)).filter(ticket => ticket.categoria === 'soporte_tecnico').length < 3)) {
        throw new Error('unsupported priority ticket');
      }
      if (!urgent && (turn.actor !== 'cliente' || !/\b(acepto|aceptamos|de acuerdo|lo acepto|la acepto|quiero esa|quiero ese)\b/i.test(turn.text) ||
        /\b(no acepto|no quiero|rechazo|aceptar[íi]a|acepto si|acepto cuando)\b/i.test(turn.text))) throw new Error('customer acceptance required');
      const eligibility = urgent ? null : await retention(ref);
      const option = urgent
        ? {id:'priority-ticket',title:'Registrar ticket prioritario',detail:'Soporte técnico. Gestionar visita prioritaria dentro de 24 horas.'}
        : eligibility?.options.find((candidate) => candidate.id === input.option_id);
      if (!option || (!urgent && (!eligibility?.eligible || !input.citation_ids.includes(policy.id)))) throw new Error('ineligible proposal');
      return db.transaction(async tx => {
        if (!stillCurrent(await loadCase(tx,row.id,true),turn)) throw new Error('stale run');
        const [existing]: { proposal: Proposal }[] = await tx.query(
          'SELECT proposal FROM retention_proposal WHERE case_id=$1 AND case_revision=$2 AND option_id=$3',
          [row.id, row.snapshot.revision, option.id]);
        if (existing) return existing.proposal;
        const proposal: Proposal = { id: randomUUID(), revision: 1, title: option.title, detail: option.detail, status: 'pending_approval', kind: urgent ? 'support_ticket' : 'retention_offer' };
        await tx.query(`INSERT INTO retention_proposal VALUES ($1,$2,$3,$4,$5,$6,now()+interval '30 minutes')`,
          [proposal.id, row.id, runId, row.snapshot.revision, option.id, proposal]);
        await audit(tx, row.id, 'proposal_created');
        return proposal;
      });
    })
  };
}
