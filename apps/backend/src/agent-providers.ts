import { createOpenAIEvidenceSelector, createOpenAIObjectivePlanner, createOpenAIPublicWriter } from '@claro/agent';

export function agentProviders(env = process.env) {
  const live = env.AGENT_PROVIDERS === 'live';
  const openaiKey = live ? env.OPENAI_API_KEY : undefined;
  const turnTimeoutMs = Number(env.AGENT_TURN_TIMEOUT_MS);
  return {
    requireApprovedPrompts: live,
    turnTimeoutMs: Number.isSafeInteger(turnTimeoutMs) && turnTimeoutMs > 0 ? turnTimeoutMs : undefined,
    writer: openaiKey ? createOpenAIPublicWriter({ apiKey: openaiKey }) : undefined,
    planner: openaiKey ? createOpenAIObjectivePlanner(openaiKey) : undefined,
    evidenceSelector: openaiKey ? createOpenAIEvidenceSelector({
      apiKey: openaiKey,
      models: { economico: 'gpt-6-luna', intermedio: 'gpt-6.1-terra', complejo: 'gpt-6.2-sol' }
    }) : undefined
  };
}
