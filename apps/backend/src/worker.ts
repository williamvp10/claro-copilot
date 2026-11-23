import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createAgent, createJevDecisionAdapter, createOpenAIPublicWriter, createOpenAIEvidenceSelector, createKnowledgeMcpAdapter, type AgentObservation } from '@claro/agent';
import { RunResult, type AgentTurn, type RunResume } from '@claro/contracts';
import { createClient } from 'redis';
import type { DataSource } from 'typeorm';
import { audit, createDatabase, enqueue, type CaseJob } from './database.js';
import { addMessage, loadCase, saveCase, stillCurrent, latestAnalyzable } from './cases.js';
import { businessPorts, runContext } from './business.js';
import { integrationMcpPorts } from './integration-mcp-client.js';
import { readRunPromptConfig } from './prompt-catalog.js';
import { databaseKnowledge } from './knowledge.js';
import { exportAgentSpan } from './telemetry.js';
import { executeAgentIntegration, executeIntegration } from './integration-operations.js';
import { accountVerificationPrompt } from './demo-accounts.js';
import { predictIntent, predictChurn, sendLabel } from './ml-advisory.js';
import { observeSimulators, SimulatorFailure } from './simulator-client.js';

@Module({})
class WorkerModule {}

const context = await NestFactory.createApplicationContext(WorkerModule);
const logger = new Logger('AttentionWorker');
const db = await createDatabase().initialize();
observeSimulators(db);
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
const observations = new Map<string, AgentObservation[]>();
const basePorts = businessPorts(db);
const ports = process.env.CRM_MCP_URL && process.env.BILLING_MCP_URL ? integrationMcpPorts(db, basePorts) : basePorts;
const runner = createAgent({
  ...ports,
  getAgentConfig: revision => readRunPromptConfig(db, revision)
}, {
  requireApprovedPrompts: live,
  knowledge: mcpUrl && knowledgeToken ? createKnowledgeMcpAdapter({ url: mcpUrl, token: knowledgeToken, trustedLocal: true }) : databaseKnowledge(db),
  decision: live && routerKey ? createJevDecisionAdapter({ apiKey: routerKey, model: process.env.JEV_MODEL || 'typesafe/jev-1.14' }) : undefined,
  writer: live && openaiKey ? createOpenAIPublicWriter({apiKey:openaiKey}) : undefined,
  evidenceSelector: live && openaiKey ? createOpenAIEvidenceSelector({apiKey:openaiKey,models:{economico:'gpt-6-luna',intermedio:'gpt-6.1-terra',complejo:'gpt-6.2-sol'}}) : undefined,
  observe: (runId, item) => {
    const list = observations.get(runId);
    if (list) list.push(item);
  },
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
    SELECT id FROM outbox WHERE (kind IN ('ml','ml_churn','ml_label'))=$1 AND (attempts<5 OR kind IN ('effect','integration')) AND
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
      const conversationalVerification = process.env.DEMO_MODE === 'true' && result.type === 'handoff' &&
        result.verification_required && !row.snapshot.verified && (row.snapshot.channel === 'web' || row.snapshot.channel === 'telegram');
      if (conversationalVerification) {
        row.account_inquiry ??= result.route === 'facturacion' ? 'invoice' : 'assistance';
      } else if (result.type === 'handoff') {
        row.handoff_pending = result.pending;
        await audit(tx, row.id, 'handoff');
      }
      const text = conversationalVerification ? accountVerificationPrompt : result.type === 'answer'
        ? row.snapshot.channel === 'telegram'
          ? [result.answer, ...result.citations.map(cite => `Fuente: ${cite.title} · ${cite.version}${cite.url ? ` · ${cite.url}` : ''}`)].join('\n')
          : result.answer
        : result.reason;
      const msg = addMessage(row, 'agente', text.slice(0, 4096), result.type === 'answer' ? result.citations : []);
      if (row.snapshot.channel === 'telegram') {
        await enqueue(tx, `deliver:${msg.id}`, row.id, 'deliver', { text: msg.text, sender: 'agente', revision: turn.case_revision, turn_seq: turn.turn_seq });
      }
    }
    if (turn.audience === 'asesor' && result.type === 'card') {
      if (result.card.proposal) {
        const [existing] = await tx.query('SELECT proposal FROM retention_proposal WHERE id=$1 AND case_id=$2', [result.card.proposal.id, row.id]);
        result.card.proposal = existing?.proposal;
      }
      row.snapshot.card = result.card;
      if (result.card.advisor_draft && result.card.advisor_draft_run_id === turn.run_id) {
        row.snapshot.card.advisor_draft_case_revision = turn.case_revision;
        row.snapshot.card.advisor_draft_turn_seq = turn.turn_seq;
        row.snapshot.card.advisor_draft_status = 'current';
      }
      row.intent_hint = result.card.intent;
    }
    const unavailable = result.type === 'card' && result.card.facts.some(f => f.id.endsWith('-unavailable'));
    const terminal = result.type === 'answer' && result.citations.length > 0 && turn.channel !== 'telegram' ? (result.route === 'consulta_planes' ? 'catalog_answer_published' : result.route === 'portabilidad' ? 'portability_guidance_published' : 'guidance_published') : result.type === 'card' && result.card.reason_codes.includes('retention_ineligible') && !unavailable ? 'ineligible_explained' : 'pending';
    await audit(tx, row.id, 'agent_task_outcome', {run_id:turn.run_id, category:result.route, channel:turn.channel, config_revision:turn.config_revision, outcome:terminal === 'pending' ? (result.type === 'handoff' ? 'expected_abstention' : 'pending') : 'qualified_success', terminal, source:result.type === 'answer' ? result.citations[0]?.id ?? '' : result.type === 'card' ? result.card.citations[0]?.id ?? '' : ''});
    const [queued] = await tx.query(`SELECT GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp()-created_at))*1000)::integer AS ms FROM outbox WHERE kind='run' AND payload->>'run_id'=$1 ORDER BY created_at LIMIT 1`,[turn.run_id]);
    if (turn.channel === 'web' && queued && Number.isFinite(Number(queued.ms))) {
      const metadata={run_id:turn.run_id,route:result.route,channel:turn.channel,ms:Number(queued.ms)};
      await audit(tx,row.id,'conversation_publication',metadata);
      await audit(tx,row.id,'conversation_completed',metadata);
    }
    await audit(tx, row.id, 'agent_completed', { run_id: turn.run_id, route: result.route });
    await saveCase(tx, row);
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
    const { sender, revision, turn_seq, text, feedback_case_id, draft_publication } = job.payload;
    if (sender === 'agente' && (row.snapshot.attention_mode !== 'autoservicio' ||
      row.snapshot.revision !== revision || latestAnalyzable(row.snapshot)?.turn_seq !== turn_seq || row.snapshot.status !== 'open')) {
      await audit(tx, row.id, 'telegram_stale');
      return;
    }
    if (sender === 'sistema' && turn_seq !== undefined && row.snapshot.status !== 'open') return;
    const [contact] = await tx.query('SELECT chat_id FROM telegram_contact WHERE ref=$1 AND enabled', [row.contact_ref]);
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || !contact?.chat_id) {
      await audit(tx, row.id, process.env.DEMO_MODE === 'true' ? 'telegram_simulated' : 'telegram_unavailable');
      return;
    }
    try {
      const reply = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: contact.chat_id, text, ...(feedback_case_id ? {reply_markup:{inline_keyboard:[
            [1,2,3,4,5].map(score => ({text:String(score),callback_data:`csat:${feedback_case_id}:${score}`}))
          ]}} : {})
        }), signal: AbortSignal.timeout(3500)
      });
      const payload = await reply.json() as { ok?: boolean };
      const delivered=reply.ok && payload.ok === true;
      await audit(tx, row.id, delivered ? 'telegram_delivered' : 'telegram_failed');
      if (delivered && sender === 'asesor' && draft_publication) {
        await audit(tx,row.id,'agent_task_outcome',{...draft_publication,channel:'telegram',outcome:'qualified_success'});
      }
      if (delivered && sender === 'agente') {
        const [run] = await tx.query(`SELECT r.id,r.turn, GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-o.created_at))*1000)::integer AS ms FROM agent_run r JOIN outbox o ON o.id=r.id AND o.kind='run' WHERE r.case_id=$1 AND (r.turn->>'case_revision')::integer=$2 AND (r.turn->>'turn_seq')::integer=$3 ORDER BY o.created_at DESC LIMIT 1`,[row.id,revision,turn_seq]);
        if (run && Number.isFinite(Number(run.ms))) {
          const metadata={run_id:run.id,channel:'telegram',ms:Number(run.ms)};
          await audit(tx,row.id,'conversation_publication',metadata);
          await audit(tx,row.id,'conversation_completed',metadata);
          const [completion] = await tx.query(`SELECT metadata->>'route' AS route FROM attention_event WHERE case_id=$1 AND kind='agent_completed' AND metadata->>'run_id'=$2 ORDER BY id DESC LIMIT 1`,[row.id,run.id]);
          const messageId=job.id.startsWith('deliver:') ? job.id.slice('deliver:'.length) : '';
          const message=row.snapshot.messages.find(item=>item.id===messageId);
          const route=completion?.route;
          if (message?.citations?.length && route) {
            const terminal=route === 'consulta_planes' ? 'catalog_answer_published' : route === 'portabilidad' ? 'portability_guidance_published' : 'guidance_published';
            await audit(tx,row.id,'agent_task_outcome',{run_id:run.id,category:route,channel:'telegram',config_revision:run.turn.config_revision,outcome:'qualified_success',terminal,source:message.citations[0].id});
          }
        }
      }
    } catch {
      await audit(tx, row.id, 'telegram_pending_verification');
    }
  });
}

async function handle(job: CaseJob) {
  switch (job.kind) {
    case 'run': {
      const { row } = await runContext(db.manager, job.payload.run_id, false);
      if (!stillCurrent(row, job.payload)) return audit(db.manager, job.case_id, 'agent_stale');
      const started = Date.now();
      const promptConfig = await readRunPromptConfig(db, job.payload.config_revision);
      const spans: AgentObservation[] = [];
      observations.set(job.payload.run_id, spans);
      const result = await runner.run(job.payload).finally(() => observations.delete(job.payload.run_id));
      await project(job.payload, result);
      await audit(db.manager, job.case_id, 'agent_latency', { ms: Date.now() - started, run_id:job.payload.run_id, route:result.route });
      for (const item of spans) {
        if (item.name === 'generation.openai' || item.name === 'decision.jev' || item.name.startsWith('tool.')) {
          await audit(db.manager, job.case_id, item.name, { ...item.metadata, route:result.route, run_id:job.payload.run_id, ms: item.ended - item.started });
        }
      }
      if (await exportAgentSpan(job.payload, started, result.route, result.type, spans, promptConfig.prompt_metadata)) {
        await audit(db.manager, job.case_id, 'langfuse_exported', {run_id:job.payload.run_id});
      }
      if (redis?.isReady) {
        await redis.set(`conversation:${job.payload.conversation_id}`, JSON.stringify({ lastRun: job.payload.run_id }), { expiration: { type: 'EX', value: 86400 } }).catch(() => undefined);
      }
      break;
    }
    case 'resume': await resume(job.payload); break;
    case 'effect': {
      const started = Date.now();
      await executeAgentIntegration(db,job.case_id,job.payload.proposal_id);
      const [record] = await db.query('SELECT r.turn,p.proposal FROM retention_proposal p JOIN agent_run r ON r.id=p.run_id WHERE p.id=$1', [job.payload.proposal_id]);
      if (record && record.proposal.status === 'confirmed' && record.proposal.effect_ref) {
        const terminal = record.proposal.kind === 'support_ticket' ? 'ticket_confirmed' : 'offer_confirmed';
        const [seen] = await db.query(`SELECT EXISTS(SELECT 1 FROM attention_event WHERE case_id=$1 AND kind='agent_task_outcome' AND metadata->>'effect_id'=$2) AS found`,[job.case_id,job.payload.proposal_id]);
        if (!seen?.found) await audit(db.manager,job.case_id,'agent_task_outcome',{run_id:record.turn.run_id,category:record.proposal.kind === 'support_ticket' ? 'soporte_tecnico' : 'cancelacion',channel:record.turn.channel,config_revision:record.turn.config_revision,outcome:'qualified_success',terminal,effect_id:job.payload.proposal_id,receipt:record.proposal.effect_ref});
      }
      if (record) await exportAgentSpan(record.turn, started, 'effect', record.proposal.status, [{
        name:'effect', started, ended:Date.now(), metadata:{ status:record.proposal.status, kind:record.proposal.kind ?? 'retention_offer' }
      }]);
      break;
    }
    case 'integration': await executeIntegration(db,job.case_id,job.payload.operation_id); break;
    case 'deliver': await deliver(job); break;
    case 'ml': await predictIntent(db,job.payload); break;
    case 'ml_churn': await predictChurn(db,job.case_id,job.payload); break;
    case 'ml_label': await sendLabel(db,job.case_id,job.payload); break;
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
      } catch (error) {
        const reconcile = job.kind === 'effect' || job.kind === 'integration';
        if (job.attempts === 5) await audit(db.manager,job.case_id,'job_failed',{kind:job.kind});
        const retry = reconcile || job.attempts < 5;
        const backoff = reconcile ? Math.min(60,2 ** Math.min(job.attempts,6)) : 1;
        const retryAfter = error instanceof SimulatorFailure ? Math.min(60,error.retryAfter) : 0;
        const delay = Math.max(backoff,retryAfter);
        await db.query(`UPDATE outbox SET status=$3,lease_until=NULL,available_at=now()+$4*interval '1 second',
          error_code='execution_failed' WHERE id=$1 AND lease_token=$2`,[job.id,job.lease_token,retry ? 'queued' : 'failed',delay]);
      }
    } catch {
      logger.warn('Outbox unavailable; retrying');
      await wait(1000);
    }
  }
}
const heartbeat = setInterval(() => {
  void db.query('SELECT 1').then(() => writeFile('/tmp/claro-worker-heartbeat', new Date().toISOString())).catch(() => undefined);
}, 3000);
try {
  await Promise.all([poll(false), poll(true)]);
} finally {
  clearInterval(heartbeat);
  if (redis?.isOpen) await redis.close();
  await db.destroy();
  await context.close();
}
