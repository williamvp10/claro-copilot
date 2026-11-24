import type { CatalogPlan, CatalogSegment, ConversationMemory, Message } from '@claro/contracts';
import type { KnowledgeDocument } from './index.js';
import { cancellationRequest, changesCancellationToPlan } from './objectives.js';

const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const pricePreference = /\b(?:barat\w*|economic[oa]s?|menor precio|precio (?:mas bajo|menor)|ahorrar|pagar menos)\b/;
const askExpert = /^(?:no se[, ]+)?(?:(?:entonces |pues )?dime tu|tu dime|(?:cual |que )?me recomiendas)(?=[, .!?¡¿]|$)/;
const otherTopic = /\b(?:factura\w*|saldo|deuda|me cobr\w*|cancel\w*|retencion|portabilidad|tecnico|fallas?|decodificador|e[ -]?202)\b/;
const advisor = /\b(?:asesor[a]?|atencion humana|hablar con (?:una? )?(?:persona|humano))\b/;
const catalogVersion = /^CAT-2026\s+v\d+(?:\.\d+)+$/i;

const tableRows = [
  {segment:'hogar', heading:/internet hogar|triple play/, standard:/^(?:Hogar Fibra|Triple Play) /i,
    row:/^([\p{L}][^$]{1,79}?)\s+(\d+\s+Mbps)\s+\$([\d.]+)(?=\s|$)/iu},
  {segment:'movil_pospago', heading:/telefonia movil pospago/, standard:/^Claro Max /i,
    row:/^([\p{L}][^$]{1,79}?)\s+(\d+\s+GB|Ilimitados?\*?)\s+\$([\d.]+)(?=\s|$)/iu},
  {segment:'movil_prepago', heading:/telefonia movil prepago/, standard:/^Paquete /i,
    row:/^([\p{L}][^$]{1,79}?)\s+(\d+\s+GB)\s+(24 horas|7 días|30 días)\s+\$([\d.]+)(?=\s|$)/iu}
] as const;

export function catalogPlans(documents: KnowledgeDocument[], context: {business_date:string; channel:string}): CatalogPlan[] {
  const groups = new Map<CatalogSegment, CatalogPlan[]>();
  for (const doc of documents) {
    if (doc.scope!=='public' || doc.status!=='ready' || !catalogVersion.test(doc.version) ||
        (doc.type!=='catalogo' && !/^catalogo-v\d+$/.test(doc.metadata?.source ?? '')) ||
        doc.effective_from > context.business_date || (doc.effective_to && context.business_date >= doc.effective_to) ||
        (doc.channels && !doc.channels.includes(context.channel))) continue;
    const {id,title,excerpt,version,source,url} = doc;
    let section = tableRows.find(group=>group.heading.test(normalize(doc.metadata?.section ?? title)))?.segment;
    for (const rawLine of excerpt.split(/\r?\n/)) {
      const line=rawLine.trim();
      const heading=tableRows.find(group=>group.heading.test(normalize(line)));
      if (heading && !line.includes('$')) section=heading.segment;
      for (const {segment,row,standard} of tableRows) {
        if (section!==segment && !standard.test(line)) continue;
        const match = line.match(row);
        if (!match) continue;
        const [,name,allowance,amountOrValidity,packageAmount] = match;
        const validity = packageAmount ? amountOrValidity as CatalogPlan['validity'] : undefined;
        const amount = packageAmount ?? amountOrValidity;
        if (!/^\d{1,3}(?:\.\d{3})*$/.test(amount)) continue;
        const price = Number(amount.replaceAll('.',''));
        if (!Number.isSafeInteger(price) || price <= 0) continue;
        const values = groups.get(segment) ?? [];
        values.push({name,segment,price,allowance:allowance.replace(/\*$/,'').replace(/\s+/g,' '),validity,citation:{id,title,excerpt,version,source,url}});
        groups.set(segment,values);
      }
    }
  }
  // Conflicting active editions or prices make that category unsafe to quote.
  return [...groups.values()].flatMap(plans => {
    const unique = new Map(plans.map(plan=>[normalize(plan.name),plan]));
    if (new Set(plans.map(plan=>plan.citation.version)).size !== 1 ||
        plans.some(plan=>{
          const matching=unique.get(normalize(plan.name));
          return matching?.price!==plan.price || matching.allowance!==plan.allowance || matching.validity!==plan.validity;
        })) return [];
    return [...unique.values()].sort((a,b)=>a.price-b.price || a.name.localeCompare(b.name,'es'));
  });
}

function explicitSegment(text: string): CatalogSegment | undefined {
  if (/\b(?:prepago|recarg\w*|paquete (?:de datos|dia|semanal|mensual))\b/.test(text)) return 'movil_prepago';
  if (/\b(?:hogar|casa|apartamento|fibra|triple play)\b/.test(text)) return 'hogar';
  if (/\b(?:movil|moviles|celular|pospago|max (?:\d+ gb|ilimitado)|(?:plan|el) ilimitado)\b/.test(text)) return 'movil_pospago';
}

function namedPlan(text: string): string | undefined {
  const name = normalize(text).match(/\b(?:hogar fibra \d+|fibra \d+|triple play \d+|(?:claro )?max (?:\d+ gb|ilimitado)|(?:plan|el) ilimitado|paquete (?:dia|semanal|mensual))\b/)?.[0];
  if ((name==='plan ilimitado' || name==='el ilimitado')) return 'claro max ilimitado';
  if (name?.startsWith('max ')) return 'claro '+name;
  if (name?.startsWith('fibra ')) return 'hogar '+name;
  return name;
}

export function catalogMemoryFromReply(text: string, answer: string, citations: CatalogPlan['citation'][], previous?: ConversationMemory): ConversationMemory | undefined {
  const sources = citations.filter(item=>catalogVersion.test(item.version));
  const segment = explicitSegment(normalize(text));
  const anchor = namedPlan(text);
  if (anchor && namedPlan(answer)===anchor && sources.some(source=>namedPlanLine(source.excerpt,anchor))) {
    return {segment,anchor_plan:anchor};
  }
  if (segment && sources.length && segment!==previous?.segment) return {segment};
  return previous;
}

function namedPlanLine(excerpt: string, name: string) {
  return normalize(excerpt).split('\n').some(line=>line.trim().startsWith(name+' '));
}

type Comparison = {segment?:CatalogSegment; anchor?:string; resolution:'explicit'|'memory'|'history'|'unscoped'; validity?:CatalogPlan['validity']};

export function catalogComparisonAfterWithdrawal(text:string, messages:Message[], before:number):Comparison|undefined {
  const query=normalize(text);
  if (!changesCancellationToPlan(query) || !pricePreference.test(query)) return;
  const explicit=explicitSegment(query);
  if (explicit) return {segment:explicit,resolution:'explicit'};
  const previous=messages.filter(message=>message.actor==='cliente' && !message.verification_input && message.turn_seq<before &&
    !/^\s*(?:si[ ,.]*)?(?:acepto|de acuerdo|l[oa] acepto)\b/.test(normalize(message.text))).at(-1);
  const prior=previous && normalize(previous.text);
  const segment=prior && cancellationRequest.test(prior) ? explicitSegment(prior) : undefined;
  return {segment,resolution:segment ? 'history' : 'unscoped'};
}

export function catalogComparison(text: string, messages: Message[], memory?: ConversationMemory, before=Infinity): Comparison | undefined {
  const query = normalize(text).trim().replace(/^[¿¡]+/,'');
  if (otherTopic.test(query) || advisor.test(query) || /\b(?:mi plan actual|cambiame|contratame|tramit\w*)\b/.test(query)) return;
  const recent = messages.filter(m=>m.turn_seq<before && !m.verification_input && m.actor!=='asesor').slice(-6).reverse();
  let history: ConversationMemory | undefined;
  for (const message of recent) {
    const previous = normalize(message.text);
    if (message.actor==='cliente' && otherTopic.test(previous)) break;
    if (message.actor==='cliente' && pricePreference.test(previous)) {
      history ??= {preference:'lower_price',pending:'compare_prices',segment:explicitSegment(previous)};
    }
    if (message.actor==='agente' && message.citations?.some(c=>catalogVersion.test(c.version))) {
      const anchor = namedPlan(message.text);
      const segment = explicitSegment(previous);
      if (segment) history = {...history,segment:history?.segment ?? segment,anchor_plan:history?.anchor_plan ?? (history?.segment && history.segment!==segment ? undefined : anchor)};
      if (segment) break;
    }
  }
  const prior = recent.find(m=>m.actor==='cliente' && !askExpert.test(normalize(m.text)));
  const context = prior && otherTopic.test(normalize(prior.text)) ? undefined : memory;
  const explicit = explicitSegment(query);
  const continuing = context?.preference==='lower_price' || history?.preference==='lower_price';
  const rawScopeReply = /^(?:(?:y )?(?:para|en) (?:la |el |mi )?)?(?:hogar|casa|apartamento|fibra|celular|movil|pospago|prepago)[ ?.?!]*$/.test(query);
  if (!pricePreference.test(query) && !(continuing && (askExpert.test(query) || rawScopeReply))) return;
  const segment = explicit ?? context?.segment ?? history?.segment;
  const anchor = namedPlan(query) ?? (segment === context?.segment ? context?.anchor_plan : undefined) ??
    (segment === history?.segment ? history?.anchor_plan : undefined);
  const resolution = explicit ? 'explicit' : context?.segment || context?.pending ? 'memory' : history?.segment ? 'history' : 'unscoped';
  const validity = segment==='movil_prepago'
    ? /\b(?:semanal|7 dias|una semana)\b/.test(query) ? '7 días'
      : /\b(?:mensual|30 dias|un mes)\b/.test(query) ? '30 días'
      : /\b(?:diari[oa]|24 horas|un dia)\b/.test(query) ? '24 horas' : context?.package_validity
    : undefined;
  return {segment,anchor,resolution,validity};
}

const cop = (value:number) => '$'+String(value).replace(/\B(?=(\d{3})+(?!\d))/g,'.');
const unavailable = 'En este momento no puedo confirmar el precio en el catálogo. Puedo pedirle a un asesor que lo revise. ¿Quieres hablar con uno?';

export function compareCatalog(request: Comparison, plans: CatalogPlan[]) {
  const {segment,anchor,validity} = request;
  const state: ConversationMemory = {segment,anchor_plan:anchor,preference:'lower_price',package_validity:validity};
  const pending: ConversationMemory = {...state,pending:'compare_prices'};
  const cheapest = (group: CatalogSegment) => plans.filter(plan=>plan.segment===group && (!validity || plan.validity===validity))
    .sort((a,b)=>a.price-b.price)[0];
  if (!segment) {
    const home = cheapest('hogar'), mobile = cheapest('movil_pospago');
    if (!home || !mobile || home.citation.version!==mobile.citation.version) return {text:unavailable,citations:[],state:pending};
    return {text:`Para casa, ${home.name} cuesta ${cop(home.price)} al mes. Para celular, ${mobile.name} cuesta ${cop(mobile.price)} al mes. ¿Cuál te interesa?`,
      citations:[home.citation,mobile.citation],state:pending};
  }
  const best = cheapest(segment);
  if (!best) return {text:unavailable,citations:[],state:pending};
  if (segment==='movil_prepago') {
    return {text:`El paquete prepago más económico${validity ? ' para '+validity : ''} es ${best.name}. Te da ${best.allowance} por ${cop(best.price)} y dura ${best.validity}.`,
      citations:[best.citation],state};
  }
  const reference = anchor ? plans.find(plan=>plan.segment===segment && normalize(plan.name)===anchor) : undefined;
  if (reference && best.price < reference.price) {
    const shortName = reference.name==='Claro Max Ilimitado' ? 'el Ilimitado' : reference.name;
    return {text:`Sí. ${best.name} cuesta ${cop(best.price)} al mes, ${cop(reference.price-best.price)} menos que ${shortName}.`,
      citations:best.citation.id===reference.citation.id ? [best.citation] : [best.citation,reference.citation],state};
  }
  const label = segment==='hogar' ? 'de internet para casa' : 'móvil pospago';
  const suffix = anchor && !reference ? ' No pude confirmar el precio vigente del plan anterior para calcular el ahorro.' : '';
  return {text:`La opción mensual más económica ${label} es ${best.name}, por ${cop(best.price)} al mes.${suffix}`,
    citations:[best.citation],state};
}
