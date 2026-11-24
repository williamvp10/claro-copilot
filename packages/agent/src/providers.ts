import type { Citation, Intent } from '@claro/contracts';
import type { Decision, DecisionAdapter } from './index.js';
import { safeDecisionFeatures } from './index.js';
import { openAIUsage, type Observe } from './generation.js';

type Fetch = typeof globalThis.fetch;
type Choice = { type?: unknown; choice?: unknown; probabilities?: unknown; confidence?: unknown };
type DecisionUsage = {input_tokens?:unknown;output_tokens?:unknown;cost?:unknown};
type JevResponse = {id?:unknown;model?:unknown;answers?:Record<string,unknown>;usage?:DecisionUsage};
type DecisionMetadata=Record<string,string|number>;
const intents = ['soporte_tecnico','facturacion','consulta_planes','cancelacion','portabilidad','fuera_de_alcance','indeterminada'] as const;
const complexity = ['simple','intermedia','compuesta','indeterminada'] as const;
const intentCriteria = {soporte_tecnico:'Falla o procedimiento técnico.', facturacion:'Factura, saldo, cobro o pago.', consulta_planes:'Planes, precios o características.', cancelacion:'Terminar el servicio.', portabilidad:'Portar número.', fuera_de_alcance:'Objetivo ajeno.', indeterminada:'No se puede distinguir el objetivo.'};
const complexityCriteria = {simple:'Un objetivo.', intermedia:'Un objetivo con verificaciones.', compuesta:'Varios objetivos.', indeterminada:'Información insuficiente.'};
function readChoice(value: unknown, labels: readonly string[]) {
  if (!value || typeof value !== 'object') return null;
  const answer = value as Choice;
  if (answer.type !== 'choice' || typeof answer.choice !== 'string' || !labels.includes(answer.choice) || !answer.probabilities || typeof answer.probabilities !== 'object') return null;
  const p = answer.probabilities as Record<string, unknown>;
  if (Object.keys(p).some(k => !labels.includes(k)) || labels.some(k => typeof p[k] !== 'number' || !Number.isFinite(p[k]) || (p[k] as number) < 0 || (p[k] as number) > 1)) return null;
  const probabilities=Object.fromEntries(labels.map(label=>[label,p[label] as number]));
  if (Math.abs(Object.values(probabilities).reduce((sum,value)=>sum+value,0)-1)>0.02) return null;
  const confidence=answer.confidence;
  return { choice:answer.choice, probability:probabilities[answer.choice], probabilities,
    ...(typeof confidence==='number' && confidence>=0 && confidence<=1 ? {confidence} : {}) };
}
function acceptChoice(choice:ReturnType<typeof readChoice>) {
  if (!choice || choice.probability<0.75) return null;
  const [first,second]=Object.values(choice.probabilities).sort((a,b)=>b-a);
  return choice.probability===first && first-second>=0.2 ? choice : null;
}
function decisionUsage(usage:DecisionUsage|undefined) {
  const values:DecisionMetadata={};
  if (typeof usage?.cost==='number' && Number.isFinite(usage.cost) && usage.cost>=0) {
    values.cost_usd=usage.cost;
    values.cost_basis='provider_reported';
  }
  for (const key of ['input_tokens','output_tokens'] as const) {
    const value=usage?.[key];
    if (typeof value==='number' && Number.isSafeInteger(value) && value>=0) values[key]=value;
  }
  return values;
}
function choiceMetadata(prefix:string, value:ReturnType<typeof readChoice>) {
  if (!value) return {};
  return { [prefix+'_choice']:value.choice,[prefix+'_probability']:value.probability,
    [prefix+'_probabilities']:JSON.stringify(value.probabilities),
    ...(value.confidence!==undefined ? {[prefix+'_confidence']:value.confidence} : {}) };
}
export type JevOptions = { apiKey: string; model: string; timeoutMs?: number; fetch?: Fetch; semanticTemplate?: string };
export function parseJevQuestion(template:string, expectedKeys:readonly string[], variables:Record<string,string> = {}): {instructions:string;criteria:Record<string,string>} | null {
 try { const value=JSON.parse(template) as {instructions:unknown;criteria:unknown}; if (typeof value.instructions !== 'string' || !value.criteria || typeof value.criteria !== 'object' || Array.isArray(value.criteria)) return null; const criteria=value.criteria as Record<string,unknown>; if (Object.keys(criteria).length !== expectedKeys.length || expectedKeys.some(k=>typeof criteria[k] !== 'string') || Object.keys(criteria).some(k=>!expectedKeys.includes(k))) return null; const render=(s:string)=>s.replace(/{{\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*}}/g,(_,key:string)=>variables[key] ?? ''); return {instructions:render(value.instructions),criteria:Object.fromEntries(expectedKeys.map(k=>[k,render(criteria[k] as string)]))}; } catch { return null; }
}
/** Jev receives only categorical features; API errors and uncertain output abstain. */
export function createJevDecisionAdapter(options: JevOptions): DecisionAdapter {
  if (!options.apiKey || !/^typesafe\/jev-[a-zA-Z0-9.-]+$/.test(options.model)) throw new Error('A server key and explicit Jev model are required');
  return { async classify(text, prompts, observe): Promise<Decision | null> {
    const intentQuestion = prompts?.intent_decision ? parseJevQuestion(prompts.intent_decision,intents) : {instructions:'Clasifica la intención a partir de señales categóricas.',criteria:intentCriteria};
    const complexityQuestion = prompts?.complexity_decision ? parseJevQuestion(prompts.complexity_decision,complexity) : {instructions:'Clasifica la complejidad solo si hay información suficiente.',criteria:complexityCriteria};
    if (!intentQuestion || !complexityQuestion) return null;
    const features = safeDecisionFeatures(text);
    if (features === 'indeterminada') return null;
    const telemetry:DecisionMetadata={model:options.model,provider_attempted:'yes',provider_status:'unavailable'};
    try {
      const response = await (options.fetch ?? fetch)('https://openrouter.ai/api/alpha/decisions', {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${options.apiKey}`},signal:AbortSignal.timeout(options.timeoutMs ?? 800),body:JSON.stringify({model:options.model,state:{senales:features},questions:{intencion:{type:'choice',...intentQuestion},complejidad:{type:'choice',...complexityQuestion}}})});
      if (!response.ok) {
        telemetry.provider_status=`http_${response.status}`;
        return null;
      }
      telemetry.provider_status='invalid_response';
      const data = await response.json() as JevResponse;
      Object.assign(telemetry,decisionUsage(data?.usage));
      if (typeof data?.id==='string' && /^gen-dec-[a-zA-Z0-9_-]{1,110}$/.test(data.id)) telemetry.provider_request_id=data.id;
      if (typeof data.model !== 'string' || !(data.model === options.model || data.model.startsWith(`${options.model}-`))) return null;
      telemetry.model=data.model;
      const intent = readChoice(data.answers?.intencion,intents);
      const profile = readChoice(data.answers?.complejidad,complexity);
      Object.assign(telemetry,choiceMetadata('intent',intent),choiceMetadata('complexity',profile));
      if (intent) telemetry.provider_status='abstained';
      const i = acceptChoice(intent); const c = acceptChoice(profile);
      if (!i || i.choice === 'indeterminada' || i.choice === 'fuera_de_alcance') return null;
      telemetry.provider_status='accepted';
      return {intent:i.choice as Intent, confidence:i.probability, complexity:c?.choice === 'compuesta' ? 'complejo' : c?.choice === 'intermedia' ? 'intermedio' : 'economico'};
    } catch (error) {
      if (error instanceof Error && error.name==='TimeoutError') telemetry.provider_status='timeout';
      return null;
    } finally {
      observe?.(telemetry);
    }
  }};
}

export interface EvidenceSelector {
  select(query:string, citations:Citation[], profile:Decision['complexity'], prompt?:string, observe?:Observe):Promise<number|null>;
}
export type OpenAISelectorOptions = {apiKey: string; models: Partial<Record<Decision['complexity'],string>>; timeoutMs?:number; fetch?:Fetch};
/** Responses API selects an already-authorized passage; generated prose is never published. */
export function createOpenAIEvidenceSelector(options: OpenAISelectorOptions): EvidenceSelector {
  if (!options.apiKey) throw new Error('A server key is required');
  for (const model of Object.values(options.models)) if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(model)) throw new Error('Invalid model identifier');
  return {async select(query,citations,profile,prompt,observe) {
    const model = options.models[profile];
    if (!model || citations.length === 0 || citations.length > 3) return null;
    // Labels are from a closed vocabulary; neither the query nor source passages leave the process.
    const candidates = citations.map((c,index)=>({index,senales:safeDecisionFeatures(`${c.title} ${c.excerpt}`)}));
    const started=Date.now();
    let status='unavailable';
    let servedModel=model;
    let usage:DecisionMetadata={};
    try {
      const response = await (options.fetch ?? fetch)('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${options.apiKey}`},signal:AbortSignal.timeout(options.timeoutMs ?? 1500),body:JSON.stringify({model,store:false,max_output_tokens:64,input:[{role:'developer',content:prompt || 'Select the most relevant candidate index. Return exactly one digit; if uncertain return -1.'},{role:'user',content:JSON.stringify({senales:safeDecisionFeatures(query),candidates})}]})});
      status=`http_${response.status}`;
      if (!response.ok) return null;
      status='invalid_response';
      const data = await response.json() as {model?:unknown;usage?:{input_tokens?:number;output_tokens?:number};output?:Array<{type?:unknown;content?:Array<{type?:unknown;text?:unknown}>}>};
      usage=openAIUsage(data?.usage,model);
      if (typeof data.model !== 'string' || !(data.model === model || data.model.startsWith(`${model}-`))) return null;
      servedModel=data.model;
      const values = data.output?.flatMap(x=>x.type === 'message' ? (x.content ?? []).filter(c=>c.type === 'output_text').map(c=>c.text) : []) ?? [];
      if (values.length !== 1 || typeof values[0] !== 'string' || !/^[0-2]$/.test(values[0].trim())) return null;
      const index = Number(values[0]);
      if (index>=citations.length) return null;
      status='accepted';
      return index;
    } catch (error) {
      if (error instanceof Error && error.name==='TimeoutError') status='timeout';
      return null;
    } finally {
      observe?.({name:'decision.evidence',started,ended:Date.now(),metadata:{
        model:servedModel,status,...usage,agent_id:'conocimiento',step_id:'select_public_evidence',prompt_ref:'public_evidence_selector'
      }});
    }
  }};
}

export type SemanticObservation = {question:string; answer:string; evidence:string[]; requiredFacts?:string[]; forbiddenFacts?:string[]; deterministicPassed:boolean};
export type SemanticResult = {status:'pass'|'fail'|'review'|'error'|'not_applicable'; decisions:{criterion:string; choice:string}[]; model?:string;
 usage?:ReturnType<typeof decisionUsage>};
// Only these generic domain words leave the process. Unknown words, numbers and names are discarded.
const evalVocabulary = new Set(('el la los las un una unos unas de del al y o en por para con sin si no se es son esta fue ha hay hasta antes despues desde entre mas menos mismo cliente asesor servicio plan fibra hogar internet tv senal televisor decodificador modem mi claro refrescar reiniciar encendido esperar minutos horas dias factura saldo pago pendiente pagado vencimiento cancelar cancelacion baja descuento oferta alternativa mejora elegible inelegible mora politica ticket visita solicitud registrada agendada confirmada confirmacion aprobada rechazada expirado titular verificado titularidad procedimiento fuente vigente precio incluye consulta soporte error cita evidencia insuficiente puede debe ' +
  'wifi cable prueba falla fallas comprobar comprobarla lento habitacion cuenta cargo cobro ajuste consultar aplicado aplicada revisar verificacion verificar exigir deuda portabilidad portarme portar operador receptor movil numero supervisor supervision queja atender escalar luz roja los persiste tecnico tecnica promocion condiciones nuevo nuevos existente garantizar alta cambio cobertura mudanza exencion reconexion registrado autorizar aprobacion descuento historial recibo prioritaria informar confirmar distinguir orientar reconocer elegibilidad reportar resultado').split(' '));
function safeEvalText(s: string): string {
 return (s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().match(/[a-z]+/g) ?? []).filter(x=>evalVocabulary.has(x)).slice(0,100).join(' ');
}
/** Restricted semantic signal for offline experiments, not a calibrated release gate. */
export function createJevSemanticEvaluator(options: JevOptions) {
 if (!options.apiKey || !/^typesafe\/jev-[a-zA-Z0-9.-]+$/.test(options.model)) throw new Error('A server key and explicit Jev model are required');
 return {async evaluate(input:SemanticObservation):Promise<SemanticResult> {
  if (!input.deterministicPassed) return {status:'fail',decisions:[]};
  const criteria = [...(input.requiredFacts ?? []).map(s=>({kind:'required',text:s})),...(input.forbiddenFacts ?? []).map(s=>({kind:'forbidden',text:s}))];
  if (!criteria.length) return {status:'not_applicable',decisions:[]};
  if (criteria.length > 20 || !safeEvalText(input.answer) || criteria.some(x=>!safeEvalText(x.text))) return {status:'review',decisions:[]};
  const questions:Record<string,unknown>={};
  criteria.forEach((x,i)=>{const question=options.semanticTemplate ? parseJevQuestion(options.semanticTemplate,['presente','ausente','ambiguo'],{criterion:safeEvalText(x.text),criterio:safeEvalText(x.text),rubric_statement:safeEvalText(x.text)}) : {instructions:`Evalúa la afirmación ${safeEvalText(x.text)} en la respuesta y evidencia.`,criteria:{presente:'La afirmación está claramente presente y respaldada.',ausente:'La afirmación no está presente.',ambiguo:'La evidencia o respuesta no permiten decidir.'}}; if (question) questions[`q${i}`]={type:'choice',...question};});
  if (Object.keys(questions).length !== criteria.length) return {status:'review',decisions:[]};
  try {
   const response=await (options.fetch ?? fetch)('https://openrouter.ai/api/alpha/decisions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${options.apiKey}`},signal:AbortSignal.timeout(options.timeoutMs ?? 800),body:JSON.stringify({model:options.model,state:{pregunta:safeEvalText(input.question),respuesta:safeEvalText(input.answer),evidencia:input.evidence.slice(0,3).map(safeEvalText)},questions})});
   if (!response.ok) return {status:'error',decisions:[]};
   const data=await response.json() as JevResponse;
   const usage=decisionUsage(data?.usage);
   if (typeof data?.model !== 'string' || !(data.model === options.model || data.model.startsWith(`${options.model}-`))) return {status:'error',decisions:[],usage};
   const choices=criteria.map((x,i)=>({criterion:`${x.kind}:${i}`, answer:acceptChoice(readChoice(data.answers?.[`q${i}`],['presente','ausente','ambiguo']))}));
   const decisions=choices.map(x=>({criterion:x.criterion,choice:x.answer?.choice ?? 'ambiguo'}));
   if (choices.some(x=>!x.answer || x.answer.choice==='ambiguo')) return {status:'review',decisions,model:data.model,usage};
   const failed=choices.some((x,i)=>criteria[i].kind==='required' ? x.answer!.choice!=='presente' : x.answer!.choice!=='ausente');
   // The lossy privacy filter prevents this signal from automatically promoting a release.
   return {status:failed?'fail':'review',decisions,model:data.model,usage};
  } catch {return {status:'error',decisions:[]};}
 }};
}
