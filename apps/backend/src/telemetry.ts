import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { isModelObservation, type AgentObservation } from '@claro/agent';
import type { AgentTurn } from '@claro/contracts';
import type { RunPromptConfig } from './prompt-catalog.js';
import { activeKnowledgeRevision } from './knowledge.js';
import { runtimeSha256 } from './runtime-revision.js';

export const traceIdentifier = (runId: string) => createHash('sha256').update(runId).digest('hex').slice(0,32);

type TraceTurn = Pick<AgentTurn,'run_id'|'conversation_id'|'channel'|'audience'|'config_revision'|'knowledge_revision'|'model_config_revision'|'model_config_digest'|'prompt_manifest_digest'>;
type TraceExchange = {input: string; output: string};

function traceText(text: string) {
  return text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[correo]')
    .replace(/\b(?:C|F)-\d+\b/gi,'[referencia]')
    .replace(/\+?\d(?:[ .()-]*\d){6,}/g,'[número]')
    .replace(/\b\d{5,6}\b/g,'[dato]')
    .slice(0,4096);
}

function stepExchange({name,metadata}: AgentObservation): Record<string,string> {
  const io = (input:object, output:object) => ({
    'langfuse.observation.input':JSON.stringify(input), 'langfuse.observation.output':JSON.stringify(output)
  });
  if (name==='conversation_context') return {'langfuse.observation.input':String(metadata.before),
    'langfuse.observation.output':String(metadata.after)};
  if (metadata.step_id==='load_case') return io({source:'case_history'},
    {messages:metadata.history_count,first_turn:metadata.first_turn_seq,last_turn:metadata.last_turn_seq});
  if (metadata.step_id==='resolve_turn') return io({decision:metadata.decision,context_route:metadata.context_route},
    {intent:metadata.intent,profile:metadata.profile,continuation:metadata.continuation});
  if (name==='model.call') return io({step:metadata.step_id,profile:metadata.profile,requested_model:metadata.requested_model},
    {provider:metadata.provider,effective_model:metadata.effective_model,status:metadata.status});
  if (name==='context.extract') return io({revision:metadata.extractor_version},
    {intent:metadata.intent,action:metadata.action,slots:metadata.slots,status:metadata.status});
  if (name==='orchestrator.delegate') return io({objectives:metadata.objectives,mode:metadata.mode},
    {findings:metadata.findings,status:metadata.status});
  if (name==='orchestrator.plan') return io({primary:metadata.primary}, {objectives:metadata.objectives,investigated:metadata.investigated});
  if (name==='retrieval' && metadata.step_id==='retrieve_knowledge') return io({source:metadata.source,tags:metadata.tags,index:metadata.index_revision},
    {count:metadata.count,passages:metadata.top_5,attempts:metadata.attempts});
  if (name==='catalogue.selection') return io({request:metadata.reference_resolution,context_route:metadata.context_route,focused:metadata.focused},
    {version:metadata.catalog_version,decision:metadata.decision,reason:metadata.reason});
  return {};
}

export async function exportAgentSpan(turn: TraceTurn, started: number, route: string, result: string,
  observations: AgentObservation[] = [], promptMetadata: RunPromptConfig['prompt_metadata'] = {}, subject?: string,
  exchange?: TraceExchange): Promise<string | false> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secret = process.env.LANGFUSE_SECRET_KEY;
  const base = process.env.LANGFUSE_BASE_URL;
  if (!publicKey || !secret || !base) return false;
  try {
    const endpoint = new URL('/api/public/otel/v1/traces', base);
    if (endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && ((endpoint.hostname === 'langfuse-web' && endpoint.port === '3000') ||
        (process.env.DEMO_MODE === 'true' && ['127.0.0.1','localhost'].includes(endpoint.hostname))))) return false;
    const traceId = traceIdentifier(turn.run_id);
    const opaqueId = (value: string) => createHmac('sha256',process.env.BETTER_AUTH_SECRET || secret).update(value).digest('hex');
    const correlation = {
      ...(turn.conversation_id ? {'langfuse.session.id':opaqueId(`langfuse:session:${turn.conversation_id}`)} : {}),
      ...(subject ? {'langfuse.user.id':opaqueId(`langfuse:user:${turn.channel}:${subject}`)} : {})
    };
    const attributes = {
      'langfuse.observation.type': 'agent',
      'langfuse.trace.name': 'claro-attention',
      'claro.channel': turn.channel,
      'claro.route': route,
      'claro.audience': turn.audience,
      'claro.result': result,
      'claro.config_revision': turn.config_revision,
      ...(turn.prompt_manifest_digest ? {'claro.prompt_manifest_digest':turn.prompt_manifest_digest} : {}),
      'claro.index_revision': turn.knowledge_revision ?? activeKnowledgeRevision(),
      ...(turn.model_config_revision ? {'claro.model_config_revision':turn.model_config_revision} : {}),
      ...(turn.model_config_digest ? {'claro.model_config_digest':turn.model_config_digest} : {}),
      'claro.runtime_sha256': runtimeSha256
    };
    const root = createHash('sha256').update(`root:${turn.run_id}`).digest('hex').slice(0,16);
    const content: Record<string,string> = exchange && turn.channel==='web' && turn.audience==='cliente' &&
      process.env.DEMO_MODE==='true' && process.env.LANGFUSE_CAPTURE_CHAT_IO==='true' ? {
        'langfuse.observation.input':JSON.stringify(traceText(exchange.input)),
        'langfuse.observation.output':JSON.stringify(traceText(exchange.output))
      } : {};
    const span = (spanId: string, name: string, from: number, to: number, metadata: Record<string,string|number>, parentSpanId?: string) => ({
      traceId, spanId, name, kind: 1, ...(parentSpanId ? { parentSpanId } : {}),
      startTimeUnixNano: String(BigInt(from) * 1_000_000n),
      endTimeUnixNano: String(BigInt(to) * 1_000_000n),
      attributes: Object.entries({...metadata,...correlation}).map(([key, value]) => ({
        key, value: typeof value === 'number'
          ? Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
          : { stringValue: value }
      }))
    });
    const rootSpans = observations.every(item => item.name === 'effect') && observations.length ? [] : [
      span(root, 'attention.run', started, Date.now(), { ...attributes, 'langfuse.trace.metadata.run_id':turn.run_id, ...content })
    ];
    const steps = observations.map(item => {
      const externalModel = isModelObservation(item.name);
      const metadata: Record<string,string|number> = {
        'langfuse.observation.type': externalModel ? 'generation'
          : item.name.startsWith('tool.') ? 'tool' : item.name === 'retrieval' ? 'retriever' : 'span',
        ...Object.fromEntries(Object.entries(item.metadata).filter(([key])=>item.name!=='conversation_context' || key==='step_id')
          .map(([key,value]) => [`claro.${key}`,value])),
        ...stepExchange(item)
      };
      if (item.name === 'tool.list_catalog_plans' || item.name === 'catalogue.selection') {
        for (const key of ['reference_resolution','catalog_version','decision','reason'] as const) {
          const value = item.metadata[key];
          if (typeof value==='string') metadata[`langfuse.observation.metadata.${key}`] = value;
        }
      }
      const promptRef = String(item.metadata.prompt_ref ?? (item.name === 'generation.openai' ? 'public_answer' : ''));
      const prompt = promptMetadata[promptRef];
      if (prompt) {
        metadata['claro.prompt_ref'] = promptRef;
        metadata['claro.prompt_sha256'] = prompt.sha256;
        metadata['claro.prompt_source'] = prompt.source;
        metadata['langfuse.observation.metadata.prompt_ref'] = promptRef;
        if (prompt.version !== null) {
          metadata['langfuse.observation.prompt.name'] = prompt.name;
          metadata['langfuse.observation.prompt.version'] = prompt.version;
        }
      }
      if (externalModel) {
        const {model,input_tokens,output_tokens,cost_usd}=item.metadata;
        if (typeof model==='string' && model) metadata['langfuse.observation.model.name']=model;
        if (typeof input_tokens==='number' || typeof output_tokens==='number') {
          metadata['langfuse.observation.usage_details']=JSON.stringify({input:input_tokens,output:output_tokens});
        }
        if (typeof cost_usd==='number') metadata['langfuse.observation.cost_details']=JSON.stringify({total:cost_usd});
      }
      return span(randomBytes(8).toString('hex'), item.name, item.started, item.ended, metadata, root);
    });
    const payload = JSON.stringify({resourceSpans:[{
      resource:{attributes:[{key:'service.name',value:{stringValue:'claro-worker'}}]},
      scopeSpans:[{scope:{name:'claro-attention'},spans:[...rootSpans,...steps]}]
    }]});
    const send = () => fetch(endpoint, {
      method: 'POST', signal: AbortSignal.timeout(1500), redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Langfuse-Ingestion-Version': '4',
        Authorization: `Basic ${Buffer.from(`${publicKey}:${secret}`).toString('base64')}` },
      body: payload
    });
    // Keep the same trace and span IDs if the collector temporarily fails to acknowledge the batch.
    let response = await send().catch(() => null);
    if (!response || response.status >= 500) response = await send();
    if (!response.ok) return false;
    const body = (await response.text()).trim();
    const ack = (body ? JSON.parse(body) : {}) as {
      partialSuccess?: { rejectedSpans?: number | string };
      partial_success?: { rejected_spans?: number | string };
    };
    if (!ack || typeof ack !== 'object' || Array.isArray(ack)) return false;
    const rejected = ack.partialSuccess?.rejectedSpans ?? ack.partial_success?.rejected_spans;
    return rejected === undefined || rejected === 0 || rejected === '0'
      ? createHash('sha256').update(payload).digest('hex') : false;
  } catch {
    return false;
  }
}

const Offline = z.object({
  metrics: z.object({ macro_f1: z.number(), baseline_macro_f1: z.number(), cancelacion_recall: z.number() }),
  rows: z.number().int().positive().optional()
});
const MlMetrics = z.object({
  classes: z.array(z.object({label:z.string(),count:z.number()})).optional(),
  groups: z.array(z.object({
    model_version: z.string(), channel: z.string(), count: z.number(), labels_count: z.number(),
    drift: z.object({ status: z.string() }).optional(), p95_latency_ms: z.number()
  })),
  offline: Offline.nullable(),
  deployment: z.object({
    model_version: z.string(), run_id: z.string().optional(), experiment_id: z.string().optional(), algorithm:z.string().optional()
  }).nullable().optional(),
  churn: z.object({
    model_version: z.string(),
    training_cohort: z.string(), run_id:z.string().optional(), experiment_id:z.string().optional(), algorithm:z.string().optional(),
    offline: z.object({
      metrics: z.object({ roc_auc: z.number(), recall_at_20: z.number() }),
      holdout: z.object({ size: z.number(), positives: z.number(), top_20_reviewed: z.number(), top_20_captured: z.number().optional() })
    })
  }).nullable().optional()
});

export async function readModelMetrics(days = 7) {
  const base = process.env.ML_API_URL;
  const token = process.env.ML_SERVICE_TOKEN;
  if (!base || !token) return null;
  try {
    const response = await fetch(new URL('/internal/v1/model-metrics?days='+days, base), {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(850)
    });
    return response.ok ? MlMetrics.parse(await response.json()) : null;
  } catch {
    return null;
  }
}
