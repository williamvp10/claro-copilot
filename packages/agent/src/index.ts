export { createOpenAIPublicWriter, isModelObservation, modelObservationNames, validateDraft } from './generation.js';
export type { AgentObservation, PublicWriter } from './generation.js';
import type { AgentObservation, Profile, PublicWriter } from './generation.js';
import { safeKnowledgeQuery } from './mcp.js';
import { claimedBillingAccount, explainInvoiceChange, invoicePeriods, reportedAdjustmentAmount } from './billing-evidence.js';
export { claimedBillingAccount, explainInvoiceChange, invoicePeriods } from './billing-evidence.js';
import { renderCaseSummary, renderTemplate, reportedHandoffAttempt } from './case-summary.js';
export { renderCaseSummary } from './case-summary.js';
import { withinDeadline } from './deadline.js';
import { TurnReads } from './read-budget.js';
import { guidePlans, homePlanPreference, plansDiscovery, prepareKnowledgeQuery, rankKnowledge, retentionPolicyQuery, wifiConfigurationSteps } from './retrieval.js';
import { alternativePlan, cancellationRequest, changesCancellationToPlan, portabilityRequest, validObjectiveOrder, type ObjectivePlanner } from './objectives.js';
export { changesCancellationToPlan, createOpenAIObjectivePlanner } from './objectives.js';
import { contextIntent, evolveContext, nextContextQuestion, questionById } from './context.js';
import { billingCycleReply, esimCompatibilityFilter, homePlanReply, mobilePlanTopic, mobilePlanReply, publicReplyLimit, quotedPublicReply, shortPublicEvidence, triplePlayReply } from './public-reply.js';
import { advisorEscalationReply, advisorPromotionReply, mobileCommitmentQuestion, mobileCommitmentReply, portabilityTimingQuestion, retentionOptionsReply } from './policy-reply.js';
import { catalogComparison, catalogComparisonAfterWithdrawal, catalogMemoryFromReply, catalogPlans, compareCatalog } from './catalogue.js';
import { answerCommercial, commercialHandoff, commercialRequest, confirmCommercialPurchase, offerPrice } from './commercial.js';
import { finishConversation, prepareConversation } from './conversation-context.js';
export { interpretConversation, platformBillingContext, traceConversation } from './conversation-context.js';
export { commercialHandoff } from './commercial.js';
export { catalogComparison, catalogPlans } from './catalogue.js';
export { asksToChangeMobilePlan, mobilePlanTopic } from './public-reply.js';
export { contextIntent, evolveContext, nextContextQuestion, recordQuestion, contextQuestions, contextCatalogVersion } from './context.js';
export { retrievalTerms } from './retrieval.js';
export { retentionPolicyQuery } from './retrieval.js';
export { createKnowledgeMcpAdapter, isTransientMcpRead, safeKnowledgeQuery } from './mcp.js';
export type { KnowledgeMcpOptions } from './mcp.js';
export { createOpenAIEvidenceSelector, createJevSemanticEvaluator, parseJevQuestion } from './providers.js';
export type { JevOptions, OpenAISelectorOptions, EvidenceSelector, SemanticObservation, SemanticResult } from './providers.js';
import type { EvidenceSelector } from './providers.js';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { ADVISOR_ADJUSTMENT_LIMIT, AgentTurn as TurnSchema, RunResult as ResultSchema, TransientReadError } from '@claro/contracts';
import type { AgentPorts, AgentRunner, AgentTurn, CaseIntake, CatalogPlan, KnowledgeSearchFilters, KnowledgeTags, RunResult, RunResume, Citation, Fact, Intent, Message, Retention } from '@claro/contracts';

export type KnowledgeDocument = Citation & { scope: 'public' | 'advisor'; effective_from: string; effective_to?: string; status?: 'ready' | 'draft'; channels?: string[]; products?: string[]; type?: string; provider_approved?: true; metadata?:KnowledgeTags };
export interface KnowledgeAdapter {
  revision?: string;
  catalog?(context: {business_date:string;channel:string}): Promise<CatalogPlan[]>;
  search(query: string, context: { business_date: string; audience: 'cliente' | 'asesor'; channel: string; filters?:KnowledgeSearchFilters }): Promise<KnowledgeDocument[]>;
}
export interface CheckpointStore { get(key: string): Promise<RunResult | undefined>; put(key: string, result: RunResult): Promise<void> }
export type AgentOptions = { requireApprovedPrompts?: boolean; documents?: KnowledgeDocument[]; knowledge?: KnowledgeAdapter; checkpoints?: CheckpointStore; rerank?: (query: string, documents: KnowledgeDocument[]) => Promise<KnowledgeDocument[]>; evidenceSelector?: EvidenceSelector; writer?: PublicWriter; planner?: ObjectivePlanner; turnTimeoutMs?:number; observe?: (runId: string, observation: AgentObservation) => void; };

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const tokens = (s: string) => norm(s).match(/[a-z0-9]+/g)?.filter(x => x.length > 2) ?? [];
const has = (s: string, re: RegExp) => re.test(norm(s));
const defaultDocuments: KnowledgeDocument[] = [{ id: 'catalogo-2026-fibra500', title: 'Catálogo de Planes y Tarifas 2026, pág. 1', version: 'CAT-2026 v1.0', excerpt: 'Hogar Fibra 500: 500 Mbps, $109.900 mensuales, módem WiFi 6 y 1 repetidor WiFi. Los precios incluyen IVA.', scope: 'public', effective_from: '2026-11-01', status: 'ready' }];
type KnowledgeTurn = Pick<AgentTurn, 'text' | 'run_id' | 'business_date' | 'audience' | 'channel'> & { home_preference?: ReturnType<typeof homePlanPreference>; intake?:CaseIntake; deadline?: number; reads?:TurnReads };
function allowed(doc: KnowledgeDocument, turn: KnowledgeTurn): boolean {
  return doc.status !== 'draft' && doc.effective_from <= turn.business_date && (!doc.effective_to || turn.business_date < doc.effective_to) && (turn.audience === 'asesor' || doc.scope === 'public') && (!doc.channels || doc.channels.includes(turn.channel));
}
function citation(doc: KnowledgeDocument): Citation {
  const {id,title,excerpt,version,url,source}=doc;
  return {id,title,excerpt,version,...(url?{url}:{}),...(doc.scope==='public' && source?{source}:{})};
}
function classify(text: string): Intent | undefined {
  if (changesCancellationToPlan(text)) return 'consulta_planes';
  if (retentionPolicyQuery(text) || has(text, cancellationRequest)) return 'cancelacion';
  if (has(text, /convergencia|convergente|\b(telefonia|linea|movil) pospago\b/) && has(text, /hogar|plan|combinar|paquete/)) return 'consulta_planes';
  if (has(text, portabilityRequest)) return 'portabilidad';
  if (has(text, /factur|saldo|cobr|vencimiento|pagar|pago|\b(?:debo|adeudo|deuda|f-\d{4,10})\b/)) return 'facturacion';
  if (has(text, /descuento|oferta/)) return 'consulta_planes';
  if (has(text, /\b(e-202|se cae|intermitencia|sin (?:internet|senal)|luces? del modem|fallas?)\b/)) return 'soporte_tecnico';
  if (has(text, /plan|fibra|precio|velocidad/)) return 'consulta_planes';
}
function planConversation(turn: AgentTurn, messages: Message[]): AgentTurn & KnowledgeTurn {
  if (turn.audience !== 'cliente' || turn.actor !== 'cliente') return turn;
  const preference = homePlanPreference(turn.text);
  if (plansDiscovery(turn.text) === 'home') return {...turn,home_preference:preference};
  const previous = messages.filter(m=>m.actor==='agente' && m.turn_seq<turn.turn_seq).at(-1);
  if (mobilePlanTopic(turn.text,previous)==='change') return {...turn,text:'¿Puedo cambiar mi plan móvil?'};
  if (previous?.citations?.some(c=>/^CAT-\d/.test(c.version)) && previous.text.split(/\n+(?:Ver fuente|Fuente):/)[0]?.endsWith('?')) {
    if (has(previous.text,/vivienda|dispositivos/) && preference) {
      return {...turn,text:'Planes de internet para el hogar',home_preference:preference};
    }
    if (has(previous.text,/plan mensual o prefieres recargar/)) {
      if (has(turn.text,/^(?:prefiero |quiero |me interesa )?(?:el |un )?(?:plan )?(?:mensual|pospago)[.?!]*$/)) {
        return {...turn,text:'Planes de telefonía móvil pospago'};
      }
      if (has(turn.text,/^(?:prefiero |quiero |me interesa )?(?:el |un )?(?:plan )?(?:prepago|recargar|recargas)[.?!]*$/)) {
        return {...turn,text:'Planes de telefonía móvil prepago'};
      }
    }
    if (has(previous.text,/hogar/) && has(previous.text,/movil|celular/) && has(turn.text,/^(?:para (?:el |mi |la )?|de |internet para (?:mi |la )?)?(?:hogar|casa|apartamento|fibra|celular|movil|linea movil)[.?!]*$/)) {
      return {...turn,text:has(turn.text,/celular|movil/) ? 'Planes de telefonía móvil' : 'Planes de internet para el hogar'};
    }
  }
  return turn;
}
function recentPurpose(messages: Message[], turn: AgentTurn): Intent {
  const meaningful = messages.filter(m => m.actor === 'cliente' && m.turn_seq < turn.turn_seq).reverse()
    .find(m => !accepted(m.text) && (contextIntent(m.text) || has(m.text,alternativePlan)));
  return classify(meaningful?.text ?? turn.text) ?? 'soporte_tecnico';
}

function isPublicContinuation(turn: AgentTurn) {
  return turn.actor==='cliente' && turn.audience==='cliente' && turn.attention_mode==='autoservicio' &&
    has(turn.text,/^\s*[¿¡]?(?:y\b|eso\b|(?:ese|esa|este|esta)\b|que (?:incluye|trae|hago|sigue)\b|como (?:funciona|lo hago|sigo)\b|cuanto (?:cuesta|tarda|dura)\b)/);
}
/** Sends only fixed categorical signals, never customer-authored text. */
export function safeDecisionFeatures(text: string): string {
  const value = norm(text);
  const features: string[] = [];
  for (const [label, pattern] of [
    ['cancelacion', /cancel|retir|baja/], ['portabilidad', portabilityRequest],
    ['facturacion', /factur|saldo|cobr|pagar|pago/], ['planes', /plan|fibra|precio|velocidad/],
    ['soporte', /soporte|internet|senal|deco|modem|falla|averia|error/], ['descuento', /descuento|oferta/],
    ['humano', /asesor|supervisor|humano/]
  ] as const) if (pattern.test(value)) features.push(label);
  return features.join(' ') || 'indeterminada';
}
type PolicyRoute = {destination:'soporte_tecnico'|'supervision';reason_code:string};
const policyReasons: Record<string,string> = {
  riesgo_de_fraude:'El cliente reportó una posible suplantación o fraude.',
  requerimiento_legal_o_regulatorio:'El cliente mencionó un requerimiento legal o regulatorio.',
  riesgo_o_vulnerabilidad:'El cliente describió una situación de riesgo o vulnerabilidad.',
  solicitud_de_tercero:'La solicitud involucra una cuenta de un tercero.',
  confianza_o_evidencia_insuficiente:'El cliente expresó falta de confianza o de evidencia.',
  supervision_solicitada:'El cliente pidió hablar con supervisión.',
  los_rojo_mas_de_10_minutos:'El cliente reportó la luz LOS roja durante más de diez minutos.',
  mas_de_tres_reinicios:'El cliente reportó más de tres reinicios sin resolver la falla.',
  dano_fisico:'El cliente reportó un posible daño físico.'
};
/** Only explicit customer signals select a mandatory route; document/tool text is never consulted. */
export function mandatoryPolicyRoute(text:string):PolicyRoute | undefined {
 const value=norm(text);
 if (/\b(fraude|estafa|suplantacion|suplantaron|robo de identidad)\b/.test(value)) return {destination:'supervision',reason_code:'riesgo_de_fraude'};
 if (/\b(tutela|sic|superintendencia|demanda|abogado|orden judicial|requerimiento legal|reclamo regulatorio)\b/.test(value)) return {destination:'supervision',reason_code:'requerimiento_legal_o_regulatorio'};
 if (/\b(vulnerable|vulnerabilidad|menor de edad|adulto mayor|discapacidad|violencia|amenaza|emergencia|riesgo)\b/.test(value)) return {destination:'supervision',reason_code:'riesgo_o_vulnerabilidad'};
 if (/\b(tercero|tercera persona|no soy el titular|no soy la titular|a nombre de (mi|otra|otro)|cuenta de (mi|otra|otro)|soy (el|la) (hijo|hija|esposa|esposo|familiar|apoderado))\b/.test(value)) return {destination:'supervision',reason_code:'solicitud_de_tercero'};
 if (/\b(no confio|falta de confianza|evidencia insuficiente|sin evidencia)\b/.test(value)) return {destination:'supervision',reason_code:'confianza_o_evidencia_insuficiente'};
 if (/\bsupervisor|supervision\b/.test(value)) return {destination:'supervision',reason_code:'supervision_solicitada'};
 const los=/\b(los|luz los)\b/.test(value) && /\b(roj[oa]|rojas|rojos)\b/.test(value);
 const minute=[...value.matchAll(/(\d+)\s*(?:minutos?|mins?)/g)].some(m=>Number(m[1])>10) || /\b(mas de (?:diez|10) minutos?|(?:media|una|dos|varias|[1-9]\d*) horas?)\b/.test(value);
 if (los && minute) return {destination:'soporte_tecnico',reason_code:'los_rojo_mas_de_10_minutos'};
 const restart=[...value.matchAll(/(?:reinici(?:e|ado|ar|amos|o)|reinicios?)[^.!?]{0,35}?(\d+)\s*veces/g)].some(m=>Number(m[1])>3) || /(?:reinici(?:e|ado|ar|amos|o)|reinicios?)[^.!?]{0,35}?(?:cuatro|cinco|seis|mas de tres) veces/.test(value) || /(?:mas de tres|cuatro|cinco|seis|[4-9]|[1-9]\d+)\s+reinicios?/.test(value);
 if (restart) return {destination:'soporte_tecnico',reason_code:'mas_de_tres_reinicios'};
 if (/\b(dano fisico|cable (?:esta )?(?:roto|cortado|danado)|fibra (?:esta )?(?:rota|cortada|danada)|equipo (?:esta )?(?:roto|danado)|conector (?:esta )?(?:roto|danado))\b/.test(value)) return {destination:'soporte_tecnico',reason_code:'dano_fisico'};
 return undefined;
}
function needsLosDuration(text:string):boolean {
 const value=norm(text);
 return /\blos\b/.test(value) && /\b(roj[oa]|rojas|rojos)\b/.test(value) && !/\b(?:\d+|un|una|dos|tres|cuatro|cinco|diez|media|varias|varios)\s*(?:minutos?|mins?|horas?|dias?)\b/.test(value);
}
function reportedLos(text:string):string {
  const items=norm(text).split(/[.!?;\n]+/);
  const symptom=items.find(item=>/\blos\b.{0,65}\broja\b/.test(item) &&
    !/\b(?:ya no|no (?:esta|sigue|se ve)|dejo de (?:estar|verse))\s+(?:la luz los\s+)?roja\b/.test(item));
  if (!symptom) return '';
  const elapsed='((?:mas de )?(?:\\d{1,3}|diez|veinte|treinta|media|una|dos|tres)\\s+(?:minutos?|horas?))';
  const duration=symptom.match(new RegExp(`\\blos\\b.{0,30}\\blleva ${elapsed} roja\\b`))?.[1] ??
    symptom.match(new RegExp(`\\broja (?:desde hace|hace|durante) ${elapsed}\\b`))?.[1];
  return duration ? `El cliente reporta luz LOS roja desde hace ${duration.replace(/^mas de /,'más de ')}.` : 'El cliente reporta la luz LOS roja.';
}
export function waitingForSupportVisit(text:string):boolean {
  return has(text,/\b(?:espero|esperando|a la espera de|sigo pendiente de|pendiente de) (?:la |una |su )?visita\b/) &&
    !has(text,/\b(?:cancel\w*|reprogram\w*|cambiar (?:la|mi) visita|factur\w*|cobr\w*)\b/);
}
function asksCurrentPlanAndBalance(text:string):boolean {
 return has(text,/\b(?:plan(?:es)?|servicios?) (?:actual(?:es)?|vigentes?)\b/) && has(text,/\b(?:saldo|deuda|adeudo|debo)\b/);
}
function asksReconnectionCharge(text: string): boolean {
  return has(text,/\breconec\w*\b/) && has(text,/\b(?:cuanto|cuesta|cobr\w*|costo|cargo|precio|tarifa)\b/);
}
function cancellationWithFaults(text:string):boolean {
 return has(text,/\b(?:cancel\w*|retir\w*|dar de baja)\b/) && has(text,/\b(?:fallas?|averias?|intermitencia|caidas?|se cae|sin internet)\b/)
  && !has(text,/\b(?:sin fallas?|no (?:tengo|hay) fallas?|no (?:es )?por fallas?)\b/);
}
function accepted(text: string): boolean { return has(text, /\b(acepto|aceptamos|aceptaria|de acuerdo|si quiero|si acepto|me sirve|lo acepto|la acepto|tomare|quiero esa|quiero ese)\b/) && !has(text, /\b(no acepto|no quiero|no me sirve|acepto si|acepto cuando)\b/); }
function selectOption(text: string, options: Retention['options'], messages: Message[]): Retention['options'][number] | undefined {
  const context = norm(text);
  const kind = /descuento|por ciento|%|rebaja/.test(context) ? 'discount' : /mejora|500|upgrade|velocidad/.test(context) ? 'upgrade' : undefined;
  const choose = (s: string) => kind === 'discount' ? /descuento|por ciento|%|rebaja|discount/.test(s) : /mejora|500|upgrade|velocidad/.test(s);
  if (kind) return options.find(o => choose(norm(`${o.id} ${o.title} ${o.detail}`)));
  if (options.length === 1) return options[0];
  const previous = [...messages].reverse().find(m => m.actor === 'asesor');
  if (previous) {
    const p = norm(previous.text), mentioned = options.filter(o => {
      const s = norm(`${o.id} ${o.title} ${o.detail}`);
      return (/descuento|%|discount/.test(s) && /descuento|%/.test(p)) || (/mejora|500|upgrade/.test(s) && /mejora|500/.test(p));
    });
    if (mentioned.length === 1) return mentioned[0];
  }
  return undefined;
}
function card(intent: Intent, summary: string, facts: Fact[], citations: Citation[], pending: string[], next_action: string, reason_codes: string[], proposal?: Awaited<ReturnType<AgentPorts['createProposal']>>): RunResult {
  return { type: 'card', route: intent, card: { intent, summary, facts, citations, pending, next_action, reason_codes, ...(proposal ? { proposal } : {}) } };
}

/** The read-only retrieval and answer path shared by attention and the admin lab. */
export function createKnowledgePipeline(options:Pick<AgentOptions,'requireApprovedPrompts'|'documents'|'knowledge'|'rerank'|'evidenceSelector'|'writer'|'observe'>) {
  type SearchPlan=ReturnType<typeof prepareKnowledgeQuery>;
  const Retrieval = Annotation.Root({turn:Annotation<KnowledgeTurn>(), plan:Annotation<SearchPlan>(),
    ranked:Annotation<KnowledgeDocument[]>(), unavailable:Annotation<boolean>(), attempts:Annotation<number>()});
  const graph=new StateGraph(Retrieval)
    .addNode('plan_search',({turn})=>({plan:prepareKnowledgeQuery(turn.text,turn.intake)}))
    .addNode('find_evidence',async ({turn,plan})=>{
      let attempts=0;
      async function search(query:string) {
        if (Date.now() >= (turn.deadline ?? Infinity)) throw new Error('knowledge deadline expired');
        const read=()=>{
          attempts+=1;
          return options.knowledge?.search(query,{business_date:turn.business_date,audience:turn.audience,
            channel:turn.channel,filters:plan.filters}) ?? Promise.resolve(options.documents ?? defaultDocuments);
        };
        const docs=turn.reads ? await turn.reads.read({tool:'search_knowledge',agent:'conocimiento',step:'retrieve_knowledge',
          purpose:'find_applicable_evidence',selector:JSON.stringify([query,plan.filters]),read}) : await read();
        if (!docs) throw new Error('knowledge unavailable');
        const permitted=docs.filter(doc=>allowed(doc,turn) &&
          !has(doc.excerpt,/\b(?:ignora|omite|desobedece|reemplaza) (?:tus |las )?(?:instrucciones|reglas)\b|\b(?:system prompt|mensaje de sistema)\b/) &&
          (!plan.filters.source ||
          (doc.metadata?.source ?? doc.id.replace(/-\d{3}$/,''))===plan.filters.source));
        return rankKnowledge(query,permitted,plan.filters);
      }
      try {
        let ranked=await search(plan.query);
        const exact=plan.filters.tags.find(tag=>tag==='elegibilidad' || tag==='e-202' || tag.startsWith('fibra-'));
        const weak=exact && ranked[0]?.metadata && !ranked[0].metadata.tags.includes(exact);
        if ((!ranked.length || weak) && plan.retry && plan.retry!==plan.query && Date.now() < (turn.deadline ?? Infinity)) {
          const second=await search(plan.retry).catch(error=>{
            if (!ranked.length) throw error;
            return [];
          });
          if (!ranked.length || second[0]?.metadata?.tags.includes(exact ?? '')) ranked=second;
        }
        return {ranked,unavailable:false,attempts};
      } catch {
        return {ranked:[],unavailable:true,attempts};
      }
    }).addEdge(START,'plan_search').addEdge('plan_search','find_evidence').addEdge('find_evidence',END).compile();
  async function retrieve(turn: KnowledgeTurn, profile: Profile, prompts:Record<string,string>, selectEvidence = true) {
    const started = Date.now();
    const timeout = {turn,plan:prepareKnowledgeQuery(turn.text,turn.intake),ranked:[],unavailable:true,attempts:0};
    const {plan,ranked,unavailable,attempts}=await withinDeadline(turn.deadline ?? Infinity,()=>graph.invoke({turn}),timeout);
    const revision=options.knowledge?.revision ?? 'legacy';
    let docs=ranked;
    const rerank=options.rerank;
    if (rerank && docs.length) {
      try {
        const candidates = docs;
        const reordered = await withinDeadline(turn.deadline ?? Infinity,()=>rerank(turn.text,candidates),candidates);
        const keys = new Set(candidates.map(d => `${d.id}\0${d.version}`));
        docs = reordered.filter(d => keys.has(`${d.id}\0${d.version}`)).map(d => candidates.find(c => c.id === d.id && c.version === d.version)!);
      } catch { /* use the filtered lexical ranking */ }
    }
    options.observe?.(turn.run_id, { name:'retrieval', started, ended:Date.now(),
      metadata:{ count:docs.length, top_5:docs.slice(0,5).map(x=>x.id).join(','), agent_id:'conocimiento',step_id:'retrieve_knowledge',tool_id:'search_knowledge',
        index_revision:revision, tags:plan.filters.tags.join(','), source:plan.filters.source ?? '', attempts } });
    const shortlist = docs.slice(0, 3);
    const candidates = selectEvidence ? await selectPublicEvidence(turn,profile,prompts.public_evidence_selector,shortlist) : shortlist;
    return { candidates, ranked:docs, unavailable, search:{query:plan.query,...plan.filters,attempts,revision} };
  }
  async function selectPublicEvidence(turn:KnowledgeTurn, profile:Profile, prompt:string|undefined, documents:KnowledgeDocument[]) {
    const publicCandidates = documents.filter(doc=>doc.scope==='public' && doc.provider_approved===true);
    const selector=options.evidenceSelector;
    if (turn.audience==='cliente' && !plansDiscovery(turn.text) && selector && publicCandidates.length > 1 && (!options.requireApprovedPrompts || Boolean(prompt))) {
      try {
        const features=publicCandidates.map(c => ({id:'',title:safeDecisionFeatures(c.title),excerpt:safeDecisionFeatures(c.excerpt),version:''}));
        const index=await withinDeadline(turn.deadline ?? Infinity,()=>selector.select(safeDecisionFeatures(turn.text),features,profile,
          prompt,item=>options.observe?.(turn.run_id,item)),null);
        const selected=index !== null && Number.isInteger(index) ? publicCandidates[index] : undefined;
        if (selected) {
          const position=documents.indexOf(selected);
          return [selected,...documents.slice(0,position),...documents.slice(position+1)];
        }
      } catch { /* preserve filtered lexical order */ }
    }
    return documents;
  }
  async function answer(turn:KnowledgeTurn, profile:Profile, publicPrompt:string, documents:KnowledgeDocument[], checkConflicts=false,
    fallbackEvidencePrompt?:string) {
    if (!documents.length) return null;
    if (checkConflicts && has(turn.text,/\b(?:precio|cuesta|tarifa|valor)\b/)) {
      const rows = documents.filter(doc => doc.type==='catalogo').flatMap(doc =>
        doc.excerpt.split('\n').flatMap(line => {
          const match = line.match(/^(Hogar Fibra \d+|Claro Max [^$]+?)\s+(?:\d+ Mbps\s+)?(\$[\d.,]+)/);
          return match && norm(turn.text).includes(norm(match[1]).replace(/^hogar /,'')) ? [{doc, name:match[1], price:match[2]}] : [];
        }));
      const conflict = rows.some(row => rows.some(other => other.name===row.name && other.price!==row.price));
      if (conflict) return null;
    }
    if (checkConflicts) {
      const policy=mobileCommitmentQuestion(turn.text) ? mobileCommitmentReply(documents) : turn.audience==='asesor'
        ? advisorPromotionReply(turn.text,documents) ?? retentionOptionsReply(turn.text,documents) : null;
      if (policy) {
        const used=policy.docs.map(citation);
        return {answer:policy.text,citations:used,used,mode:'guided' as const};
      }
    }
    if (checkConflicts && turn.audience==='cliente' && has(turn.text,/\bpromoci\w*\b/) && has(turn.text,/\bfibra\s*500\b/)) {
      const catalog=documents.find(doc=>doc.type==='catalogo' &&
        has(doc.excerpt,/promocion fibra 500:[^•]*clientes nuevos de internet hogar/) &&
        has(doc.excerpt,/no\s+aplica para clientes actuales que cambien de plan/));
      if (catalog) {
        const used=[citation(catalog)];
        return {answer:'La promoción de Fibra 500 aplica a nuevas altas de Internet Hogar. Si ya tienes Internet Hogar y cambias de plan, esa promoción no aplica.',citations:used,used,mode:'guided' as const};
      }
    }
    if (checkConflicts && turn.audience==='cliente' && turn.intake?.facts.sintoma==='Lentitud'
        && turn.intake.facts.medio==='Wi-Fi' && !has(turn.text,/intermiten|se corta|videollamad/)) {
      const guide=documents.find(doc=>has(doc.excerpt,/\bmedir (?:la )?velocidad[^.]{0,65}\b(?:computador|equipo) por cable\b/));
      if (guide) {
        const used=[citation(guide)];
        return {answer:'Para comprobar la velocidad del servicio, conecta un computador al módem por cable y mide desde ese equipo.',citations:used,used,mode:'guided' as const};
      }
      return null;
    }
    const quote=checkConflicts && turn.audience==='cliente' && quotedPublicReply(turn.text,documents,turn.channel);
    if (quote) {
      const used=[citation(quote.doc)];
      return {answer:quote.text,citations:used,used,mode:'extractive' as const};
    }
    const guidedOffer=turn.audience==='cliente' &&
      (mobilePlanReply(mobilePlanTopic(turn.text),documents,turn.channel) ?? triplePlayReply(turn.text,documents,turn.channel) ??
        (checkConflicts ? homePlanReply(turn.text,documents,turn.channel) : null));
    const specific=guidedOffer || billingCycleReply(turn.text,documents);
    if (specific) {
      const used=[citation(specific.doc)];
      return {answer:specific.text,citations:used,used,mode:'guided' as const};
    }
    const guided = turn.audience==='cliente' ? guidePlans(turn.text,documents,turn.home_preference) : null;
    if (guided) {
      const used=guided.used.map(citation);
      return {answer:guided.answer,citations:used,used,mode:'guided' as const,needsClarification:guided.needsClarification,contextField:guided.contextField};
    }
    // Keep detailed procedures in the advisor view. The public answer gives a concise sequence.
    const procedure=wifiConfigurationSteps(turn.text,documents);
    if (procedure.length) {
      const sources=procedure.map(citation);
      const address=procedure[0].excerpt.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
      if (turn.audience==='asesor') return {answer:procedure.map(document=>document.excerpt).join('\n'),citations:sources,used:sources,mode:'extractive' as const};
      const user=procedure[1].excerpt.match(/\bUsuario:\s*([a-z\d_-]+)\.\s*Contraseña:\s*la indicada en la etiqueta\b/i)?.[1];
      const menu=procedure[2].excerpt.match(/\bVaya a ([\p{L}\p{N} _-]+(?:\s*>\s*[\p{L}\p{N} _-]+)+),/u)?.[1]?.split('>').map(item=>item.trim());
      const min=procedure[2].excerpt.match(/m[ií]nimo (\d+) caracteres/i)?.[1];
      if (user && menu && address) {
        const path=menu.slice(0,-1).join(', ')+' y '+menu.at(-1);
        return {answer:`Abre ${address} en el navegador. Entra con el usuario ${user} y la clave de la etiqueta. Ve a ${path}. Cambia la contraseña${min?` (mínimo ${min} caracteres)`:''} y guarda.`,
          citations:sources,used:sources,mode:'guided' as const};
      }
    }
    const decoderInstructions=turn.audience==='cliente' && has(turn.text,/\be[ -]?202\b/)
      ? documents.flatMap(doc=>{
          const excerpt=norm(doc.excerpt.replace(/\s+/g,' '));
          const wait=excerpt.match(/\besper(?:a|ar|e) hasta (\d{1,2} minutos?)\b/)?.[1];
          return wait && /\be[ -]?202\b/.test(excerpt) && /\bmi claro\W+mi tv\W+refrescar senal\b/.test(excerpt) &&
            /\b(?:equipo|decodificador) encendido\b/.test(excerpt) ? [{doc,wait}] : [];
        }) : [];
    const decoder=new Set(decoderInstructions.map(item=>item.wait)).size===1 ? decoderInstructions[0] : undefined;
    const decoderSources=decoder ? [citation(decoder.doc)] : [];
    const decoderReply=decoder ? {
      answer:`Abre Mi Claro, entra en Mi TV y elige «Refrescar señal». Deja el decodificador encendido y espera hasta ${decoder.wait}.`,
      citations:decoderSources,used:decoderSources,mode:'guided' as const
    } : null;
    if (checkConflicts && decoderReply) return decoderReply;

    // A remote ranking is only needed when local evidence has not produced a complete reply.
    if (fallbackEvidencePrompt !== undefined) documents=await selectPublicEvidence(turn,profile,fallbackEvidencePrompt,documents);
    const approvedEvidence=documents.filter(document=>document.scope==='public' && document.provider_approved===true).map(citation);
    if (turn.audience==='cliente' && options.writer && approvedEvidence.length && (!options.requireApprovedPrompts || Boolean(publicPrompt))) {
      const writer = options.writer;
      const draft=await withinDeadline(turn.deadline ?? Infinity,()=>writer.write(safeKnowledgeQuery(turn.text),approvedEvidence,profile,publicPrompt,
        observation=>options.observe?.(turn.run_id,{...observation,metadata:{...observation.metadata,agent_id:'copiloto',step_id:'draft_public_reply',prompt_ref:'public_answer'}}),turn.channel,turn.deadline),null);
      if (draft && draft.answer.length<=publicReplyLimit(turn.channel)) return {...draft,used:draft.citations,mode:'openai' as const};
    }
    if (decoderReply) return decoderReply;
    const plan=!checkConflicts && turn.audience==='cliente' && turn.text.match(/\bfibra\s*(300|500|900)\b/i)?.[1];
    if (plan && has(turn.text,/\b(?:incluye|trae|tiene|que ofrece|precio|cuesta)\b/) && !has(turn.text,/\b(?:promocion|iva|instalacion|simetri\w*|permanencia|cargo)\b/)) {
      const rowPattern=new RegExp(`^Hogar Fibra ${plan} +${plan} Mbps +(\\$[\\d.,]+) +([^\\n]+)`,'im');
      for (const doc of documents) {
        const row=doc.metadata?.tags.includes('catalogo') && doc.excerpt.match(rowPattern);
        if (!row) continue;
        const used=[citation(doc)];
        return {answer:`El plan Hogar Fibra ${plan} ofrece ${plan} Mbps por ${row[1]} al mes. Incluye ${row[2].replace(/ \+ /g,', ')}. ¿Qué uso le darías al internet en casa?`,citations:used,used,mode:'guided' as const};
      }
    }
    const multiPart=has(turn.text,/\by (cuanto|cuanta|como|que|cuando|cual)\b/);
    const citations=documents.map(citation);
    const [top]=citations;
    const source=top.id.replace(/-\d{3}$/,'');
    const companion=multiPart ? citations.find((item,index)=>index>0 && item.excerpt!==top.excerpt && item.version===top.version && item.id.replace(/-\d{3}$/,'')===source) : undefined;
    const used=companion ? [top,companion] : [top];
    if (turn.audience==='cliente') {
      const brief=shortPublicEvidence(top.excerpt,turn.channel);
      if (brief && !companion) return {answer:brief,citations:[top],used:[top],mode:'extractive' as const};
      return {answer:'No puedo confirmar ese dato. Puedo pedirle a un asesor que lo revise. ¿Quieres hablar con uno?',citations:[top],used:[top],
        mode:'guided' as const,needsClarification:true};
    }
    return {answer:used.map(item=>item.excerpt).join('\n\n').slice(0,3900),citations,used,mode:'extractive' as const};
  }
  return {retrieve,answer};
}

/** Agent decisions are bounded by server-owned ports; no tool accepts customer identifiers. */
export function createAgent(ports: AgentPorts, options: AgentOptions = {}): AgentRunner {
  const turnTimeoutMs = options.turnTimeoutMs ?? 8000;
  const results = new Map<string, RunResult>();
  const inFlight = new Map<string, Promise<RunResult>>();
  const readBudgets = new Map<string, TurnReads>();
  const get = async (key: string) => (await options.checkpoints?.get(key)) ?? results.get(key);
  const put = async (key: string, value: RunResult) => { results.set(key, value); await options.checkpoints?.put(key, value); };
  const {retrieve: retrieveKnowledge, answer: answerKnowledge} = createKnowledgePipeline(options);
  async function retrieve(turn:AgentTurn & KnowledgeTurn, profile:Profile, prompts:Record<string,string>, selectEvidence=true) {
    return (await retrieveKnowledge({...turn,reads:readBudgets.get(turn.run_id)},profile,prompts,selectEvidence)).candidates;
  }
  type CaseState = Awaited<ReturnType<AgentPorts['readCaseForRun']>>;
  function policyText(turn:AgentTurn,state:CaseState):string {
    const current=norm(turn.text);
    if (/\blos\b/.test(current) || !/\b(?:\d+|un|una|dos|tres|cuatro|cinco|diez|media|varias|varios)\s*(?:minutos?|mins?|horas?|dias?)\b/.test(current)) return turn.text;
    const previous=state.messages.filter(m=>m.actor==='cliente' && m.turn_seq<turn.turn_seq).at(-1);
    return previous && needsLosDuration(previous.text) ? `${previous.text} ${turn.text}` : turn.text;
  }
  function comparisonFor(turn:AgentTurn, state:CaseState, objectivesEnabled:boolean) {
    if (turn.actor!=='cliente') return;
    const changed=objectivesEnabled ? catalogComparisonAfterWithdrawal(turn.text,state.messages,turn.turn_seq) : undefined;
    return changed ?? (turn.audience==='cliente' && turn.attention_mode==='autoservicio'
      ? catalogComparison(turn.text,state.messages,state.conversation_memory,turn.turn_seq) : undefined);
  }
  function commercialFor(turn:AgentTurn, state:CaseState) {
    if (turn.actor!=='cliente' || turn.audience!=='cliente' || turn.attention_mode!=='autoservicio') return;
    const query=planConversation(turn,state.messages);
    const memory=state.conversation_memory;
    const previous=memory?.purchase_confirmation && state.messages.filter(message=>message.turn_seq<turn.turn_seq).at(-1);
    const request=commercialRequest(turn.text,query.text,memory?.purchase_confirmation
      ? {...memory,purchase_confirmation:!!previous && previous.actor==='agente' && previous.text.includes(confirmCommercialPurchase)} : memory);
    // Legacy fixtures with prose-only catalogues still use the knowledge path.
    if (request && (request.action==='list' || request.action==='detail') && !options.knowledge?.catalog && !catalogPlans(options.documents ?? [],turn).length) return;
    return request;
  }
  async function readCatalogue(turn:AgentTurn, deadline:number, purpose:string) {
    const knowledge=options.knowledge;
    if (!knowledge) return catalogPlans(options.documents ?? [],turn);
    const read=()=>knowledge.catalog?.({business_date:turn.business_date,channel:turn.channel}) ?? Promise.resolve([]);
    const budget=readBudgets.get(turn.run_id);
    return budget ? await budget.read({tool:'list_catalog_plans',agent:'comercial',step:'compare_catalogue',purpose,read}) ?? []
      : await withinDeadline(deadline,()=>read().catch(()=>[]),[]);
  }
  const GraphState = Annotation.Root({ turn: Annotation<AgentTurn>(), caseState: Annotation<CaseState>(), context: Annotation<ReturnType<typeof prepareConversation>>(), intent: Annotation<Intent>(), profile: Annotation<Profile>(), publicPrompt: Annotation<string>(), prompts: Annotation<Record<string,string>>(), result: Annotation<RunResult>(), historyOnly:Annotation<boolean>(), objectives:Annotation<Intent[]>(), supportingCards:Annotation<Extract<RunResult,{type:'card'}>[]>(), deadline:Annotation<number>() });
  type Domain = 'soporte' | 'facturacion' | 'comercial';
  type CaseRead = 'crm.get_customer_context' | 'crm.list_services' | 'crm.list_recent_tickets' | 'crm.evaluate_retention'
    | 'billing.get_balance' | 'billing.list_invoices' | 'billing.get_invoice_detail';
  type ReadPurpose = 'identify_affected_service' | 'compare_billed_service' | 'review_recurrence'
    | 'inspect_invoice' | 'review_invoices' | 'explain_balance' | 'review_current_plan' | 'review_customer_context' | 'check_offer_eligibility';
  const domainReads: Record<Domain, readonly CaseRead[]> = {
    soporte:['crm.list_services','crm.list_recent_tickets'],
    facturacion:['crm.list_services','billing.get_balance','billing.list_invoices','billing.get_invoice_detail'],
    comercial:['crm.get_customer_context','crm.list_services','crm.evaluate_retention']
  };
  const sourceUnavailable = (facts:Fact[]) => facts.some(fact => fact.id.endsWith('-unavailable'));
  const explicitAccountBilling = (text:string) => has(text,/\b(mi factura|mi saldo|saldo actual|saldo pendiente|mi vencimiento|mi deuda|cuanto debo|cuanto adeudo|me cobro|me cobraron|f-\d{4,10})\b/);
  const reportsCancellationFaults = (turn:AgentTurn,state:CaseState) => [turn.text,...state.messages
    .filter(message => message.actor==='cliente' && message.turn_seq<turn.turn_seq).map(message => message.text)]
    .some(text => cancellationWithFaults(text) || has(text,/\b(se cae|caidas|fallas recurrentes|intermitencia|falla todo el tiempo)\b/));
  async function resolve(turn: AgentTurn, state: CaseState, intent: Intent, profile: Profile, publicPrompt: string, prompts:Record<string,string>, agentId:Domain, historyOnly:boolean, deadline:number, supportingCards:Extract<RunResult,{type:'card'}>[]): Promise<RunResult> {
    const reads=readBudgets.get(turn.run_id);
    const scopeStep = agentId==='facturacion' ? 'resolve_billing_facts'
      : agentId==='soporte' ? 'read_service_context' : 'read_commercial_context';
    const unavailableResult = (result:Fact[] | Retention) => sourceUnavailable(Array.isArray(result) ? result : result.facts);
    async function readCaseTool<T extends Fact[] | Retention>(toolId:CaseRead, purpose:ReadPurpose, read:()=>Promise<T>, fallback:T, selector?:string) {
      if (!state.verified || turn.audience !== 'asesor' || !domainReads[agentId].includes(toolId)) throw new Error('tool not permitted for subgraph');
      if (reads) return await reads.read({ tool:toolId, agent:agentId, step:scopeStep,
        purpose, selector, read, unavailable:unavailableResult }) ?? fallback;
      const started = Date.now();
      let status = 'success';
      try {
        const result = await withinDeadline(deadline, read, fallback);
        if (unavailableResult(result)) status = 'error';
        return result;
      } catch (error) {
        status = 'error';
        if (error instanceof TransientReadError) return fallback;
        throw error;
      } finally {
        options.observe?.(turn.run_id,{name:`tool.${toolId}`,started,ended:Date.now(),
          metadata:{status,tool_id:toolId,agent_id:agentId,step_id:scopeStep,purpose}});
      }
    }
    const unavailable = (tool:CaseRead):Fact => ({
      id: `${tool.split('.')[0]}-unavailable`, label: 'Fuente pendiente', value: 'Lectura sin confirmar'
    });
    const readFacts = (tool:CaseRead, purpose:ReadPurpose, read:()=>Promise<Fact[]>, selector?:string) =>
      readCaseTool(tool,purpose,read,[unavailable(tool)],selector);
    const getServices = (purpose:ReadPurpose) => readFacts('crm.list_services',purpose,() =>
      (ports.listServices ?? ports.getCustomerContext)(turn.run_id));
    if (historyOnly && agentId === 'soporte') {
      const history = await readFacts('crm.list_recent_tickets','review_recurrence',() => ports.getTickets(turn.run_id));
      return card(intent,'Antecedentes técnicos del caso.',history,[],[],'Revisar la recurrencia.',['service_history']);
    }
    const reportedAdjustment = prompts.agent_objectives && agentId==='facturacion' && state.verified && turn.audience==='asesor' && turn.actor==='asesor'
      ? reportedAdjustmentAmount(norm(turn.text)) : undefined;
    if (reportedAdjustment !== undefined && reportedAdjustment > ADVISOR_ADJUSTMENT_LIMIT) {
      const format = new Intl.NumberFormat('es-CO');
      const amount = format.format(reportedAdjustment);
      const limit = format.format(ADVISOR_ADJUSTMENT_LIMIT);
      const out = card('facturacion', `El importe reportado de COP ${amount} supera el límite de COP ${limit} acumulados por factura. El ajuste queda pendiente de revisión y aprobación por Supervisión.`,
        [{id:'reported-adjustment-cop',label:'Importe reportado del ajuste',value:String(reportedAdjustment)},
          {id:'advisor-adjustment-limit-cop',label:'Límite de ajuste del asesor',value:String(ADVISOR_ADJUSTMENT_LIMIT)}],
        [],['Verificar el cargo en la factura','Obtener la aprobación de Supervisión'],
        'Revisar el cargo y derivar a Supervisión para autorizar cualquier ajuste.',['adjustment_requires_supervisor']);
      if (out.type==='card') out.card.suggested_escalation={destination:'supervision',reason_code:'adjustment_requires_supervisor'};
      return out;
    }
    if (prompts.agent_objectives && agentId==='facturacion' && !state.verified && turn.channel==='telegram' &&
        turn.audience==='cliente' && claimedBillingAccount(turn.text)) {
      return {type:'handoff',route:'facturacion',pending:'Revisión de facturación con titularidad pendiente',
        reason:'Dejé tu consulta en espera de un asesor. Para revisar la factura de tu cuenta, abre el chat web de Claro Copiloto y verifica allí la titularidad.'};
    }
      if (has(turn.text,/\b(cotizacion bursatil|bolsa de valores|precio de (la accion|las acciones)|criptomoneda|pronostico bursatil|declarar renta|declaracion de renta)\b/)) {
      return {type:'handoff',reason:'Puedo ayudarte con planes, facturas y soporte de Claro.',pending:'Consulta fuera del alcance',route:'fuera_de_alcance'};
    }
    const followup=prompts.agent_objectives && intent==='soporte_tecnico' ? nextContextQuestion(state.intake) : undefined;
    if (followup?.id==='alcance_intermitencia') {
      const reported='El cliente reporta una velocidad normal por cable e intermitencia en las videollamadas.';
      return turn.audience==='asesor'
        ? card(intent,reported,[],[],['Comprobar en cuántos dispositivos ocurre la intermitencia'],followup.text,['reported_interruption'])
        : {type:'answer',route:intent,answer:followup.text,citations:[],context_question:followup,needs_clarification:true};
    }
    const reconnectionCharge = Boolean(prompts.agent_objectives && intent==='facturacion' && asksReconnectionCharge(turn.text));
    const policyQuestion = (reconnectionCharge || has(turn.text,/\b(cual|cuales|cuanto|cuanta|como|que|cuando|plazo|politica|contrato|clausula|penalidad|nip|pqr|requisitos)\b/))
      && !explicitAccountBilling(turn.text) && !asksCurrentPlanAndBalance(turn.text) && !has(turn.text,/\b(mi cuenta|mi (plan|linea) actual|quiero cancelar|c-\d{4})\b/);
    const advisorKnowledge = turn.audience === 'asesor' && !state.verified;
    const generalPortability = intent === 'portabilidad' && policyQuestion && !state.verified;
    if (retentionPolicyQuery(turn.text) || intent === 'consulta_planes' || (intent === 'soporte_tecnico' && (turn.audience==='cliente' || !state.verified)) || intent === 'portabilidad' || (intent === 'facturacion' && policyQuestion) || generalPortability || (advisorKnowledge && policyQuestion)) {
      if (turn.audience==='cliente' && state.intake?.facts.imagen==='Imagen recuperada' && !has(turn.text,/\be[ -]?202\b/)) {
        return {type:'answer',answer:'Me alegra que haya vuelto la imagen. Si vuelve a fallar, cuéntame qué aparece en pantalla.',citations:[],route:intent};
      }
      if (turn.audience==='cliente' && state.intake?.facts.imagen==='Imagen aún ausente' && !has(turn.text,/\be[ -]?202\b/)) {
        return {type:'answer',answer:'Entiendo que la imagen sigue sin volver. Si ya pasó el tiempo de espera indicado, puedo comunicarte con un asesor. ¿Quieres hablar con uno?',citations:[],route:intent};
      }
      const resolved=planConversation(turn,state.messages);
      const detailFocus=state.conversation_memory?.focused_plan ?? state.conversation_memory?.selected_plan;
      const scopedDetail=intent==='consulta_planes' && detailFocus && commercialFor(turn,state)?.action==='detail';
      const query={...resolved,text:scopedDetail ? `${detailFocus.name}. ${turn.text}` : resolved.text,intake:state.intake,deadline};
      const objectives=Boolean(prompts.agent_objectives);
      const documents = await retrieve(query, profile, prompts, !objectives);
      const timing=prompts.agent_objectives && intent==='portabilidad' && portabilityTimingQuestion(turn.text);
      const compatibility = prompts.agent_objectives ? esimCompatibilityFilter(turn.text) : undefined;
      const applicable = documents.filter(doc => {
        if (compatibility) return compatibility(doc);
        if (scopedDetail) return doc.type!=='catalogo' && !/^CAT-/.test(doc.version) &&
          norm(doc.title+' '+doc.excerpt).includes(norm(detailFocus.name));
        if (reconnectionCharge) return has(doc.excerpt,/\bcargo de reconexion\b/);
        if (intent !== 'portabilidad') return true;
        if (timing) return /^crc-portabilidad-\d+$/.test(doc.id) && has(doc.excerpt,/\bplazos\b.+\bvigencia del nip\b/);
        if (!has(doc.title+' '+doc.excerpt,/\b(?:portab\w*|portacion)\b/)) return false;
        if (has(turn.text,/\b(?:deuda|vencida|saldo|mora)\b/)) return has(doc.excerpt,/\b(?:deuda|mora)\b/);
        if (has(turn.text,/\b(?:tramite|seguir|como sigo|cambiar de operador|conservar|conservando)\b/) &&
            !has(turn.text,/\b(?:tarda|cuanto|plazo)\b/)) return has(doc.excerpt,/\b(?:operador receptor|requisitos|nip)\b/);
        return true;
      });
      const reply=await answerKnowledge(query,profile,publicPrompt,applicable,objectives,objectives ? prompts.public_evidence_selector ?? '' : undefined);
      const continuing=intent===state.public_route && isPublicContinuation(turn) && !contextIntent(turn.text);
      if ((scopedDetail || continuing) && (!reply || 'needsClarification' in reply && reply.needsClarification && !('contextField' in reply))) {
        const answer=scopedDetail ? `No puedo confirmar ese detalle para ${detailFocus.name} con las fuentes vigentes. ¿Qué otra condición quieres revisar?`
          : '¿Qué parte de lo que estábamos revisando quieres aclarar?';
        return {type:'answer',answer,citations:[],route:intent,needs_clarification:true};
      }
      if (!reply) return turn.audience === 'asesor'
        ? card(intent, 'No hay evidencia vigente suficiente.', [], [], ['Consultar fuente autorizada'], 'Solicitar información adicional o derivar.', ['missing_evidence'])
        : retentionPolicyQuery(turn.text)
          ? {type:'answer',answer:'Si estás considerando cancelar o quieres revisar las opciones para tu cuenta, puedo ayudarte a comunicarte con un asesor. ¿Quieres hablar con uno?',citations:[],route:'cancelacion'}
        : { type:'answer', answer:'No puedo confirmar ese dato con la información vigente. Puedo pedirle a un asesor que lo revise. ¿Quieres hablar con uno?', citations:[], route:intent, needs_clarification:true };
      const askDecoder=intent==='soporte_tecnico' && has(turn.text,/\be[ -]?202\b/) &&
        !state.intake?.asked.includes('imagen') && !state.intake?.facts.imagen &&
        reply.used.some(c=>/\b\d+ minutos?\b/i.test(c.excerpt));
      const answer = reconnectionCharge && state.intake?.facts.objetivo==='Pago sin reconexión'
        ? `${reply.answer} Para comprobar si tu pago ya aparece registrado, primero debemos verificar la titularidad y consultar la cuenta.`
        : reply.answer;
      return turn.audience === 'asesor'
        ? card(intent,reply.answer,[],reply.citations,[],'Compartir la información pertinente.',['knowledge'])
        : {type:'answer',answer:answer + (askDecoder && !answer.includes('?')
            ? '\n\nCuando termine la espera, cuéntame: ¿volvió la imagen?' : ''),citations:reply.used,route:intent,
          ...(intent==='consulta_planes' ? {conversation_memory:catalogMemoryFromReply(turn.text,reply.answer,reply.used,state.conversation_memory)} : {}),
          ...(reply.mode==='guided' && 'needsClarification' in reply && reply.needsClarification ? {needs_clarification:true} : {}),
          ...(askDecoder ? {context_question:questionById('imagen')} :
            'contextField' in reply && reply.contextField ? {context_question:questionById(reply.contextField)} : {})};
    }
    if (!state.verified) {
      const reportedFaults = intent==='cancelacion' && (cancellationWithFaults(turn.text) || state.intake?.facts.motivo==='Fallas del servicio');
      const pending = reportedFaults ? 'Verificar titularidad y revisar antecedentes técnicos de la solicitud de baja' : 'Verificar titularidad y atender la consulta';
      if (turn.audience === 'asesor') return card(intent,'Se necesita verificar la titularidad antes de consultar datos de cuenta.',
        [],[],[pending,state.pending ?? 'Consultar la solicitud'],'Verificar titularidad.',['verification_required']);
      const reason = reportedFaults
        ? 'Entiendo que quieres cancelar por las fallas. Verifiquemos la titularidad para que un asesor revise tu historial técnico y continúe con tu solicitud.'
        : prompts.agent_objectives && intent==='cancelacion'
          ? 'Un asesor verificará la titularidad y las condiciones de tu servicio antes de confirmar la baja o indicar si aplica alguna condición especial. Si te interesa una oferta, primero revisará tu elegibilidad.'
          : 'Para consultar tu cuenta, un asesor verificará la titularidad.';
      return {type:'handoff',reason,pending,route:intent,verification_required:true};
    }
    if (turn.audience === 'cliente') return intent === 'cancelacion'
      ? {type:'handoff',reason:'Entiendo que quieres cancelar. Dejé tu solicitud en espera de un asesor, que continuará en este chat.',pending:'Solicitud de cancelación',route:intent}
      : {type:'handoff', reason:'Un asesor atenderá tu consulta de cuenta.', pending:'Atención de cuenta', route:intent};
    if (intent === 'facturacion') {
      const invoiceId = turn.text.match(/\bF-\d{4,10}\b/i)?.[0]?.toUpperCase();
      const invoiceRequested = !!invoiceId || has(turn.text,/\b(factur\w*|cobr\w*|cargos?)\b/);
      const balanceRequested = has(turn.text,/\b(saldo|debo|adeudo|deuda|vencimiento|vencen?|fecha limite)\b/);
      const comparePlan = invoiceRequested && has(turn.text,/\b(mi plan|cambio de plan|plan contratado|servicio contratado)\b/) && has(turn.text,/\b(cambio|cambie|subio|relacion|afecta|coincide|compartir|explic\w*|por que)\b/);
      const getDetail = ports.getInvoiceDetail;
      const listInvoices = ports.listInvoices;
      const readDetail = () => invoiceId
        ? (getDetail ? readFacts('billing.get_invoice_detail','inspect_invoice',() => getDetail(turn.run_id,invoiceId),invoiceId) : [])
        : invoiceRequested && listInvoices
          ? readFacts('billing.list_invoices','review_invoices',() => listInvoices(turn.run_id)) : [];
      const readBalance = () => balanceRequested || !invoiceRequested || (!getDetail && !listInvoices)
        ? readFacts('billing.get_balance','explain_balance',() => ports.getBilling(turn.run_id)) : [];
      const currentPlanAndBalance=asksCurrentPlanAndBalance(turn.text);
      const independentServices=Boolean(reads && currentPlanAndBalance && !invoiceId);
      const [detail, initialBalance, initialServices] = await Promise.all([readDetail(),
        reads ? readBalance() : [], independentServices ? getServices('review_current_plan') : []]);
      const investigateChange = Boolean(prompts.agent_objectives && !invoiceId && invoiceRequested
        && has(turn.text,/\b(?:subi\w*|aument\w*|mas|cambio|diferencia)\b/));
      const requestedPeriod = turn.text.match(/\b\d{4}-(?:0[1-9]|1[0-2])\b/)?.[0];
      const periods = investigateChange ? invoicePeriods(detail,turn.business_date,requestedPeriod) : [];
      const readBreakdown = () => getDetail && periods.length === 2 ? Promise.all(periods.map(({id}) =>
        readFacts('billing.get_invoice_detail','inspect_invoice',() => getDetail(turn.run_id,id),id))) : [];
      const validDetail=detail.length>0 && !sourceUnavailable(detail);
      const readRelatedServices = () => currentPlanAndBalance && (!invoiceId || validDetail) || comparePlan && validDetail
        ? getServices(currentPlanAndBalance ? 'review_current_plan' : 'compare_billed_service') : [];
      const [breakdown, earlyServices] = await Promise.all([readBreakdown(), reads && !independentServices ? readRelatedServices() : initialServices]);
      const comparison = breakdown.length === 2 && !breakdown.some(sourceUnavailable)
        ? explainInvoiceChange(breakdown[0],breakdown[1]) : null;
      const balance = reads ? initialBalance : await readBalance();
      const services = reads ? earlyServices : await readRelatedServices();
      const billingUnavailable = sourceUnavailable([...detail,...balance,...breakdown.flat()]);
      const crmUnavailable = sourceUnavailable(services);
      const pending = [...(billingUnavailable ? ['Consultar Facturación · API mock'] : []),
        ...(crmUnavailable ? ['Consultar CRM · API mock'] : []),
        ...(investigateChange && !comparison ? ['Confirmar los conceptos que explican la diferencia'] : [])];
      return card(intent, billingUnavailable ? 'La fuente de facturación está pendiente.'
        : comparison ? `Cambios verificados de ${periods[1].period} a ${periods[0].period}. ${comparison}`
          : 'Consulta de facturación para titular verificado.',
        [...detail,...breakdown.flat(),...balance,...services], [], pending, pending.length ? 'Revisar las fuentes pendientes antes de explicar su parte del cargo.'
          : comparePlan ? 'Contrastar la factura y el plan vigente. Explicar el aumento solo si los conceptos lo sustentan.' : currentPlanAndBalance ? 'Explicar los planes activos, el saldo y el vencimiento verificados.' : 'Explicar los importes y vencimientos verificados.',
        [pending.length ? 'source_unavailable' : 'verified_account']);
    }
    const customerContext = () => readFacts('crm.get_customer_context','review_customer_context',() => ports.getCustomerContext(turn.run_id));
    if (prompts.agent_objectives && intent==='cancelacion' && turn.actor==='cliente' && state.intake?.skip && !accepted(turn.text)) {
      return card(intent,'El cliente pide continuar con la baja.',[],[],['Tramitar la baja con el responsable de cancelaciones'],
        'Continuar el trámite de cancelación y confirmar el resultado cuando se haya registrado.',['cancellation_requested']);
    }
    let customer: Fact[] | undefined;
    if (intent === 'cancelacion' && reportsCancellationFaults(turn,state)) {
      const history = supportingCards.find(result => result.route === 'soporte_tecnico');
      const contextRead = reads ? undefined : customerContext();
      const support = history ?? (reads ? undefined : (await supportGraph.invoke({
        turn,caseState:state,intent:'soporte_tecnico',profile,publicPrompt,prompts,historyOnly:true,deadline,supportingCards
      })).result);
      const tickets = support?.type === 'card' ? support.card.facts : [];
      if (!tickets.length || sourceUnavailable(tickets)) return card(intent,'Falta confirmar las fallas reportadas.',[...(await contextRead ?? []),...tickets],[],['Consultar antecedentes técnicos en CRM · API mock'],'Revisar los tickets antes de evaluar una oferta.',['source_unavailable']);
      const recurrence = tickets.find(fact => fact.id === 'technical-tickets-90d');
      const recurrent = recurrence && Number(recurrence.value)>=3;
      if (recurrent) {
        const [context,documents] = await Promise.all([contextRead ?? customerContext(), reads ? retrieve({
          ...turn, deadline, text:'política de retención fallas técnicas recurrentes visita prioritaria'
        },profile,prompts,false) : []]);
        customer=context;
        const published = documents.find(doc => has(doc.excerpt,/24 horas/) && has(doc.excerpt,/visita/) &&
          (doc.metadata?.source === 'retencion' || /^retencion-\d+$/.test(doc.id)));
        if (prompts.agent_objectives && !published) {
          return card(intent,'Se comprobó recurrencia técnica.',[...customer,...tickets],[],['Política vigente de recurrencia'],
            'Solicitar revisión del asesor antes de indicar un plazo.',['missing_evidence']);
        }
        const evidence: Citation = published ? citation(published) : {
          id:'retention-recurrent-faults', title:'Política de retención y fallas recurrentes',
          version:'POL-RET-2026 v3.1', excerpt:'Gestionar una visita técnica prioritaria dentro de 24 horas antes de evaluar una oferta cuando se cumple el umbral de recurrencia.'
        };
        if (Date.now() >= deadline) return card(intent,'Se comprobó recurrencia técnica.',[...customer,...tickets],[evidence],['Registrar la solicitud prioritaria'],'Solicitar revisión del asesor.',['turn_deadline']);
        const proposal = await ports.createProposal(turn.run_id, {option_id:'priority-ticket',citation_ids:[
          evidence.id, ...(published ? ['retention-recurrent-faults'] : [])
        ]});
        return card('cancelacion','Fallas técnicas recurrentes. Corresponde gestionar una visita técnica prioritaria dentro de 24 horas.',
          [...customer,...tickets],[evidence],['Aprobación del asesor'], 'Aprobar el registro del ticket prioritario.',
          ['priority_support_required'],proposal);
      }
      customer=await contextRead;
    }
    if (intent === 'cancelacion') {
      if (supportingCards.some(({card}) => card.pending.length || card.reason_codes.includes('source_unavailable'))) {
        return card(intent,'La solicitud de baja sigue abierta.',customer ?? [],[],[],
          'Aclarar los cargos y continuar el trámite solicitado.',['supporting_evidence_pending']);
      }
      const [context, retention] = await Promise.all([customer ?? customerContext(),
        readCaseTool('crm.evaluate_retention','check_offer_eligibility',() => ports.evaluateRetention(turn.run_id),{
          eligible:false, reason:'Fuente pendiente', facts:[unavailable('crm.evaluate_retention')], options:[],
          policy:{id:'retention-unavailable',title:'Fuente pendiente',version:'pendiente',excerpt:'Verificar elegibilidad.'}
        })]);
      const facts = [...context, ...retention.facts];
      if (sourceUnavailable(retention.facts)) return card(intent,'La fuente de elegibilidad está pendiente.',facts,[],['Consultar elegibilidad en CRM · API mock'],'Verificar la elegibilidad antes de ofrecer alternativas.',['source_unavailable']);
      const citations = [retention.policy];
      if (!retention.eligible) {
        const reported=prompts.agent_objectives && turn.actor==='cliente' &&
          has(turn.text,/\b(?:me promet(?:io|ieron)|me ofrec(?:io|ieron)|me dijeron que me (?:darian|iban a dar))\b[^.!?]{0,65}\b(?:descuento|oferta|beneficio)\b/)
          ? 'El cliente dice que le prometieron un beneficio. ' : '';
        return card(intent,`${reported}Resultado de elegibilidad: ${retention.reason}`,facts,citations,['Trámite solicitado por el cliente'],
          'Continuar el trámite solicitado sin ofrecer alternativas no elegibles.',['retention_ineligible']);
      }
      const alternatives = retention.options.map(o => `${o.title}: ${o.detail}`).join(' · ');
      let proposal;
      if (turn.actor === 'cliente' && accepted(turn.text)) {
        const selected = selectOption(turn.text, retention.options, state.messages.filter(m => m.turn_seq < turn.turn_seq));
        if (selected && Date.now() < deadline) proposal = await ports.createProposal(turn.run_id, {option_id:selected.id, citation_ids:[retention.policy.id]});
        else return card(intent, `Alternativas elegibles: ${alternatives}`, facts, citations, ['Precisar la alternativa aceptada'], 'Preguntar cuál alternativa acepta el cliente.', ['option_unclear']);
      }
      const advisorPresented = state.messages.some(m => m.actor === 'asesor' && has(m.text, /oferta|descuento|mejora|alternativa/));
      return card(intent, `Resultado de elegibilidad: ${retention.reason}. Alternativas: ${alternatives}`, facts, citations, proposal ? ['Aprobación del asesor'] : ['Decisión del cliente'], proposal ? 'Revisar y aprobar la propuesta en consola.' : advisorPresented ? 'Esperar la decisión del cliente.' : 'Presentar las alternativas y esperar la decisión del cliente.', ['retention_eligible'], proposal);
    }
    const relevantService=intent==='soporte_tecnico' && has(turn.text,/\b(mi (internet|fibra|modem|equipo|decodificador)|tengo intermitencia|sigo sin (internet|senal))\b/);
    const [documents, supportFacts] = await Promise.all([retrieve({...turn,deadline},profile,prompts),
      relevantService ? getServices('identify_affected_service') : []]);
    const citations = documents.map(citation);
    return card(intent, citations[0]?.excerpt ?? 'No hay evidencia suficiente para resolver la consulta.', supportFacts, citations,
      [...(citations.length ? [] : ['Consultar fuente autorizada']),...(sourceUnavailable(supportFacts) ? ['Consultar CRM · API mock'] : [])],
      citations.length ? 'Compartir el procedimiento aplicable.' : 'Solicitar información adicional o derivar.', [citations.length ? 'knowledge' : 'missing_evidence']);
  }
  const specialized = (agentId:Domain) => new StateGraph(GraphState)
    .addNode('domain_read_and_compose', async ({turn,caseState,intent,profile,publicPrompt,prompts,historyOnly,deadline,supportingCards}) => {
      const started=Date.now(); const result=await resolve(turn,caseState,intent,profile,publicPrompt,prompts,agentId,historyOnly ?? false,deadline,supportingCards ?? []);
      options.observe?.(turn.run_id,{name:'retrieval',started,ended:Date.now(),metadata:{agent_id:agentId,step_id:'propose_next_action'}});
      return {result};
    }).addEdge(START,'domain_read_and_compose').addEdge('domain_read_and_compose',END).compile();
  const supportGraph=specialized('soporte');
  const billingGraph=specialized('facturacion');
  const commercialGraph=specialized('comercial');
  function advisorDraft(result:RunResult, prompts:Record<string,string>, turn:AgentTurn, state:CaseState, objectives:Intent[] = []):RunResult {
    if (result.type !== 'card') return result;
    const c=result.card;
    const facts=c.facts.map(f=>`${f.label}: ${f.value}`).join('. ');
    const guidance=c.citations[0]?.excerpt ?? c.summary;
    const issue = c.intent === 'soporte_tecnico' && has(turn.text,/\b(fallas?|error|sin (internet|senal)|los|no funciona|no se ve|se cae)\b/) ? 'tener una falla en el servicio'
      : c.intent === 'facturacion' && has(turn.text,/\b(subio|aumento|duplicado|no reconozco|injusto|me cobraron|reclamo)\b/) ? 'encontrar un cargo que necesitas aclarar'
      : c.intent === 'cancelacion' && has(turn.text,/\b(fallas?|inconveniente|inconforme|se cae|no funciona|intermitencia)\b/) ? 'tener inconvenientes con el servicio' : '';
    const empathy=issue && prompts.advisor_empathy ? renderTemplate(prompts.advisor_empathy,{reported_issue:issue}) : '';
    const domainKey=c.intent === 'soporte_tecnico' ? 'support_reply' : c.intent === 'facturacion' ? 'billing_reply' : 'commercial_reply';
    const domain=prompts[domainKey] ? renderTemplate(prompts[domainKey],{symptom_sentence:issue,authorized_guidance:guidance,billing_fact_sentence:facts,billing_explanation:c.summary,commercial_fact_sentence:facts || c.summary,applicable_condition:guidance}) : [c.summary,facts].filter(Boolean).join(' ');
    const rendered=prompts.advisor_reply ? renderTemplate(prompts.advisor_reply,{empathy_sentence:empathy,domain_reply:domain,next_step_sentence:c.next_action}) : [empathy,domain,c.next_action].filter(Boolean).join('\n\n');
    const authorized=[c.summary,facts,guidance,c.next_action].join(' ');
    const nums=(v:string)=>v.match(/\d+(?:[.,:/-]\d+)*(?:\s*%)?/g) ?? [];
    const allowedNumbers=new Set(nums(authorized).map(x=>x.replace(/\s/g,'')));
    const unsafe=!rendered.trim() || rendered.length>4000 || /{{|https?:\/\/|<[^>]*>|\b(ya (?:fue|quedó|quedo|está|esta) (?:aprobad|confirmad|registrad)[oa]s?|hemos (?:aprobado|registrado|confirmado))\b/i.test(rendered) || nums(rendered).some(x=>!allowedNumbers.has(x.replace(/\s/g,'')));
    const fallback=[issue && `Entiendo lo incómodo que es ${issue}.`,c.summary,facts,c.next_action].filter(Boolean).join('\n\n').slice(0,4000);
    const handoffStarted=Date.now();
    const handoff = c.reason_codes.includes('human_requested') && prompts.handoff_summary
      ? renderCaseSummary(prompts.handoff_summary,c,state.confirmed_receipts ?? []) : undefined;
    if (handoff) options.observe?.(turn.run_id,{name:'advisor.handoff_summary',started:handoffStarted,ended:Date.now(),metadata:{
      agent_id:'copiloto',step_id:'prepare_handoff',prompt_ref:'handoff_summary'
    }});
    const question=c.suggested_escalation || c.proposal || c.reason_codes.some(reason=>['human_requested','support_followup','catalogue_comparison'].includes(reason)) ? undefined :
      nextContextQuestion(state.intake ?? evolveContext(turn.text,undefined,c.intent ?? undefined));
    return {...result,card:{...c,...(objectives.length ? {objectives} : {}),context_question:question,advisor_draft:unsafe ? fallback : rendered,advisor_draft_run_id:turn.run_id,...(handoff && handoff.length < 4000 ? {handoff_summary:handoff} : {})}};
  }
  const graph = new StateGraph(GraphState)
    .addNode('load_case', async ({ turn, deadline }) => {
      const started = Date.now();
      const caseState = await ports.readCaseForRun(turn.run_id);
      const config = await ports.getAgentConfig(turn.config_revision);
      if (config.revision !== turn.config_revision) throw new Error('configuration revision mismatch');
      if (config.prompts.agent_objectives) {
        const readDeadline=deadline - Math.min(150, Math.floor(turnTimeoutMs/10));
        readBudgets.set(turn.run_id,new TurnReads(readDeadline,observation=>options.observe?.(turn.run_id,observation)));
      }
      const history = caseState.messages.filter(message=>message.turn_seq<turn.turn_seq);
      options.observe?.(turn.run_id,{name:'context',started,ended:Date.now(),metadata:{
        agent_id:'copiloto',step_id:'load_case',history_count:history.length,
        first_turn_seq:history[0]?.turn_seq ?? 0,last_turn_seq:history.at(-1)?.turn_seq ?? 0
      }});
      const context=prepareConversation(turn,caseState);
      return {turn:context.turn,caseState:context.state,context,prompts:config.prompts,publicPrompt:config.prompts.public_answer ?? '',
        intent:context.domain ?? recentPurpose(caseState.messages,turn)};
    })
    .addNode('resolve_turn', ({ turn, caseState, prompts, context }) => {
      const started = Date.now();
      let intent = recentPurpose(caseState.messages, turn);
      const explicitIntent=contextIntent(turn.text);
      const continuation=!explicitIntent ? context.domain ?? (isPublicContinuation(turn) ? caseState.public_route : undefined) : undefined;
      if (continuation) intent=continuation;
      if (turn.actor === 'cliente' && !accepted(turn.text) && tokens(turn.text).length > 2) {
        const activeOffer = intent === 'cancelacion' && !explicitIntent && has(turn.text,/\b(?:descuento|oferta)\b/);
        if (!activeOffer && !continuation) intent = classify(turn.text) ?? explicitIntent ?? intent;
      }
      const newPlan = changesCancellationToPlan(turn.text);
      if (newPlan) intent='consulta_planes';
      else if (retentionPolicyQuery(turn.text) || cancellationWithFaults(turn.text) || has(turn.text, cancellationRequest)) intent='cancelacion';
      else if ((has(turn.text, portabilityRequest) || prompts.agent_objectives && portabilityTimingQuestion(turn.text)) && !has(turn.text,/\b(?:junt\w*|combina\w*|convergen\w*)\b/)) intent='portabilidad';
      else if (prompts.agent_objectives && (asksReconnectionCharge(turn.text) ||
        !caseState.verified && turn.channel==='telegram' && turn.audience==='cliente' && claimedBillingAccount(turn.text) ||
        turn.actor==='asesor' && reportedAdjustmentAmount(norm(turn.text))!==undefined)) intent='facturacion';
      else if (prompts.agent_objectives && mobileCommitmentQuestion(turn.text)) intent='consulta_planes';
      else if (has(turn.text,/\b(?:junt\w*|combina\w*|convergen\w*)\b/) && has(turn.text,/\b(?:descuento|beneficio|plan|oferta)\b/)) intent='consulta_planes';
      else if (asksCurrentPlanAndBalance(turn.text) && !has(turn.text,/\b(?:cancel\w*|retir\w*|dar de baja)\b/)) intent='facturacion';
      else if (plansDiscovery(planConversation(turn,caseState.messages).text) || mobilePlanTopic(planConversation(turn,caseState.messages).text)) intent='consulta_planes';
      else if (caseState.intake?.intent==='cancelacion' && !retentionPolicyQuery(turn.text)) intent='cancelacion';
      else if (caseState.intake?.intent==='soporte_tecnico' && ['Lentitud','E-202','Luz LOS roja','Cortes en videollamadas'].includes(caseState.intake.facts.sintoma ?? '')) intent='soporte_tecnico';
      const profile: Profile = caseState.verified && turn.audience==='asesor' ? 'intermedio' : 'economico';
      options.observe?.(turn.run_id,{name:'context',started,ended:Date.now(),metadata:{
        agent_id:'copiloto',step_id:'resolve_turn',decision:'orchestrator',intent,profile,
        context_route:caseState.public_route ?? '',continuation:continuation===intent ? 'yes' : 'no'
      }});
      return { intent, profile };
    })
    .addNode('plan_objectives', async (state) => {
      const {turn,caseState,intent,prompts,deadline} = state;
      const objectives = new Set<Intent>([intent]);
      if (intent !== 'facturacion' && (explicitAccountBilling(turn.text) ||
          prompts.agent_objectives && intent==='cancelacion' && has(turn.text,/\b(?:facturas?|cobros?|cargos?)\b/))) objectives.add('facturacion');
      if (intent !== 'soporte_tecnico' && (cancellationWithFaults(turn.text) ||
          prompts.agent_objectives && intent==='cancelacion' && reportsCancellationFaults(turn,caseState) ||
          prompts.agent_objectives && has(turn.text,/\b(?:intermiten\w*|se cae|sin (?:senal|internet)|luz los|videollamadas? se cortan)\b/))) {
        objectives.add('soporte_tecnico');
      }
      const planned = [...objectives];
      const profile: Profile = planned.length > 1 ? 'complejo' : state.profile;
      if (!prompts.agent_objectives) return {objectives:planned,profile};
      const started = Date.now();
      const planner=options.planner;
      const order = planned.length > 1 && planner
        ? await withinDeadline(deadline,()=>planner.order(planned,turn.audience,prompts.agent_objectives,observation => options.observe?.(turn.run_id,observation)),null)
        : null;
      const proposedOrder = validObjectiveOrder(order,planned) ? order : planned;
      const ordered = intent === 'cancelacion'
        ? [...proposedOrder.filter(objective => objective !== intent), intent]
        : proposedOrder;
      const evidence = caseState.verified && turn.audience === 'asesor'
        ? await Promise.all(ordered.filter(objective=>objective!==intent).map(async objective => {
          if (objective==='facturacion') return billingGraph.invoke({...state,intent:objective});
          if (objective==='soporte_tecnico') return supportGraph.invoke({...state,intent:objective,historyOnly:intent==='cancelacion'});
          return null;
        })) : [];
      const supportingCards=evidence.flatMap(item=>item?.result.type==='card' ? [item.result] : []);
      options.observe?.(turn.run_id,{name:'context',started,ended:Date.now(),metadata:{
        agent_id:'copiloto',step_id:'plan_objectives',primary:intent,
        objectives:ordered.join(','),investigated:supportingCards.map(result=>result.route).join(',')
      }});
      return {objectives:ordered,supportingCards,profile};
    })
    .addNode('unresolved_objective', ({turn}) => ({
      result: turn.audience === 'asesor'
        ? card('soporte_tecnico','Falta precisar la necesidad del cliente.',[],[],['Objetivo de atención'],'Precisar qué desea resolver.',['unknown_objective'])
        : {type:'answer',answer:'¿Qué necesitas resolver sobre tus servicios de Claro?',citations:[],route:'indeterminada',needs_clarification:true} as RunResult
    }))
    .addNode('clarify_context', ({context}) => ({result:{type:'answer',route:context.reading.ambiguous ? 'indeterminada' : 'consulta_planes',
      answer:context.reading.ambiguous ? '¿Quieres retomar la consulta de planes, soporte o facturación?' : '¿Cuál de las opciones del catálogo quieres revisar?',
      needs_clarification:true,citations:[]} as RunResult}))
    .addNode('catalogue_advice', async ({turn,caseState,deadline,prompts}) => {
      const comparison = comparisonFor(turn,caseState,Boolean(prompts.agent_objectives));
      if (!comparison) throw new Error('missing catalogue comparison');
      const started=Date.now();
      // Pricing reads the full published catalogue and never invokes a generative model.
      const budget=readBudgets.get(turn.run_id);
      const plans=await readCatalogue(turn,deadline,'compare_public_prices');
      const {text,citations,state} = compareCatalog(comparison,plans);
      options.observe?.(turn.run_id,{name:budget && options.knowledge ? 'catalogue.selection' : 'tool.list_catalog_plans',started,ended:Date.now(),metadata:{
        agent_id:'comercial',step_id:'compare_catalogue',tool_id:'list_catalog_plans',
        reference_resolution:comparison.resolution, catalog_version:citations[0]?.version ?? 'unavailable',
        decision:citations.length ? (comparison.segment ? 'answer' : 'ask') : 'offer_handoff',
        reason:citations.length ? (comparison.segment ? 'lowest_applicable_price' : 'choose_service') : 'unconfirmed_catalogue'
      }});
      if (turn.audience==='asesor') return {result:citations.length
        ? card('consulta_planes',text,[],citations,[],'Compartir el precio del catálogo vigente.',['knowledge','catalogue_comparison'])
        : card('consulta_planes','Falta confirmar el precio vigente en el catálogo.',[],[],['Validar el precio'],
          'Confirmar las condiciones aplicables antes de orientar al cliente.',['missing_evidence','catalogue_comparison'])};
      const result:RunResult={type:'answer',answer:text,citations,route:'consulta_planes',conversation_memory:{...caseState.conversation_memory,...state},
        ...(citations.length ? {catalog_answer:true} : {needs_clarification:true})};
      return {result};
    })
    .addNode('commercial_catalogue', async ({turn,caseState,deadline}) => {
      const request=commercialFor(turn,caseState);
      if (!request) throw new Error('missing commercial request');
      const started=Date.now();
      const plans=await readCatalogue(turn,deadline,'read_public_catalogue');
      const result=answerCommercial(request,plans,caseState.conversation_memory);
      options.observe?.(turn.run_id,{name:'catalogue.selection',started,ended:Date.now(),metadata:{
        agent_id:'comercial',step_id:'compare_catalogue',tool_id:'list_catalog_plans',reference_resolution:request.action,
        context_route:caseState.public_route ?? '',focused:caseState.conversation_memory?.focused_plan ? 'yes' : 'no',
        catalog_version:result?.type==='answer' ? result.citations[0]?.version ?? 'unavailable' : 'unavailable',
        decision:result?.type ?? 'documentary_fallback',reason:plans.length ? 'reviewed_catalogue' : 'unconfirmed_catalogue'
      }});
      return {result,intent:'consulta_planes' as const,profile:'economico' as const};
    })
    .addNode('clarify_duration', async ({turn,caseState,prompts,deadline}):Promise<{result:RunResult}> => {
      if (turn.audience==='asesor') return {result:card('soporte_tecnico','Falta confirmar cuánto tiempo lleva roja la luz LOS.',[],[],
        ['Duración de la luz LOS roja'],'Preguntar al cliente cuántos minutos lleva roja la luz LOS.',['duration_required'])};
      const alreadyAsked=caseState.intake?.asked.includes('duracion') ||
        caseState.messages.some(message=>message.actor==='agente' && has(message.text,/cuantos minutos lleva roja la luz los/));
      if (prompts.agent_objectives && alreadyAsked) {
        const sources=await retrieve({...turn,text:'módem luz LOS roja cable de fibra persiste 10 minutos soporte nivel 2',deadline},'economico',prompts,false);
        const manual=sources.find(doc=>has(doc.excerpt,/\blos rojo/) && has(doc.excerpt,/doblado ni desconectado/) &&
          has(doc.excerpt,/si persiste mas\s+de 10 minutos, escalar a soporte nivel 2/));
        if (manual) return {result:{type:'answer',route:'soporte_tecnico',citations:[citation(manual)],
          answer:'Si el cable está conectado, revisa que tampoco esté doblado. Si la luz LOS sigue roja por más de 10 minutos, pide revisión a soporte técnico de nivel 2. ¿Quieres hablar con un asesor?'}};
        return {result:{type:'handoff',route:'soporte_tecnico',
          reason:'Si la luz LOS sigue roja con el cable conectado, puedo solicitar que un asesor de soporte revise la falla.',
          pending:'La luz LOS sigue roja y queda pendiente la revisión técnica'}};
      }
      return {result:{type:'answer',answer:'¿Cuántos minutos lleva roja la luz LOS?',citations:[],route:'soporte_tecnico',
        needs_clarification:true,context_question:questionById('duracion')}};
    })
    .addNode('priority_handoff', async ({ turn, intent, caseState, prompts, deadline }) => {
      const query=policyText(turn,caseState);
      const policy=mandatoryPolicyRoute(query);
      if (!policy) {
        if (turn.audience==='cliente') return {result:{type:'handoff',reason:'Solicitaré atención de un asesor.',pending:'Atención humana',route:'handoff'} as RunResult};
        const selected=caseState.conversation_memory?.selected_plan;
        if (selected && (caseState.pending===commercialHandoff || caseState.pending==='Atención humana')) {
          return {result:card('consulta_planes',`El cliente eligió ${selected.name}, por ${offerPrice(selected)} según el catálogo citado.`,
            [{id:'selected-plan',label:'Plan elegido',value:selected.name}], [selected.citation],
            ['Confirmar las condiciones vigentes','Gestionar inscripción y facturación'],
            'Revisar la solicitud con el cliente y continuar el trámite.',['human_requested','commercial_selection'])};
        }
        const previous=caseState.messages.filter(message=>message.actor==='cliente' && message.turn_seq<turn.turn_seq).at(-1);
        const attempt=prompts.agent_objectives && turn.actor==='cliente'
          ? reportedHandoffAttempt([turn.text,previous?.text].filter(Boolean).join(' '),caseState.intake) : '';
        return {result:card(intent,['Se solicita atención humana.',attempt].filter(Boolean).join(' '),[],[],
          [attempt ? 'Revisar el resultado del procedimiento informado' : 'Derivación'],
          attempt ? 'Continuar la atención con el responsable del caso.' : 'Contactar al responsable de atención.',['human_requested'])};
      }
      const destination=policy.destination === 'supervision' ? 'supervisión' : 'soporte técnico de nivel 2';
      const reported=prompts.agent_objectives && policy.destination==='supervision' ? reportedLos(query) : '';
      if (turn.audience === 'cliente') return {result:{type:'handoff',reason:`Dejé la solicitud en espera para que un asesor revise la derivación a ${destination}.`,pending:[policyReasons[policy.reason_code],reported,`Revisar derivación a ${destination}.`].filter(Boolean).join(' '),route:policy.destination === 'supervision' ? 'handoff' : 'soporte_tecnico'} as RunResult};
      // La derivación ya está decidida. Recuperar fuentes solo para explicar la regla al asesor.
      const documents = await retrieve({...turn,deadline,text:`${query} política de escalamiento ${destination}`},'economico',prompts,false);
      const evidence=prompts.agent_objectives ? advisorEscalationReply(policy.reason_code,documents) : null;
      const citations = (evidence?.docs ?? documents).map(citation);
      const reason=evidence?.text ?? policyReasons[policy.reason_code] ?? `Se recomienda revisión por ${destination}.`;
      const out=card(policy.destination === 'soporte_tecnico' ? 'soporte_tecnico' : intent,
        [reason,reported].filter(Boolean).join(' '),[],citations,[`Revisar solicitud a ${destination}`],
        `Revisar y confirmar la solicitud de escalamiento a ${destination}.`,['human_requested',policy.reason_code]);
      if (out.type === 'card') out.card.suggested_escalation=policy;
      return {result:out};
    })
    .addNode('support_followup', ({turn}):{result:RunResult} => {
      if (turn.audience==='cliente') return {result:{type:'answer',route:'seguimiento',citations:[],
        answer:'El seguimiento con Soporte sigue abierto. Un asesor puede revisar el estado de la visita.'}};
      const out=card('soporte_tecnico','El cliente sigue esperando la visita técnica.',[],[],
        ['Confirmar la coordinación de la visita'],'Mantener abierto el seguimiento con Soporte.',['support_followup']);
      return {result:{...out,route:'seguimiento'}};
    })
    .addNode('support', supportGraph)
    .addNode('billing', billingGraph)
    .addNode('commercial', commercialGraph)
    .addNode('context_question', async ({turn,intent,caseState,prompts})=>{
      const next=caseState.intake?.intent===intent ? nextContextQuestion(caseState.intake) : undefined;
      if (!next) throw new Error('missing context question');
      const at=Date.now();
      options.observe?.(turn.run_id,{name:'context',started:at,ended:at,metadata:{decision:'ask',question_id:next.id,agent_id:'copiloto'}});
      const answer = prompts.agent_objectives && next.id==='pago' && caseState.intake?.facts.medio_pago
        ? 'Para saber si el pago aparece registrado, primero hay que verificar la cuenta. ¿Cuándo hiciste el pago?'
        : next.text;
      return {result:{type:'answer',answer,citations:[],route:intent,needs_clarification:true,context_question:next} as RunResult};
    })
    .addEdge(START, 'load_case')
    .addConditionalEdges('load_case', ({ turn,caseState,prompts,context }) => {
      if (mandatoryPolicyRoute(policyText(turn,caseState)) || /hablar con (un |una )?(humano|asesor|persona)/.test(norm(turn.text))) return 'priority_handoff';
      if (turn.audience==='asesor' && turn.observed_context?.decision==='prepare_commercial_handoff') return 'priority_handoff';
      if (prompts.agent_objectives && turn.actor==='cliente' && caseState.pending_support_handoff && waitingForSupportVisit(turn.text)) return 'support_followup';
      if (needsLosDuration(turn.text)) return 'clarify_duration';
      if (context.unresolved) return 'clarify_context';
      const commercial=commercialFor(turn,caseState);
      if (commercial && ['purchase','download','select'].includes(commercial.action)) return 'commercial_catalogue';
      if (comparisonFor(turn,caseState,Boolean(prompts.agent_objectives))) return 'catalogue_advice';
      return commercial ? 'commercial_catalogue' : 'resolve_turn';
    })
    .addEdge('resolve_turn', 'plan_objectives')
    .addConditionalEdges('plan_objectives', ({turn,intent,caseState,prompts}) => {
      const publicPolicy=prompts.agent_objectives && (asksReconnectionCharge(turn.text) || portabilityTimingQuestion(turn.text) ||
        !caseState.verified && turn.channel==='telegram' && intent==='facturacion' && claimedBillingAccount(turn.text));
      if (prompts.agent_objectives && !publicPolicy && !retentionPolicyQuery(turn.text) && !caseState.intake && !contextIntent(turn.text)
          && !(caseState.public_route===intent && isPublicContinuation(turn))
          && !has(turn.text,/\b(?:declarar renta|declaracion de renta|cotizacion bursatil|bolsa de valores|criptomoneda)\b/)
          && !has(turn.text,/\b(?:plan|fibra|precio|empresa|servicio|contrato|e-?sim|roaming|descuento|oferta|portabilidad|pqr|reclamo|velocidad|internet|senal|factur\w*)\b/)) return 'unresolved_objective';
      const next=caseState.intake?.intent===intent ? nextContextQuestion(caseState.intake) : undefined;
      if (turn.audience==='cliente' && !publicPolicy && next && ['codigo','medio','cable','cargo','pago','direccion','tramite'].includes(next.id)) return 'context_question';
      return intent === 'facturacion' ? 'billing' : intent === 'soporte_tecnico' ? 'support' : 'commercial';
    })
    .addNode('compose_secondary', async (state) => {
      const {turn,caseState,intent,result}=state;
      if (!caseState.verified || turn.audience !== 'asesor' || result.type !== 'card') return {};
      let supporting = state.supportingCards?.filter(card => !(intent==='cancelacion' && card.route==='soporte_tecnico')) ?? [];
      if (!state.prompts.agent_objectives && intent!=='facturacion' && state.objectives?.includes('facturacion')) {
        const billing = (await billingGraph.invoke({...state,intent:'facturacion'})).result;
        if (billing.type==='card') supporting = [billing];
      }
      if (!supporting.length) return {};
      const cards = [result.card,...supporting.map(item => item.card)];
      return {result:{...result,card:{...result.card,
        summary:state.prompts.agent_objectives ? cards.map(card => card.summary).join(' ') : result.card.summary,
        facts:[...new Map(cards.flatMap(card => card.facts).map(fact => [fact.id,fact])).values()],
        pending:[...new Set(cards.flatMap(card => card.pending))],
        citations:[...new Map(cards.flatMap(card => card.citations).map(source => [source.id,source])).values()]
      }}};

    })
    .addNode('render_private_draft', async ({result,prompts,turn,caseState,objectives}) => ({result:advisorDraft(result,prompts,turn,caseState,prompts.agent_objectives ? objectives : [])}))
    .addEdge('priority_handoff', 'render_private_draft')
    .addEdge('support_followup', 'render_private_draft')
    .addEdge('clarify_duration', 'render_private_draft')
    .addEdge('context_question', END)
    .addEdge('clarify_context', END)
    .addEdge('unresolved_objective', 'render_private_draft')
    .addConditionalEdges('catalogue_advice', ({result})=>result.type==='card' ? 'render_private_draft' : END)
    .addConditionalEdges('commercial_catalogue', ({result})=>result ? END : 'commercial')
    .addEdge('support', 'compose_secondary')
    .addEdge('billing', 'compose_secondary')
    .addEdge('commercial', 'compose_secondary')
    .addEdge('compose_secondary', 'render_private_draft')
    .addEdge('render_private_draft', END)
    .compile();
  return {
    async run(input) {
      const turn = TurnSchema.parse(input); const key = `run:${turn.run_id}`;
      const cached = await get(key); if (cached) return cached;
      const existing = inFlight.get(key); if (existing) return existing;
      const task = (async () => {
        try {
          const state=await graph.invoke({turn,deadline:Date.now()+turnTimeoutMs});
          const context=finishConversation(state.context,state.result,turn);
          const result=ResultSchema.parse({...state.result,...(context ? {conversation_context:context} : {})});
          await put(key,result);
          return result;
        } catch { return {type:'failed',reason:'agent_unavailable',route:'error'} as RunResult; }
      })();
      inFlight.set(key, task); try { return await task; } finally { inFlight.delete(key); readBudgets.delete(turn.run_id); }
    },
    async resume(input: RunResume) {
      const key = `resume:${input.run_id}:${input.effect_id}:${input.status}:${input.effect_ref ?? ''}`;
      const cached = await get(key); if (cached) return cached;
      const original = await get(`run:${input.run_id}`);
      if (!original || original.type !== 'card' || !original.card.proposal || original.card.proposal.id !== input.effect_id) return {type:'failed', reason:'unknown_proposal', route:'resume'};
      const ticket = original.card.proposal.kind === 'support_ticket' || input.effect_ref?.startsWith('ticket-');
      const action = input.status === 'confirmed' && input.effect_ref ? (ticket ? `Ticket registrado: ${input.effect_ref}. Franja de visita pendiente de coordinación.` : `Operación confirmada: ${input.effect_ref}.`) : input.status === 'confirmed' ? 'La confirmación requiere una referencia de operación.' : input.status === 'pending_verification' ? 'El resultado está pendiente de verificación.' : input.status === 'rejected' ? 'La propuesta fue rechazada.' : 'La propuesta expiró.';
      const result: RunResult = {type:'card', route:'resume', card:{...original.card, summary:action, next_action:input.status === 'pending_verification' || (input.status === 'confirmed' && !input.effect_ref) ? 'Verificar el resultado antes de informar una ejecución.' : 'Informar el estado al cliente.', pending: input.status === 'pending_verification' ? ['Verificar resultado'] : []}};
      await put(key, result); return result;
    }
  };
}
