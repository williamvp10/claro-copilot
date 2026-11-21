export { createKnowledgeMcpAdapter, safeKnowledgeQuery } from './mcp.js';
export type { KnowledgeMcpOptions } from './mcp.js';
export { createJevDecisionAdapter, createOpenAIEvidenceSelector, createJevSemanticEvaluator } from './providers.js';
export type { JevOptions, OpenAISelectorOptions, EvidenceSelector, SemanticObservation, SemanticResult } from './providers.js';
import type { EvidenceSelector } from './providers.js';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { AgentTurn as TurnSchema, RunResult as ResultSchema } from '@claro/contracts';
import type { AgentPorts, AgentRunner, AgentTurn, RunResult, RunResume, Citation, Fact, Intent, Message, Retention } from '@claro/contracts';

export type KnowledgeDocument = Citation & { scope: 'public' | 'advisor'; effective_from: string; effective_to?: string; status?: 'ready' | 'draft'; channels?: string[]; products?: string[]; type?: string };
export type Decision = { intent: Intent; complexity: 'economico' | 'intermedio' | 'complejo'; confidence: number };
export interface DecisionAdapter { classify(text: string): Promise<Decision | null> }
export interface KnowledgeAdapter { search(query: string, context: { business_date: string; audience: 'cliente' | 'asesor'; channel: string }): Promise<KnowledgeDocument[]> }
export interface CheckpointStore { get(key: string): Promise<RunResult | undefined>; put(key: string, result: RunResult): Promise<void> }
export type AgentOptions = { documents?: KnowledgeDocument[]; knowledge?: KnowledgeAdapter; decision?: DecisionAdapter; checkpoints?: CheckpointStore; rerank?: (query: string, documents: KnowledgeDocument[]) => Promise<KnowledgeDocument[]>; evidenceSelector?: EvidenceSelector; };

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const tokens = (s: string) => norm(s).match(/[a-z0-9]+/g)?.filter(x => x.length > 2) ?? [];
const has = (s: string, re: RegExp) => re.test(norm(s));
const defaultDocuments: KnowledgeDocument[] = [{ id: 'catalogo-2026-fibra500', title: 'Catálogo de Planes y Tarifas 2026, pág. 1', version: 'CAT-2026 v1.0', excerpt: 'Hogar Fibra 500: 500 Mbps, $109.900 mensuales, módem WiFi 6 y 1 repetidor WiFi. Los precios incluyen IVA.', scope: 'public', effective_from: '2026-11-01', status: 'ready' }];
function allowed(doc: KnowledgeDocument, turn: AgentTurn): boolean {
  return doc.status !== 'draft' && doc.effective_from <= turn.business_date && (!doc.effective_to || turn.business_date < doc.effective_to) && (turn.audience === 'asesor' || doc.scope === 'public') && (!doc.channels || doc.channels.includes(turn.channel));
}
function score(query: string, d: KnowledgeDocument): number {
  const q = new Set(tokens(query)), words = new Set(tokens(`${d.title} ${d.excerpt}`));
  return [...q].reduce((n, word) => n + (words.has(word) ? 1 : 0), 0);
}
function citation(doc: KnowledgeDocument): Citation { const { id, title, excerpt, version, url } = doc; return { id, title, excerpt, version, ...(url ? { url } : {}) }; }
function classify(text: string): Intent {
  if (has(text, /cancel|retir|dar de baja|descuento|oferta/)) return 'cancelacion';
  if (has(text, /portabil|portar/)) return 'portabilidad';
  if (has(text, /factur|saldo|cobr|vencimiento|pagar|pago/)) return 'facturacion';
  if (has(text, /plan|fibra|precio|velocidad/)) return 'consulta_planes';
  return 'soporte_tecnico';
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
function accepted(text: string): boolean { return has(text, /\b(acepto|aceptamos|aceptaria|de acuerdo|si quiero|si acepto|me sirve|lo acepto|la acepto|tomare|quiero esa|quiero ese)\b/) && !has(text, /\b(no acepto|no quiero|no me sirve)\b/); }
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

/** Agent decisions are bounded by server-owned ports; no tool accepts customer identifiers. */
export function createAgent(ports: AgentPorts, options: AgentOptions = {}): AgentRunner {
  const results = new Map<string, RunResult>();
  const inFlight = new Map<string, Promise<RunResult>>();
  const get = async (key: string) => (await options.checkpoints?.get(key)) ?? results.get(key);
  const put = async (key: string, value: RunResult) => { results.set(key, value); await options.checkpoints?.put(key, value); };
  async function retrieve(turn: AgentTurn, profile: Decision['complexity']): Promise<Citation[]> {
    let docs: KnowledgeDocument[];
    try { docs = options.knowledge ? await options.knowledge.search(turn.text, { business_date: turn.business_date, audience: turn.audience, channel: turn.channel }) : options.documents ?? defaultDocuments; } catch { return []; }
    docs = docs.filter(d => allowed(d, turn) && score(turn.text, d) > 0).sort((a,b) => score(turn.text,b) - score(turn.text,a));
    if (options.rerank && docs.length) {
      try {
        const candidates = docs; const reordered = await options.rerank(turn.text, candidates);
        const keys = new Set(candidates.map(d => `${d.id}\0${d.version}`));
        docs = reordered.filter(d => keys.has(`${d.id}\0${d.version}`)).map(d => candidates.find(c => c.id === d.id && c.version === d.version)!);
      } catch { /* use the filtered lexical ranking */ }
    }
    const citations = docs.slice(0, 3).map(citation);
    if (options.evidenceSelector && citations.length > 1) {
      try { const index = await options.evidenceSelector.select(safeDecisionFeatures(turn.text), citations.map(c => ({id:'',title:safeDecisionFeatures(c.title),excerpt:safeDecisionFeatures(c.excerpt),version:''})), profile); if (index !== null && Number.isInteger(index) && index >= 0 && index < citations.length) citations.unshift(...citations.splice(index,1)); } catch { /* preserve filtered lexical order */ }
    }
    return citations;
  }
  type CaseState = Awaited<ReturnType<AgentPorts['readCaseForRun']>>;
  const GraphState = Annotation.Root({ turn: Annotation<AgentTurn>(), caseState: Annotation<CaseState>(), intent: Annotation<Intent>(), profile: Annotation<Decision['complexity']>(), result: Annotation<RunResult>() });
  async function resolve(turn: AgentTurn, state: CaseState, intent: Intent, profile: Decision['complexity']): Promise<RunResult> {
    if (intent === 'consulta_planes' || (intent === 'soporte_tecnico' && !state.verified)) {
      const citations = await retrieve(turn, profile);
      if (!citations.length) return turn.audience === 'asesor' ? card(intent, 'No hay evidencia vigente suficiente.', [], [], ['Consultar fuente autorizada'], 'Solicitar información adicional o derivar.', ['missing_evidence']) : { type:'handoff', reason:'No encontré información vigente suficiente para responder.', pending:'Consultar fuente autorizada', route:intent };
      const answer = citations[0].excerpt;
      return turn.audience === 'asesor' ? card(intent, answer, [], citations, [], 'Compartir la información pertinente.', ['knowledge']) : { type:'answer', answer, citations, route:intent };
    }
    if (!state.verified) {
      return turn.audience === 'asesor' ? card(intent, 'Se necesita verificar la titularidad antes de consultar datos de cuenta.', [], [], ['Verificar titularidad', state.pending ?? 'Consultar la solicitud'], 'Verificar titularidad.', ['verification_required']) : {type:'handoff', reason:'Para consultar tu cuenta, un asesor verificará la titularidad.', pending:'Verificar titularidad y atender la consulta', route:intent};
    }
    if (turn.audience === 'cliente') return {type:'handoff', reason:'Un asesor atenderá tu consulta de cuenta.', pending:'Atención de cuenta', route:intent};
    if (intent === 'facturacion') {
      const [customer, billing] = await Promise.all([ports.getCustomerContext(turn.run_id), ports.getBilling(turn.run_id)]);
      return card(intent, 'Consulta de facturación para titular verificado.', [...customer, ...billing], [], [], 'Explicar los importes y vencimientos verificados.', ['verified_account']);
    }
    if (intent === 'cancelacion' || intent === 'portabilidad') {
      const [customer, retention] = await Promise.all([ports.getCustomerContext(turn.run_id), ports.evaluateRetention(turn.run_id)]);
      const facts = [...customer, ...retention.facts];
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
    const citations = await retrieve(turn, profile);
    return card(intent, citations[0]?.excerpt ?? 'No hay evidencia suficiente para resolver la consulta.', [], citations, citations.length ? [] : ['Consultar fuente autorizada'], citations.length ? 'Compartir el procedimiento aplicable.' : 'Solicitar información adicional o derivar.', [citations.length ? 'knowledge' : 'missing_evidence']);
  }
  const graph = new StateGraph(GraphState)
    .addNode('load_case', async ({ turn }) => {
      const caseState = await ports.readCaseForRun(turn.run_id);
      const config = await ports.getAgentConfig(turn.config_revision);
      if (config.revision !== turn.config_revision) throw new Error('configuration revision mismatch');
      return { caseState, intent: recentPurpose(caseState.messages, turn) };
    })
    .addNode('classify', async ({ turn, caseState }) => {
      let intent = recentPurpose(caseState.messages, turn);
      let profile: Decision['complexity'] = 'economico';
      if (turn.actor === 'cliente' && !accepted(turn.text) && tokens(turn.text).length > 2) intent = classify(turn.text);
      if (options.decision && turn.actor === 'cliente' && !accepted(turn.text)) {
        try { const d = await options.decision.classify(safeDecisionFeatures(turn.text)); if (d && d.confidence >= 0.75 && ['soporte_tecnico','facturacion','consulta_planes','cancelacion','portabilidad'].includes(d.intent)) { intent = d.intent; if (['economico','intermedio','complejo'].includes(d.complexity)) profile = d.complexity; } } catch { /* deterministic fallback */ }
      }
      return { intent, profile };
    })
    .addNode('priority_handoff', async ({ turn, intent }) => ({ result: turn.audience === 'asesor' ? card(intent, 'Se solicita atención humana.', [], [], ['Derivación'], 'Contactar al responsable de atención.', ['human_requested']) : {type:'handoff', reason:'Te comunicaré con un asesor.', pending:'Atención humana', route:'handoff'} as RunResult }))
    .addNode('resolve', async ({ turn, caseState, intent, profile }) => ({ result: await resolve(turn, caseState, intent, profile) }))
    .addEdge(START, 'load_case')
    .addConditionalEdges('load_case', ({ turn }) => /supervisor|hablar con (un |una )?(humano|asesor|persona)|amenaza|emergencia/.test(norm(turn.text)) ? 'priority_handoff' : 'classify')
    .addEdge('classify', 'resolve')
    .addEdge('priority_handoff', END)
    .addEdge('resolve', END)
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
      const action = input.status === 'confirmed' && input.effect_ref ? `Operación confirmada: ${input.effect_ref}.` : input.status === 'confirmed' ? 'La confirmación requiere una referencia de operación.' : input.status === 'pending_verification' ? 'El resultado está pendiente de verificación.' : input.status === 'rejected' ? 'La propuesta fue rechazada.' : 'La propuesta expiró.';
      const result: RunResult = {type:'card', route:'resume', card:{...original.card, summary:action, next_action:input.status === 'pending_verification' || (input.status === 'confirmed' && !input.effect_ref) ? 'Verificar el resultado antes de informar una ejecución.' : 'Informar el estado al cliente.', pending: input.status === 'pending_verification' ? ['Verificar resultado'] : []}};
      await put(key, result); return result;
    }
  };
}
