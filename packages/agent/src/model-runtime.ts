import { agentModelCatalog, modelComponentByStep, modelProfileRank, modelTuningIssue, type AgentModelPolicy, type ModelOption, type ModelProfile, type ModelProvider, type ModelStep, type ModelComponent, type ModelTuning } from '@claro/contracts';
import type { AgentObservation, Observe } from './generation.js';

type JsonSchema = Record<string, unknown>;
export type ModelCredentials = Partial<Record<ModelProvider,string>>;
type ModelRequest<T> = {
  step: ModelStep; profile: ModelProfile; promptRef?:string; instructions: string; input: unknown;
  schema: JsonSchema; accept: (value:unknown)=>T|null; maxOutput?:number;
};
type ModelReply = {value:unknown; effective:string; usage:AgentObservation['metadata']};
const encoder = new TextEncoder();

export function objectSchema(properties:Record<string,JsonSchema>):JsonSchema {
  return {type:'object',properties,required:Object.keys(properties),additionalProperties:false};
}

export async function requestModel(model:ModelOption, key:string, instructions:string, input:string, schema:JsonSchema,
  maxOutput:number, timeoutMs:number, fetcher:typeof fetch=fetch, tuning?:ModelTuning):Promise<ModelReply> {
  const direct = model.provider==='openai';
  const local = model.provider==='lmstudio';
  const format={name:'claro_result',strict:true,schema};
  const effort=tuning?.reasoning ?? model.reasoning;
  const body=direct
    ? {model:model.id,store:false,instructions,input,max_output_tokens:maxOutput,reasoning:{effort},
      ...(model.supports_no_reasoning && effort==='none' && tuning?.temperature!==undefined ? {temperature:tuning.temperature} : {}),
      text:{format:{...format,type:'json_schema'},...(tuning?.verbosity ? {verbosity:tuning.verbosity} : {})}}
    : {model:model.id,messages:[{role:'system',content:instructions},{role:'user',content:input}],max_tokens:maxOutput,
      response_format:{type:'json_schema',json_schema:format},
      ...(!local ? {provider:{require_parameters:true,data_collection:'deny',zdr:true,
        max_price:{prompt:model.input_usd_per_million,completion:model.output_usd_per_million}}} : {})};
  const endpoints={openai:'https://api.openai.com/v1/responses',openrouter:'https://openrouter.ai/api/v1/chat/completions',
    lmstudio:'http://lm-studio:1234/v1/chat/completions'};
  const response=await fetcher(endpoints[model.provider],{
    method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
    body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const data=await response.json();
  const claimed=typeof data.model==='string' ? data.model : '';
  const matches=claimed===model.id || (direct && /^\d{4}-\d{2}-\d{2}$/.test(claimed.slice(model.id.length+1)) && claimed.startsWith(`${model.id}-`));
  const tokensIn=direct ? data.usage?.input_tokens : data.usage?.prompt_tokens;
  const tokensOut=direct ? data.usage?.output_tokens : data.usage?.completion_tokens;
  const billed=direct ? undefined : data.usage?.cost;
  const measured=Number.isFinite(billed) && billed>=0;
  const counted=Number.isSafeInteger(tokensIn) && tokensIn>=0 && Number.isSafeInteger(tokensOut) && tokensOut>=0;
  const usage:AgentObservation['metadata'] = counted ? {input_tokens:tokensIn,output_tokens:tokensOut} : {};
  usage.cost_basis=measured?'provider':counted?'rate_estimate':'unavailable';
  if (measured || counted) usage.cost_usd=measured ? billed : (tokensIn*model.input_usd_per_million+tokensOut*model.output_usd_per_million)/1e6;
  const content=direct && data.status==='completed' && Array.isArray(data.output)
    ? data.output.filter((item:{type:string})=>item.type==='message').flatMap((item:{content?:{type:string;text?:string}[]})=>item.content ?? [])
      .filter((part:{type:string})=>part.type==='output_text')
    : [];
  const raw=direct ? content.length===1 ? content[0].text : undefined
    : data.choices?.length===1 && data.choices[0].finish_reason==='stop' ? data.choices[0].message?.content : undefined;
  let value:unknown=null;
  if (matches && typeof raw==='string') {
    try { value=JSON.parse(raw); } catch { /* malformed structured response */ }
  }
  return {value,effective:matches?claimed:'',usage};
}

const agentForStep:Partial<Record<ModelStep,string>> = {
  commercial_evidence:'comercial',support_evidence:'soporte',billing_evidence:'facturacion'
};

const toneInstructions:Record<NonNullable<ModelTuning['tone']>,string> = {
  cercano:'Usa un tono cercano y empático. Mantén la precisión de los hechos, cifras y citas.',
  formal:'Usa un tono profesional y formal. Mantén la precisión de los hechos, cifras y citas.',
  directo:'Usa un tono directo y frases breves. Conserva los hechos, cifras y citas relevantes.'
};

export class TurnModels {
  private reserved=0;
  private readonly reservedByComponent=new Map<ModelComponent,number>();
  constructor(private readonly policy:AgentModelPolicy,private readonly credentials:ModelCredentials,
    private readonly revision:string,private readonly deadline:number,private readonly observe:Observe,
    private readonly fetcher:typeof fetch=fetch) {}

  async call<T>(request:ModelRequest<T>):Promise<T|null> {
    if (!request.instructions.trim()) return null;
    const rule=this.policy.steps[request.step];
    const {tuning}=rule;
    const component=modelComponentByStep[request.step];
    const limits=this.policy.component_limits?.[component];
    const instructions=tuning?.tone ? `${request.instructions}\n\n${toneInstructions[tuning.tone]}` : request.instructions;
    const input=JSON.stringify(request.input);
    const maxOutput=tuning?.max_output_tokens ?? request.maxOutput ?? 480;
    const promptDigest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(instructions))),
      byte=>byte.toString(16).padStart(2,'0')).join('');
    const upperTokens=encoder.encode(input+instructions+JSON.stringify(request.schema)).length+512;
    const price=(model:ModelOption)=>(upperTokens*model.input_usd_per_million+maxOutput*model.output_usd_per_million)/1e6;
    const allowed=(id:string|undefined)=>agentModelCatalog.find(model=>model.id===id && this.credentials[model.provider] && !modelTuningIssue(request.step,tuning,model));
    const minimum=modelProfileRank[request.profile];
    const candidates=rule.mode==='fixed' ? [allowed(rule.model)] :
      [allowed(rule.profiles[request.profile]),...rule.alternatives.map(allowed).filter(model=>model && modelProfileRank[model.profile]>=minimum)];
    const primary=candidates.filter((model):model is ModelOption=>!!model).sort((a,b)=>price(a)-price(b))[0];
    const fallback=allowed(rule.fallback);
    const models=[primary, fallback?.id!==primary?.id ? fallback : undefined];
    for (let attempt=0;attempt<models.length;attempt++) {
      const model=models[attempt];
      if (!model) continue;
      const started=Date.now(), allowance=price(model);
      const callLimit=limits?.max_call_ms ?? this.policy.max_call_ms;
      const remaining=Math.min(callLimit,this.deadline-started);
      let status='budget_exhausted', effective='', usage:AgentObservation['metadata'] = {cost_basis:'unavailable'};
      try {
        const componentSpent=this.reservedByComponent.get(component) ?? 0;
        if (remaining<350 || this.reserved+allowance>this.policy.max_cost_usd ||
            componentSpent+allowance>(limits?.max_cost_usd ?? Infinity)) continue;
        this.reserved+=allowance;
        this.reservedByComponent.set(component,componentSpent+allowance);
        const reply=await requestModel(model,this.credentials[model.provider]!,instructions,input,request.schema,maxOutput,remaining,this.fetcher,tuning);
        effective=reply.effective;
        usage=reply.usage;
        const value=reply.value===null ? null : request.accept(reply.value);
        status=value===null?'invalid':'accepted';
        if (value!==null) return value;
      } catch (error) {
        status=error instanceof Error && /^http_\d+$/.test(error.message) ? error.message : 'unavailable';
      } finally {
        this.observe({name:'model.call',started,ended:Date.now(),metadata:{
          ...usage,agent_id:agentForStep[request.step] ?? 'copiloto',step_id:request.step,model:effective,
          provider:model.provider,requested_model:model.id,effective_model:effective,model_config_revision:this.revision,
          prompt_sha256:promptDigest,prompt_ref:request.promptRef ?? '',profile:request.profile,selection:attempt?'fallback':rule.mode,
          status,attempt:attempt+1,
          ...(tuning ? {
            ...(tuning.reasoning ? {reasoning_effort:tuning.reasoning} : {}),
            ...(tuning.verbosity ? {text_verbosity:tuning.verbosity} : {}),
            ...(tuning.temperature!==undefined ? {temperature:tuning.temperature} : {}),
            ...(tuning.tone ? {response_tone:tuning.tone} : {}),
            ...(tuning.max_output_tokens!==undefined ? {max_output_tokens:maxOutput} : {})
          } : {}),
          ...(limits?.max_cost_usd!==undefined ? {component_turn_cost_limit_usd:limits.max_cost_usd} : {}),
          ...(limits?.max_call_ms!==undefined ? {component_call_timeout_ms:callLimit} : {})
        }});
      }
    }
    return null;
  }
}
