import type { Citation, Intent } from '@claro/contracts';
import type { Decision, DecisionAdapter } from './index.js';
import { safeDecisionFeatures } from './index.js';

type Fetch = typeof globalThis.fetch;
type Choice = { type?: unknown; choice?: unknown; probabilities?: unknown };
const intents = ['soporte_tecnico','facturacion','consulta_planes','cancelacion','portabilidad','fuera_de_alcance','indeterminada'] as const;
const complexity = ['simple','intermedia','compuesta','indeterminada'] as const;
const intentCriteria = {soporte_tecnico:'Falla o procedimiento técnico.', facturacion:'Factura, saldo, cobro o pago.', consulta_planes:'Planes, precios o características.', cancelacion:'Terminar el servicio.', portabilidad:'Portar número.', fuera_de_alcance:'Objetivo ajeno.', indeterminada:'No se puede distinguir el objetivo.'};
const complexityCriteria = {simple:'Un objetivo.', intermedia:'Un objetivo con verificaciones.', compuesta:'Varios objetivos.', indeterminada:'Información insuficiente.'};
function acceptedChoice(value: unknown, labels: readonly string[]): { choice: string; probability: number } | null {
  if (!value || typeof value !== 'object') return null;
  const answer = value as Choice;
  if (answer.type !== 'choice' || typeof answer.choice !== 'string' || !labels.includes(answer.choice) || !answer.probabilities || typeof answer.probabilities !== 'object') return null;
  const p = answer.probabilities as Record<string, unknown>;
  if (Object.keys(p).some(k => !labels.includes(k)) || labels.some(k => typeof p[k] !== 'number' || !Number.isFinite(p[k]) || (p[k] as number) < 0 || (p[k] as number) > 1)) return null;
  const ordered = labels.map(k => p[k] as number).sort((a,b) => b-a);
  const selected = p[answer.choice] as number;
  if (Math.abs(labels.reduce((sum,k)=>sum+(p[k] as number),0)-1) > 0.02 || selected < 0.75 || selected !== ordered[0] || selected - ordered[1] < 0.2) return null;
  return {choice:answer.choice, probability:selected};
}
export type JevOptions = { apiKey: string; model: string; timeoutMs?: number; fetch?: Fetch; semanticTemplate?: string };
export function parseJevQuestion(template:string, expectedKeys:readonly string[], variables:Record<string,string> = {}): {instructions:string;criteria:Record<string,string>} | null {
 try { const value=JSON.parse(template) as {instructions:unknown;criteria:unknown}; if (typeof value.instructions !== 'string' || !value.criteria || typeof value.criteria !== 'object' || Array.isArray(value.criteria)) return null; const criteria=value.criteria as Record<string,unknown>; if (Object.keys(criteria).length !== expectedKeys.length || expectedKeys.some(k=>typeof criteria[k] !== 'string') || Object.keys(criteria).some(k=>!expectedKeys.includes(k))) return null; const render=(s:string)=>s.replace(/{{\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*}}/g,(_,key:string)=>variables[key] ?? ''); return {instructions:render(value.instructions),criteria:Object.fromEntries(expectedKeys.map(k=>[k,render(criteria[k] as string)]))}; } catch { return null; }
}
/** Jev receives only categorical features; API errors and uncertain output abstain. */
export function createJevDecisionAdapter(options: JevOptions): DecisionAdapter {
  if (!options.apiKey || !/^typesafe\/jev-[a-zA-Z0-9.-]+$/.test(options.model)) throw new Error('A server key and explicit Jev model are required');
  return { async classify(text, prompts): Promise<Decision | null> {
    const intentQuestion = prompts?.intent_decision ? parseJevQuestion(prompts.intent_decision,intents) : {instructions:'Clasifica la intención a partir de señales categóricas.',criteria:intentCriteria};
    const complexityQuestion = prompts?.complexity_decision ? parseJevQuestion(prompts.complexity_decision,complexity) : {instructions:'Clasifica la complejidad solo si hay información suficiente.',criteria:complexityCriteria};
    if (!intentQuestion || !complexityQuestion) return null;
    const features = safeDecisionFeatures(text);
    if (features === 'indeterminada') return null;
    try {
      const response = await (options.fetch ?? fetch)('https://openrouter.ai/api/alpha/decisions', {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${options.apiKey}`},signal:AbortSignal.timeout(options.timeoutMs ?? 800),body:JSON.stringify({model:options.model,state:{senales:features},questions:{intencion:{type:'choice',...intentQuestion},complejidad:{type:'choice',...complexityQuestion}}})});
      if (!response.ok) return null;
      const data = await response.json() as {model?: unknown; answers?: Record<string,unknown>};
      if (typeof data.model !== 'string' || !(data.model === options.model || data.model.startsWith(`${options.model}-`))) return null;
      const i = acceptedChoice(data.answers?.intencion,intents); const c = acceptedChoice(data.answers?.complejidad,complexity);
      if (!i || i.choice === 'indeterminada' || i.choice === 'fuera_de_alcance') return null;
      return {intent:i.choice as Intent, confidence:i.probability, complexity:c?.choice === 'compuesta' ? 'complejo' : c?.choice === 'intermedia' ? 'intermedio' : 'economico'};
    } catch { return null; }
  }};
}

export interface EvidenceSelector { select(query: string, citations: Citation[], profile: Decision['complexity'], prompt?:string): Promise<number | null> }
export type OpenAISelectorOptions = {apiKey: string; models: Partial<Record<Decision['complexity'],string>>; timeoutMs?:number; fetch?:Fetch};
/** Responses API selects an already-authorized passage; generated prose is never published. */
export function createOpenAIEvidenceSelector(options: OpenAISelectorOptions): EvidenceSelector {
  if (!options.apiKey) throw new Error('A server key is required');
  for (const model of Object.values(options.models)) if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(model)) throw new Error('Invalid model identifier');
  return {async select(query,citations,profile,prompt) {
    const model = options.models[profile];
    if (!model || citations.length === 0 || citations.length > 3) return null;
    // Labels are from a closed vocabulary; neither the query nor source passages leave the process.
    const candidates = citations.map((c,index)=>({index,senales:safeDecisionFeatures(`${c.title} ${c.excerpt}`)}));
    try {
      const response = await (options.fetch ?? fetch)('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${options.apiKey}`},signal:AbortSignal.timeout(options.timeoutMs ?? 1500),body:JSON.stringify({model,store:false,max_output_tokens:64,input:[{role:'developer',content:prompt || 'Select the most relevant candidate index. Return exactly one digit; if uncertain return -1.'},{role:'user',content:JSON.stringify({senales:safeDecisionFeatures(query),candidates})}]})});
      if (!response.ok) return null;
      const data = await response.json() as {model?:unknown;output?:Array<{type?:unknown;content?:Array<{type?:unknown;text?:unknown}>}>};
      if (typeof data.model !== 'string' || !(data.model === model || data.model.startsWith(`${model}-`))) return null;
      const values = data.output?.flatMap(x=>x.type === 'message' ? (x.content ?? []).filter(c=>c.type === 'output_text').map(c=>c.text) : []) ?? [];
      if (values.length !== 1 || typeof values[0] !== 'string' || !/^[0-2]$/.test(values[0].trim())) return null;
      const index = Number(values[0]); return index < citations.length ? index : null;
    } catch { return null; }
  }};
}

export type SemanticObservation = {question:string; answer:string; evidence:string[]; requiredFacts?:string[]; forbiddenFacts?:string[]; deterministicPassed:boolean};
export type SemanticResult = {status:'pass'|'fail'|'review'|'error'|'not_applicable'; decisions:{criterion:string; choice:string}[]; model?:string};
// Only these generic domain words leave the process. Unknown words, numbers and names are discarded.
const evalVocabulary = new Set('el la los las un una unos unas de del al y o en por para con sin si no se es son esta fue ha hay hasta antes despues desde entre mas menos mismo cliente asesor servicio plan fibra hogar internet tv senal televisor decodificador modem mi claro refrescar reiniciar encendido esperar minutos horas dias factura saldo pago pendiente pagado vencimiento cancelar cancelacion baja descuento oferta alternativa mejora elegible inelegible mora politica ticket visita solicitud registrada agendada confirmada confirmacion aprobada rechazada expirado titular verificado titularidad procedimiento fuente vigente precio incluye consulta soporte error cita evidencia insuficiente puede debe'.split(' '));
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
   const data=await response.json() as {model?:unknown; answers?:Record<string,unknown>};
   if (typeof data.model !== 'string' || !(data.model === options.model || data.model.startsWith(`${options.model}-`))) return {status:'error',decisions:[]};
   const choices=criteria.map((x,i)=>({criterion:`${x.kind}:${i}`, answer:acceptedChoice(data.answers?.[`q${i}`],['presente','ausente','ambiguo'])}));
   const decisions=choices.map(x=>({criterion:x.criterion,choice:x.answer?.choice ?? 'ambiguo'}));
   if (choices.some(x=>!x.answer || x.answer.choice==='ambiguo')) return {status:'review',decisions,model:data.model};
   const failed=choices.some((x,i)=>criteria[i].kind==='required' ? x.answer!.choice!=='presente' : x.answer!.choice!=='ausente');
   // The lossy privacy filter prevents this signal from automatically promoting a release.
   return {status:failed?'fail':'review',decisions,model:data.model};
  } catch {return {status:'error',decisions:[]};}
 }};
}
