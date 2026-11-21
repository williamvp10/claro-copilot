import { randomUUID } from 'node:crypto';
import { type DataSource, type EntityManager } from 'typeorm';
import { type AgentPorts, type AgentTurn, type Fact, type Proposal, type Retention } from '@claro/contracts';
import { clearPersonalData, loadCase, stillCurrent } from './cases.js';
import { audit, type CaseRow } from './database.js';

const policy = {
  id: 'retention-policy-2026', title: 'Política de retención y descuentos', version: 'RET 2026',
  excerpt: 'Las cuentas con más de 30 días de mora quedan fuera de las ofertas de retención.'
};
const options = [
  { id: 'discount', title: '30 % de descuento', detail: 'Sobre la tarifa de $89.900, durante seis meses.' },
  { id: 'upgrade', title: 'Mejora a Fibra 500', detail: 'Sin costo adicional durante seis meses.' }
];
const fact = (id: string, label: string, value: string): Fact => ({ id, label, value });

export async function retention(tx: EntityManager, row: CaseRow, exceptProposal?: string): Promise<Retention> {
  if (row.contact_ref === 'C-1007') return {
    eligible: false, reason: '45 días de mora superan el límite de 30 días.',
    facts: [fact('days-past-due', 'Días de mora', '45'), fact('days-limit', 'Límite de mora', '30')], policy, options: []
  };
  if (row.contact_ref !== 'C-1004') return { eligible: false, reason: 'Sin elegibilidad acreditada.', facts: [], policy, options: [] };
  const [{ previous }] = await tx.query(`SELECT count(*)::integer AS previous FROM retention_proposal p
    JOIN attention_case c ON c.id=p.case_id JOIN crm_effect e ON e.proposal_id=p.id
    WHERE c.contact_ref=$1 AND ($2::text IS NULL OR p.id<>$2)
    AND e.confirmed_at > now()-interval '12 months'`, [row.contact_ref, exceptProposal ?? null]);
  return {
    eligible: previous === 0,
    reason: previous ? 'Ya se aplicó una oferta en los últimos 12 meses.' : '30 meses de antigüedad, sin mora ni ofertas en los últimos 12 meses.',
    facts: [fact('tenure', 'Antigüedad en meses', '30'), fact('days-past-due', 'Días de mora', '0'),
      fact('offers-year', 'Ofertas en los últimos 12 meses', String(previous))],
    policy, options: previous ? [] : options
  };
}

export async function runContext(tx: EntityManager, runId: string, lock: boolean) {
  const [run]: { case_id: string; turn: AgentTurn }[] = await tx.query('SELECT case_id,turn FROM agent_run WHERE id=$1', [runId]);
  if (!run) throw new Error('unknown run');
  return { turn: run.turn, row: await loadCase(tx, run.case_id, lock) };
}

export function businessPorts(db: DataSource): AgentPorts {
  async function scoped<T>(runId: string, verified: boolean, read: (tx: EntityManager, row: CaseRow, turn: AgentTurn) => Promise<T>) {
    return db.transaction(async (tx) => {
      const { turn, row } = await runContext(tx, runId, true);
      if (!stillCurrent(row, turn)) throw new Error('stale run');
      if (verified && (!row.snapshot.verified || turn.audience !== 'asesor' || !row.snapshot.owner_id)) throw new Error('scope denied');
      return read(tx, row, turn);
    });
  }
  return {
    readCaseForRun: (runId) => scoped(runId, false, async (_tx, row) => ({
      messages: row.snapshot.messages.map(m => ({ ...m, text: clearPersonalData(m.text) })),
      verified: row.snapshot.verified, pending: row.handoff_pending
    })),
    async getAgentConfig(revision) {
      const [row] = await db.query('SELECT revision,prompts FROM prompt_revision WHERE revision=$1', [revision]);
      if (!row) throw new Error('unknown config');
      return row;
    },
    getCustomerContext: (runId) => scoped(runId, true, async (tx, row) => {
      await audit(tx, row.id, 'crm_read');
      return row.contact_ref === 'C-1001' ? [
        fact('home-fibra-500', 'Hogar Fibra 500', '$109.900'), fact('mobile-max-60', 'Claro Max 60 GB', '$59.415')
      ] : [];
    }),
    getBilling: (runId) => scoped(runId, true, async (tx, row) => {
      await audit(tx, row.id, 'billing_read');
      return row.contact_ref === 'C-1001' ? [
        fact('invoice-nov-status', 'Factura de noviembre', 'Pendiente'), fact('invoice-nov-amount', 'Saldo', '$169.315'),
        fact('invoice-nov-due', 'Vencimiento', '25 de noviembre de 2026')
      ] : [];
    }),
    getTickets: (runId) => scoped(runId, true, async (tx, row) => {
      await audit(tx, row.id, 'tickets_read');
      return [];
    }),
    evaluateRetention: (runId) => scoped(runId, true, async (tx, row) => {
      await audit(tx, row.id, 'retention_read');
      return retention(tx, row);
    }),
    createProposal: (runId, input) => scoped(runId, true, async (tx, row, turn) => {
      if (turn.actor !== 'cliente' || !/\b(acepto|aceptamos|de acuerdo|lo acepto|la acepto|quiero esa|quiero ese)\b/i.test(turn.text) ||
        /\b(no acepto|no quiero|rechazo|aceptar[íi]a|acepto si|acepto cuando)\b/i.test(turn.text)) throw new Error('customer acceptance required');
      const eligibility = await retention(tx, row);
      const option = eligibility.options.find((candidate) => candidate.id === input.option_id);
      if (!eligibility.eligible || !option || !input.citation_ids.includes(policy.id)) throw new Error('ineligible proposal');
      const [existing]: { proposal: Proposal }[] = await tx.query(
        'SELECT proposal FROM retention_proposal WHERE case_id=$1 AND case_revision=$2 AND option_id=$3',
        [row.id, row.snapshot.revision, option.id]);
      if (existing) return existing.proposal;
      const proposal: Proposal = { id: randomUUID(), revision: 1, title: option.title, detail: option.detail, status: 'pending_approval' };
      await tx.query(`INSERT INTO retention_proposal VALUES ($1,$2,$3,$4,$5,$6,now()+interval '30 minutes')`,
        [proposal.id, row.id, runId, row.snapshot.revision, option.id, proposal]);
      await audit(tx, row.id, 'proposal_created');
      return proposal;
    })
  };
}
