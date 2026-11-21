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
export const Fact = z.object({ id: Id, label: z.string(), value: z.string() });
export type Fact = z.infer<typeof Fact>;
export const Message = z.object({
  id: Id, turn_seq: z.number().int().positive(), actor: Actor, text: Text,
  created_at: z.iso.datetime(), citations: z.array(Citation).optional()
});
export type Message = z.infer<typeof Message>;
export const Proposal = z.object({
  id: Id, revision: z.number().int().positive(), title: z.string(), detail: z.string(),
  status: z.enum(['pending_approval', 'approved', 'confirmed', 'rejected', 'expired', 'pending_verification']),
  effect_ref: Id.optional()
});
export type Proposal = z.infer<typeof Proposal>;
export const AdvisorCard = z.object({
  intent: Intent.nullable(), summary: z.string(), facts: z.array(Fact), citations: z.array(Citation),
  pending: z.array(z.string()), next_action: z.string(), reason_codes: z.array(z.string()), proposal: Proposal.optional()
});
export type AdvisorCard = z.infer<typeof AdvisorCard>;
export const CaseSummary = z.object({
  id: Id, conversation_id: Id, display_name: z.string(), channel: Channel,
  attention_mode: AttentionMode, owner_id: Id.nullable(), verified: z.boolean(),
  status: z.enum(['open', 'closed']), revision: z.number().int().positive(),
  updated_at: z.iso.datetime(), last_message: z.string().nullable()
});
export type CaseSummary = z.infer<typeof CaseSummary>;
export const CaseSnapshot = CaseSummary.extend({
  messages: z.array(Message), card: AdvisorCard.nullable(), cursor: z.number().int().nonnegative()
});
export type CaseSnapshot = z.infer<typeof CaseSnapshot>;
export const CaseEvent = z.object({ type: z.literal('case.updated'), cursor: z.number().int().positive(), snapshot: CaseSnapshot });
export type CaseEvent = z.infer<typeof CaseEvent>;
export const OpenCase = z.object({ contact_ref: Id, text: Text, idempotency_key: Id });
export const SendMessage = z.object({ text: Text, idempotency_key: Id });
export const VerifyHolder = z.object({ verification_code: z.string().min(4).max(32) });
export const DecideProposal = z.object({ decision: z.enum(['approved', 'rejected']), revision: z.number().int().positive(), idempotency_key: Id });
export const CloseCase = z.object({ resolved: z.boolean() });
export const AgentTurn = z.object({
  run_id: Id, case_id: Id, conversation_id: Id, turn_id: Id, channel: Channel, actor: Actor.exclude(['agente']),
  turn_seq: z.number().int().positive(), case_revision: z.number().int().positive(),
  attention_mode: AttentionMode, audience: Audience, scope_ref: Id, config_revision: Id,
  business_date: z.iso.date(), text: Text, traceparent: z.string().optional()
});
export type AgentTurn = z.infer<typeof AgentTurn>;
export const RunResult = z.discriminatedUnion('type', [
  z.object({ type: z.literal('answer'), answer: Text, citations: z.array(Citation), route: Id }),
  z.object({ type: z.literal('handoff'), reason: Text, pending: Text, route: Id }),
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
  getBilling(runId: string): Promise<Fact[]>;
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
export type Dashboard = {
  sample: 'synthetic' | 'pilot'; window_days: number;
  metrics: { id: string; label: string; value: number | null; unit: string; denominator?: number }[];
  providers: { name: string; status: string }[];
  revision: string;
};
export type PromptRevision = { revision: string; status: 'active' | 'candidate' | 'passed' | 'failed'; prompts: Record<string, string> };
export type Contact = { ref: string; display_name: string; enabled: boolean };
export type Viewer = { id: string; name: string; role: z.infer<typeof Role> };
