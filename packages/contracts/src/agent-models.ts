import { z } from 'zod';

export const ModelProfile = z.enum(['economico', 'intermedio', 'complejo']);
export type ModelProfile = z.infer<typeof ModelProfile>;
export const ModelStep = z.enum([
  'extract_turn', 'plan_objectives', 'select_evidence', 'write_public', 'write_advisor',
  'commercial_evidence', 'support_evidence', 'billing_evidence'
]);
export type ModelStep = z.infer<typeof ModelStep>;
export const ModelProvider = z.enum(['openai', 'openrouter']);
export type ModelProvider = z.infer<typeof ModelProvider>;

export type ModelOption = {
  id: string;
  provider: ModelProvider;
  family: string;
  label: string;
  profile: ModelProfile;
  input_usd_per_million: number;
  output_usd_per_million: number;
  reasoning?: 'none' | 'low';
};

export const agentModelCatalog: readonly ModelOption[] = [
  {id:'gpt-6-luna',provider:'openai',family:'OpenAI',label:'Luna',profile:'economico',input_usd_per_million:0.10,output_usd_per_million:0.50,reasoning:'none'},
  {id:'gpt-6.1-terra',provider:'openai',family:'OpenAI',label:'Terra',profile:'intermedio',input_usd_per_million:1,output_usd_per_million:5,reasoning:'low'},
  {id:'gpt-6.2-sol',provider:'openai',family:'OpenAI',label:'Sol',profile:'complejo',input_usd_per_million:2,output_usd_per_million:10,reasoning:'low'},
  {id:'gpt-6.2-astra',provider:'openai',family:'OpenAI',label:'Astra',profile:'complejo',input_usd_per_million:8,output_usd_per_million:40,reasoning:'low'},
  {id:'anthropic/claude-sonnet-4.6',provider:'openrouter',family:'Anthropic',label:'Claude Sonnet 4.6',profile:'complejo',input_usd_per_million:3,output_usd_per_million:15},
  {id:'google/gemini-3.5-flash-lite',provider:'openrouter',family:'Google',label:'Gemini 3.5 Flash Lite',profile:'intermedio',input_usd_per_million:0.30,output_usd_per_million:2.50},
  {id:'meta-llama/llama-3.3-70b-instruct',provider:'openrouter',family:'Meta',label:'Llama 3.3 70B',profile:'economico',input_usd_per_million:0.40,output_usd_per_million:2.50},
  {id:'mistralai/mistral-small-3.2-24b-instruct',provider:'openrouter',family:'Mistral',label:'Mistral Small 3.2',profile:'economico',input_usd_per_million:0.10,output_usd_per_million:0.30}
];

export const modelStepLabels: Record<ModelStep, string> = {
  extract_turn:'Orquestador · Extraer contexto', plan_objectives:'Orquestador · Planificar tareas',
  select_evidence:'Orquestador · Ordenar fuentes', write_public:'Orquestador · Redactar respuesta',
  write_advisor:'Orquestador · Redactar sugerencia', commercial_evidence:'Comercial y Portabilidad',
  support_evidence:'Soporte Técnico', billing_evidence:'Facturación'
};
const ModelId = z.string().min(1).max(128);
const ProfileModels = z.record(ModelProfile,ModelId);
export const ModelAssignment = z.discriminatedUnion('mode', [
  z.object({mode:z.literal('fixed'),model:ModelId,fallback:ModelId.optional()}).strict(),
  z.object({mode:z.literal('auto'),profiles:ProfileModels,alternatives:z.array(ModelId).max(8),fallback:ModelId.optional()}).strict()
]);
export type ModelAssignment = z.infer<typeof ModelAssignment>;
export const AgentModelPolicy = z.object({
  steps:z.record(ModelStep,ModelAssignment),
  max_cost_usd:z.number().min(0.0001).max(1),
  max_call_ms:z.number().int().min(350).max(10000)
}).strict();
export type AgentModelPolicy = z.infer<typeof AgentModelPolicy>;
export const initialAgentModelPolicy = AgentModelPolicy.parse({
  steps:Object.fromEntries(ModelStep.options.map(step=>[step,{mode:'auto',profiles:{
    economico:'gpt-6-luna',intermedio:'gpt-6.1-terra',complejo:'gpt-6.2-sol'
  },alternatives:[],fallback:'gpt-6.1-terra'}])),
  max_cost_usd:0.06, max_call_ms:3600
});
export const modelProfileRank: Record<ModelProfile, number> = {economico:0,intermedio:1,complejo:2};

export function assignedModelIds(rule:ModelAssignment) {
  const primary = rule.mode==='fixed' ? [rule.model] : [...Object.values(rule.profiles),...rule.alternatives];
  return [...new Set(rule.fallback ? [...primary,rule.fallback] : primary)];
}

export type ModelValidation = { digest:string; checked_at:string; issues:{step:ModelStep;model:string;reason:string}[] };
export type AgentModelRevision = {
  revision:string; base_revision:string|null; digest:string; policy:AgentModelPolicy;
  created_by:string; reason:string; created_at:string; validation:ModelValidation|null; was_active:boolean;
};
export type AgentModelRevisions = {active:string; revisions:AgentModelRevision[]};
export type AgentModelActivation = {active:string; revision:AgentModelRevision};
export type AgentModelCatalog = {
  providers:Record<ModelProvider,boolean>;
  models:(ModelOption & {available:boolean; structured_outputs:boolean|null})[];
};

export type AgentModelExecution = {
  id:string; at:string; step:ModelStep; provider:ModelProvider; revision:string;
  requested_model:string; effective_model:string|null; status:string; attempt:number;
  latency_ms:number|null; cost_usd:number|null; cost_basis:string|null; trace_url:string|null;
};
export type AgentModelExecutions = {items:AgentModelExecution[];langfuse_url:string|null};
