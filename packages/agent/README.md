# @claro/agent

`createAgent(ports, options?)` returns an `AgentRunner`. A LangGraph `StateGraph` loads the authorized case and configuration, applies the priority handoff, classifies and executes bounded routes through the server-owned ports. The default is deterministic and makes no vendor calls. Only a verified case in the advisor audience may read account data. The agent requests an internal proposal only after explicit client acceptance of an identifiable option; the platform owns approval, execution and cross-process idempotency.

Options accept `documents`, `knowledge`, a `decision` adapter, `evidenceSelector`, a `rerank` callback and a `CheckpointStore`. Filtering by scope, date, status and channel precedes lexical ranking. The optional reranker may only reorder filtered documents. The included excerpt is from the fictional CAT-2026 v1.0 fixture; production must inject its authorized, published corpus. `CheckpointStore` retains the public run result; the default is process-local. This is not a LangGraph durable checkpointer, interrupt or replay implementation. `resume` requires `effect_id` to equal the original proposal ID and reports confirmation only with an effect reference.

Optional server-only adapters require explicit keys and model IDs; no environment variable is read automatically:

```ts
import { createAgent, createJevDecisionAdapter, createOpenAIEvidenceSelector } from '@claro/agent';
const agent = createAgent(ports, {
  decision: createJevDecisionAdapter({ apiKey: process.env.OPENROUTER_API_KEY!, model: 'typesafe/jev-1.14' }),
  evidenceSelector: createOpenAIEvidenceSelector({ apiKey: process.env.OPENAI_API_KEY!, models: {
    economico: process.env.OPENAI_MODEL_ECONOMICO!, intermedio: process.env.OPENAI_MODEL_INTERMEDIO!, complejo: process.env.OPENAI_MODEL_COMPLEJO!
  } })
});
```

Enable adapters only when credentials, configured models and network access are available. Jev checks the typed decision and probability/margin thresholds; timeout, invalid response or uncertainty fall back to deterministic routing. It receives only fixed categorical signals extracted locally. The OpenAI Responses API is used to select an index among already-authorized passages, based only on fixed categorical signals; generated prose is never published. The configured profile follows a valid Jev complexity signal; otherwise it is economic. Missing models and provider failures preserve the local ranking. This is not multi-model synthesis or a budget-based escalation policy.

`createJevSemanticEvaluator(options).evaluate(observation)` is an experimental offline signal: deterministic failures block before any request; free text is reduced to a fixed generic vocabulary; uncertain answers result in `review`, and even a positive semantic judgment requires review because this filter loses meaning. It cannot promote a release. No names, arbitrary numbers, raw case text or account values are sent by these built-in adapters. The loss of detail limits classification and semantic quality, and must be evaluated on a privacy-approved dataset before operational use. Injected custom adapters must enforce their own security and privacy.

LangGraph durable checkpoints/interrupts, Redis, pgvector/hybrid search, production semantic gates, Langfuse and Deep Agents are not implemented. Do not treat these seams or the experimental judge as evidence of production readiness.
