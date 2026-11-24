import { ContextDomain, type AgentPorts, type AgentTurn, type CaseIntake, type ConversationContext, type ConversationMemory, type RunResult } from '@claro/contracts';
import { commercialRequest } from './commercial.js';
import { contextIntent, evolveContext, recordQuestion } from './context.js';

type CaseState = Awaited<ReturnType<AgentPorts['readCaseForRun']>>;
type Frame = NonNullable<ConversationContext['frames'][ContextDomain]>;
type Transition = ConversationContext['transition'];
type Variables = ConversationContext['variables'];

const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
const resume = /^[¿¡]?(?:(?:y|ahora)\s+)?(?:volvamos|retomemos|regresemos|volviendo|retomando|sobre lo de)\b/;
const corrections = /^[¿¡]?(?:perdon|corrijo|quise decir|en realidad|no[,]? era|me equivoque)\b/;
const ordinals = ['primer[oa]?','segund[oa]','tercer[oa]?','cuart[oa]','quint[oa]','sext[oa]'];
const ordinal = new RegExp(`\\b(?:el|la)\\s+(?:opcion\\s+)?(${ordinals.join('|')})(?:\\s+de\\s+(?:pospago|prepago))?\\b`);
const catalogueDetail = /^(?:y )?(?:cuanto (?:cuesta|vale)|que (?:incluye|trae)|(?:incluye|trae|tiene) )/;
const catalogueCorrection = /^(?:[¿¡]?(?:perdon|corrijo|quise decir|en realidad|me equivoque)[,:]?\s+(?:(?:era|es)\s+)?|no[,]? era\s+)((?:el|la)\s+(?:de\s+|plan\s+|paquete\s+)?(?:\d+\s*(?:gb|mbps)|ilimitad[oa]|semanal|mensual|diario|primer[oa]?|segund[oa]|tercer[oa]?))[.!?]*$/;
const slotKeys: Record<ContextDomain, ReadonlySet<string>> = {
  consulta_planes:new Set(['producto','plan','modalidad','uso','vivienda']),
  soporte_tecnico:new Set(['equipo','codigo','sintoma','medio','velocidad','alcance_intermitencia','duracion','cable','imagen']),
  facturacion:new Set(['objetivo','cargo','fecha_pago','medio_pago','pago'])
};

function domainOf(value: string | undefined): ContextDomain | undefined {
  const parsed = ContextDomain.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function interpretConversation(text:string, context?:ConversationContext) {
  const normalized = normalize(text);
  const resuming = resume.test(normalized);
  const separator = resuming ? text.search(/[,;:]|\s(?=¿)/) : -1;
  const heading = normalize(separator>=0 ? text.slice(0,separator) : text);
  const resumable=Object.values(context?.frames ?? {}).filter(frame=>frame.intent!==context?.active);
  const domain = (resuming ? domainOf(contextIntent(heading)) ??
    (/\b(?:movil|celular|catalogo|comercial)\b/.test(heading) ? 'consulta_planes'
      : /\b(?:soporte|equipo|decodificador)\b/.test(heading) ? 'soporte_tecnico'
      : resumable.length===1 ? resumable[0]?.intent : undefined) : undefined) ??
    (context?.active==='consulta_planes' && context.frames.consulta_planes?.catalogue &&
      catalogueDetail.test(normalized.replace(/^[¿¡]/,'')) && commercialRequest(text,text,context.frames.consulta_planes.catalogue)
      ? 'consulta_planes' : domainOf(contextIntent(text)));
  const correction=normalized.match(catalogueCorrection);
  const effective = separator>=0 && resuming && domain ? (text.slice(separator+1).trim() || text)
    : context?.active==='consulta_planes' && correction ? `Qué incluye ${correction[1]}` : text;
  return {domain,text:effective,resuming:resuming&&Boolean(domain),ambiguous:resuming&&!domain&&resumable.length>1,correction:corrections.test(normalized)};
}

function evolveIntake(text:string,domain:ContextDomain,prior?:CaseIntake) {
  const candidate=evolveContext(text,undefined,domain);
  if (candidate?.intent!==domain) return prior;
  const symptomChanged=domain==='soporte_tecnico' && prior && (
    candidate.facts.sintoma && prior.facts.sintoma && candidate.facts.sintoma!==prior.facts.sintoma ||
    candidate.facts.codigo && prior.facts.codigo && candidate.facts.codigo!==prior.facts.codigo);
  return symptomChanged ? candidate : evolveContext(text,prior,domain);
}

function resolvePresentedOption(text:string, memory?:ConversationMemory) {
  const query=normalize(text);
  const match=query.match(ordinal);
  if (!match) return {text};
  if (!memory?.presented_plans?.length) return {text,unresolved:true};
  const group=/\bprepago\b/.test(match[0]) ? 'movil_prepago' : /\bpospago\b/.test(match[0]) ? 'movil_pospago' : undefined;
  const presented=memory.presented_plans.filter(plan=>!group||plan.segment===group);
  const index=ordinals.findIndex(pattern=>new RegExp(`^${pattern}$`).test(match[1]!));
  const plan=presented[index];
  if (!plan) return {text,unresolved:true};
  const rewritten=query.replace(match[0],plan.name);
  return {text:/^[¿¡]?(?:y\s+)?(?:el|la)\b/.test(query) ? `Qué incluye ${plan.name}` : rewritten};
}

export function prepareConversation(turn:AgentTurn, state:CaseState) {
  const before=state.conversation_context;
  const reading=interpretConversation(turn.text,before);
  const eligible=turn.actor==='cliente' && turn.audience==='cliente' && turn.attention_mode==='autoservicio';
  if (!eligible) return {turn,state,before,reading,unresolved:false,domain:undefined};
  const foreignIntent=contextIntent(turn.text);
  const priorOutsideDomain=state.intake && !domainOf(state.intake.intent);
  const domain=reading.domain ?? (foreignIntent || priorOutsideDomain ? undefined : before?.active);
  const frame=domain ? before?.frames[domain] : undefined;
  const catalogue=domain==='consulta_planes' ? frame?.catalogue ?? state.conversation_memory : undefined;
  const resolved=domain==='consulta_planes' ? resolvePresentedOption(reading.text,catalogue) : {text:reading.text};
  const previous=frame?.intake ?? (state.intake?.intent===domain ? state.intake : undefined);
  const intake=domain && (frame || reading.resuming) ? evolveIntake(resolved.text,domain,previous) : state.intake;
  const returning=reading.resuming || Boolean(frame && domain!==before?.active);
  const useRestoredContext = Boolean(domain && (before || reading.resuming));
  const effectiveState=useRestoredContext ? {...state,intake,
    public_route:returning ? domain : state.public_route,
    conversation_memory:domain==='consulta_planes' ? catalogue : foreignIntent ? undefined : state.conversation_memory} : state;
  return {turn:{...turn,text:resolved.text},state:effectiveState,before,reading,unresolved:!!resolved.unresolved||reading.ambiguous,
    domain:returning || frame && !foreignIntent && /^(?:[¿¡]?)(?:y\b|eso\b|(?:ese|esa|este|esta)\b|que (?:incluye|trae|hago|sigue)\b|como (?:funciona|lo hago|sigo)\b|cuanto (?:cuesta|tarda|dura)\b)/.test(normalize(resolved.text)) ? domain : undefined};
}

function makeFrame(domain:ContextDomain, action:Frame['action'], turn:number, old:Frame|undefined,
  intake?:CaseIntake, catalogue?:ConversationMemory, account?:{kind:'invoice'|'balance';verified:boolean}):Frame {
  const slots: Frame['slots'] = {};
  const put=(key:string,value: string | undefined,source:Frame['slots'][string]['source'],status:Frame['slots'][string]['status'])=>{
    const previous=old?.slots[key];
    slots[key]=previous && previous.value===value && previous.source===source && previous.status===status
      ? previous : {value,source,status,turn};
  };
  for (const [key,value] of Object.entries(intake?.facts ?? {})) {
    if (slotKeys[domain].has(key)) put(key,value,'cliente','confirmado');
  }
  if (intake?.pending && slotKeys[domain].has(intake.pending) && !slots[intake.pending]) {
    put(intake.pending,undefined,'plataforma','pendiente');
  }
  const plan=catalogue?.focused_plan ?? catalogue?.selected_plan;
  const selection=catalogue?.selected_plan;
  if (plan) put('plan_en_consulta',plan.name,'catalogo','inferido');
  if (selection) put('plan_elegido',selection.name,'cliente','confirmado');
  if (domain==='facturacion') {
    const prior=old?.slots.consulta_cuenta;
    if (account) put('consulta_cuenta',account.kind,'plataforma',account.verified ? 'confirmado' : 'pendiente');
    else if (prior) slots.consulta_cuenta=prior;
  }
  return {intent:domain,action,last_turn:turn,entities:{
    ...(plan ? {plan:{name:plan.name,segment:plan.segment}} : {}),
    options:catalogue?.presented_plans,equipment:domain==='soporte_tecnico' ? intake?.facts.equipo : undefined
  },slots,intake,catalogue};
}

function transitionOf(before:ConversationContext|undefined, domain:ContextDomain, correction:boolean):Transition {
  if (!before) return 'iniciar';
  if (before.active===domain) return correction ? 'corregir' : 'continuar';
  return before.frames[domain] ? 'retomar' : 'cambiar';
}

function updateContext(before:ConversationContext|undefined, frame:Frame, variables:Variables, correction:boolean):ConversationContext {
  return {version:1,active:frame.intent,transition:transitionOf(before,frame.intent,correction),
    frames:{...before?.frames,[frame.intent]:frame},variables};
}

const actions = {list:'listar',select:'elegir',price:'consultar',detail:'detallar',download:'descargar',purchase:'contratar'} as const;

export function finishConversation(prepared:ReturnType<typeof prepareConversation>, result:RunResult, turn:AgentTurn):ConversationContext|undefined {
  const {before,state,reading}=prepared;
  const domain=domainOf(result.route);
  if (result.type==='failed' || !domain || turn.actor!=='cliente' || reading.ambiguous) return;
  const old=before?.frames[domain];
  const grounded=result.type==='answer' && (result.citations.length || result.context_question)
    || result.type==='handoff' && (result.verification_required || result.commercial_plan)
    || result.type==='card' && result.card.intent===domain;
  if (reading.domain!==domain && before?.active!==domain && prepared.domain!==domain && !grounded) return;
  const previous=state.intake?.intent===domain ? state.intake : old?.intake;
  const intake=evolveIntake(prepared.turn.text,domain,previous);
  const question=result.type==='answer' ? result.context_question : result.type==='card' ? result.card.context_question : undefined;
  if (intake && question) recordQuestion(intake,question);
  const priorCatalogue=old?.catalogue ?? state.conversation_memory;
  const catalogue=domain!=='consulta_planes' ? undefined : result.type==='answer'
    ? result.conversation_memory ?? priorCatalogue
    : result.type==='handoff' && result.commercial_plan ? {...priorCatalogue,selected_plan:result.commercial_plan} : priorCatalogue;
  const request=domain==='consulta_planes' ? commercialRequest(prepared.turn.text,prepared.turn.text,priorCatalogue) : undefined;
  const action=prepared.unresolved || result.type==='answer' && result.needs_clarification && !result.citations.length ? 'aclarar'
    : request ? actions[request.action] : catalogue?.preference==='lower_price' ? 'comparar'
      : domain==='soporte_tecnico' ? intake?.facts.imagen ? 'confirmar' : 'diagnosticar' : 'consultar';
  const edition=domain==='consulta_planes' && result.type==='answer' ? result.citations.find(citation=>/^CAT-/.test(citation.version))?.version : undefined;
  const frame=makeFrame(domain,action,turn.turn_seq,old,intake,catalogue);
  return updateContext(before,frame,{channel:turn.channel,business_date:turn.business_date,config_revision:turn.config_revision,
    verified:state.verified,awaiting_advisor:!!state.pending,catalogue_version:edition ?? before?.variables.catalogue_version},reading.correction);
}

export function platformBillingContext(before:ConversationContext|undefined, input:string, turn:number,
  variables:Variables, accountKind:'invoice'|'balance'):ConversationContext {
  const old=before?.frames.facturacion;
  const reading=interpretConversation(input,before);
  const intake=evolveIntake(reading.text,'facturacion',old?.intake);
  return updateContext(before,makeFrame('facturacion',variables.verified ? 'consultar' : 'aclarar',turn,old,intake,undefined,
    {kind:accountKind,verified:variables.verified}),
    {...variables,catalogue_version:before?.variables.catalogue_version},reading.correction);
}

export function traceConversation(context:ConversationContext|undefined) {
  if (!context) return null;
  const frames=Object.fromEntries(Object.entries(context.frames).map(([domain,frame])=>[domain,{
    action:frame.action,last_turn:frame.last_turn,entity:frame.entities.plan?.name,
    options:frame.entities.options?.length,
    slots:Object.fromEntries(Object.entries(frame.slots).map(([key,{status,source,turn}])=>[key,{status,source,turn}]))
  }]));
  return {version:context.version,intent:context.active,transition:context.transition,frames,variables:context.variables};
}
