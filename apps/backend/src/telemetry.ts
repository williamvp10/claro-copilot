import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AgentObservation } from '@claro/agent';
import type { AgentTurn } from '@claro/contracts';
import type { RunPromptConfig } from './prompt-catalog.js';

export const traceIdentifier = (runId: string) => createHash('sha256').update(runId).digest('hex').slice(0,32);

export async function exportAgentSpan(turn: AgentTurn, started: number, route: string, result: string, observations: AgentObservation[] = [], promptMetadata: RunPromptConfig['prompt_metadata'] = {}) {
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
    const attributes = {
      'langfuse.observation.type': 'agent',
      'langfuse.trace.name': 'claro-attention',
      'claro.channel': turn.channel,
      'claro.route': route,
      'claro.audience': turn.audience,
      'claro.result': result,
      'claro.config_revision': turn.config_revision
    };
    const root = createHash('sha256').update(`root:${turn.run_id}`).digest('hex').slice(0,16);
    const span = (spanId: string, name: string, from: number, to: number, metadata: Record<string,string|number>, parentSpanId?: string) => ({
      traceId, spanId, name, kind: 1, ...(parentSpanId ? { parentSpanId } : {}),
      startTimeUnixNano: String(BigInt(from) * 1_000_000n),
      endTimeUnixNano: String(BigInt(to) * 1_000_000n),
      attributes: Object.entries(metadata).map(([key, value]) => ({
        key, value: typeof value === 'number'
          ? Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
          : { stringValue: value }
      }))
    });
    const rootSpans = observations.every(item => item.name === 'effect') && observations.length ? [] : [
      span(root, 'attention.run', started, Date.now(), { ...attributes, 'langfuse.trace.metadata.run_id':turn.run_id })
    ];
    const steps = observations.map(item => {
      const metadata: Record<string,string|number> = {
        'langfuse.observation.type': item.name === 'generation.openai' ? 'generation'
          : item.name.startsWith('tool.') ? 'tool' : item.name === 'retrieval' ? 'retriever' : 'span',
        ...Object.fromEntries(Object.entries(item.metadata).map(([key,value]) => [`claro.${key}`,value]))
      };
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
      if (item.name === 'generation.openai') {
        metadata['langfuse.observation.model.name'] = String(item.metadata.model ?? '');
        metadata['langfuse.observation.usage_details'] = JSON.stringify({input:item.metadata.input_tokens ?? 0,output:item.metadata.output_tokens ?? 0});
        metadata['langfuse.observation.cost_details'] = JSON.stringify({total:item.metadata.cost_usd ?? 0});
      }
      return span(randomBytes(8).toString('hex'), item.name, item.started, item.ended, metadata, root);
    });
    const response = await fetch(endpoint, {
      method: 'POST', signal: AbortSignal.timeout(1500), redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Langfuse-Ingestion-Version': '4',
        Authorization: `Basic ${Buffer.from(`${publicKey}:${secret}`).toString('base64')}` },
      body: JSON.stringify({resourceSpans:[{
        resource:{attributes:[{key:'service.name',value:{stringValue:'claro-worker'}}]},
        scopeSpans:[{scope:{name:'claro-attention'},spans:[...rootSpans,...steps]}]
      }]})
    });
    if (!response.ok) return false;
    const body = (await response.text()).trim();
    if (!body) return true;
    const ack = JSON.parse(body) as {
      partialSuccess?: { rejectedSpans?: number | string };
      partial_success?: { rejected_spans?: number | string };
    };
    if (!ack || typeof ack !== 'object' || Array.isArray(ack)) return false;
    const rejected = ack.partialSuccess?.rejectedSpans ?? ack.partial_success?.rejected_spans;
    return rejected === undefined || rejected === 0 || rejected === '0';
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
