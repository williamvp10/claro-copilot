import type { Intent } from '@claro/contracts';
import { openAIUsage, type Observe } from './generation.js';

export const cancellationRequest = /\b(?:cancel\w*|retir\w*|dar (?:de )?baja|terminar (?:el|mi) (?:plan|contrato|servicio))\b/;
export const alternativePlan = /\b(?:cambiarme?|pasarme?|buscar|quiero|prefiero|ver)\b[^.!?]{0,55}\b(?:otro plan|un plan|plan mas|planes mas)\b/;
export const changeOfGoal = /\b(?:ya no|mejor|en vez de|ahora prefiero|cambie de opinion)\b/;
export const portabilityRequest = /\b(?:portabilidad|portab\w*|portar\w*|mismo numero|conserv\w* (?:mi|el) numero|mant\w* (?:mi|el) numero)\b/;

export function requestsInvoiceCancellation(text: string) {
  const value=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const action=/\b(?:cancel(?:ar|en|es|a)|anul(?:ar|en|es|a)|dar de baja|(?:cancelacion|anulacion) de)\s+(?:(?:mi|mis|la|las|el|los|esta|estas|este|estos)\s+)?(?:ultim[ao]s?\s+)?(?:facturas?|recibos?)\b/;
  return action.test(value) && !/\b(?:no (?:quiero |necesito |deseo )?|evitar |sin )(?:cancel(?:ar|en|es|a)|anul(?:ar|en|es|a)|dar de baja)\b/.test(value);
}

export function changesCancellationToPlan(text: string) {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return changeOfGoal.test(normalized) && alternativePlan.test(normalized);
}

export interface ObjectivePlanner {
  order(objectives: Intent[], audience: 'cliente' | 'asesor', prompt: string, observe: Observe): Promise<Intent[] | null>;
}

export function validObjectiveOrder(value: unknown, expected: Intent[]): value is Intent[] {
  return Array.isArray(value) && value.length === expected.length &&
    new Set(value).size === expected.length && expected.every(intent => value.includes(intent));
}

export function createOpenAIObjectivePlanner(apiKey: string, fetcher = fetch): ObjectivePlanner {
  return {
    async order(objectives, audience, prompt, observe) {
      const started = Date.now();
      const model = 'gpt-6-luna';
      let servedModel=model;
      let status = 'unavailable';
      let usage = {};
      try {
        const response = await fetcher('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(1800),
          body: JSON.stringify({
            model, store: false, reasoning: { effort: 'none' }, instructions: prompt,
            input: JSON.stringify({ objectives, audience }),
            max_output_tokens: 128,
            text: { format: { type: 'json_schema', name: 'objective_order', strict: true, schema: {
              type: 'object', properties: { order: { type: 'array', items: { type: 'string', enum: objectives } } },
              required: ['order'], additionalProperties: false
            } } }
          })
        });
        if (!response.ok) {
          status = `http_${response.status}`;
          return null;
        }
        const body = await response.json();
        if (typeof body.model==='string' && (body.model===model || body.model.startsWith(`${model}-`))) servedModel=body.model;
        usage = openAIUsage(body.usage,model);
        const messages = body.output?.filter((item: { type: string }) => item.type === 'message') ?? [];
        const order = JSON.parse(messages[0]?.content?.[0]?.text ?? '{}').order;
        status = body.status === 'completed' && validObjectiveOrder(order, objectives) ? 'accepted' : 'invalid';
        return status === 'accepted' ? order : null;
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') status = 'timeout';
        return null;
      } finally {
        observe({ name: 'decision.objectives', started, ended: Date.now(), metadata: {
          status, model:servedModel, ...usage, agent_id: 'copiloto', step_id: 'plan_objectives', prompt_ref: 'agent_objectives'
        } });
      }
    }
  };
}
