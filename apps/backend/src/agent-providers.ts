import { createOpenAIEvidenceSelector, createOpenAIObjectivePlanner, createOpenAIPublicWriter, objectSchema, requestModel } from '@claro/agent';
import type { ModelOption, ModelTuning } from '@claro/contracts';

export function modelCredentials(env=process.env) {
  return {
    openai:env.OPENAI_API_KEY,
    openrouter:env.OPENROUTER_API_KEY,
    lmstudio:env.LM_STUDIO_ENABLED==='true' ? env.LM_STUDIO_API_TOKEN || 'local-docker' : undefined
  };
}

export function agentProviders(env = process.env) {
  const live = env.AGENT_PROVIDERS === 'live';
  const openaiKey = live ? env.OPENAI_API_KEY : undefined;
  const keys = modelCredentials(env);
  const turnTimeoutMs = Number(env.AGENT_TURN_TIMEOUT_MS);
  return {
    requireApprovedPrompts: live,
    modelCredentials: live ? keys : keys.lmstudio ? {lmstudio:keys.lmstudio} : undefined,
    turnTimeoutMs: Number.isSafeInteger(turnTimeoutMs) && turnTimeoutMs > 0 ? turnTimeoutMs : undefined,
    writer: openaiKey ? createOpenAIPublicWriter({ apiKey: openaiKey }) : undefined,
    planner: openaiKey ? createOpenAIObjectivePlanner(openaiKey) : undefined,
    evidenceSelector: openaiKey ? createOpenAIEvidenceSelector({
      apiKey: openaiKey,
      models: { economico: 'gpt-6-luna', intermedio: 'gpt-6.1-terra', complejo: 'gpt-6.2-sol' }
    }) : undefined
  };
}

export async function probeModel(model:ModelOption,key:string,tuning?:ModelTuning) {
  try {
    const reply=await requestModel(model,key,'Devuelve exactamente el valor de entrada en el campo resultado.',
      '{"resultado":"claro-validacion"}',objectSchema({resultado:{type:'string'}}),tuning?.max_output_tokens ?? 400,model.provider==='lmstudio' ? 10000 : 6500,fetch,tuning);
    return (reply.value as {resultado?:unknown}|null)?.resultado==='claro-validacion' ? '' : 'salida_estructurada_incompatible';
  } catch (error) {
    return error instanceof Error && /^http_\d+$/.test(error.message) ? error.message : 'proveedor_no_disponible';
  }
}
