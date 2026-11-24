import type { JevCaseResult, LangfuseEvaluations } from '@claro/contracts';
import { z } from 'zod';
import { browserEndpoint } from './dashboard.js';
import { createLangfuseConnection } from './langfuse-prompts.js';

const datasetName = 'claro-llamadas-v1';
const nativeRunPrefix = 'llamadas-v1-jev-native-';
const requiredChoices = z.enum(['completo', 'parcial', 'ausente']);
const forbiddenChoices = z.enum(['limpio', 'dudoso', 'infraccion']);

const dataset = z.object({ id: z.string() });
const experiment = z.object({
  id: z.string(), name: z.string(), startTime: z.iso.datetime(), itemCount: z.number().int().nonnegative()
});
const score = z.object({
  name: z.string(), source: z.string(), dataType: z.string(), value: z.unknown(), timestamp: z.iso.datetime()
});
const item = z.object({
  traceId: z.string(), experimentItemId: z.string(), scores: z.array(score).nullish()
});
const page = <T extends z.ZodType>(row: T) => z.object({
  data: z.array(row), meta: z.object({ cursor: z.string().nullish() })
});

function resultFor(row: z.infer<typeof item>, projectUrl: string | null): JevCaseResult {
  const scores = (row.scores ?? []).filter(({ source, dataType }) => source === 'EVAL' && dataType === 'CATEGORICAL')
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const required = requiredChoices.safeParse(scores.find(s => s.name === 'jev_native_required')?.value).data ?? null;
  const forbidden = forbiddenChoices.safeParse(scores.find(s => s.name === 'jev_native_forbidden')?.value).data ?? null;
  let verdict: JevCaseResult['verdict'] = 'pending';
  if (required && forbidden) {
    if (required === 'ausente' || forbidden === 'infraccion') verdict = 'failed';
    else if (required === 'completo' && forbidden === 'limpio') verdict = 'passed';
    else verdict = 'review';
  }
  return {
    id: row.experimentItemId.replace(datasetName + '-', ''),
    trace_url: projectUrl && `${projectUrl}/traces/${encodeURIComponent(row.traceId)}`,
    required, forbidden, verdict
  };
}

export async function readLangfuseEvaluations(experimentId?: string): Promise<LangfuseEvaluations> {
  const env = process.env;
  const ui = browserEndpoint(env.LANGFUSE_UI_URL);
  const projectUrl = ui && `${ui}/project/${encodeURIComponent(env.LANGFUSE_PROJECT_ID || 'claro-copiloto')}`;
  const empty: LangfuseEvaluations = {
    dataset_url: null, evaluator_url: projectUrl && `${projectUrl}/evals`, runs: [], selected_id: null, cases: []
  };
  const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_BASE_URL: endpoint } = env;
  if (!publicKey && !secretKey && !endpoint) return empty;
  if (!publicKey || !secretKey || !endpoint) throw new Error('langfuse_not_configured');
  const { base, authorization } = createLangfuseConnection({
    publicKey, secretKey, base: endpoint, demo: env.DEMO_MODE === 'true'
  });
  const signal = AbortSignal.timeout(12000);
  async function read(path: string, query: Record<string, string> = {}) {
    const url = new URL('/api/public/' + path, base);
    url.search = new URLSearchParams(query).toString();
    return fetch(url, { headers: { Authorization: authorization }, redirect: 'error', signal });
  }
  async function list<T extends z.ZodType>(path: string, schema: T, query: Record<string, string>) {
    const data: z.infer<T>[] = [];
    let cursor: string | null | undefined;
    do {
      const response = await read(path, { ...query, ...(cursor ? { cursor } : {}) });
      if (!response.ok) throw new Error('langfuse_request_failed');
      const batch = page(schema).parse(await response.json());
      data.push(...batch.data);
      cursor = batch.meta.cursor;
    } while (cursor);
    return data;
  }
  const response = await read('v2/datasets/' + datasetName);
  if (response.status === 404) return empty;
  if (!response.ok) throw new Error('langfuse_request_failed');
  const { id: datasetId } = dataset.parse(await response.json());
  const fromStartTime = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const experiments = await list('experiments', experiment, { datasetId, fromStartTime, fields: 'core', limit: '100' });
  const runs = experiments.filter(row => row.name.startsWith(nativeRunPrefix))
    .map(row => ({ id: row.id, name: row.name, started_at: row.startTime, cases: row.itemCount }))
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const selected = runs.find(row => row.id === experimentId) ?? runs[0];
  const items = selected ? await list('experiment-items', item, {
    experimentId: selected.id, fromStartTime: selected.started_at, fields: 'core,scores', limit: '100'
  }) : [];
  return {
    ...empty,
    dataset_url: projectUrl && `${projectUrl}/datasets/${encodeURIComponent(datasetId)}/experiments`,
    runs, selected_id: selected?.id ?? null,
    cases: items.map(row => resultFor(row, projectUrl)).sort((a, b) => a.id.localeCompare(b.id))
  };
}
