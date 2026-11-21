import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { type z } from 'zod';
import {
  AgentTurn, CaseSnapshot, type Actor, type Contact, type DecideProposal, type Intent,
  type Message, type OpenCase, type Proposal, type SendMessage, type Viewer
} from '@claro/contracts';
import { DataSource, type EntityManager } from 'typeorm';
import { audit, type CaseRow, type ContactRow, DATABASE, enqueue } from './database.js';

type Assessor = Viewer;
type Mutation = (tx: EntityManager, row: CaseRow) => Promise<void>;
type ProposalRow = { id: string; case_id: string; proposal: Proposal; option_id: string; case_revision: number; run_id: string; expires_at: Date };

export function constantEqual(input: string, expected: string) {
  const inputHash = createHash('sha256').update(input).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(inputHash, expectedHash);
}

export function clearPersonalData(text: string) {
  return text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[correo]')
    .replace(/\+?\d(?:[ .()-]*\d){6,}/g, '[número]');
}

export function latestAnalyzable(snapshot: CaseSnapshot) {
  return snapshot.messages.findLast((message) => message.actor !== 'agente');
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
  await tx.query('UPDATE attention_case SET snapshot=$2,handoff_pending=$3,intent_hint=$4 WHERE id=$1',
    [row.id, row.snapshot, row.handoff_pending, row.intent_hint]);
}

function assessor(viewer: Viewer) {
  if (viewer.role !== 'asesor') throw new ForbiddenException('Se requiere rol asesor');
}

function checkCase(viewer: Viewer, row: CaseRow, mustOwn = false) {
  assessor(viewer);
  const owner = row.snapshot.owner_id;
  if ((owner && owner !== viewer.id) || (mustOwn && owner !== viewer.id)) throw new NotFoundException('Caso no disponible');
}

export function addMessage(row: CaseRow, actor: z.infer<typeof Actor>, text: string, citations?: Message['citations']) {
  const { messages } = row.snapshot;
  const last = messages.at(-1)?.turn_seq ?? 0;
  const message: Message = { id: randomUUID(), turn_seq: last + 1, actor, text, created_at: new Date().toISOString(), citations };
  messages.push(message);
  row.snapshot.last_message = text;
  return message;
}

export async function queueRun(tx: EntityManager, row: CaseRow, message = latestAnalyzable(row.snapshot), shadow = false) {
  if (!message || message.actor === 'agente') return;
  const [{ revision }] = await tx.query('SELECT revision FROM prompt_revision WHERE activated');
  const scope = row.snapshot.verified ? 'verified' : 'unverified';
  const turn = AgentTurn.parse({
    run_id: randomUUID(), case_id: row.id, conversation_id: row.snapshot.conversation_id, turn_id: message.id,
    channel: row.snapshot.channel, actor: message.actor, turn_seq: message.turn_seq, case_revision: row.snapshot.revision,
    attention_mode: row.snapshot.attention_mode, audience: row.snapshot.attention_mode === 'asistido' ? 'asesor' : 'cliente',
    scope_ref: scope, config_revision: revision, business_date: process.env.DEMO_MODE === 'true' ? '2026-11-18' : new Date().toISOString().slice(0, 10),
    text: clearPersonalData(message.text)
  });
  await tx.query('INSERT INTO agent_run VALUES ($1,$2,$3)', [turn.run_id, row.id, turn]);
  await enqueue(tx, turn.run_id, row.id, 'run', turn);
  if (shadow && message.actor === 'cliente' && process.env.ML_API_URL) {
    await enqueue(tx, `ml:${message.id}`, row.id, 'ml', turn);
  }
}

@Injectable()
export class Cases {
  constructor(@Inject(DATABASE) private readonly db: DataSource) {}

  async list(viewer: Viewer) {
    assessor(viewer);
    const rows: CaseRow[] = await this.db.query(`SELECT * FROM attention_case WHERE snapshot->>'owner_id'=$1 OR
      (snapshot->>'owner_id' IS NULL AND (handoff_pending IS NOT NULL OR snapshot->>'attention_mode'='asistido'))
      ORDER BY snapshot->>'updated_at' DESC LIMIT 100`, [viewer.id]);
    return rows.map(({ snapshot: { messages: _messages, card: _card, cursor: _cursor, ...summary } }) => summary);
  }

  async contacts(viewer: Viewer): Promise<Contact[]> {
    assessor(viewer);
    return this.db.query(`SELECT ref,display_name,enabled FROM telegram_contact WHERE enabled AND
      (direct_owner IS NULL OR direct_owner=$1) AND (chat_id IS NOT NULL OR $2) ORDER BY ref`, [viewer.id, process.env.DEMO_MODE === 'true']);
  }

  async get(viewer: Viewer, id: string) {
    const row = await loadCase(this.db.manager, id);
    checkCase(viewer, row);
    if (!row.snapshot.owner_id && !row.handoff_pending) throw new NotFoundException('Caso no disponible');
    return row.snapshot;
  }

  async take(viewer: Viewer, id: string) {
    return this.change(viewer, id, false, async (tx, row) => {
      if (row.snapshot.owner_id === viewer.id) return;
      if (!row.handoff_pending) throw new ConflictException('El caso todavía está en autoservicio');
      row.snapshot.owner_id = viewer.id;
      row.snapshot.attention_mode = 'asistido';
      row.snapshot.revision += 1;
      row.snapshot.card = null;
      await audit(tx, id, 'handoff_taken');
      await queueRun(tx, row);
    });
  }

  async verify(viewer: Viewer, id: string, code: string) {
    const expected = process.env.DEMO_HOLDER_CODE;
    if (process.env.DEMO_MODE !== 'true' || !expected) throw new ForbiddenException('La verificación de demo no está configurada');
    return this.change(viewer, id, true, async (tx, row) => {
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
      await this.assessorMessage(tx, row, input.text);
      await this.remember(tx, scope, input.idempotency_key, input, id);
    });
  }

  async close(viewer: Viewer, id: string, resolved: boolean) {
    return this.change(viewer, id, true, async (tx, row) => {
      row.snapshot.status = 'closed';
      row.snapshot.revision += 1;
      await tx.query('UPDATE attention_case SET resolved=$2 WHERE id=$1', [id, resolved]);
      await audit(tx, id, 'closed', { resolved });
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
      if (await this.replay(tx, scope, input.idempotency_key, input)) return row.snapshot;
      const [p]: ProposalRow[] = await tx.query('SELECT * FROM retention_proposal WHERE id=$1 FOR UPDATE', [proposalId]);
      if (p.proposal.status !== 'pending_approval') {
        if (!(p.proposal.status === input.decision || (p.proposal.status === 'confirmed' && input.decision === 'approved'))) {
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
      await audit(tx, row.id, `proposal_${input.decision}`);
      await saveCase(tx, row);
      return row.snapshot;
    });
  }

  async receiveTelegram(input: { update_id: number; chat_id: string; text: string }) {
    return this.receive(input.chat_id, input.text, `telegram:${input.update_id}`, false);
  }

  async receiveSynthetic(contactRef: string, text: string, key: string) {
    if (process.env.DEMO_MODE !== 'true') throw new NotFoundException();
    return this.receive(contactRef, text, `synthetic:${contactRef}:${key}`, true);
  }

  private async receive(address: string, text: string, key: string, synthetic: boolean) {
    return this.db.transaction(async (tx) => {
      const payload = { address, text };
      if (await this.replay(tx, 'incoming', key, payload)) return;
      const [contact]: ContactRow[] = await tx.query(
        `SELECT * FROM telegram_contact WHERE ${synthetic ? 'ref' : 'chat_id'}=$1 AND enabled FOR UPDATE`, [address]);
      if (!contact) return;
      let row = await this.activeForContact(tx, contact.ref);
      if (!row && contact.fixture === 'C-1004') return;
      row ??= await this.newCase(tx, contact, contact.direct_owner);
      const message = addMessage(row, 'cliente', text);
      await queueRun(tx, row, message, true);
      await this.remember(tx, 'incoming', key, payload, row.id);
      await audit(tx, row.id, 'customer_turn');
      await saveCase(tx, row);
    });
  }

  private async assessorMessage(tx: EntityManager, row: CaseRow, text: string) {
    const m = addMessage(row, 'asesor', text);
    await enqueue(tx, `deliver:${m.id}`, row.id, 'deliver', { text, sender: 'asesor', revision: row.snapshot.revision });
    await queueRun(tx, row, m);
  }

  private async change(viewer: Viewer, id: string, mustOwn: boolean, apply: Mutation) {
    return this.db.transaction(async (tx) => {
      const row = await loadCase(tx, id, true);
      checkCase(viewer, row, mustOwn);
      if (row.snapshot.status !== 'open') throw new UnprocessableEntityException('El caso ya está cerrado');
      await apply(tx, row);
      await saveCase(tx, row);
      return row.snapshot;
    });
  }

  private async activeForContact(tx: EntityManager, ref: string): Promise<CaseRow | undefined> {
    const [row] = await tx.query("SELECT * FROM attention_case WHERE contact_ref=$1 AND snapshot->>'status'='open' FOR UPDATE", [ref]);
    return row;
  }

  private async newCase(tx: EntityManager, contact: ContactRow, owner: string | null): Promise<CaseRow> {
    const id = randomUUID();
    const snapshot: CaseSnapshot = {
      id, conversation_id: randomUUID(), display_name: contact.display_name, channel: 'telegram',
      owner_id: owner, attention_mode: owner ? 'asistido' : 'autoservicio', status: 'open',
      verified: false, revision: 1, updated_at: new Date().toISOString(), cursor: 0, messages: [], card: null, last_message: null
    };
    await tx.query('INSERT INTO attention_case(id,contact_ref,snapshot) VALUES ($1,$2,$3)', [id, contact.ref, snapshot]);
    await audit(tx, id, 'opened');
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
