import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createAgent, isModelObservation, recordQuestion, type AgentObservation } from '@claro/agent';
import { RunResult, type AgentTurn, type Citation, type RunResume } from '@claro/contracts';
import { createClient } from 'redis';
import type { DataSource } from 'typeorm';
import { audit, createDatabase, enqueue, type CaseJob } from './database.js';
import { addMessage, loadCase, saveCase, stillCurrent, latestAnalyzable, isLegacyKnowledgeWait } from './cases.js';
import { businessPorts, runContext } from './business.js';
import { integrationMcpPorts } from './integration-mcp-client.js';
import { agentProviders } from './agent-providers.js';
import { readRunPromptConfig } from './prompt-catalog.js';
import { configuredKnowledge } from './knowledge.js';
import { exportAgentSpan } from './telemetry.js';
import { executeAgentIntegration, executeIntegration } from './integration-operations.js';
import { accountVerificationPrompt } from './demo-accounts.js';
import { predictIntent, predictChurn, sendLabel } from './ml-advisory.js';
import { observeSimulators, SimulatorFailure } from './simulator-client.js';
import { runtimeSha256 } from './runtime-revision.js';

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
const observations = new Map<string, AgentObservation[]>();
const basePorts = businessPorts(db);
const ports = process.env.CRM_MCP_URL && process.env.BILLING_MCP_URL ? integrationMcpPorts(db, basePorts) : basePorts;
const runner = createAgent({
  ...ports,
  getAgentConfig: revision => readRunPromptConfig(db, revision)
}, {
  ...agentProviders(),
  knowledge: configuredKnowledge(db).adapter,
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
      if (!key.startsWith('run:')) {
        await db.query('INSERT INTO agent_checkpoint VALUES ($1,$2) ON CONFLICT DO NOTHING', [key,value]);
        return;
      }
      await db.query(`WITH saved AS (INSERT INTO agent_checkpoint VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id)
        INSERT INTO attention_event(case_id,kind,metadata)
        SELECT run.case_id,'agent_result_checkpointed',jsonb_build_object('run_id',run.id,'runtime_sha256',$4::text)
        FROM saved JOIN agent_run run ON run.id=$3`,[key,value,key.slice(4),runtimeSha256]);
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

function telegramCitationLines(citations:Citation[]) {
  const sources=new Map(citations.map(cite=>[cite.source ? `${cite.source.publication}/${cite.source.key}` : cite.id,cite]));
  return [...sources.values()].map(citation=>{
    const title=citation.title.split(' · ')[0];
    if (!citation.source || !process.env.BETTER_AUTH_URL?.startsWith('https://')) return `Fuente: ${title} · ${citation.version}`;
    const url=new URL(`/fuentes/${citation.source.publication}/${citation.source.key}`,process.env.BETTER_AUTH_URL);
    url.searchParams.set('pasaje',citation.id);
    return `Ver fuente: ${title} · ${url.href}`;
  });
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
        if (result.commercial_plan && row.handoff_pending && !isLegacyKnowledgeWait(row)) return;
        row.handoff_pending = result.pending;
        row.snapshot.handoff_reason = result.pending.slice(0,300);
        if (result.commercial_plan) {
          row.snapshot.conversation_memory={segment:result.commercial_plan.segment,selected_plan:result.commercial_plan};
          await audit(tx,row.id,'handoff_requested',{channel:turn.channel,reason:'commercial_purchase',run_id:turn.run_id});
        } else await audit(tx, row.id, 'handoff');
      }
      if (result.type==='answer' && result.conversation_memory) row.snapshot.conversation_memory=result.conversation_memory;
      if (result.route!=='consulta_planes') delete row.snapshot.conversation_memory;
      if (result.type==='answer' && result.catalog_answer && result.citations.length && isLegacyKnowledgeWait(row)) {
        row.handoff_pending=null;
        delete row.snapshot.handoff_reason;
        await audit(tx,row.id,'case_autoservice_resumed',{run_id:turn.run_id,channel:turn.channel,reason:'catalogue_confirmed'});
      }
      const text = conversationalVerification ? accountVerificationPrompt : result.type === 'answer'
        ? row.snapshot.channel === 'telegram'
          ? [result.answer, ...telegramCitationLines(result.citations)].join('\n\n')
          : result.answer
        : result.reason;
      const msg = addMessage(row, 'agente', text.slice(0, 4096), result.type === 'answer' ? result.citations : []);
      if (result.type==='answer' && result.context_question && row.snapshot.intake) {
        recordQuestion(row.snapshot.intake,result.context_question);
        await audit(tx,row.id,'case_context_question',{run_id:turn.run_id,question_id:result.context_question.id,channel:turn.channel});
      }
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
    const clarification = result.type==='answer' && result.needs_clarification===true;
    const terminal = result.type === 'answer' && !clarification && result.citations.length > 0 && turn.channel !== 'telegram' ? (result.route === 'consulta_planes' ? 'catalog_answer_published' : result.route === 'portabilidad' ? 'portability_guidance_published' : 'guidance_published') : result.type === 'card' && result.card.reason_codes.includes('retention_ineligible') && !unavailable ? 'ineligible_explained' : 'pending';
    await audit(tx, row.id, 'agent_task_outcome', {run_id:turn.run_id, category:result.route, channel:turn.channel, config_revision:turn.config_revision, outcome:terminal === 'pending' ? (result.type === 'handoff' ? 'expected_abstention' : 'pending') : 'qualified_success', terminal, source:result.type === 'answer' ? result.citations[0]?.id ?? '' : result.type === 'card' ? result.card.citations[0]?.id ?? '' : ''});
    const [queued] = await tx.query(`SELECT GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp()-created_at))*1000)::integer AS ms FROM outbox WHERE kind='run' AND payload->>'run_id'=$1 ORDER BY created_at LIMIT 1`,[turn.run_id]);
    if (turn.channel === 'web' && queued && Number.isFinite(Number(queued.ms))) {
      const metadata={run_id:turn.run_id,route:result.route,channel:turn.channel,ms:Number(queued.ms)};
      await audit(tx,row.id,'conversation_publication',metadata);
      await audit(tx,row.id,'conversation_completed',metadata);
    }
    await audit(tx, row.id, 'agent_completed', { run_id: turn.run_id, route: result.route, clarification, runtime_sha256:runtimeSha256 });
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
          const [completion] = await tx.query(`SELECT metadata->>'route' AS route,metadata->>'clarification' AS clarification FROM attention_event WHERE case_id=$1 AND kind='agent_completed' AND metadata->>'run_id'=$2 ORDER BY id DESC LIMIT 1`,[row.id,run.id]);
          const messageId=job.id.startsWith('deliver:') ? job.id.slice('deliver:'.length) : '';
          const message=row.snapshot.messages.find(item=>item.id===messageId);
          const route=completion?.route;
          if (message?.citations?.length && route && completion.clarification!=='true') {
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
      const subject = row.web_visitor_ref ?? row.contact_ref;
      if (job.payload.observed_context && job.payload.observed_context.decision!=='prepare_commercial_handoff') {
        const at=Date.now();
        const metadata=job.payload.observed_context;
        const config=await readRunPromptConfig(db,job.payload.config_revision);
        const traceSha = await exportAgentSpan(job.payload,at,'context',metadata.decision,[{name:'context',started:at,ended:at,
          metadata:{decision:metadata.decision,question_id:metadata.question_id ?? '',agent_id:'copiloto'}}],config.prompt_metadata,subject);
        if (traceSha) {
          await audit(db.manager,job.case_id,'langfuse_exported',{run_id:job.payload.run_id,trace_sha256:traceSha});
        }
        break;
      }
      if (!stillCurrent(row, job.payload)) return audit(db.manager, job.case_id, 'agent_stale');
      const started = Date.now();
      const promptConfig = await readRunPromptConfig(db, job.payload.config_revision);
      const spans: AgentObservation[] = [];
      observations.set(job.payload.run_id, spans);
      const result = await runner.run(job.payload).finally(() => observations.delete(job.payload.run_id));
      await project(job.payload, result);
      await audit(db.manager, job.case_id, 'agent_latency', { ms: Date.now() - started, run_id:job.payload.run_id, route:result.route });
      for (const item of spans) {
        if (isModelObservation(item.name) || item.name.startsWith('tool.')) {
          await audit(db.manager, job.case_id, item.name, { ...item.metadata, route:result.route, run_id:job.payload.run_id, ms: item.ended - item.started });
        }
      }
      const traceSha = await exportAgentSpan(job.payload, started, result.route, result.type, spans, promptConfig.prompt_metadata,subject);
      if (traceSha) {
        await audit(db.manager, job.case_id, 'langfuse_exported', {run_id:job.payload.run_id,trace_sha256:traceSha});
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
      const [record] = await db.query(`SELECT r.turn,p.proposal,COALESCE(c.web_visitor_ref,c.contact_ref) AS subject
        FROM retention_proposal p JOIN agent_run r ON r.id=p.run_id JOIN attention_case c ON c.id=r.case_id WHERE p.id=$1`, [job.payload.proposal_id]);
      if (record && record.proposal.status === 'confirmed' && record.proposal.effect_ref) {
        const terminal = record.proposal.kind === 'support_ticket' ? 'ticket_confirmed' : 'offer_confirmed';
        const [seen] = await db.query(`SELECT EXISTS(SELECT 1 FROM attention_event WHERE case_id=$1 AND kind='agent_task_outcome' AND metadata->>'effect_id'=$2) AS found`,[job.case_id,job.payload.proposal_id]);
        if (!seen?.found) await audit(db.manager,job.case_id,'agent_task_outcome',{run_id:record.turn.run_id,category:record.proposal.kind === 'support_ticket' ? 'soporte_tecnico' : 'cancelacion',channel:record.turn.channel,config_revision:record.turn.config_revision,outcome:'qualified_success',terminal,effect_id:job.payload.proposal_id,receipt:record.proposal.effect_ref});
      }
      if (record) await exportAgentSpan(record.turn, started, 'effect', record.proposal.status, [{
        name:'effect', started, ended:Date.now(), metadata:{ status:record.proposal.status, kind:record.proposal.kind ?? 'retention_offer' }
      }],undefined,record.subject);
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
