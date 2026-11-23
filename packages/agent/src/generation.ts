import type { Citation } from '@claro/contracts';

export type Profile = 'economico' | 'intermedio' | 'complejo';
export type AgentObservation = {
  name: 'retrieval' | 'decision.jev' | 'generation.openai' | 'effect' | `tool.${string}`;
  started: number;
  ended: number;
  metadata: Record<string, string | number>;
};
export type Observe = (observation: AgentObservation) => void;
export type Draft = { answer: string; citations: Citation[] };
export interface PublicWriter {
  write(topic: string, sources: Citation[], profile: Profile, prompt: string, observe?: Observe): Promise<Draft | null>;
}

const profiles = {
  economico: { model: 'gpt-6-luna', effort: 'none', input: 0.10, output: 0.50 },
  intermedio: { model: 'gpt-6.1-terra', effort: 'low', input: 1, output: 5 },
  complejo: { model: 'gpt-6.2-sol', effort: 'low', input: 2, output: 10 }
};
const alternate: Record<Profile, Profile> = { economico: 'intermedio', intermedio: 'complejo', complejo: 'intermedio' };

function numbers(text: string) {
  return [...text.matchAll(/\d+(?:[.,:/-]\d+)*(?:\s*%)?/g)].map(match => match[0].replace(/\s+/g, ''));
}

export function validateDraft(value: unknown, sources: Citation[]): Draft | null {
  if (!value || typeof value !== 'object') return null;
  const { answer, citation_ids } = value as { answer?: unknown; citation_ids?: unknown };
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 1000 || !Array.isArray(citation_ids)
    || citation_ids.length === 0 || citation_ids.length > 3 || new Set(citation_ids).size !== citation_ids.length
    || /https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|<[^>]*>/i.test(answer)) return null;
  const citations: Citation[] = [];
  for (const id of citation_ids) {
    const source = sources.find(citation => citation.id === id);
    if (!source) return null;
    citations.push(source);
  }
  const supported = new Set(citations.flatMap(citation => numbers(citation.excerpt)));
  if (numbers(answer).some(number => !supported.has(number))) return null;
  return { answer: answer.trim(), citations };
}

type Usage = { input_tokens?: number; output_tokens?: number };
type ResponseBody = { status?: string; model?: string; usage?: Usage; output?: { type?: string; content?: { type?: string; text?: string }[] }[] };

export function createOpenAIPublicWriter(options: { apiKey: string; fetch?: typeof fetch }): PublicWriter {
  return { async write(topic, sources, profile, prompt, observe) {
    const instructions = prompt.trim();
    if (!sources.length || !instructions) return null;
    const deadline = Date.now() + 5700;
    const input = JSON.stringify({ tema: topic.slice(0, 512),
      pasajes: sources.slice(0, 3).map(({ id,title,excerpt }) => ({ id,title,extracto:excerpt.slice(0, 1400) })) });
    const maxOutput = 480;
    let reserved = 0;
    for (const level of [profile, alternate[profile]]) {
      const remaining = deadline - Date.now();
      const spec = profiles[level];
      // UTF-8 bytes plus framing are a conservative input-token allowance.
      const upper = ((new TextEncoder().encode(input + instructions).length + 512) * spec.input + maxOutput * spec.output) / 1e6;
      if (remaining < 350 || reserved + upper > 0.02) break;
      reserved += upper;
      const started = Date.now();
      let status = 'unavailable';
      let used: Record<string, number> = {};
      try {
        const response = await (options.fetch ?? fetch)('https://api.openai.com/v1/responses', {
          method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(Math.min(remaining, 3600)),
          body: JSON.stringify({ model: spec.model, store: false, reasoning: { effort: spec.effort },
            max_output_tokens: maxOutput, instructions, input,
            text: { format: { name: 'claro_answer', type: 'json_schema', strict: true,
              schema: { type: 'object', properties: { answer: { type: 'string' }, citation_ids: { type: 'array', items: { type: 'string' } } },
                required: ['answer','citation_ids'], additionalProperties: false } } }
          })
        });
        status = String(response.status);
        if (!response.ok) {
          if (response.status !== 429 && response.status < 500) break;
          continue;
        }
        const body: ResponseBody = await response.json();
        const incoming = body.usage?.input_tokens ?? 0, outgoing = body.usage?.output_tokens ?? 0;
        used = { input_tokens: incoming, output_tokens: outgoing, cost_usd: (incoming * spec.input + outgoing * spec.output) / 1e6 };
        const values = body.output?.filter(x => x.type === 'message').flatMap(x => x.content ?? []).filter(x => x.type === 'output_text');
        const modelMatch = body.model === spec.model || body.model?.startsWith(`${spec.model}-`);
        const draft = modelMatch && body.status === 'completed' && values?.length === 1 && values[0].text
          ? validateDraft(JSON.parse(values[0].text), sources) : null;
        status = draft ? 'accepted' : 'invalid';
        if (draft) return draft;
      } catch {
        status = 'invalid_or_timeout';
      } finally {
        observe?.({ name: 'generation.openai', started, ended: Date.now(), metadata: { ...used, model: spec.model, status } });
      }
    }
    return null;
  } };
}
