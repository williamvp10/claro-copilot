import { z } from 'zod';

export const Id = z.string().trim().min(1).max(128);
export const Text = z.string().trim().min(1).max(4096);
export const Intent = z.enum(['soporte_tecnico', 'facturacion', 'consulta_planes', 'cancelacion', 'portabilidad']);
export type Intent = z.infer<typeof Intent>;
export const Role = z.enum(['asesor', 'admin']);
export const Channel = z.enum(['telegram', 'web', 'whatsapp', 'voice']);
export const Actor = z.enum(['cliente', 'asesor', 'agente']);
export const AttentionMode = z.enum(['autoservicio', 'asistido']);
export const Audience = z.enum(['cliente', 'asesor']);
export const Citation = z.object({ id: Id, title: z.string(), excerpt: z.string(), version: z.string(), url: z.string().optional() });
export type Citation = z.infer<typeof Citation>;
export const KnowledgeDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const KnowledgeSourceKey = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const KnowledgeLabQuery = z.object({
  question: z.string().trim().min(3).max(1024),
  audience: Audience,
  channel: z.enum(['web','telegram']),
  business_date: z.iso.date(),
  mode: z.enum(['extractive','openai'])
}).strict();
export type KnowledgeLabQuery = z.infer<typeof KnowledgeLabQuery>;
export type KnowledgeSourceSummary = {
  key:string; file_name:string|null; title:string; sha256:string; version:string|null;
  scope:'public'|'advisor'|null; type:string|null; effective_from:string|null; effective_to:string|null;
  passage_count:number|null; original:'available'|'missing'|'mismatch';
};
export type KnowledgePublication = {
  sha256:string; stage:'initial'|'current'; published_at:string; count:number; files:KnowledgeSourceSummary[];
};
export type KnowledgeInventory = {
  publications:KnowledgePublication[]; business_date:string; live_available:boolean; indexed_count:number;
};
export type KnowledgePassage = { id:string; version:string; excerpt_sha256:string; citation:Citation|null };
export type KnowledgeLabResult = {
  run_id:string; revision:string|null; mode:'extractive'|'openai'|null;
  reason:'no_evidence'|'retrieval_unavailable'|'generation_disabled'|'generation_fallback'|null;
  transport:'mcp'|'postgres'; pgvector:boolean; latency_ms:number; retrieval_ms:number;
  answer:string|null; retrieved:Citation[]; citations:Citation[];
};
export const Fact = z.object({ id: Id, label: z.string(), value: z.string() });
export type Fact = z.infer<typeof Fact>;
export const Message = z.object({
  id: Id, turn_seq: z.number().int().positive(), actor: Actor, text: Text,
  created_at: z.iso.datetime(), citations: z.array(Citation).optional(), verification_input: z.literal(true).optional()
});
export type Message = z.infer<typeof Message>;
export const Proposal = z.object({
  id: Id, revision: z.number().int().positive(), title: z.string(), detail: z.string(),
  status: z.enum(['pending_approval', 'approved', 'confirmed', 'rejected', 'expired', 'pending_verification']),
  effect_ref: Id.optional(), kind: z.enum(['retention_offer','support_ticket']).optional()
});
export type Proposal = z.infer<typeof Proposal>;
export const AdvisorCard = z.object({
  intent: Intent.nullable(), summary: z.string(), facts: z.array(Fact), citations: z.array(Citation),
  pending: z.array(z.string()), next_action: z.string(), reason_codes: z.array(z.string()), suggested_escalation: z.object({destination:z.enum(['soporte_tecnico','supervision']),reason_code:z.string().min(3).max(120)}).optional(), advisor_draft: z.string().optional(), advisor_draft_run_id: z.string().optional(),
  advisor_draft_case_revision: z.number().int().positive().optional(), advisor_draft_turn_seq: z.number().int().positive().optional(),
  advisor_draft_status: z.enum(['current','stale']).optional(), handoff_summary: z.string().optional(), proposal: Proposal.optional()
});
export type AdvisorCard = z.infer<typeof AdvisorCard>;
export const CaseSummary = z.object({
  id: Id, conversation_id: Id, display_name: z.string(), channel: Channel,
  attention_mode: AttentionMode, owner_id: Id.nullable(), verified: z.boolean(),
  status: z.enum(['open', 'closed']), revision: z.number().int().positive(),
  updated_at: z.iso.datetime(), last_message: z.string().nullable()
});
export type CaseSummary = z.infer<typeof CaseSummary>;
export const CaseMlSignals = z.object({
  intent: z.object({
    prediction_id:Id, turn_id:Id, case_revision:z.number().int().positive(), label:Intent, model_version:Id,
    recommendation:z.enum(['confirm_cancellation_intent','suggest_intent_for_review','clarify_intent']),
    requires_human_confirmation:z.literal(true),
    feedback:z.object({label:Intent,synchronized:z.boolean()}).nullable().optional()
  }).nullable(),
  churn: z.discriminatedUnion('status',[
    z.object({status:z.literal('unavailable')}),
    z.object({status:z.literal('available'),priority:z.enum(['alta','media','habitual']),
      recommendation:z.enum(['review_retention_followup','check_unresolved_issues','standard_followup']),
      fecha_corte:z.iso.date(),model_version:Id,synthetic:z.boolean().optional()})
  ]),
  follow_up: z.object({status:z.enum(['agreed','completed']),due_date:z.iso.date(),responsible_name:z.string()}).nullable().optional()
});
export type CaseMlSignals = z.infer<typeof CaseMlSignals>;
export const CaseSnapshot = CaseSummary.extend({
  tracking: z.object({
    owner_name:z.string().nullable(), level:z.enum(['n1','n2','supervisor']).nullable(),
    escalation:z.object({
      id:Id, destination:z.enum(['soporte_tecnico','facturacion','comercial_portabilidad','supervision']),
      reason_code:z.string(), status:z.enum(['en_cola','tomado','resuelto','cancelado']),
      queued_seconds:z.number().int().nonnegative(), updated_at:z.iso.datetime()
    }).nullable(),
    events:z.array(z.object({kind:z.string(),at:z.iso.datetime()})),
    receipts:z.array(z.object({kind:z.string(),reference:Id}))
  }).optional(),
  ml: CaseMlSignals.optional(),
  messages: z.array(Message), card: AdvisorCard.nullable(), cursor: z.number().int().nonnegative()
});
export type CaseSnapshot = z.infer<typeof CaseSnapshot>;
export const CaseEvent = z.object({ type: z.literal('case.updated'), cursor: z.number().int().positive(), snapshot: CaseSnapshot });
export type CaseEvent = z.infer<typeof CaseEvent>;
export const WebChatSnapshot = CaseSnapshot.pick({
  conversation_id: true, attention_mode: true, status: true, messages: true, cursor: true
}).extend({
  awaiting_advisor: z.boolean(),
  verification: z.discriminatedUnion('stage', [
    z.object({ stage: z.literal('idle') }),
    z.object({ stage: z.literal('required') }),
    z.object({ stage: z.literal('code_sent'), challenge_id: z.uuid() }),
    z.object({ stage: z.literal('verified') })
  ])
});
export type WebChatSnapshot = z.infer<typeof WebChatSnapshot>;
export const WebChatEvent = z.object({ type: z.literal('conversation.updated'), snapshot: WebChatSnapshot });
export type WebChatEvent = z.infer<typeof WebChatEvent>;
export const OpenCase = z.object({ contact_ref: Id, text: Text, idempotency_key: Id });
export const SendMessage = z.object({ text: Text, idempotency_key: Id, draft: z.object({run_id:Id,case_revision:z.number().int().positive()}).optional() });
export const VerifyHolder = z.object({ verification_code: z.string().min(4).max(32) });
export const WebVerificationStart = z.object({ identifier: z.string().trim().min(5).max(128) });
export const WebVerificationConfirm = z.object({ challenge_id: z.uuid(), code: z.string().regex(/^\d{6}$/) });
export const DecideProposal = z.object({ decision: z.enum(['approved', 'rejected']), revision: z.number().int().positive(), idempotency_key: Id });
export const CloseCase = z.object({ resolved: z.boolean(), retention_outcome: z.enum(['permanencia','baja','pendiente']).optional() });
export const AgentTurn = z.object({
  run_id: Id, case_id: Id, conversation_id: Id, turn_id: Id, channel: Channel, actor: Actor.exclude(['agente']),
  turn_seq: z.number().int().positive(), case_revision: z.number().int().positive(),
  attention_mode: AttentionMode, audience: Audience, scope_ref: Id, config_revision: Id,
  business_date: z.iso.date(), text: Text, traceparent: z.string().optional()
});
export type AgentTurn = z.infer<typeof AgentTurn>;
export const RunResult = z.discriminatedUnion('type', [
  z.object({ type: z.literal('answer'), answer: Text, citations: z.array(Citation), route: Id }),
  z.object({ type: z.literal('handoff'), reason: Text, pending: Text, route: Id, verification_required: z.literal(true).optional() }),
  z.object({ type: z.literal('card'), card: AdvisorCard, route: Id }),
  z.object({ type: z.literal('failed'), reason: Id, route: Id })
]);
export type RunResult = z.infer<typeof RunResult>;
export type RunResume = {
  run_id: string; effect_id: string;
  status: 'confirmed' | 'rejected' | 'expired' | 'pending_verification';
  effect_ref?: string;
};
export type AgentConfig = {
  revision: string;
  prompts: Record<string, string>;
  models?: Partial<Record<'economico' | 'intermedio' | 'complejo', string>>;
};
export type Retention = { eligible: boolean; reason: string; facts: Fact[]; policy: Citation; options: { id: string; title: string; detail: string }[] };
export interface AgentPorts {
  readCaseForRun(runId: string): Promise<{ messages: Message[]; verified: boolean; pending: string | null }>;
  getAgentConfig(revision: string): Promise<AgentConfig>;
  getCustomerContext(runId: string): Promise<Fact[]>;
  listServices?(runId: string): Promise<Fact[]>;
  getBilling(runId: string): Promise<Fact[]>;
  listInvoices?(runId: string): Promise<Fact[]>;
  getInvoiceDetail?(runId: string, invoiceId: string): Promise<Fact[]>;
  getTickets(runId: string): Promise<Fact[]>;
  evaluateRetention(runId: string): Promise<Retention>;
  createProposal(runId: string, input: { option_id: string; citation_ids: string[] }): Promise<Proposal>;
}
export interface AgentRunner {
  run(turn: AgentTurn): Promise<RunResult>;
  resume(result: RunResume): Promise<RunResult>;
}
export const PredictionRequest = z.object({ text: Text, channel: Channel, turn_id: Id, idempotency_key: Id });
export const Prediction = z.object({
  prediction_id: Id, label: Intent, score: z.number().min(0).max(1),
  score_type: z.literal('uncalibrated'), model_version: Id, mode: z.literal('shadow')
});
export type Prediction = z.infer<typeof Prediction>;
export const IntentLabel = z.object({ prediction_id: Id, label: Intent, event_id: Id });
export const DashboardFilters = z.object({
  days: z.enum(['7','30']).default('7'),
  channel: z.enum(['all','web','telegram']).default('all')
});
export type DashboardFilters = z.infer<typeof DashboardFilters>;
export type DashboardDay = {
  date: string; cases: number; aht: number | null; aht_sample: number;
  latency_p95: number | null; latency_sample: number; errors: number
};
export type EvalMetrics = {
  accuracy: number | null; groundedness: number | null; recall_at_5: number | null;
  unresolved_critical?: number; cost_usd?: number
};
export type EvalComparison = {
  evidence?: { golden_sha256?:string; scenarios_sha256?:string; corpus_sha256?:string };
  gate: string; baseline: EvalMetrics; candidate: EvalMetrics;
  cases: { id: string; baseline: string; candidate: string; human_review: boolean }[];
  date?: string; rubric?: string; provider_mode?: string
};
export type EvalJob = {
  id: string; revision: string; status: 'queued' | 'running' | 'completed' | 'failed';
  completed_cases: number; total_cases: number; failure_code?: string | null
};
export type EvalStatus = { job: EvalJob | null; report: EvalComparison | null };
export type Dashboard = {
  sample: 'synthetic' | 'pilot'; window_days: number;
  metrics: { id: string; label: string; value: number | null; unit: string; denominator?: number }[];
  providers: { name: string; status: string }[];
  revision: string;
  channel?: DashboardFilters['channel'];
  timezone?: string;
  daily?: DashboardDay[];
  prediction_classes?: { label: string; count: number }[];
  evaluation?: EvalComparison | null;
  evidence?: { langfuse: string | null; mlflow: string | null; model_version?: string; model_run_id?: string; traces: { run_id: string; channel: string; url: string }[] };
};
export type PromptRevision = { revision: string; status: 'active' | 'candidate' | 'passed' | 'failed'; prompts: Record<string, string> };
export type Contact = { ref: string; display_name: string; enabled: boolean };
export type Viewer = { id: string; name: string; role: z.infer<typeof Role>; capabilities?: string[]; specialties?: string[]; available?: boolean };

export * from './integrations.js';
