import { z } from 'zod';

export const ModelProfile = z.enum(['economico', 'intermedio', 'complejo']);
export type ModelProfile = z.infer<typeof ModelProfile>;
export const ModelStep = z.enum([
  'extract_turn', 'plan_objectives', 'select_evidence', 'write_public', 'write_advisor',
  'commercial_evidence', 'support_evidence', 'billing_evidence'
]);
export type ModelStep = z.infer<typeof ModelStep>;
export const ModelProvider = z.enum(['openai', 'openrouter', 'lmstudio']);
export type ModelProvider = z.infer<typeof ModelProvider>;

export const ModelComponent = z.enum(['orquestador','comercial','soporte','facturacion']);
export type ModelComponent = z.infer<typeof ModelComponent>;
export const modelComponentByStep:Record<ModelStep,ModelComponent> = {
  extract_turn:'orquestador',plan_objectives:'orquestador',select_evidence:'orquestador',
  write_public:'orquestador',write_advisor:'orquestador',commercial_evidence:'comercial',
  support_evidence:'soporte',billing_evidence:'facturacion'
};
export const ModelReasoning = z.enum(['none','low','medium','high','xhigh','max']);
export const ModelVerbosity = z.enum(['low','medium','high']);
export const ModelTone = z.enum(['cercano','formal','directo']);
export const ModelTuning = z.object({
  reasoning:ModelReasoning.optional(),
  verbosity:ModelVerbosity.optional(),
  temperature:z.number().min(0).max(2).optional(),
  tone:ModelTone.optional(),
  max_output_tokens:z.number().int().min(128).max(2048).optional()
}).strict();
export type ModelTuning = z.infer<typeof ModelTuning>;
export function writesModelResponse(step:ModelStep) {
  return step==='write_public' || step==='write_advisor' || step==='commercial_evidence' ||
    step==='support_evidence' || step==='billing_evidence';
}

export type ModelOption = {
  id: string;
  provider: ModelProvider;
  family: string;
  label: string;
  profile: ModelProfile;
  input_usd_per_million: number;
  output_usd_per_million: number;
  reasoning?: z.infer<typeof ModelReasoning>;
  supports_no_reasoning?: true;
};

export const localLlamaModel = {id:'claro-llama',provider:'lmstudio',family:'Meta',label:'Llama 3.2 3B · LM Studio',profile:'economico',input_usd_per_million:0,output_usd_per_million:0} as const satisfies ModelOption;

export const agentModelCatalog: readonly ModelOption[] = [
  {id:'gpt-6-luna',provider:'openai',family:'OpenAI',label:'Luna',profile:'economico',input_usd_per_million:0.10,output_usd_per_million:0.50,reasoning:'none',supports_no_reasoning:true},
  {id:'gpt-6.1-terra',provider:'openai',family:'OpenAI',label:'Terra',profile:'intermedio',input_usd_per_million:1,output_usd_per_million:5,reasoning:'low',supports_no_reasoning:true},
  {id:'gpt-6.2-sol',provider:'openai',family:'OpenAI',label:'Sol',profile:'complejo',input_usd_per_million:2,output_usd_per_million:10,reasoning:'low'},
  {id:'gpt-6.2-astra',provider:'openai',family:'OpenAI',label:'Astra',profile:'complejo',input_usd_per_million:8,output_usd_per_million:40,reasoning:'low'},
  {id:'anthropic/claude-sonnet-4.6',provider:'openrouter',family:'Anthropic',label:'Claude Sonnet 4.6',profile:'complejo',input_usd_per_million:3,output_usd_per_million:15},
  {id:'google/gemini-3.5-flash-lite',provider:'openrouter',family:'Google',label:'Gemini 3.5 Flash Lite',profile:'intermedio',input_usd_per_million:0.30,output_usd_per_million:2.50},
  {id:'meta-llama/llama-3.3-70b-instruct',provider:'openrouter',family:'Meta',label:'Llama 3.3 70B',profile:'economico',input_usd_per_million:0.40,output_usd_per_million:2.50},
  localLlamaModel,
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
  z.object({mode:z.literal('fixed'),model:ModelId,fallback:ModelId.optional(),tuning:ModelTuning.optional()}).strict(),
  z.object({mode:z.literal('auto'),profiles:ProfileModels,alternatives:z.array(ModelId).max(8),fallback:ModelId.optional(),tuning:ModelTuning.optional()}).strict()
]);
export type ModelAssignment = z.infer<typeof ModelAssignment>;
const Cost = z.number().min(0.0001).max(1);
export const maxModelCallMs = 30000;
const Timeout = z.number().int().min(350).max(maxModelCallMs);
export const AgentModelPolicy = z.object({
  steps:z.record(ModelStep,ModelAssignment),
  max_cost_usd:Cost,
  max_call_ms:Timeout,
  component_limits:z.partialRecord(ModelComponent,z.object({max_cost_usd:Cost.optional(),max_call_ms:Timeout.optional()}).strict()).optional()
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

export function modelTuningIssue(step:ModelStep,tuning:ModelTuning|undefined,model:ModelOption):string|undefined {
  if (!tuning) return;
  if (!writesModelResponse(step) && (tuning.tone || tuning.verbosity || tuning.temperature!==undefined || tuning.max_output_tokens!==undefined)) {
    return 'ajuste_exclusivo_de_respuesta';
  }
  if (model.provider!=='openai' && (tuning.reasoning || tuning.verbosity || tuning.temperature!==undefined)) return 'ajuste_requiere_openai';
  if (tuning.reasoning==='none' && !model.supports_no_reasoning) return 'razonamiento_no_compatible';
  if (tuning.temperature!==undefined && (!model.supports_no_reasoning || (tuning.reasoning ?? model.reasoning)!=='none')) {
    return 'temperatura_requiere_sin_razonamiento';
  }
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
