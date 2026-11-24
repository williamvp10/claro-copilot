export { createOpenAIPublicWriter, validateDraft } from './generation.js';
export type { AgentObservation, PublicWriter } from './generation.js';
import type { AgentObservation, PublicWriter } from './generation.js';
import { safeKnowledgeQuery } from './mcp.js';
import { guidePlans, homePlanPreference, plansDiscovery, prepareKnowledgeQuery, rankKnowledge, retentionPolicyQuery, wifiConfigurationSteps } from './retrieval.js';
import { evolveContext, nextContextQuestion, questionById } from './context.js';
import { mobilePlanTopic, mobilePlanReply, publicReplyLimit, shortPublicEvidence } from './public-reply.js';
import { catalogComparison, catalogMemoryFromReply, catalogPlans, compareCatalog } from './catalogue.js';
export { catalogComparison, catalogPlans } from './catalogue.js';
export { asksToChangeMobilePlan, mobilePlanTopic } from './public-reply.js';
export { contextIntent, evolveContext, nextContextQuestion, recordQuestion, contextQuestions, contextCatalogVersion } from './context.js';
export { retrievalTerms } from './retrieval.js';
export { retentionPolicyQuery } from './retrieval.js';
export { createKnowledgeMcpAdapter, safeKnowledgeQuery } from './mcp.js';
export type { KnowledgeMcpOptions } from './mcp.js';
export { createJevDecisionAdapter, createOpenAIEvidenceSelector, createJevSemanticEvaluator, parseJevQuestion } from './providers.js';
export type { JevOptions, OpenAISelectorOptions, EvidenceSelector, SemanticObservation, SemanticResult } from './providers.js';
import type { EvidenceSelector } from './providers.js';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { AgentTurn as TurnSchema, RunResult as ResultSchema } from '@claro/contracts';
import type { AgentPorts, AgentRunner, AgentTurn, CaseIntake, CatalogPlan, KnowledgeSearchFilters, KnowledgeTags, RunResult, RunResume, Citation, Fact, Intent, Message, Retention } from '@claro/contracts';

export type KnowledgeDocument = Citation & { scope: 'public' | 'advisor'; effective_from: string; effective_to?: string; status?: 'ready' | 'draft'; channels?: string[]; products?: string[]; type?: string; provider_approved?: true; metadata?:KnowledgeTags };
export type Decision = { intent: Intent; complexity: 'economico' | 'intermedio' | 'complejo'; confidence: number };
export interface DecisionAdapter { classify(text: string, prompts?:Record<string,string>): Promise<Decision | null> }
export interface KnowledgeAdapter {
  revision?: string;
  catalog?(context: {business_date:string;channel:string}): Promise<CatalogPlan[]>;
  search(query: string, context: { business_date: string; audience: 'cliente' | 'asesor'; channel: string; filters?:KnowledgeSearchFilters }): Promise<KnowledgeDocument[]>;
}
export interface CheckpointStore { get(key: string): Promise<RunResult | undefined>; put(key: string, result: RunResult): Promise<void> }
export type AgentOptions = { requireApprovedPrompts?: boolean; documents?: KnowledgeDocument[]; knowledge?: KnowledgeAdapter; decision?: DecisionAdapter; checkpoints?: CheckpointStore; rerank?: (query: string, documents: KnowledgeDocument[]) => Promise<KnowledgeDocument[]>; evidenceSelector?: EvidenceSelector; writer?: PublicWriter; observe?: (runId: string, observation: AgentObservation) => void; };

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const tokens = (s: string) => norm(s).match(/[a-z0-9]+/g)?.filter(x => x.length > 2) ?? [];
const has = (s: string, re: RegExp) => re.test(norm(s));
const defaultDocuments: KnowledgeDocument[] = [{ id: 'catalogo-2026-fibra500', title: 'Catálogo de Planes y Tarifas 2026, pág. 1', version: 'CAT-2026 v1.0', excerpt: 'Hogar Fibra 500: 500 Mbps, $109.900 mensuales, módem WiFi 6 y 1 repetidor WiFi. Los precios incluyen IVA.', scope: 'public', effective_from: '2026-11-01', status: 'ready' }];
type KnowledgeTurn = Pick<AgentTurn, 'text' | 'run_id' | 'business_date' | 'audience' | 'channel'> & { home_preference?: ReturnType<typeof homePlanPreference>; intake?:CaseIntake };
function allowed(doc: KnowledgeDocument, turn: KnowledgeTurn): boolean {
  return doc.status !== 'draft' && doc.effective_from <= turn.business_date && (!doc.effective_to || turn.business_date < doc.effective_to) && (turn.audience === 'asesor' || doc.scope === 'public') && (!doc.channels || doc.channels.includes(turn.channel));
}
function citation(doc: KnowledgeDocument): Citation {
  const {id,title,excerpt,version,url,source}=doc;
  return {id,title,excerpt,version,...(url?{url}:{}),...(doc.scope==='public' && source?{source}:{})};
}
function classify(text: string): Intent {
  if (retentionPolicyQuery(text) || has(text, /cancel|retir|dar de baja/)) return 'cancelacion';
  if (has(text, /convergencia|convergente|\b(telefonia|linea|movil) pospago\b/) && has(text, /hogar|plan|combinar|paquete/)) return 'consulta_planes';
  if (has(text, /portabil|portar/)) return 'portabilidad';
  if (has(text, /factur|saldo|cobr|vencimiento|pagar|pago|\b(?:debo|adeudo|deuda|f-\d{4,10})\b/)) return 'facturacion';
  if (has(text, /descuento|oferta/)) return 'cancelacion';
  if (has(text, /\b(e-202|se cae|intermitencia|sin (?:internet|senal)|luces? del modem|fallas?)\b/)) return 'soporte_tecnico';
  if (has(text, /plan|fibra|precio|velocidad/)) return 'consulta_planes';
  return 'soporte_tecnico';
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
  const meaningful = messages.filter(m => m.actor === 'cliente' && m.turn_seq <= turn.turn_seq).reverse().find(m => has(m.text, /cancel|retir|baja|descuento|oferta|factur|saldo|cobr|pagar|portabil|plan|fibra|internet|senal/));
  return classify(meaningful?.text ?? turn.text);
}
/** Sends only fixed categorical signals, never customer-authored text. */
export function safeDecisionFeatures(text: string): string {
  const value = norm(text);
  const features: string[] = [];
  for (const [label, pattern] of [
    ['cancelacion', /cancel|retir|baja/], ['portabilidad', /portab|portar/],
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
function asksCurrentPlanAndBalance(text:string):boolean {
 return has(text,/\b(?:plan(?:es)?|servicios?) (?:actual(?:es)?|vigentes?)\b/) && has(text,/\b(?:saldo|deuda|adeudo|debo)\b/);
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
        attempts+=1;
        const docs=options.knowledge ? await options.knowledge.search(query,{business_date:turn.business_date,
          audience:turn.audience,channel:turn.channel,filters:plan.filters}) : options.documents ?? defaultDocuments;
        const permitted=docs.filter(doc=>allowed(doc,turn) && (!plan.filters.source ||
          (doc.metadata?.source ?? doc.id.replace(/-\d{3}$/,''))===plan.filters.source));
        return rankKnowledge(query,permitted,plan.filters);
      }
      try {
        let ranked=await search(plan.query);
        const exact=plan.filters.tags.find(tag=>tag==='elegibilidad' || tag==='e-202' || tag.startsWith('fibra-'));
        const weak=exact && ranked[0]?.metadata && !ranked[0].metadata.tags.includes(exact);
        if ((!ranked.length || weak) && plan.retry && plan.retry!==plan.query) {
          const second=await search(plan.retry);
          if (!ranked.length || second[0]?.metadata?.tags.includes(exact ?? '')) ranked=second;
        }
        return {ranked,unavailable:false,attempts};
      } catch {
        return {ranked:[],unavailable:true,attempts};
      }
    }).addEdge(START,'plan_search').addEdge('plan_search','find_evidence').addEdge('find_evidence',END).compile();
  async function retrieve(turn: KnowledgeTurn, profile: Decision['complexity'], prompts:Record<string,string>, selectEvidence = true) {
    const started = Date.now();
    const {plan,ranked,unavailable,attempts}=await graph.invoke({turn});
    const revision=options.knowledge?.revision ?? 'legacy';
    let docs=ranked;
    if (options.rerank && docs.length) {
      try {
        const candidates = docs; const reordered = await options.rerank(turn.text, candidates);
        const keys = new Set(candidates.map(d => `${d.id}\0${d.version}`));
        docs = reordered.filter(d => keys.has(`${d.id}\0${d.version}`)).map(d => candidates.find(c => c.id === d.id && c.version === d.version)!);
      } catch { /* use the filtered lexical ranking */ }
    }
    options.observe?.(turn.run_id, { name:'retrieval', started, ended:Date.now(),
      metadata:{ count:docs.length, top_5:docs.slice(0,5).map(x=>x.id).join(','), agent_id:'conocimiento',step_id:'retrieve_knowledge',tool_id:'search_knowledge',
        index_revision:revision, tags:plan.filters.tags.join(','), source:plan.filters.source ?? '', attempts } });
    const candidates = docs.slice(0, 3);
    const publicCandidates = candidates.filter(doc=>doc.scope==='public' && doc.provider_approved===true);
    if (turn.audience==='cliente' && !plansDiscovery(turn.text) && selectEvidence && options.evidenceSelector && publicCandidates.length > 1 && (!options.requireApprovedPrompts || Boolean(prompts.public_evidence_selector))) {
      try { const index = await options.evidenceSelector.select(safeDecisionFeatures(turn.text), publicCandidates.map(c => ({id:'',title:safeDecisionFeatures(c.title),excerpt:safeDecisionFeatures(c.excerpt),version:''})), profile, prompts.public_evidence_selector); if (index !== null && Number.isInteger(index) && publicCandidates[index]) candidates.unshift(...candidates.splice(candidates.indexOf(publicCandidates[index]),1)); } catch { /* preserve filtered lexical order */ }
    }
    return { candidates, ranked:docs, unavailable, search:{query:plan.query,...plan.filters,attempts,revision} };
  }
  async function answer(turn:KnowledgeTurn, profile:Decision['complexity'], publicPrompt:string, documents:KnowledgeDocument[]) {
    const citations=documents.map(citation);
    const [top]=citations;
    if (!top) return null;
    const mobile=turn.audience==='cliente' && mobilePlanReply(mobilePlanTopic(turn.text),documents,turn.channel);
    if (mobile) {
      const used=[citation(mobile.doc)];
      return {answer:mobile.text,citations:used,used,mode:'guided' as const};
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
      const min=procedure[2].excerpt.match(/m[ií]nimo (\d+) caracteres/i)?.[1];
      return {answer:`Abre ${address} en el navegador. Entra con el usuario admin y la clave de la etiqueta. Ve a Red, WLAN y SSID. Cambia la contraseña${min?` (mínimo ${min} caracteres)`:''} y guarda.`,
        citations:sources,used:sources,mode:'guided' as const};
    }
    const approvedEvidence=documents.filter(document=>document.scope==='public' && document.provider_approved===true).map(citation);
    if (turn.audience==='cliente' && options.writer && approvedEvidence.length && (!options.requireApprovedPrompts || Boolean(publicPrompt))) {
      const draft=await options.writer.write(safeKnowledgeQuery(turn.text),approvedEvidence,profile,publicPrompt,
        observation=>options.observe?.(turn.run_id,{...observation,metadata:{...observation.metadata,agent_id:'copiloto',step_id:'draft_public_reply',prompt_ref:'public_answer'}}),turn.channel);
      if (draft && draft.answer.length<=publicReplyLimit(turn.channel)) return {...draft,used:draft.citations,mode:'openai' as const};
    }
    const decoder=turn.audience==='cliente' && has(turn.text,/\be[ -]?202\b/) && documents.find(doc=>
      has(doc.excerpt,/refresc\w* (?:la )?senal/) && /\b15 minutos\b/i.test(doc.excerpt) && has(doc.excerpt,/mi claro.*mi tv/s));
    if (decoder) {
      const used=[citation(decoder)];
      return {answer:'El decodificador necesita actualizar la autorización del servicio. Abre Mi Claro, entra en Mi TV y elige «Refrescar señal». Deja el decodificador encendido y espera hasta 15 minutos.',citations:used,used,mode:'guided' as const};
    }
    const plan=turn.audience==='cliente' && turn.text.match(/\bfibra\s*(300|500|900)\b/i)?.[1];
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
  const results = new Map<string, RunResult>();
  const inFlight = new Map<string, Promise<RunResult>>();
  const get = async (key: string) => (await options.checkpoints?.get(key)) ?? results.get(key);
  const put = async (key: string, value: RunResult) => { results.set(key, value); await options.checkpoints?.put(key, value); };
  const {retrieve: retrieveKnowledge, answer: answerKnowledge} = createKnowledgePipeline(options);
  async function retrieve(turn:AgentTurn, profile:Decision['complexity'], prompts:Record<string,string>, selectEvidence=true) {
    return (await retrieveKnowledge(turn,profile,prompts,selectEvidence)).candidates;
  }
  type CaseState = Awaited<ReturnType<AgentPorts['readCaseForRun']>>;
  function policyText(turn:AgentTurn,state:CaseState):string {
    const current=norm(turn.text);
    if (/\blos\b/.test(current) || !/\b(?:\d+|un|una|dos|tres|cuatro|cinco|diez|media|varias|varios)\s*(?:minutos?|mins?|horas?|dias?)\b/.test(current)) return turn.text;
    const previous=state.messages.filter(m=>m.actor==='cliente' && m.turn_seq<turn.turn_seq).at(-1);
    return previous && needsLosDuration(previous.text) ? `${previous.text} ${turn.text}` : turn.text;
  }
  function comparisonFor(turn:AgentTurn, state:CaseState) {
    return turn.audience==='cliente' && turn.actor==='cliente' && turn.attention_mode==='autoservicio'
      ? catalogComparison(turn.text,state.messages,state.conversation_memory,turn.turn_seq) : undefined;
  }
  const GraphState = Annotation.Root({ turn: Annotation<AgentTurn>(), caseState: Annotation<CaseState>(), intent: Annotation<Intent>(), profile: Annotation<Decision['complexity']>(), publicPrompt: Annotation<string>(), prompts: Annotation<Record<string,string>>(), result: Annotation<RunResult>(), historyOnly:Annotation<boolean>() });
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
  const explicitAccountBilling = (text:string) => has(text,/\b(mi factura|mi saldo|mi vencimiento|mi deuda|cuanto debo|cuanto adeudo|me cobro|me cobraron|f-\d{4,10})\b/);
  async function resolve(turn: AgentTurn, state: CaseState, intent: Intent, profile: Decision['complexity'], publicPrompt: string, prompts:Record<string,string>, agentId:Domain, historyOnly:boolean): Promise<RunResult> {
    const scopeStep = agentId==='facturacion' ? 'resolve_billing_facts'
      : agentId==='soporte' ? 'read_service_context' : 'read_commercial_context';
    async function readCaseTool<T extends Fact[] | Retention>(toolId:CaseRead, purpose:ReadPurpose, read:()=>Promise<T>) {
      if (!state.verified || turn.audience !== 'asesor' || !domainReads[agentId].includes(toolId)) throw new Error('tool not permitted for subgraph');
      const started = Date.now();
      let status = 'success';
      try {
        const result = await read();
        if (sourceUnavailable(Array.isArray(result) ? result : result.facts)) status = 'error';
        return result;
      } catch (error) {
        status = 'error';
        throw error;
      } finally {
        options.observe?.(turn.run_id,{name:`tool.${toolId}`,started,ended:Date.now(),
          metadata:{status,tool_id:toolId,agent_id:agentId,step_id:scopeStep,purpose}});
      }
    }
    const getServices = (purpose:ReadPurpose) => readCaseTool('crm.list_services',purpose,() =>
      (ports.listServices ?? ports.getCustomerContext)(turn.run_id));
    if (historyOnly && agentId === 'soporte') {
      const history = await readCaseTool('crm.list_recent_tickets','review_recurrence',() => ports.getTickets(turn.run_id));
      return card(intent,'Antecedentes técnicos del caso.',history,[],[],'Revisar la recurrencia.',['service_history']);
    }
    if (has(turn.text,/\b(cotizacion bursatil|bolsa de valores|precio de (la accion|las acciones)|criptomoneda|pronostico bursatil)\b/)) {
      return {type:'handoff',reason:'Puedo ayudarte con planes, facturas y soporte de Claro.',pending:'Consulta fuera del alcance',route:'fuera_de_alcance'};
    }
    const policyQuestion = has(turn.text,/\b(cual|cuales|cuanto|cuanta|como|que|cuando|plazo|politica|contrato|clausula|penalidad|nip|pqr|requisitos)\b/)
      && !explicitAccountBilling(turn.text) && !asksCurrentPlanAndBalance(turn.text) && !has(turn.text,/\b(mi cuenta|mi (plan|linea) actual|quiero cancelar|c-\d{4})\b/);
    const advisorKnowledge = turn.audience === 'asesor' && !state.verified;
    const generalPortability = intent === 'portabilidad' && policyQuestion && !state.verified;
    if (retentionPolicyQuery(turn.text) || intent === 'consulta_planes' || (intent === 'soporte_tecnico' && (turn.audience==='cliente' || !state.verified)) || intent === 'portabilidad' || (intent === 'facturacion' && policyQuestion) || generalPortability || (advisorKnowledge && policyQuestion)) {
      if (turn.audience==='cliente' && state.intake?.facts.imagen==='Imagen recuperada' && !has(turn.text,/\be[ -]?202\b/)) {
        return {type:'answer',answer:'Me alegra que haya vuelto la imagen. Si vuelve a fallar, cuéntame qué aparece en pantalla.',citations:[],route:intent};
      }
      if (turn.audience==='cliente' && state.intake?.facts.imagen==='Imagen aún ausente' && !has(turn.text,/\be[ -]?202\b/)) {
        return {type:'answer',answer:'Entiendo que la imagen sigue sin volver. Si ya transcurrieron los 15 minutos con el equipo encendido, puedo comunicarte con un asesor. ¿Quieres hablar con uno?',citations:[],route:intent};
      }
      const query={...planConversation(turn,state.messages),intake:state.intake};
      const documents = await retrieve(query, profile, prompts);
      const reply=await answerKnowledge(query,profile,publicPrompt,documents);
      if (!reply) return turn.audience === 'asesor'
        ? card(intent, 'No hay evidencia vigente suficiente.', [], [], ['Consultar fuente autorizada'], 'Solicitar información adicional o derivar.', ['missing_evidence'])
        : retentionPolicyQuery(turn.text)
          ? {type:'answer',answer:'Si estás considerando cancelar o quieres revisar las opciones para tu cuenta, puedo ayudarte a comunicarte con un asesor. ¿Quieres hablar con uno?',citations:[],route:'cancelacion'}
        : { type:'answer', answer:'No puedo confirmar ese dato con la información vigente. Puedo pedirle a un asesor que lo revise. ¿Quieres hablar con uno?', citations:[], route:intent, needs_clarification:true };
      const askDecoder=intent==='soporte_tecnico' && has(turn.text,/\be[ -]?202\b/) &&
        !state.intake?.asked.includes('imagen') && !state.intake?.facts.imagen &&
        reply.used.some(c=>/15 minutos/i.test(c.excerpt));
      return turn.audience === 'asesor'
        ? card(intent,reply.answer,[],reply.citations,[],'Compartir la información pertinente.',['knowledge'])
        : {type:'answer',answer:reply.answer + (askDecoder && !reply.answer.includes('?')
            ? '\n\nCuando termine la espera, cuéntame: ¿volvió la imagen?' : ''),citations:reply.used,route:intent,
          ...(intent==='consulta_planes' ? {conversation_memory:catalogMemoryFromReply(turn.text,reply.answer,reply.used,state.conversation_memory)} : {}),
          ...(reply.mode==='guided' && 'needsClarification' in reply && reply.needsClarification ? {needs_clarification:true} : {}),
          ...(askDecoder ? {context_question:questionById('imagen')} :
            'contextField' in reply && reply.contextField ? {context_question:questionById(reply.contextField)} : {})};
    }
    if (!state.verified) {
      return turn.audience === 'asesor' ? card(intent, 'Se necesita verificar la titularidad antes de consultar datos de cuenta.', [], [], ['Verificar titularidad', state.pending ?? 'Consultar la solicitud'], 'Verificar titularidad.', ['verification_required']) : {type:'handoff', reason:'Para consultar tu cuenta, un asesor verificará la titularidad.', pending:'Verificar titularidad y atender la consulta', route:intent, verification_required:true};
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
      const detail = invoiceId
        ? (getDetail ? await readCaseTool('billing.get_invoice_detail','inspect_invoice',() => getDetail(turn.run_id,invoiceId)) : [])
        : invoiceRequested && listInvoices
          ? await readCaseTool('billing.list_invoices','review_invoices',() => listInvoices(turn.run_id)) : [];
      const balance = balanceRequested || !invoiceRequested || (!getDetail && !listInvoices)
        ? await readCaseTool('billing.get_balance','explain_balance',() => ports.getBilling(turn.run_id)) : [];
      const currentPlanAndBalance=asksCurrentPlanAndBalance(turn.text);
      const safeToReadPlan=!invoiceId || (detail.length>0 && !sourceUnavailable(detail));
      const services = safeToReadPlan && (currentPlanAndBalance || (comparePlan && detail.length>0 && !sourceUnavailable(detail)))
        ? await getServices(currentPlanAndBalance ? 'review_current_plan' : 'compare_billed_service') : [];
      const billingUnavailable = sourceUnavailable([...detail,...balance]);
      const crmUnavailable = sourceUnavailable(services);
      const pending = [...(billingUnavailable ? ['Consultar Facturación · API mock'] : []),...(crmUnavailable ? ['Consultar CRM · API mock'] : [])];
      return card(intent, billingUnavailable ? 'La fuente de facturación está pendiente.' : 'Consulta de facturación para titular verificado.',
        [...detail,...balance,...services], [], pending, pending.length ? 'Revisar las fuentes pendientes antes de explicar su parte del cargo.'
          : comparePlan ? 'Contrastar la factura y el plan vigente. Explicar el aumento solo si los conceptos lo sustentan.' : currentPlanAndBalance ? 'Explicar los planes activos, el saldo y el vencimiento verificados.' : 'Explicar los importes y vencimientos verificados.',
        [pending.length ? 'source_unavailable' : 'verified_account']);
    }
    const customerContext = () => readCaseTool('crm.get_customer_context','review_customer_context',() => ports.getCustomerContext(turn.run_id));
    let customer: Fact[] | undefined;
    if (intent === 'cancelacion' && [turn.text,...state.messages.filter(message => message.actor === 'cliente' && message.turn_seq <= turn.turn_seq).map(message => message.text)]
      .some(text => cancellationWithFaults(text) || has(text, /\b(se cae|caidas|fallas recurrentes|intermitencia|falla todo el tiempo)\b/))) {
      const [context, support] = await Promise.all([customerContext(),supportGraph.invoke({turn,caseState:state,intent:'soporte_tecnico',profile,publicPrompt,prompts,historyOnly:true})]);
      customer = context;
      const tickets = support.result.type === 'card' ? support.result.card.facts : [];
      if (!tickets.length || sourceUnavailable(tickets)) return card(intent,'Falta confirmar las fallas reportadas.',[...customer,...tickets],[],['Consultar antecedentes técnicos en CRM · API mock'],'Revisar los tickets antes de evaluar una oferta.',['source_unavailable']);
      const recurrence = tickets.find(fact => fact.id === 'technical-tickets-90d');
      if (recurrence && Number(recurrence.value) >= 3) {
        const evidence: Citation = {
          id:'retention-recurrent-faults', title:'Política de retención y fallas recurrentes',
          version:'POL-RET-2026 v3.1', excerpt:'Gestionar una visita técnica prioritaria dentro de 24 horas antes de evaluar una oferta cuando se cumple el umbral de recurrencia.'
        };
        const proposal = await ports.createProposal(turn.run_id, {option_id:'priority-ticket',citation_ids:[evidence.id]});
        return card('cancelacion','Fallas técnicas recurrentes. Corresponde gestionar una visita técnica prioritaria dentro de 24 horas.',
          [...customer,...tickets],[evidence],['Aprobación del asesor'], 'Aprobar el registro del ticket prioritario.',
          ['priority_support_required'],proposal);
      }
    }
    if (intent === 'cancelacion') {
      const [context, retention] = await Promise.all([customer ?? customerContext(),readCaseTool('crm.evaluate_retention','check_offer_eligibility',() => ports.evaluateRetention(turn.run_id))]);
      const facts = [...context, ...retention.facts];
      if (sourceUnavailable(retention.facts)) return card(intent,'La fuente de elegibilidad está pendiente.',facts,[],['Consultar elegibilidad en CRM · API mock'],'Verificar la elegibilidad antes de ofrecer alternativas.',['source_unavailable']);
      const citations = [retention.policy];
      if (!retention.eligible) return card(intent, `Resultado de elegibilidad: ${retention.reason}`, facts, citations, ['Trámite solicitado por el cliente'], 'Continuar el trámite solicitado sin ofrecer alternativas no elegibles.', ['retention_ineligible']);
      const alternatives = retention.options.map(o => `${o.title}: ${o.detail}`).join(' · ');
      let proposal;
      if (turn.actor === 'cliente' && accepted(turn.text)) {
        const selected = selectOption(turn.text, retention.options, state.messages.filter(m => m.turn_seq < turn.turn_seq));
        if (selected) proposal = await ports.createProposal(turn.run_id, {option_id:selected.id, citation_ids:[retention.policy.id]});
        else return card(intent, `Alternativas elegibles: ${alternatives}`, facts, citations, ['Precisar la alternativa aceptada'], 'Preguntar cuál alternativa acepta el cliente.', ['option_unclear']);
      }
      const advisorPresented = state.messages.some(m => m.actor === 'asesor' && has(m.text, /oferta|descuento|mejora|alternativa/));
      return card(intent, `Resultado de elegibilidad: ${retention.reason}. Alternativas: ${alternatives}`, facts, citations, proposal ? ['Aprobación del asesor'] : ['Decisión del cliente'], proposal ? 'Revisar y aprobar la propuesta en consola.' : advisorPresented ? 'Esperar la decisión del cliente.' : 'Presentar las alternativas y esperar la decisión del cliente.', ['retention_eligible'], proposal);
    }
    const citations = (await retrieve(turn, profile, prompts)).map(citation);
    const supportFacts = intent === 'soporte_tecnico' && has(turn.text,/\b(mi (internet|fibra|modem|equipo|decodificador)|tengo intermitencia|sigo sin (internet|senal))\b/)
      ? await getServices('identify_affected_service') : [];
    return card(intent, citations[0]?.excerpt ?? 'No hay evidencia suficiente para resolver la consulta.', supportFacts, citations,
      [...(citations.length ? [] : ['Consultar fuente autorizada']),...(sourceUnavailable(supportFacts) ? ['Consultar CRM · API mock'] : [])],
      citations.length ? 'Compartir el procedimiento aplicable.' : 'Solicitar información adicional o derivar.', [citations.length ? 'knowledge' : 'missing_evidence']);
  }
  const specialized = (agentId:Domain) => new StateGraph(GraphState)
    .addNode('domain_read_and_compose', async ({turn,caseState,intent,profile,publicPrompt,prompts,historyOnly}) => {
      const started=Date.now(); const result=await resolve(turn,caseState,intent,profile,publicPrompt,prompts,agentId,historyOnly ?? false);
      options.observe?.(turn.run_id,{name:'retrieval',started,ended:Date.now(),metadata:{agent_id:agentId,step_id:'propose_next_action'}});
      return {result};
    }).addEdge(START,'domain_read_and_compose').addEdge('domain_read_and_compose',END).compile();
  const supportGraph=specialized('soporte');
  const billingGraph=specialized('facturacion');
  const commercialGraph=specialized('comercial');
  function renderTemplate(template:string, values:Record<string,string>):string {
    return template.replace(/{{\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*}}/g,(_,key:string)=>values[key] ?? '').trim();
  }
  function advisorDraft(result:RunResult, prompts:Record<string,string>, turn:AgentTurn, state:CaseState):RunResult {
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
    const handoff = c.reason_codes.includes('human_requested') && prompts.handoff_summary ? renderTemplate(prompts.handoff_summary,{reason:c.summary,verified_facts:facts || 'Sin hechos de cuenta.',source_refs:c.citations.map(x=>`${x.title} · ${x.version}`).join('; ') || 'Sin fuentes.',recorded_actions:'Sin acciones confirmadas.',pending_steps:c.pending.join('; ') || c.next_action}) : undefined;
    const question=c.suggested_escalation || c.proposal || c.reason_codes.includes('human_requested') ? undefined :
      nextContextQuestion(state.intake ?? evolveContext(turn.text,undefined,c.intent ?? undefined));
    return {...result,card:{...c,context_question:question,advisor_draft:unsafe ? fallback : rendered,advisor_draft_run_id:turn.run_id,...(handoff && handoff.length < 4000 ? {handoff_summary:handoff} : {})}};
  }
  const graph = new StateGraph(GraphState)
    .addNode('load_case', async ({ turn }) => {
      const caseState = await ports.readCaseForRun(turn.run_id);
      const config = await ports.getAgentConfig(turn.config_revision);
      if (config.revision !== turn.config_revision) throw new Error('configuration revision mismatch');
      return { caseState, prompts:config.prompts, publicPrompt: config.prompts.public_answer ?? '', intent: recentPurpose(caseState.messages, turn) };
    })
    .addNode('classify', async ({ turn, caseState, prompts }) => {
      let intent = recentPurpose(caseState.messages, turn);
      let profile: Decision['complexity'] = 'economico';
      if (turn.actor === 'cliente' && !accepted(turn.text) && tokens(turn.text).length > 2) intent = classify(turn.text);
      if (options.decision && turn.actor === 'cliente' && !accepted(turn.text) && (!options.requireApprovedPrompts || Boolean(prompts.intent_decision && prompts.complexity_decision))) {
        const started = Date.now();
        let status = 'fallback';
        try {
          const decision = await options.decision.classify(safeDecisionFeatures(turn.text), prompts);
          if (decision && decision.confidence >= 0.75) {
            if (!(intent === 'cancelacion' && (explicitAccountBilling(turn.text) || asksCurrentPlanAndBalance(turn.text)))) intent = decision.intent;
            profile = decision.complexity;
            status = 'accepted';
          }
        } catch { /* Keep the local rules when Jev is unavailable. */ }
        options.observe?.(turn.run_id, { name:'decision.jev', started, ended:Date.now(), metadata:{status,intent,profile,agent_id:'copiloto',step_id:'classify_turn',prompt_ref:'intent_decision'} });
      }
      if (retentionPolicyQuery(turn.text) || cancellationWithFaults(turn.text)) intent='cancelacion';
      else if (asksCurrentPlanAndBalance(turn.text) && !has(turn.text,/\b(?:cancel\w*|retir\w*|dar de baja)\b/)) intent='facturacion';
      else if (plansDiscovery(planConversation(turn,caseState.messages).text) || mobilePlanTopic(planConversation(turn,caseState.messages).text)) intent='consulta_planes';
      else if (caseState.intake?.intent==='cancelacion' && !retentionPolicyQuery(turn.text)) intent='cancelacion';
      else if (caseState.intake?.intent==='soporte_tecnico' && ['Lentitud','E-202','Luz LOS roja'].includes(caseState.intake.facts.sintoma ?? '')) intent='soporte_tecnico';
      return { intent, profile };
    })
    .addNode('catalogue_advice', async ({turn,caseState}) => {
      const comparison = comparisonFor(turn,caseState);
      if (!comparison) throw new Error('missing catalogue comparison');
      const started=Date.now();
      // Pricing reads the full published catalogue and never invokes a generative model.
      const plans = options.knowledge
        ? await options.knowledge.catalog?.({business_date:turn.business_date,channel:turn.channel}).catch(()=>[]) ?? []
        : catalogPlans(options.documents ?? [],turn);
      const {text,citations,state} = compareCatalog(comparison,plans);
      options.observe?.(turn.run_id,{name:'tool.list_catalog_plans',started,ended:Date.now(),metadata:{
        agent_id:'comercial',step_id:'compare_catalogue',tool_id:'list_catalog_plans',
        reference_resolution:comparison.resolution, catalog_version:citations[0]?.version ?? 'unavailable',
        decision:citations.length ? (comparison.segment ? 'answer' : 'ask') : 'offer_handoff',
        reason:citations.length ? (comparison.segment ? 'lowest_applicable_price' : 'choose_service') : 'unconfirmed_catalogue'
      }});
      const result:RunResult={type:'answer',answer:text,citations,route:'consulta_planes',conversation_memory:state,
        ...(citations.length ? {catalog_answer:true} : {needs_clarification:true})};
      return {result};
    })
    .addNode('clarify_duration', async ({turn}) => ({result:turn.audience === 'asesor' ? card('soporte_tecnico','Falta confirmar cuánto tiempo lleva roja la luz LOS.',[],[],['Duración de la luz LOS roja'],'Preguntar al cliente cuántos minutos lleva roja la luz LOS.',['duration_required']) : {type:'answer',answer:'¿Cuántos minutos lleva roja la luz LOS?',citations:[],route:'soporte_tecnico',needs_clarification:true,context_question:questionById('duracion')} as RunResult}))
    .addNode('priority_handoff', async ({ turn, intent, caseState, prompts }) => {
      const policy=mandatoryPolicyRoute(policyText(turn,caseState));
      if (!policy) return {result:turn.audience === 'asesor' ? card(intent,'Se solicita atención humana.',[],[],['Derivación'],'Contactar al responsable de atención.',['human_requested']) : {type:'handoff',reason:'Solicitaré atención de un asesor.',pending:'Atención humana',route:'handoff'} as RunResult};
      const destination=policy.destination === 'supervision' ? 'supervisión' : 'soporte técnico de nivel 2';
      if (turn.audience === 'cliente') return {result:{type:'handoff',reason:`Dejé la solicitud en espera para que un asesor revise la derivación a ${destination}.`,pending:`${policyReasons[policy.reason_code]} Revisar derivación a ${destination}.`,route:policy.destination === 'supervision' ? 'handoff' : 'soporte_tecnico'} as RunResult};
      // La derivación ya está decidida. Recuperar fuentes solo para explicar la regla al asesor.
      const query = policyText(turn,caseState);
      const documents = await retrieve({...turn,text:`${query} política de escalamiento ${destination}`},'economico',prompts,false);
      const citations = documents.map(citation);
      const out=card(policy.destination === 'soporte_tecnico' ? 'soporte_tecnico' : intent,
        policyReasons[policy.reason_code] ?? `Se recomienda revisión por ${destination}.`,[],citations,[`Revisar solicitud a ${destination}`],
        `Revisar y confirmar la solicitud de escalamiento a ${destination}.`,['human_requested',policy.reason_code]);
      if (out.type === 'card') out.card.suggested_escalation=policy;
      return {result:out};
    })
    .addNode('support', supportGraph)
    .addNode('billing', billingGraph)
    .addNode('commercial', commercialGraph)
    .addNode('context_question', async ({turn,intent,caseState})=>{
      const next=nextContextQuestion(caseState.intake);
      if (!next) throw new Error('missing context question');
      const at=Date.now();
      options.observe?.(turn.run_id,{name:'context',started:at,ended:at,metadata:{decision:'ask',question_id:next.id,agent_id:'copiloto'}});
      return {result:{type:'answer',answer:next.text,citations:[],route:intent,needs_clarification:true,context_question:next} as RunResult};
    })
    .addEdge(START, 'load_case')
    .addConditionalEdges('load_case', ({ turn,caseState }) => mandatoryPolicyRoute(policyText(turn,caseState)) || /hablar con (un |una )?(humano|asesor|persona)/.test(norm(turn.text)) ? 'priority_handoff' : needsLosDuration(turn.text) ? 'clarify_duration' : comparisonFor(turn,caseState) ? 'catalogue_advice' : 'classify')
    .addConditionalEdges('classify', ({turn,intent,caseState}) => {
      const next=nextContextQuestion(caseState.intake);
      if (turn.audience==='cliente' && next && ['codigo','medio','cable','cargo','pago','direccion','tramite'].includes(next.id)) return 'context_question';
      return intent === 'facturacion' ? 'billing' : intent === 'soporte_tecnico' ? 'support' : 'commercial';
    })
    .addNode('compose_secondary', async (state) => {
      const {turn,caseState,intent,result}=state;
      if (!caseState.verified || turn.audience !== 'asesor' || result.type !== 'card' || intent === 'facturacion' || !explicitAccountBilling(turn.text)) return {};
      const secondary=await billingGraph.invoke({...state,intent:'facturacion'});
      if (secondary.result.type !== 'card') return {};
      return {result:{...result,card:{...result.card,facts:[...result.card.facts,...secondary.result.card.facts],pending:[...result.card.pending,...secondary.result.card.pending]}}};
    })
    .addNode('render_private_draft', async ({result,prompts,turn,caseState}) => ({result:advisorDraft(result,prompts,turn,caseState)}))
    .addEdge('priority_handoff', 'render_private_draft')
    .addEdge('clarify_duration', 'render_private_draft')
    .addEdge('context_question', END)
    .addEdge('catalogue_advice', END)
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
      const task = (async () => { try { const result = ResultSchema.parse((await graph.invoke({turn})).result); await put(key, result); return result; } catch { return {type:'failed', reason:'agent_unavailable', route:'error'} as RunResult; } })();
      inFlight.set(key, task); try { return await task; } finally { inFlight.delete(key); }
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
