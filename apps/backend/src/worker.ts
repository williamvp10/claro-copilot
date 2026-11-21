import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createAgent, createJevDecisionAdapter, createOpenAIEvidenceSelector, createKnowledgeMcpAdapter } from '@claro/agent';
import { Prediction, RunResult, type AgentTurn, type Proposal, type RunResume } from '@claro/contracts';
import { createClient } from 'redis';
import type { DataSource } from 'typeorm';
import { audit, createDatabase, enqueue, type CaseJob } from './database.js';
import { addMessage, loadCase, saveCase, stillCurrent, latestAnalyzable } from './cases.js';
import { businessPorts, retention, runContext } from './business.js';
import { databaseKnowledge } from './knowledge.js';
import { exportAgentSpan } from './telemetry.js';

@Module({})
class WorkerModule {}

const context = await NestFactory.createApplicationContext(WorkerModule);
const logger = new Logger('AttentionWorker');
const db = await createDatabase().initialize();
const redis = process.env.REDIS_URL ? createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 1500, reconnectStrategy: false } }) : null;
if (redis) {
  redis.on('error', () => logger.warn('Redis unavailable'));
  await redis.connect().catch(() => undefined);
}
const live = process.env.AGENT_PROVIDERS === 'live';
const routerKey = process.env.OPENROUTER_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const mcpUrl = process.env.KNOWLEDGE_MCP_URL;
const knowledgeToken = process.env.KNOWLEDGE_SERVICE_TOKEN;
const runner = createAgent(businessPorts(db), {
  knowledge: mcpUrl && knowledgeToken ? createKnowledgeMcpAdapter({ url: mcpUrl, token: knowledgeToken }) : databaseKnowledge(db),
  decision: live && routerKey ? createJevDecisionAdapter({ apiKey: routerKey, model: process.env.JEV_MODEL || 'typesafe/jev-1.14' }) : undefined,
  evidenceSelector: live && openaiKey ? createOpenAIEvidenceSelector({
    apiKey: openaiKey,
    models: {
      economico: process.env.OPENAI_MODEL_ECONOMICO,
      intermedio: process.env.OPENAI_MODEL_INTERMEDIO,
      complejo: process.env.OPENAI_MODEL_COMPLEJO
    }
  }) : undefined,
  checkpoints: {
    async get(key) {
      const [row] = await db.query('SELECT result FROM agent_checkpoint WHERE id=$1', [key]);
      return row ? RunResult.parse(row.result) : undefined;
    },
    async put(key, value) {
      await db.query('INSERT INTO agent_checkpoint VALUES ($1,$2) ON CONFLICT DO NOTHING', [key, value]);
    }
  }
});

async function claim(db: DataSource, ml: boolean): Promise<CaseJob | undefined> {
  const token = randomUUID();
  const [jobs] = await db.query(`WITH job AS (
    SELECT id FROM outbox WHERE (kind='ml')=$1 AND attempts<5 AND
      ((status='queued' AND available_at<=now()) OR (status='processing' AND lease_until<=now()))
    ORDER BY available_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
  ) UPDATE outbox o SET status='processing',attempts=o.attempts+1,lease_token=$2,lease_until=now()+interval '60 seconds'
    FROM job WHERE o.id=job.id RETURNING o.*`, [ml, token]);
  return jobs?.[0];
}

async function project(turn: AgentTurn, result: RunResult) {
  await db.transaction(async (tx) => {
    const row = await loadCase(tx, turn.case_id, true);
    if (!stillCurrent(row, turn)) {
      await audit(tx, row.id, 'agent_stale');
      return;
    }
    const [{ published }] = await tx.query(`SELECT EXISTS(SELECT 1 FROM attention_event
      WHERE case_id=$1 AND kind='agent_completed' AND metadata->>'run_id'=$2) AS published`, [row.id, turn.run_id]);
    if (published) return;
    if (result.type === 'failed') throw new Error('agent_failed');
    if (turn.audience === 'cliente' && (result.type === 'answer' || result.type === 'handoff')) {
      if (result.type === 'handoff') {
        row.handoff_pending = result.pending;
        await audit(tx, row.id, 'handoff');
      }
      const text = result.type === 'answer'
        ? [result.answer, ...result.citations.map(cite => `Fuente: ${cite.title} · ${cite.version}${cite.url ? ` · ${cite.url}` : ''}`)].join('\n')
        : result.reason;
      const msg = addMessage(row, 'agente', text.slice(0, 4096), result.type === 'answer' ? result.citations : []);
      await enqueue(tx, `deliver:${msg.id}`, row.id, 'deliver', { text: msg.text, sender: 'agente', revision: turn.case_revision, turn_seq: turn.turn_seq });
    }
    if (turn.audience === 'asesor' && result.type === 'card') {
      if (result.card.proposal) {
        const [existing] = await tx.query('SELECT proposal FROM retention_proposal WHERE id=$1 AND case_id=$2', [result.card.proposal.id, row.id]);
        result.card.proposal = existing?.proposal;
      }
      row.snapshot.card = result.card;
      row.intent_hint = result.card.intent;
    }
    await audit(tx, row.id, 'agent_completed', { run_id: turn.run_id, route: result.route });
    await saveCase(tx, row);
  });
}

async function executeEffect(job: Extract<CaseJob, {kind: 'effect'}>) {
  await db.transaction(async (tx) => {
    const row = await loadCase(tx, job.case_id, true);
    const [record]: { proposal: Proposal; run_id: string; expires_at: Date; case_revision: number; option_id: string }[] = await tx.query(
      'SELECT * FROM retention_proposal WHERE id=$1 AND case_id=$2 FOR UPDATE', [job.payload.proposal_id, row.id]);
    if (!record || record.proposal.status !== 'approved') return;
    const id = record.proposal.id;
    const eligibility = await retention(tx, row, id);
    const [owner] = await tx.query('SELECT role FROM operator_role WHERE user_id=$1', [row.snapshot.owner_id]);
    const allowed = row.snapshot.verified && owner?.role === 'asesor' && row.snapshot.status === 'open' &&
      row.snapshot.revision === record.case_revision && eligibility.eligible &&
      eligibility.options.some((option) => option.id === record.option_id) && Number(record.expires_at) > Date.now();
    if (allowed) {
      await tx.query('INSERT INTO crm_effect (id,proposal_id) VALUES ($1,$2) ON CONFLICT (proposal_id) DO NOTHING', [`crm-${id}`, id]);
      const [effect] = await tx.query('SELECT id FROM crm_effect WHERE proposal_id=$1', [id]);
      record.proposal.effect_ref = effect.id;
      record.proposal.status = 'confirmed';
      await audit(tx, row.id, 'retention_confirmed');
    } else {
      record.proposal.status = 'expired';
      await audit(tx, row.id, 'retention_expired');
    }
    await tx.query('UPDATE retention_proposal SET proposal=$2 WHERE id=$1', [id, record.proposal]);
    if (row.snapshot.card?.proposal?.id === id) row.snapshot.card.proposal = record.proposal;
    await saveCase(tx, row);
    await enqueue(tx, `resume:${id}`, row.id, 'resume', {
      run_id: record.run_id, effect_id: id, status: record.proposal.status, effect_ref: record.proposal.effect_ref
    });
  });
}

async function resume(result: RunResume) {
  const generated = await runner.resume(result);
  if (generated.type !== 'card') throw new Error('checkpoint_not_ready');
  await db.transaction(async (tx) => {
    const { row, turn } = await runContext(tx, result.run_id, true);
    if (!stillCurrent(row, turn) || row.snapshot.card?.proposal?.id !== result.effect_id) return;
    row.snapshot.card = { ...generated.card, proposal: row.snapshot.card.proposal };
    await saveCase(tx, row);
  });
}

async function deliver(job: Extract<CaseJob, {kind: 'deliver'}>) {
  // Reserve attempted deliveries durably. An ambiguous network result requires reconciliation.
  const reserved = await db.query('INSERT INTO message_dispatch(id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id', [job.id]);
  if (reserved.length === 0) return;
  await db.transaction(async (tx) => {
    const row = await loadCase(tx, job.case_id, true);
    const { sender, revision, turn_seq, text } = job.payload;
    if (sender === 'agente' && (row.snapshot.attention_mode !== 'autoservicio' ||
      row.snapshot.revision !== revision || latestAnalyzable(row.snapshot)?.turn_seq !== turn_seq || row.snapshot.status !== 'open')) {
      await audit(tx, row.id, 'telegram_stale');
      return;
    }
    const [contact] = await tx.query('SELECT chat_id FROM telegram_contact WHERE ref=$1 AND enabled', [row.contact_ref]);
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || !contact?.chat_id) {
      await audit(tx, row.id, process.env.DEMO_MODE === 'true' ? 'telegram_simulated' : 'telegram_unavailable');
      return;
    }
    try {
      const reply = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: contact.chat_id, text }), signal: AbortSignal.timeout(3500)
      });
      const payload = await reply.json() as { ok?: boolean };
      await audit(tx, row.id, reply.ok && payload.ok === true ? 'telegram_delivered' : 'telegram_failed');
    } catch {
      await audit(tx, row.id, 'telegram_pending_verification');
    }
  });
}

async function predict(turn: AgentTurn) {
  const url = process.env.ML_API_URL;
  const token = process.env.ML_SERVICE_TOKEN;
  if (!url || !token) return;
  try {
    const response = await fetch(new URL('/internal/v1/predict-intent', url), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: turn.text, turn_id: turn.turn_id, idempotency_key: turn.turn_id, channel: turn.channel }),
      signal: AbortSignal.timeout(1000)
    });
    if (!response.ok) throw new Error('prediction unavailable');
    const data = Prediction.parse(await response.json());
    await audit(db.manager, turn.case_id, 'ml_predicted', { version: data.model_version, mode: data.mode, label: data.label });
  } catch {
    await audit(db.manager, turn.case_id, 'ml_unavailable');
  }
}

async function handle(job: CaseJob) {
  switch (job.kind) {
    case 'run': {
      const { row } = await runContext(db.manager, job.payload.run_id, false);
      if (!stillCurrent(row, job.payload)) return audit(db.manager, job.case_id, 'agent_stale');
      const started = Date.now();
      const result = await runner.run(job.payload);
      await project(job.payload, result);
      await audit(db.manager, job.case_id, 'agent_latency', { ms: Date.now() - started });
      if (await exportAgentSpan(job.payload, started, result.route, result.type)) {
        await audit(db.manager, job.case_id, 'langfuse_exported');
      }
      if (redis?.isReady) {
        await redis.set(`conversation:${job.payload.conversation_id}`, JSON.stringify({ lastRun: job.payload.run_id }), { expiration: { type: 'EX', value: 86400 } }).catch(() => undefined);
      }
      break;
    }
    case 'resume': await resume(job.payload); break;
    case 'effect': await executeEffect(job); break;
    case 'deliver': await deliver(job); break;
    case 'ml': await predict(job.payload); break;
  }
}

let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopped = true; });
async function poll(ml: boolean) {
  while (!stopped) {
    try {
      const job = await claim(db, ml);
      if (!job) {
        await wait(200);
        continue;
      }
      try {
        await handle(job);
        await db.query("UPDATE outbox SET status='done',lease_until=NULL WHERE id=$1 AND lease_token=$2", [job.id, job.lease_token]);
      } catch {
        if (job.attempts >= 5) await audit(db.manager, job.case_id, 'job_failed', { kind: job.kind });
        await db.query(`UPDATE outbox SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,
          lease_until=NULL,available_at=now()+interval '1 second',error_code='execution_failed' WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token]);
      }
    } catch {
      logger.warn('Outbox unavailable; retrying');
      await wait(1000);
    }
  }
}
const heartbeat = setInterval(() => void writeFile('/tmp/claro-worker-heartbeat', new Date().toISOString()).catch(() => undefined), 3000);
try {
  await Promise.all([poll(false), poll(true)]);
} finally {
  clearInterval(heartbeat);
  if (redis?.isOpen) await redis.close();
  await db.destroy();
  await context.close();
}
