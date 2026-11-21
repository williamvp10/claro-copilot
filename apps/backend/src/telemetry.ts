import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AgentTurn } from '@claro/contracts';

export async function exportAgentSpan(turn: AgentTurn, started: number, route: string, result: string) {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secret = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secret) return false;
  try {
    const endpoint = new URL('/api/public/otel/v1/traces', process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com');
    if (endpoint.protocol !== 'https:') return false;
    const traceId = createHash('sha256').update(turn.run_id).digest('hex').slice(0, 32);
    const attributes = {
      'langfuse.observation.type': 'agent',
      'langfuse.trace.name': 'claro-attention',
      'claro.channel': turn.channel,
      'claro.route': route,
      'claro.audience': turn.audience,
      'claro.result': result,
      'claro.config_revision': turn.config_revision
    };
    const response = await fetch(endpoint, {
      method: 'POST', signal: AbortSignal.timeout(1000),
      headers: { 'Content-Type': 'application/json', 'X-Langfuse-Ingestion-Version': '4',
        Authorization: `Basic ${Buffer.from(`${publicKey}:${secret}`).toString('base64')}` },
      body: JSON.stringify({resourceSpans:[{
        resource:{attributes:[{key:'service.name',value:{stringValue:'claro-worker'}}]},
        scopeSpans:[{scope:{name:'claro-attention'},spans:[{
          traceId, spanId:randomBytes(8).toString('hex'), name:'attention.run', kind:1,
          startTimeUnixNano:String(BigInt(started) * 1_000_000n),
          endTimeUnixNano:String(BigInt(Date.now()) * 1_000_000n),
          attributes:Object.entries(attributes).map(([key, stringValue]) => ({key,value:{stringValue}}))
        }]}]
      }]})
    });
    return response.ok;
  } catch {
    return false;
  }
}

const Offline = z.object({
  metrics: z.object({ macro_f1: z.number(), baseline_macro_f1: z.number(), cancelacion_recall: z.number() })
});
const MlMetrics = z.object({
  groups: z.array(z.object({
    model_version: z.string(), count: z.number(), labels_count: z.number(),
    drift: z.object({ status: z.string() }).optional(), p95_latency_ms: z.number()
  })),
  offline: Offline.nullable()
});

export async function readModelMetrics() {
  const base = process.env.ML_API_URL;
  const token = process.env.ML_SERVICE_TOKEN;
  if (!base || !token) return null;
  try {
    const response = await fetch(new URL('/internal/v1/model-metrics?days=7', base), {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(850)
    });
    return response.ok ? MlMetrics.parse(await response.json()) : null;
  } catch {
    return null;
  }
}
