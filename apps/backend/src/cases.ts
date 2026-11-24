import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { asksToChangeMobilePlan, catalogComparison, contextIntent, evolveContext, mandatoryPolicyRoute, nextContextQuestion, recordQuestion } from '@claro/agent';
import { ConflictException, ForbiddenException, ServiceUnavailableException, Inject, Injectable, NotFoundException, UnauthorizedException, HttpException, UnprocessableEntityException } from '@nestjs/common';
import { type z } from 'zod';
import {
  AgentTurn, CaseSnapshot, WebChatSnapshot, demoWelcome, demoVerifyInvitation, type Actor, type Contact, type DecideProposal, type Intent,
  type CloseCase, type Message, type OpenCase, type Proposal, type SendMessage, type Viewer
} from '@claro/contracts';
import { DataSource, type EntityManager } from 'typeorm';
import { audit, type CaseRow, type ContactRow, type DraftPublication, DATABASE, enqueue } from './database.js';
import { accountHandoffReason, accountInquiry, accountReply, accountVerificationPrompt, codeCandidates, contactCandidates, isGreeting, isVerificationContact, requestedAdvisor, type AccountInquiry, type AccountRead } from './demo-accounts.js';
import { privateSignals, queueChurn } from './ml-advisory.js';
import { readRunPromptConfig } from './prompt-catalog.js';
import { SimulatorFailure, simulators } from './simulator-client.js';

type Assessor = Viewer;
type Mutation = (tx: EntityManager, row: CaseRow) => Promise<void>;
type ProposalRow = { id: string; case_id: string; proposal: Proposal; option_id: string; case_revision: number; run_id: string; expires_at: Date };
const knowledgePublication: Partial<Record<Intent, DraftPublication['terminal']>> = {
  soporte_tecnico: 'guidance_published',
  consulta_planes: 'catalog_answer_published',
  portabilidad: 'portability_guidance_published'
};

export function constantEqual(input: string, expected: string) {
  const inputHash = createHash('sha256').update(input).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(inputHash, expectedHash);
}

export function clearPersonalData(text: string) {
  // Invoice selectors are opaque, validated identifiers; retain them for ownership checks.
  const invoices:string[]=[];
  const protectedText=text.replace(/\bF-\d{4,10}\b/gi,id=>{invoices.push(id.toUpperCase());return `[factura_${invoices.length.toString(36).replace(/[0-9]/g,'x')}]`;});
  let index=0;
  return protectedText.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[correo]')
    .replace(/\+?\d(?:[ .()-]*\d){6,}/g, '[número]')
    .replace(/\[factura_[a-z]+\]/g,()=>invoices[index++] ?? '');
}

export function latestAnalyzable(snapshot: CaseSnapshot) {
  return snapshot.messages.findLast((message) => message.actor !== 'agente' && !message.verification_input);
}

function draftIsCurrent(snapshot: CaseSnapshot) {
  const card = snapshot.card;
  return snapshot.status === 'open' && !!card?.advisor_draft && !!card.advisor_draft_run_id &&
    card.advisor_draft_case_revision === snapshot.revision && card.advisor_draft_turn_seq === latestAnalyzable(snapshot)?.turn_seq;
}

function operatorSnapshot(snapshot: CaseSnapshot): CaseSnapshot {
  if (!snapshot.card?.advisor_draft || draftIsCurrent(snapshot)) return snapshot;
  const {advisor_draft:_draft,advisor_draft_run_id:_run,...context} = snapshot.card;
  return {...snapshot,card:{...context,advisor_draft_status:'stale'}};
}

function handoffReason(row: CaseRow) {
  if (row.snapshot.handoff_reason || !row.handoff_pending) return row.snapshot.handoff_reason;
  const request=row.snapshot.messages.findLast(message=>message.actor==='cliente' && accountInquiry(message.text)==='assistance');
  return request ? accountHandoffReason(request.text) : row.handoff_pending.slice(0,300);
}

function assistanceReason(row:CaseRow, text:string) {
  const intake=row.snapshot.intake;
  if (intake?.intent==='facturacion' && intake.facts.objetivo) return `Consulta de facturación. ${intake.facts.objetivo}.`;
  if (intake?.intent!=='cancelacion') return accountHandoffReason(text);
  const reason=intake.facts.motivo;
  return reason ? `El cliente solicita cancelar el servicio. Motivo declarado: ${reason.toLowerCase()}.` : 'El cliente solicita cancelar el servicio.';
}

export function isLegacyKnowledgeWait(row: CaseRow) {
  return row.snapshot.status==='open' && row.snapshot.attention_mode==='autoservicio' &&
    !row.snapshot.owner_id && row.handoff_pending==='Consultar fuente autorizada';
}

export function stillCurrent(row: CaseRow, turn: AgentTurn) {
  const state = row.snapshot;
  return state.status === 'open' && state.revision === turn.case_revision &&
    state.attention_mode === turn.attention_mode &&
    (state.attention_mode === 'asistido') === (turn.audience === 'asesor') &&
    latestAnalyzable(state)?.turn_seq === turn.turn_seq;
}

export async function loadCase(tx: EntityManager, id: string, lock = false): Promise<CaseRow> {
  const [row] = await tx.query(`SELECT * FROM attention_case WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!row) throw new NotFoundException('Caso no encontrado');
  return row;
}

export async function saveCase(tx: EntityManager, row: CaseRow) {
  row.snapshot.cursor += 1;
  row.snapshot.updated_at = new Date().toISOString();
  CaseSnapshot.parse(row.snapshot);
  await tx.query(`UPDATE attention_case SET snapshot=$2,handoff_pending=$3,intent_hint=$4,
    account_ref=$5,account_inquiry=$6,account_challenge_ref=$7,account_challenge_id=$8,account_challenge_expires_at=$9 WHERE id=$1`,
    [row.id, row.snapshot, row.handoff_pending, row.intent_hint, row.account_ref ?? null, row.account_inquiry ?? null,
      row.account_challenge_ref ?? null, row.account_challenge_id ?? null, row.account_challenge_expires_at ?? null]);
}

function assessor(viewer: Viewer) {
  if (!viewer.capabilities?.some(capability => ['n1','n2','supervisor'].includes(capability)) && !(viewer.capabilities === undefined && viewer.role === 'asesor')) throw new ForbiddenException('Se requiere capacidad de atención');
}

export function checkCase(viewer: Viewer, row: CaseRow, mustOwn = false) {
  assessor(viewer);
  const owner = row.snapshot.owner_id;
  if ((owner && owner !== viewer.id) || (mustOwn && owner !== viewer.id)) throw new NotFoundException('Caso no disponible');
}

export function customerReference(row: CaseRow) {
  if (!row.snapshot.verified) return null;
  const ref = row.snapshot.channel === 'web'
    ? row.account_ref ?? (row.contact_ref.startsWith('web-c1001:') ? 'C-1001' : null)
    : row.contact_ref;
  return ref && /^C-\d{4}$/.test(ref) ? ref : null;
}

export function addMessage(row: CaseRow, actor: z.infer<typeof Actor>, text: string, citations?: Message['citations']) {
  const { messages } = row.snapshot;
  const last = messages.at(-1)?.turn_seq ?? 0;
  const message: Message = { id: randomUUID(), turn_seq: last + 1, actor, text, created_at: new Date().toISOString(), citations };
  messages.push(message);
  row.snapshot.last_message = text;
  return message;
}

const replayScenarios:Record<string,{fixture:string;channel:'telegram'|'whatsapp'}> = {
  'CC-E03':{fixture:'C-1013',channel:'telegram'}, 'CC-E10':{fixture:'C-1013',channel:'whatsapp'},
  'CC-E11':{fixture:'C-1004',channel:'telegram'}, 'CC-E12':{fixture:'C-1007',channel:'telegram'},
  'CC-E13':{fixture:'C-1013',channel:'telegram'},
  'GQ-25':{fixture:'C-1001',channel:'telegram'}, 'GQ-26':{fixture:'C-1004',channel:'telegram'},
  'GQ-27':{fixture:'C-1007',channel:'telegram'}, 'GQ-28':{fixture:'C-1013',channel:'telegram'}
};
function localPromptReplayAllowed() {
  const loopback = ['127.0.0.1','localhost','[::1]'];
  const authUrl = new URL(process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:0');
  return process.env.DEMO_MODE === 'true' && loopback.includes(authUrl.hostname)
    && loopback.includes(process.env.HOST ?? '') && !process.env.TELEGRAM_BOT_TOKEN;
}
async function revisionForTurn(tx: EntityManager, row: CaseRow): Promise<{revision:string;scenario?:string}> {
  const [{revision}] = await tx.query('SELECT revision FROM prompt_revision WHERE activated');
  const replay = process.env.LOCAL_PROMPT_REPLAY_REVISION;
  const requested=process.env.LOCAL_PROMPT_REPLAY_SCENARIO;
  const scenario=requested ?? (row.contact_ref==='C-1004'?'CC-E11':row.contact_ref==='C-1013'?'CC-E13':undefined);
  const mapping=scenario ? replayScenarios[scenario] : undefined;
  if (!replay || !scenario || !mapping || row.contact_ref!==mapping.fixture || row.snapshot.channel!==mapping.channel) return {revision};
  if (!localPromptReplayAllowed()) {
    throw new Error('Local prompt replay requires a loopback demo API with Telegram delivery disabled');
  }
  const [candidate] = await tx.query(`SELECT revision FROM prompt_revision
    WHERE revision=$1 AND base_revision=$2 AND NOT activated AND manifest IS NOT NULL
    AND status IN ('candidate','passed')`,[replay,revision]);
  if (!candidate) throw new ConflictException('La revisión de replay no es candidata de la revisión activa');
  return {revision:candidate.revision,scenario};
}

export async function queueRun(tx: EntityManager, row: CaseRow, message = latestAnalyzable(row.snapshot), shadow = false,
  observedContext?:AgentTurn['observed_context']) {
  if (!message || message.actor === 'agente') return;
  const {revision,scenario} = await revisionForTurn(tx, row);
  const scope = row.snapshot.verified ? 'verified' : 'unverified';
  const turn = AgentTurn.parse({
    run_id: randomUUID(), case_id: row.id, conversation_id: row.snapshot.conversation_id, turn_id: message.id,
    channel: row.snapshot.channel, actor: message.actor, turn_seq: message.turn_seq, case_revision: row.snapshot.revision,
    attention_mode: row.snapshot.attention_mode, audience: row.snapshot.attention_mode === 'asistido' ? 'asesor' : 'cliente',
    scope_ref: scope, config_revision: revision, business_date: process.env.DEMO_MODE === 'true' ? (process.env.DEMO_BUSINESS_DATE || '2026-11-18') : new Date().toISOString().slice(0, 10),
    text: clearPersonalData(message.text), observed_context:observedContext
  });
  await tx.query('INSERT INTO agent_run VALUES ($1,$2,$3)', [turn.run_id, row.id, turn]);
  if (scenario && !observedContext) await audit(tx,row.id,'candidate_replay_queued',{
    run_id:turn.run_id,candidate_revision:revision,scenario_id:scenario,fixture:row.contact_ref,
    ...(scenario==='CC-E10' ? {transport:'whatsapp_fixture'} : {})
  });
  await enqueue(tx, turn.run_id, row.id, 'run', turn);
  if (shadow && message.actor === 'cliente' && !message.verification_input && process.env.ML_API_URL) {
    await enqueue(tx, `ml:${message.id}`, row.id, 'ml', turn);
  }
  return turn;
}

async function queueIntentOnly(tx:EntityManager,row:CaseRow,message:Message) {
  if (!process.env.ML_API_URL || message.actor!=='cliente' || message.verification_input) return;
  const [{revision}]=await tx.query('SELECT revision FROM prompt_revision WHERE activated');
  const turn=AgentTurn.parse({run_id:randomUUID(),case_id:row.id,conversation_id:row.snapshot.conversation_id,turn_id:message.id,
    channel:row.snapshot.channel,actor:'cliente',turn_seq:message.turn_seq,case_revision:row.snapshot.revision,
    attention_mode:row.snapshot.attention_mode,audience:row.snapshot.attention_mode==='asistido'?'asesor':'cliente',
    scope_ref:row.snapshot.verified?'verified':'unverified',config_revision:revision,
    business_date:process.env.DEMO_MODE==='true'?(process.env.DEMO_BUSINESS_DATE || '2026-11-18'):new Date().toISOString().slice(0,10),text:clearPersonalData(message.text)});
  await enqueue(tx,`ml:${message.id}`,row.id,'ml',turn);
}

@Injectable()
export class Cases {
  constructor(@Inject(DATABASE) private readonly db: DataSource) {}

  async list(viewer: Viewer) {
    assessor(viewer);
    const canIntake = viewer.capabilities?.includes('n1') ?? viewer.role === 'asesor';
    const rows: CaseRow[] = await this.db.query(`SELECT * FROM attention_case WHERE snapshot->>'owner_id'=$1 OR
      ($2 AND snapshot->>'owner_id' IS NULL AND (handoff_pending IS NOT NULL OR snapshot->>'attention_mode'='asistido'))
      ORDER BY snapshot->>'updated_at' DESC LIMIT 100`, [viewer.id, canIntake]);
    return rows.map(({ snapshot: { messages: _messages, card: _card, intake: _intake, cursor: _cursor, ...summary } }) => summary);
  }

  async contacts(viewer: Viewer): Promise<Contact[]> {
    assessor(viewer);
    return this.db.query(`SELECT ref,display_name,enabled FROM telegram_contact WHERE enabled AND
      (direct_owner IS NULL OR direct_owner=$1) AND (chat_id IS NOT NULL OR $2) ORDER BY ref`, [viewer.id, process.env.DEMO_MODE === 'true']);
  }

  async get(viewer: Viewer, id: string) {
    const row = await loadCase(this.db.manager, id);
    const reason=handoffReason(row);
    if (!row.snapshot.owner_id && row.handoff_pending && row.snapshot.status==='open' &&
        (viewer.capabilities?.includes('n1') ?? viewer.role==='asesor')) {
      // A queue preview exposes the reason. Account facts and conversation history require assignment.
      const {tracking:_tracking,ml:_ml,intake:_intake,...snapshot}=row.snapshot;
      return {...snapshot,handoff_reason:reason,messages:[],card:null,last_message:null};
    }
    checkCase(viewer, row, true);
    const [ml, tracking] = await Promise.all([privateSignals(this.db,row),this.caseTracking(row)]);
    return {...operatorSnapshot(row.snapshot),handoff_reason:reason,ml,tracking};
  }

  private async caseTracking(row:CaseRow):Promise<NonNullable<CaseSnapshot['tracking']>> {
    const [[owner],[escalation],events,receipts] = await Promise.all([
      this.db.query(`SELECT u.name, r.capabilities FROM "user" u JOIN operator_role r ON u.id=r.user_id WHERE u.id=$1`,
        [row.snapshot.owner_id]),
      this.db.query(`SELECT e.id,e.destination,e.reason_code,e.status,e.updated_at,
        GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(t.first_action,now())-e.created_at)))::int AS queued_seconds
        FROM escalation e LEFT JOIN LATERAL (
          SELECT MIN(created_at) AS first_action FROM attention_event
          WHERE case_id=e.case_id AND kind IN ('escalation_claim','escalation_reassign','escalation_cancel')
            AND created_at>=e.created_at
        ) t ON true WHERE e.case_id=$1 ORDER BY e.created_at DESC LIMIT 1`, [row.id]),
      this.db.query(`SELECT kind,created_at AS at FROM attention_event
        WHERE case_id=$1 AND (kind LIKE 'escalation_%' OR kind IN ('handoff_taken','holder_verified','closed'))
        ORDER BY id DESC LIMIT 12`, [row.id]),
      this.db.query(`SELECT action->>'kind' AS kind, reference FROM integration_operation
        WHERE case_id=$1 AND status='confirmed' AND reference IS NOT NULL ORDER BY created_at DESC LIMIT 12`, [row.id])
    ]);
    const preferred = escalation?.status==='tomado' || escalation?.status==='resuelto'
      ? escalation.destination==='supervision' ? 'supervisor' : 'n2' : 'n1';
    const level = owner?.capabilities?.includes(preferred) ? preferred :
      (['n1','n2','supervisor'] as const).find(cap => owner?.capabilities?.includes(cap)) ?? null;
    return {owner_name:owner?.name ?? null,level,
      escalation:escalation ? {...escalation,updated_at:escalation.updated_at.toISOString()} : null,
      events:events.map((event:{kind:string;at:Date})=>({kind:event.kind,at:event.at.toISOString()})),receipts};
  }

  async take(viewer: Viewer, id: string) {
    return this.change(viewer, id, false, async (tx, row) => {
      if (row.snapshot.owner_id === viewer.id) return;
      if (!(viewer.capabilities?.includes('n1') ?? viewer.role === 'asesor') || viewer.available === false) {
        throw new ForbiddenException('Se requiere un asesor de primer nivel disponible');
      }
      if (!row.handoff_pending) throw new ConflictException('El caso todavía está en autoservicio');
      row.snapshot.handoff_reason = handoffReason(row);
      row.snapshot.owner_id = viewer.id;
      row.snapshot.attention_mode = 'asistido';
      row.snapshot.revision += 1;
      row.snapshot.card = null;
      await audit(tx, id, 'handoff_taken');
      await queueChurn(tx,row);
      await queueRun(tx, row);
    });
  }

  async verify(viewer: Viewer, id: string, code: string) {
    const expected = process.env.DEMO_HOLDER_CODE;
    if (process.env.DEMO_MODE !== 'true' || !expected) throw new ForbiddenException('La verificación de demo no está configurada');
    return this.change(viewer, id, true, async (tx, row) => {
      if (row.snapshot.channel === 'web' && !row.account_ref && !row.contact_ref.startsWith('web-c1001:')) {
        throw new ConflictException('La titularidad se verifica en el chat web.');
      }
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('holder-verification'),hashtext($1))", [id]);
      const [{ failures }] = await tx.query(`SELECT count(*)::integer AS failures FROM attention_event
        WHERE case_id=$1 AND kind='holder_failed' AND created_at>now()-interval '15 minutes'`, [id]);
      if (failures >= 5) throw new ForbiddenException('Intente más tarde');
      if (!constantEqual(code, expected)) {
        await audit(tx, id, 'holder_failed');
        return;
      }
      if (!row.snapshot.verified) {
        row.snapshot.verified = true;
        row.snapshot.revision += 1;
        row.snapshot.card = null;
        await audit(tx, id, 'holder_verified');
        await queueChurn(tx,row);
        await queueRun(tx, row);
      }
    }).then((snapshot) => {
      if (!constantEqual(code, expected)) throw new ForbiddenException('Código inválido');
      return snapshot;
    });
  }

  async open(viewer: Viewer, input: z.infer<typeof OpenCase>) {
    assessor(viewer);
    return this.db.transaction(async (tx) => {
      const scope = `open:${viewer.id}`;
      const prior = await this.replay(tx, scope, input.idempotency_key, input);
      if (prior) return prior.snapshot;
      const [contact]: ContactRow[] = await tx.query('SELECT * FROM telegram_contact WHERE ref=$1 AND enabled FOR UPDATE', [input.contact_ref]);
      if (!contact || (contact.direct_owner && contact.direct_owner !== viewer.id) ||
        (!contact.chat_id && process.env.DEMO_MODE !== 'true')) throw new NotFoundException('Contacto no disponible');
      if (await this.activeForContact(tx, contact.ref)) throw new ConflictException('El contacto ya tiene un caso abierto');
      const row = await this.newCase(tx, contact, viewer.id);
      await this.assessorMessage(tx, row, input.text);
      await this.remember(tx, scope, input.idempotency_key, input, row.id);
      await saveCase(tx, row);
      return row.snapshot;
    });
  }

  async send(viewer: Viewer, id: string, input: z.infer<typeof SendMessage>) {
    return this.change(viewer, id, true, async (tx, row) => {
      const scope = `message:${viewer.id}:${id}`;
      if (await this.replay(tx, scope, input.idempotency_key, input)) return;
      let publication: DraftPublication | undefined;
      if (input.draft) {
        this.assertCurrentDraft(row,input.draft);
        await this.saveDraftEvent(tx,row,viewer.id,{...input.draft,event_id:`sent:${viewer.id}:${id}:${input.idempotency_key}`,kind:'sent'});
        publication = await this.draftPublication(tx,row,input.draft.run_id,input.text);
      }
      await this.assessorMessage(tx, row, input.text, publication);
      await this.remember(tx, scope, input.idempotency_key, input, id);
    });
  }

  private async draftPublication(tx:EntityManager,row:CaseRow,runId:string,text:string):Promise<DraftPublication|undefined> {
    const card=row.snapshot.card;
    if (!card?.advisor_draft || !card.intent || text.trim() !== card.advisor_draft.trim() || card.pending.length) return;
    const source=card.citations[0]?.id;
    const invoiceExplained = card.intent === 'facturacion' && row.snapshot.verified
      && card.reason_codes.includes('verified_account') && card.facts.length > 0;
    const terminal = invoiceExplained ? 'invoice_explained'
      : card.reason_codes.includes('knowledge') && source ? knowledgePublication[card.intent] : undefined;
    if (!terminal) return;
    const [run] = await tx.query(`SELECT turn->>'config_revision' AS revision FROM agent_run WHERE id=$1 AND case_id=$2`,[runId,row.id]);
    if (!run?.revision) return;
    return {run_id:runId,category:card.intent,terminal,config_revision:run.revision,...(source ? {source} : {})};
  }

  async recordDraftEvent(viewer:Viewer, id:string, event:{
    run_id:string;case_revision:number;event_id:string;kind:'used'|'edited'|'feedback_positive'|'feedback_negative'
  }) {
    return this.db.transaction(async tx => {
      const row = await loadCase(tx,id,true);
      checkCase(viewer,row,true);
      this.assertCurrentDraft(row,event);
      await this.saveDraftEvent(tx,row,viewer.id,event);
      return {accepted:true};
    });
  }

  private assertCurrentDraft(row:CaseRow,event:{run_id:string;case_revision:number}) {
    if (!draftIsCurrent(row.snapshot) || row.snapshot.revision !== event.case_revision ||
        row.snapshot.card?.advisor_draft_run_id !== event.run_id) {
      throw new ConflictException('El borrador corresponde a un turno anterior');
    }
  }

  private async saveDraftEvent(tx:EntityManager,row:CaseRow,operator:string,event:{
    run_id:string;event_id:string;kind:'used'|'edited'|'sent'|'feedback_positive'|'feedback_negative'
  }) {
    const inserted = await tx.query(`INSERT INTO draft_event(event_id,case_id,run_id,operator_id,kind)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING event_id`,
    [event.event_id,row.id,event.run_id,operator,event.kind]);
    if (inserted.length) await audit(tx,row.id,event.kind.startsWith('feedback_') ? `reply_${event.kind}` : `draft_${event.kind}`,
      {run_id:event.run_id,category:row.intent_hint});
  }

  async close(viewer: Viewer, id: string, input:z.infer<typeof CloseCase>) {
    return this.change(viewer, id, true, async (tx, row) => {
      const {resolved,retention_outcome} = input;
      const eligible = row.snapshot.verified && row.intent_hint === 'cancelacion' &&
        (row.snapshot.card?.reason_codes.includes('retention_eligible') || row.snapshot.card?.proposal?.kind === 'retention_offer');
      if (retention_outcome && retention_outcome !== 'pendiente' && !eligible) {
        throw new ConflictException('Se requiere un caso de cancelación elegible y verificado');
      }
      if (eligible) await audit(tx,id,'retention_outcome',{category:'cancelacion',outcome:retention_outcome ?? 'pendiente'});
      row.snapshot.status = 'closed';
      row.snapshot.revision += 1;
      await tx.query('UPDATE attention_case SET resolved=$2 WHERE id=$1', [id, resolved]);
      await audit(tx, id, 'closed', { resolved });
      await queueChurn(tx,row);
      if (row.snapshot.channel === 'telegram') {
        await enqueue(tx, `feedback:${id}`, id, 'deliver', {
          sender:'sistema', revision:row.snapshot.revision, feedback_case_id:id,
          text:'¿Qué tan satisfecho quedaste con esta atención? Elige del 1 al 5.'
        });
      }
    });
  }

  async decide(viewer: Viewer, proposalId: string, input: z.infer<typeof DecideProposal>) {
    assessor(viewer);
    return this.db.transaction(async (tx) => {
      const [ref] = await tx.query('SELECT case_id FROM retention_proposal WHERE id=$1', [proposalId]);
      if (!ref) throw new NotFoundException('Propuesta no encontrada');
      const row = await loadCase(tx, ref.case_id, true);
      checkCase(viewer, row, true);
      const scope = `decision:${viewer.id}:${proposalId}`;
      const [p]: ProposalRow[] = await tx.query('SELECT * FROM retention_proposal WHERE id=$1 FOR UPDATE', [proposalId]);
      if (!p) throw new NotFoundException();
      const auditData = {proposal_id:proposalId,run_id:p.run_id,decision:input.decision};
      if (await this.replay(tx, scope, input.idempotency_key, input)) {
        await audit(tx,row.id,'proposal_decision_replayed',auditData);
        return row.snapshot;
      }
      if (p.proposal.status !== 'pending_approval') {
        if (!(p.proposal.status === input.decision || (input.decision === 'approved' &&
          ['pending_verification','confirmed'].includes(p.proposal.status)))) {
          throw new ConflictException('La propuesta ya está decidida');
        }
        return row.snapshot;
      }
      if (row.snapshot.status !== 'open' || !row.snapshot.verified || row.snapshot.revision !== p.case_revision ||
        row.snapshot.card?.proposal?.id !== proposalId || p.proposal.revision !== input.revision ||
        Number(p.expires_at) <= Date.now()) throw new ConflictException('La propuesta ya no está vigente');
      p.proposal.status = input.decision;
      await tx.query('UPDATE retention_proposal SET proposal=$2 WHERE id=$1', [proposalId, p.proposal]);
      row.snapshot.card.proposal = p.proposal;
      await this.remember(tx, scope, input.idempotency_key, input, row.id);
      if (input.decision === 'approved') await enqueue(tx, `effect:${proposalId}`, row.id, 'effect', { proposal_id: proposalId });
      else await enqueue(tx, `resume:${proposalId}`, row.id, 'resume', { run_id: p.run_id, effect_id: proposalId, status: 'rejected' });
      await audit(tx, row.id, `proposal_${input.decision}`,auditData);
      await saveCase(tx, row);
      return row.snapshot;
    });
  }

  async recordFeedback(caseId: string, chatId: string, score: number) {
    await this.db.query(`INSERT INTO case_feedback(case_id,score)
      SELECT c.id,$3 FROM attention_case c JOIN telegram_contact t ON t.ref=c.contact_ref
      WHERE c.id=$1 AND t.chat_id=$2 AND t.enabled AND c.snapshot->>'status'='closed'
      ON CONFLICT(case_id) DO NOTHING`, [caseId,chatId,score]);
  }

  async receiveTelegram(input: { update_id: number; chat_id: string; text: string }) {
    return this.receive(input.chat_id, input.text, `telegram:${input.update_id}`, false);
  }

  async receiveSynthetic(contactRef: string, text: string, key: string, channel?:'whatsapp') {
    if (process.env.DEMO_MODE !== 'true') throw new NotFoundException();
    if (channel === 'whatsapp') {
      const scenario = process.env.LOCAL_PROMPT_REPLAY_SCENARIO;
      if (scenario !== 'CC-E10' || !process.env.LOCAL_PROMPT_REPLAY_REVISION || contactRef !== replayScenarios[scenario].fixture
        || !localPromptReplayAllowed()) throw new NotFoundException();
      return this.receive(contactRef, text, `synthetic:whatsapp:${contactRef}:${key}`, true, channel);
    }
    return this.receive(contactRef, text, `synthetic:${contactRef}:${key}`, true);
  }

  private async receive(address: string, text: string, key: string, synthetic: boolean, channel:'telegram'|'whatsapp'='telegram') {
    return this.db.transaction(async (tx) => {
      const payload = { address, text };
      if (await this.replay(tx, 'incoming', key, payload)) return;
      const [contact]: ContactRow[] = await tx.query(
        `SELECT * FROM telegram_contact WHERE ${synthetic ? 'ref' : 'chat_id'}=$1 AND enabled FOR UPDATE`, [address]);
      if (!contact) return;
      let row = await this.activeForContact(tx, contact.ref);
      if (row && row.snapshot.channel !== channel) throw new ConflictException('El contacto ya tiene un caso abierto en otro canal');
      if (!row && contact.fixture === 'C-1004') return;
      row ??= await this.newCase(tx, contact, contact.direct_owner, channel);
      await this.customerTurn(tx,row,text);
      await this.remember(tx, 'incoming', key, payload, row.id);
      await audit(tx, row.id, 'customer_turn');
      await saveCase(tx, row);
    });
  }

  async startWeb(token?: string, fresh = false) {
    this.requireWebDemo();
    return this.db.transaction(async (tx) => {
      const session = await this.webSession(tx, token);
      if (session && !fresh) return { token: undefined, snapshot: this.publicWeb(await loadCase(tx, session.case_id)) };
      await this.consumeWebQuota(tx, 'start', 24);
      await tx.query('DELETE FROM web_chat_session WHERE expires_at <= now()');
      const issued = randomBytes(32).toString('base64url');
      const row = await this.newCase(tx, { ref: `web:${randomUUID()}`, display_name: 'Cliente web' }, null, 'web');
      await tx.query("INSERT INTO web_chat_session VALUES ($1, $2, now() + interval '24 hours')", [this.tokenHash(issued), row.id]);
      return { token: issued, snapshot: this.publicWeb(row) };
    });
  }

  async viewWeb(token: string | undefined) {
    this.requireWebDemo();
    const session = await this.webSession(this.db.manager, token);
    if (!session) throw new UnauthorizedException('Sesión del chat vencida');
    return this.publicWeb(await loadCase(this.db.manager, session.case_id));
  }

  async sendWeb(token: string | undefined, input: z.infer<typeof SendMessage>) {
    this.requireWebDemo();
    return this.db.transaction(async (tx) => {
      const session = await this.webSession(tx, token);
      if (!session) throw new UnauthorizedException('Sesión del chat vencida');
      const row = await loadCase(tx, session.case_id, true);
      const scope = `web:${row.id}`;
      if (await this.replay(tx, scope, input.idempotency_key, input)) return this.publicWeb(row);
      if (row.snapshot.status !== 'open') throw new UnprocessableEntityException('La conversación está cerrada');
      await this.consumeWebQuota(tx, 'send', 40);
      await this.consumeWebQuota(tx, scope, 12);
      await this.customerTurn(tx,row,input.text);
      await this.remember(tx,scope,input.idempotency_key,input,row.id);
      await audit(tx,row.id,'customer_turn');
      await saveCase(tx, row);
      return this.publicWeb(row);
    });
  }

  async startWebVerification(token: string | undefined, identifier: string) {
    this.requireWebDemo();
    const caseId = await this.db.transaction(async tx => {
      const row = await this.lockWebCase(tx,token);
      if (row.account_ref) throw new ConflictException('La cuenta de esta conversación ya está verificada.');
      if (!this.pendingInquiry(row)) throw new ConflictException('Primero solicita una consulta de cuenta en el chat.');
      await this.consumeWebQuota(tx, 'verification-start', 36);
      await this.consumeWebQuota(tx, `verification-start:${row.id}`, 6);
      return row.id;
    });
    const ref = await simulators.alias(identifier).then(result => result.cliente_id, error => {
      if (error instanceof SimulatorFailure && error.status === 404) {
        throw new NotFoundException('No encontramos esa cuenta de prueba. Usa uno de los números o correos indicados.');
      }
      throw new ServiceUnavailableException('El CRM de prueba no está disponible. Reintenta en unos segundos.');
    });
    return this.db.transaction(async tx => {
      const row = await this.lockWebCase(tx,token);
      const inquiry = this.pendingInquiry(row);
      if (row.id !== caseId || row.account_ref || !inquiry) throw new ConflictException('La consulta cambió. Intenta de nuevo.');
      row.account_inquiry = inquiry;
      row.account_challenge_ref = ref;
      row.account_challenge_id = randomUUID();
      row.account_challenge_expires_at = new Date(Date.now() + 5 * 60 * 1000);
      await audit(tx,row.id,'web_demo_challenge_started');
      await saveCase(tx,row);
      return this.publicWeb(row);
    });
  }

  async confirmWebVerification(token: string | undefined, challengeId: string) {
    this.requireWebDemo();
    return this.db.transaction(async (tx) => {
      const row = await this.lockWebCase(tx, token);
      if (row.account_ref) return this.publicWeb(row);
      if (row.account_challenge_id !== challengeId || !row.account_challenge_ref ||
        !row.account_challenge_expires_at || Number(row.account_challenge_expires_at) <= Date.now() || !row.account_inquiry) {
        throw new ConflictException('El código de prueba venció o cambió. Solicita otro.');
      }
      await this.consumeWebQuota(tx, `verification-confirm:${row.id}`, 6);
      await this.confirmAccount(tx,row);
      await saveCase(tx, row);
      return this.publicWeb(row);
    });
  }

  private async lockWebCase(tx: EntityManager, token: string | undefined) {
    const session = await this.webSession(tx, token);
    if (!session) throw new UnauthorizedException('Sesión del chat vencida');
    const row = await loadCase(tx, session.case_id, true);
    if (row.snapshot.status !== 'open') throw new UnprocessableEntityException('La conversación está cerrada');
    return row;
  }

  private async customerTurn(tx: EntityManager, row: CaseRow, text: string) {
    const demo = process.env.DEMO_MODE === 'true';
    let requested = demo ? accountInquiry(text) : null;
    let pending = demo ? this.pendingInquiry(row) : null;
    const lastMessage = row.snapshot.messages.at(-1);
    const handoff = requestedAdvisor(text) || (
      lastMessage?.actor === 'agente' && lastMessage.text.endsWith('¿Quieres hablar con uno?') && /^\s*(?:s[ií](?:,? por favor)?|por favor|de acuerdo|claro(?: que s[ií])?)[. !]*$/i.test(text)
    );
    const verified = customerReference(row);
    const aliases = demo ? contactCandidates(text) : [];
    const codes = demo ? codeCandidates(text) : [];
    const planChange=demo && asksToChangeMobilePlan(text,lastMessage);
    if (planChange) {
      requested='assistance';
      row.snapshot.handoff_reason='El cliente solicita cambiar su plan móvil.';
    }
    if (pending==='identify' && !codes.length && !aliases.length && !isGreeting(text) && (requested || contextIntent(text))) {
      pending=null;
      row.account_inquiry=null;
      this.clearChallenge(row);
    }
    if (demo && !verified && !pending && !requested && !handoff && row.snapshot.attention_mode==='autoservicio' &&
        !contextIntent(text) && isVerificationContact(text,aliases)) requested='identify';
    const activeChallenge = row.account_challenge_id && Number(row.account_challenge_expires_at) > Date.now();
    const greeting=!requested && !pending && !contextIntent(text) && isGreeting(text);
    const safeText=greeting ? 'Hola' : this.safeCustomerText(text,aliases,codes);
    const priority=mandatoryPolicyRoute(safeText);
    const previousIntake=row.snapshot.intake;
    const collectingCancellation=demo && row.snapshot.attention_mode==='autoservicio' && !pending &&
      (requested==='assistance' && contextIntent(text)==='cancelacion' ||
        previousIntake?.intent==='cancelacion' && !!previousIntake.pending);
    const verificationTurn = !verified && !handoff && !priority && (requested==='identify' || !!pending && (!requested || !!activeChallenge));
    const message = addMessage(row,'cliente',verificationTurn
      ? '[Dato de verificación oculto]'
      : safeText);
    if (verificationTurn) message.verification_input = true;

    if (row.snapshot.attention_mode === 'autoservicio' && row.handoff_pending && !pending) {
      const canResume = isLegacyKnowledgeWait(row) && (handoff || priority ||
        !!catalogComparison(safeText,row.snapshot.messages,row.snapshot.conversation_memory,message.turn_seq));
      if (!canResume) return;
    }
    if (greeting && row.snapshot.attention_mode==='autoservicio') {
      await this.channelReply(tx,row,row.snapshot.channel==='web' || lastMessage
        ? 'Hola, ¿en qué te puedo ayudar?'
        : `${demoWelcome}${demo ? ` ${demoVerifyInvitation}` : ''} ¿En qué te puedo ayudar?`);
      return;
    }
    if (requested && requested!=='identify' && !verificationTurn) delete row.snapshot.conversation_memory;
    if (!verificationTurn && !(collectingCancellation && previousIntake && aliases.length)) {
      row.snapshot.intake=evolveContext(safeText,previousIntake);
    }
    if (!handoff && priority) {
      row.account_inquiry=null;
      this.clearChallenge(row);
      await queueRun(tx,row,message,true);
      return;
    }
    const intake=row.snapshot.intake;
    if (demo && !pending && !handoff && row.snapshot.attention_mode==='autoservicio' && intake?.intent==='facturacion' && intake.facts.objetivo) {
      if (nextContextQuestion(intake) && !aliases.length) {
        await queueRun(tx,row,message,true);
        return;
      }
      requested='assistance';
    }
    if (collectingCancellation && !handoff && intake?.intent==='cancelacion') {
      const next=nextContextQuestion(intake);
      if (next && !aliases.length && !(previousIntake?.pending && contextIntent(text)==='cancelacion' && !intake.facts.motivo)) {
        recordQuestion(intake,next);
        const run=await queueRun(tx,row,message,false,{decision:'ask',question_id:next.id});
        await audit(tx,row.id,'case_context_question',{run_id:run?.run_id,question_id:next.id,channel:row.snapshot.channel});
        await this.channelReply(tx,row,next.text);
        return;
      }
      delete intake.pending;
      requested='assistance';
    }
    if (row.snapshot.attention_mode === 'autoservicio' && (handoff || (verified && requested === 'assistance'))) {
      await queueIntentOnly(tx,row,message);
      await this.requestHumanAttention(tx,row,planChange ? 'El cliente solicita cambiar su plan móvil.' :
        handoff && intake?.intent!=='cancelacion' ? 'El cliente pidió hablar con un asesor.' : assistanceReason(row,text),
        planChange ? 'Te paso con un asesor para revisar y tramitar el cambio de plan.' :
        handoff ? 'Dejé tu solicitud en espera de un asesor. Puedes seguir escribiendo en este chat.'
          : 'Entiendo que quieres revisar tu solicitud con un asesor. Ya está en espera y podrás continuar en este mismo chat.');
      return;
    }
    if (verified && requested && requested !== 'assistance' && requested !== 'identify' && row.snapshot.attention_mode === 'autoservicio' && !row.handoff_pending) {
      await queueIntentOnly(tx,row,message);
      await this.answerAccount(tx,row,verified,requested);
      return;
    }
    if (verified || (!requested && !pending) || handoff) {
      if (!(demo && !requested && (aliases.length || codes.length) && !handoff)) await queueRun(tx,row,message,true);
      else await this.channelReply(tx,row,'Cuéntame qué necesitas consultar. Si hace falta, te pediré un dato de prueba.');
      return;
    }

    if (requested && !pending) await queueIntentOnly(tx,row,message);
    row.account_inquiry = requested ?? pending;
    if (requested && requested !== 'assistance' && requested !== 'identify') row.intent_hint = requested === 'plans' ? 'consulta_planes' : requested === 'tickets' ? 'soporte_tecnico' : 'facturacion';
    const replaceContact = aliases.some(alias => alias.includes('@') || alias.length >= 10) ||
      (aliases.length > 0 && /\b(correo|tel[eé]fono|celular|contacto|mi n[uú]mero)\b/i.test(text) &&
        !/\b(c[oó]digo|otp)\b/i.test(text));
    if (activeChallenge && !replaceContact) {
      if (codes.length === 1) await this.confirmAccount(tx,row);
      else await this.channelReply(tx,row,'Escribe un solo código de seis dígitos. En modo demo puedes usar cualquier código de ese formato.');
      return;
    }
    this.clearChallenge(row);
    if (aliases.length !== 1) {
      await this.channelReply(tx,row,aliases.length > 1 ? 'Indícame un solo correo o teléfono de prueba.' :
        accountVerificationPrompt);
      return;
    }
    try {
      const {cliente_id:ref} = await simulators.alias(aliases[0]);
      if (row.snapshot.channel === 'telegram' && ref !== row.contact_ref) {
        await this.channelReply(tx,row,'No encontré una coincidencia para este chat. Escribe el contacto de prueba asociado.');
        return;
      }
      row.account_challenge_ref = ref;
      row.account_challenge_id = randomUUID();
      row.account_challenge_expires_at = new Date(Date.now()+5*60*1000);
      await audit(tx,row.id,'demo_challenge_started',{channel:row.snapshot.channel});
      await this.channelReply(tx,row,'Simulé el envío de un código. En modo demo, escribe cualquier número de seis dígitos.');
    } catch (error) {
      if (!(error instanceof SimulatorFailure)) throw error;
      await this.channelReply(tx,row,error.status === 404
        ? row.snapshot.channel === 'telegram'
          ? 'No encontré una coincidencia para este chat. Escribe el contacto de prueba asociado.'
          : 'No encontré ese contacto de prueba. Escribe de nuevo tu correo o número.'
        : 'La verificación está temporalmente indisponible. Vuelve a escribir tu contacto en unos segundos.');
    }
  }

  private safeCustomerText(text: string, aliases: string[], codes: string[]) {
    const redacted = clearPersonalData(text);
    if (!aliases.length && !codes.length) return redacted;
    const sensitive = new Set([...aliases,...codes]);
    return redacted.replace(/(?<!\w)\+?\d(?:[ ()-]*\d){4,14}(?!\w)/g,value =>
      sensitive.has(value.replace(/\D/g,'')) ? '[dato oculto]' : value);

  }

  private clearChallenge(row: CaseRow) {
    row.account_challenge_ref = row.account_challenge_id = row.account_challenge_expires_at = null;
  }

  private async confirmAccount(tx: EntityManager,row: CaseRow) {
    const ref = row.account_challenge_ref;
    const inquiry = row.account_inquiry;
    if (!ref || !inquiry) throw new ConflictException('Solicita un código nuevo.');
    row.account_ref = ref;
    this.clearChallenge(row);
    row.account_inquiry = null;
    row.snapshot.verified = true;
    if (row.snapshot.channel === 'web') row.snapshot.display_name = `Cliente ${ref} · Web`;
    row.snapshot.revision += 1;
    row.snapshot.card = null;
    await audit(tx,row.id,'holder_verified',{method:'demo_chat',channel:row.snapshot.channel});
    await queueChurn(tx,row);
    if (row.snapshot.attention_mode === 'asistido') {
      await this.channelReply(tx,row,'Cuenta de prueba verificada.');
      await queueRun(tx,row,latestAnalyzable(row.snapshot),true);
    } else if (inquiry === 'assistance' || row.handoff_pending === 'Atención humana') {
      const source=latestAnalyzable(row.snapshot)?.text ?? '';
      await this.requestHumanAttention(tx,row,row.snapshot.handoff_reason ?? assistanceReason(row,source),
        'Cuenta de prueba verificada. Tu solicitud quedó en espera de un asesor en este mismo chat.');
    } else if (inquiry==='identify') {
      await this.channelReply(tx,row,'Listo, verifiqué tu cuenta de prueba. ¿En qué te puedo ayudar?');
    } else {
      row.handoff_pending = null;
      await this.answerAccount(tx,row,ref,inquiry,'Cuenta de prueba verificada. ');
    }
  }

  private async requestHumanAttention(tx: EntityManager,row: CaseRow,reason: string,reply: string) {
    row.snapshot.revision += 1;
    row.snapshot.handoff_reason = reason;
    row.handoff_pending = 'Atención humana';
    row.account_inquiry = null;
    this.clearChallenge(row);
    await audit(tx,row.id,'handoff_requested',{channel:row.snapshot.channel});
    await queueRun(tx,row,latestAnalyzable(row.snapshot),false,{decision:'handoff'});
    await this.channelReply(tx,row,reply);
  }

  private async channelReply(tx: EntityManager,row: CaseRow,text: string) {
    const message = addMessage(row,'agente',text);
    if (row.snapshot.channel === 'telegram') {
      await enqueue(tx,`deliver:${message.id}`,row.id,'deliver',{
        text,sender:'sistema',revision:row.snapshot.revision,turn_seq:message.turn_seq
      });
    }
  }

  private async answerAccount(tx: EntityManager,row: CaseRow,ref: string,inquiry: AccountRead,prefix = '') {
    try {
      const reply = await accountReply(ref,inquiry);
      const [active] = await tx.query('SELECT revision FROM prompt_revision WHERE activated');
      const config = active ? await readRunPromptConfig(tx,active.revision) : null;
      const template = config?.prompts.account_answer;
      const values:Record<string,string> = {account_fact_sentence:reply,next_step_sentence:''};
      const rendered = template?.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g,(_,key:string)=>values[key] ?? '').trim();
      await audit(tx,row.id,inquiry === 'plans' ? 'crm_read' : inquiry === 'tickets' ? 'tickets_read' : 'billing_read',{
        scope:'demo_chat_account', ...(rendered ? {config_revision:active.revision,prompt_sha256:config?.prompt_metadata.account_answer?.sha256} : {})
      });
      await this.channelReply(tx,row,prefix + (rendered || reply));
    } catch (error) {
      if (!(error instanceof SimulatorFailure)) throw error;
      await this.channelReply(tx,row,prefix + 'La API de esta consulta está temporalmente indisponible. Puedes volver a preguntar o solicitar un asesor.');
    }
  }

  private requireWebDemo() {
    if (process.env.DEMO_MODE !== 'true') throw new NotFoundException();
  }

  private tokenHash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async webSession(tx: EntityManager, token: string | undefined): Promise<{ case_id: string } | undefined> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const [session] = await tx.query('SELECT case_id FROM web_chat_session WHERE token_hash=$1 AND expires_at>now()', [this.tokenHash(token)]);
    return session;
  }

  private async consumeWebQuota(tx: EntityManager, scope: string, limit: number) {
    // INSERT/UPDATE returns its row through a CTE on TypeORM's PostgreSQL driver.
    const [entry] = await tx.query(`WITH counted AS (
      INSERT INTO web_chat_rate AS previous (scope,bucket,total) VALUES ($1,date_trunc('minute',now()),1)
      ON CONFLICT (scope) DO UPDATE SET bucket=EXCLUDED.bucket,
        total=CASE WHEN previous.bucket=EXCLUDED.bucket THEN previous.total+1 ELSE 1 END
      WHERE previous.bucket<>EXCLUDED.bucket OR previous.total<$2 RETURNING total
    ) SELECT total FROM counted`, [scope, limit]);
    if (!entry) throw new HttpException('El chat alcanzó su límite. Intenta en un minuto.', 429);
  }

  private publicWeb(row: CaseRow): WebChatSnapshot {
    let verification: WebChatSnapshot['verification'] = {stage:'idle'};
    if (row.account_ref) verification = {stage:'verified'};
    else if (row.account_challenge_id && row.account_challenge_expires_at && Number(row.account_challenge_expires_at) > Date.now()) {
      verification = {stage:'code_sent', challenge_id:row.account_challenge_id};
    } else if (this.pendingInquiry(row)) verification = {stage:'required'};
    return WebChatSnapshot.parse({ ...row.snapshot,
      awaiting_advisor: !!row.handoff_pending && row.snapshot.attention_mode === 'autoservicio' &&
        (row.handoff_pending === 'Atención humana' || verification.stage === 'idle' || verification.stage === 'verified'),
      verification
    });
  }

  private pendingInquiry(row: CaseRow) {
    if (row.account_inquiry) return row.account_inquiry;
    if (!row.contact_ref.startsWith('web-c1001:') || !row.handoff_pending || row.handoff_pending === 'Atención humana') return null;
    return accountInquiry(row.snapshot.messages.findLast(message => message.actor === 'cliente')?.text ?? '');
  }

  private async assessorMessage(tx: EntityManager, row: CaseRow, text: string, publication?:DraftPublication) {
    const m = addMessage(row, 'asesor', text);
    const question=row.snapshot.card?.context_question;
    if (question && row.snapshot.intake && text.includes(question.text)) recordQuestion(row.snapshot.intake,question);
    if (row.snapshot.channel === 'telegram') {
      await enqueue(tx, `deliver:${m.id}`, row.id, 'deliver', {
        text,sender:'asesor',revision:row.snapshot.revision,...(publication ? {draft_publication:publication} : {})
      });
    } else if (row.snapshot.channel === 'web' && publication) {
      await audit(tx,row.id,'agent_task_outcome',{...publication,channel:'web',outcome:'qualified_success'});
    }
    await queueRun(tx, row, m);
  }

  private async change(viewer: Viewer, id: string, mustOwn: boolean, apply: Mutation) {
    return this.db.transaction(async (tx) => {
      const row = await loadCase(tx, id, true);
      checkCase(viewer, row, mustOwn);
      if (row.snapshot.status !== 'open') throw new UnprocessableEntityException('El caso ya está cerrado');
      await apply(tx, row);
      await saveCase(tx, row);
      const snapshot=operatorSnapshot(row.snapshot);
      return snapshot.owner_id===viewer.id ? {...snapshot,ml:await privateSignals(tx,row)} : snapshot;
    });
  }

  private async activeForContact(tx: EntityManager, ref: string): Promise<CaseRow | undefined> {
    const [row] = await tx.query("SELECT * FROM attention_case WHERE contact_ref=$1 AND snapshot->>'status'='open' FOR UPDATE", [ref]);
    return row;
  }

  private async newCase(tx: EntityManager, contact: Pick<ContactRow, 'ref' | 'display_name'>, owner: string | null, channel: 'telegram' | 'web' | 'whatsapp' = 'telegram'): Promise<CaseRow> {
    const id = randomUUID();
    const snapshot: CaseSnapshot = {
      id, conversation_id: randomUUID(), display_name: contact.display_name, channel,
      owner_id: owner, attention_mode: owner ? 'asistido' : 'autoservicio', status: 'open',
      verified: false, revision: 1, updated_at: new Date().toISOString(), cursor: 0, messages: [], card: null, last_message: null
    };
    await tx.query('INSERT INTO attention_case(id,contact_ref,snapshot) VALUES ($1,$2,$3)', [id, contact.ref, snapshot]);
    await audit(tx, id, 'opened');
    if (owner) await audit(tx,id,'human_attention_started',{operator_id:owner,channel});
    return { id, snapshot, contact_ref: contact.ref, handoff_pending: null, intent_hint: null };
  }

  private async replay(tx: EntityManager, scope: string, key: string, input: unknown) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [scope, key]);
    const [existing] = await tx.query('SELECT fingerprint,case_id FROM idempotency WHERE scope=$1 AND key=$2', [scope, key]);
    if (!existing) return null;
    if (existing.fingerprint !== this.fingerprint(input)) throw new ConflictException('Clave de idempotencia reutilizada con otro contenido');
    return loadCase(tx, existing.case_id);
  }

  private async remember(tx: EntityManager, scope: string, key: string, input: unknown, caseId: string) {
    await tx.query('INSERT INTO idempotency VALUES ($1,$2,$3,$4)', [scope, key, this.fingerprint(input), caseId]);
  }

  private fingerprint(input: unknown) {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
  }
}
