import type { CatalogPlan, CatalogSegment, Citation, ConversationMemory, RunResult } from '@claro/contracts';
import { plansDiscovery } from './retrieval.js';

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const clean = (value: string) => normalize(value).trim().replace(/^[¿¡]+|[.!?]+$/g, '').trim();
const words = (value: string) => normalize(value).replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export const commercialHandoff = 'Solicitud de contratación';
export const confirmCommercialPurchase = '¿Confirmas que quieres continuar con un asesor?';
const labels: Record<CatalogSegment, string> = { hogar: 'Internet Hogar', movil_pospago: 'Pospago', movil_prepago: 'Prepago' };
type Action = 'list' | 'select' | 'price' | 'detail' | 'download' | 'purchase';
export type CatalogRequest = { action: Action; query: string; groups: CatalogSegment[] };

export function commercialRequest(text: string, contextualText: string, memory?: ConversationMemory): CatalogRequest | undefined {
  const query = clean(text);
  const reply = clean(contextualText);
  if (/\b(?:mi saldo|mi mora|mis? facturas?|mi plan actual|mis servicios|que plan tengo|plan contratado)\b/.test(query)) return;
  const mobile = /\b(?:movil(?:es)?|celular(?:es)?)\b/;
  const home = /\b(?:hogar|casa|fibra)\b/;
  const groups: CatalogSegment[] = /\bpospago\b/.test(reply) ? ['movil_pospago'] : /\bprepago\b/.test(reply) ? ['movil_prepago']
    : mobile.test(reply) && !home.test(reply) ? ['movil_pospago','movil_prepago'] : home.test(reply) && !mobile.test(reply) ? ['hogar'] : [];
  const request = (action: Action): CatalogRequest => ({ action, query, groups });
  const purchase = /\b(?:quiero (?:ya )?|deseo |quisiera |voy a )(?:contratar|comprar|adquirir)(?:lo|la)?\b|^(?:si,? )?(?:contratame|compra(?:lo|la)|contrata(?:lo|la)|procedamos con la contratacion)\b/;
  if (!/\b(?:no|tampoco|todavia no|aun no)\s+(?:(?:quiero|deseo|quisiera|voy a)\s+)?(?:contratar|comprar|adquirir)/.test(query)) {
    if (purchase.test(query) || memory?.purchase_confirmation && /^(?:si(?:,? por favor)?|confirmo|de acuerdo|adelante)$/.test(query)) return request('purchase');
  }
  if (/\bcatalogo\b/.test(query) && /\b(?:pdf|descarg\w*|pasas|envia\w*|compart\w*|abri\w*|ver|manda\w*)\b/.test(query)) return request('download');
  if (plansDiscovery(contextualText) || groups.length && /^que (?:ofrecen|opciones (?:hay|tienen))\b/.test(query) ||
    /^(?:plan(?:es)? )?(?:de |para (?:mi |el )?)?(?:pospago|prepago|movil(?:es)?|celular(?:es)?|internet hogar)$/.test(reply)) return request('list');
  if ((memory || /\b(?:plan|paquete|gb|mbps)\b/.test(query)) &&
    !/\b(?:saber|conocer|comparar)\b/.test(query) &&
    /^(?:(?:si,? )?me (?:quedo con|interesa|gusta) |elijo |prefiero |escojo |selecciono |(?:el|la) de |(?:ese|esa)(?: plan| paquete)?$)/.test(query)) return request('select');
  const price = /\b(?:precio|cuesta|cuestan|cuanto vale|cuanto valen|valor mensual)\b/;
  const hasCommercialSubject = memory?.selected_plan || groups.length || /\b(?:plan|paquete|catalogo|gb|mbps)\b/.test(query);
  if (hasCommercialSubject && price.test(query)) return request('price');
  if (memory?.selected_plan && /\b(?:incluy\w*|trae|benefici\w*|tiene|vigencia|dura)\b/.test(query)) return request('detail');
}

const money = (price: number) => '$' + new Intl.NumberFormat('es-CO').format(price);
export const offerPrice = (plan: CatalogPlan) => plan.validity ? `${money(plan.price)} por ${plan.validity}` : `${money(plan.price)} al mes`;
const reference = (plan: CatalogPlan) => `${plan.citation.id}\0${plan.citation.version}`;
const citations = (plans: CatalogPlan[]): Citation[] => [...new Map(plans.map(plan => [reference(plan), plan.citation])).values()];
function sameProduct(left: CatalogPlan, right: CatalogPlan) {
  return left.segment === right.segment && clean(left.name) === clean(right.name);
}

function namedOptions(query: string, plans: CatalogPlan[]) {
  // Prefer a full published name before interpreting an informal description.
  const nameMatches = plans.filter(plan => (` ${words(query)} `).includes(` ${words(plan.name)} `));
  if (nameMatches.length) return nameMatches;
  const number = query.match(/\b(\d+)\s*(gb|mbps)?\b/);
  if (number) {
    return plans.filter(plan => {
      const allowance = clean(plan.allowance).match(/^(\d+)\s*(gb|mbps)$/);
      return allowance && allowance[1] === number[1] && (!number[2] || number[2] === allowance[2]);
    });
  }
  if (/\bilimitad[oa]\b/.test(query)) return plans.filter(plan => /ilimitad/.test(clean(plan.allowance)));
  const validity = /\b(?:semanal|7 dias)\b/.test(query) ? '7 días' : /\b(?:mensual|30 dias)\b/.test(query) ? '30 días'
    : /\b(?:diario|de un dia|24 horas)\b/.test(query) ? '24 horas' : undefined;
  if (validity) return plans.filter(plan => plan.validity === validity);
  return [];
}

function changedOffer(previous: CatalogPlan, current: CatalogPlan) {
  return previous.price !== current.price || previous.validity !== current.validity ||
    previous.allowance !== current.allowance || previous.citation.version !== current.citation.version;
}

export function answerCommercial(request: CatalogRequest, plans: CatalogPlan[], memory?: ConversationMemory): RunResult | undefined {
  const {action, groups, query} = request;
  const selected = memory?.selected_plan;
  const scoped = plans.filter(plan => !groups.length || groups.includes(plan.segment));
  const answer = (text: string, used: CatalogPlan[], next = memory): RunResult => ({ type:'answer', route:'consulta_planes',
    answer:text, citations:citations(used), conversation_memory:next, ...(used.length ? {catalog_answer:true} : {}) });
  const remember = (plan: CatalogPlan, confirmation = false): ConversationMemory => ({
    segment:plan.segment, anchor_plan:clean(plan.name), selected_plan:plan, purchase_confirmation:confirmation
  });
  const unavailable = 'No puedo confirmar una oferta vigente para esa consulta. ¿Quieres hablar con un asesor?';
  if (action === 'list') {
    if (!scoped.length) return answer(unavailable, []);
    if (!groups.length && scoped.some(plan => plan.segment === 'hogar') && scoped.some(plan => plan.segment !== 'hogar')) {
      return answer('Tenemos opciones de internet para el hogar y telefonía móvil. ¿Cuál estás buscando?', scoped, undefined);
    }
    const headings = [...new Set(scoped.map(plan => plan.segment))];
    const sections = headings.map(group => {
      const rows = scoped.filter(plan => plan.segment === group);
      return `${labels[group]}${group !== 'movil_prepago' ? ' (al mes)' : ''}\n${rows.map(plan =>
        `• ${plan.name} · ${plan.allowance} · ${money(plan.price)}${plan.validity ? ' por '+plan.validity : ''}`).join('\n')}`;
    });
    const missing = groups.filter(group => !headings.includes(group));
    const note = missing.length ? `\nFalta confirmar ${missing.map(group=>labels[group]).join(' y ')}.` : '';
    const listing = `${sections.join('\n\n')}${note}\n\n¿Cuál te interesa?`;
    const summary = `Encontré ${headings.map(group=>labels[group]).join(' y ')} en el catálogo.${note} ¿De qué plan quieres conocer el precio?`;
    return answer(listing.length <= 4000 ? listing : summary, scoped, groups.length === 1 ? {segment:groups[0]} : {});
  }
  if (action === 'download') {
    if (selected?.citation.source && /\b(?:ese|esa|anterior|que citaste)\b/.test(query)) {
      return answer('Puedes ver o descargar la edición citada del catálogo en la fuente adjunta.', [selected]);
    }
    const current = selected && scoped.find(plan => sameProduct(plan, selected));
    const source = (current ? [current] : scoped).find(plan => plan.citation.source);
    return source ? answer('Puedes ver o descargar la edición vigente del catálogo en la fuente adjunta.', [source])
      : answer('El PDF del catálogo no está disponible para esta consulta.', []);
  }
  // In a detail question a number can describe a feature, rather than be a plan reference.
  const options = action === 'detail' ? [] : namedOptions(query, scoped);
  const current = options.length === 1 ? options[0] : options.length ? undefined
    : selected && (action === 'detail' || !/\b(?:\d+\s*(?:gb|mbps)|ilimitad[oa])\b/.test(query)) ? scoped.find(plan => sameProduct(plan, selected)) : undefined;
  if (options.length > 1) return answer(`Encontré más de una opción. ¿Te refieres a ${options.slice(0,4).map(plan=>plan.name).join(' o ')}?`, options);
  if (action === 'purchase') {
    if (!current && selected) {
      const alternatives = scoped.filter(plan => plan.segment === selected.segment);
      return answer(`Ya no puedo confirmar ${selected.name} en el catálogo vigente. ¿Quieres elegir otra opción o hablar con un asesor?`, alternatives, {});
    }
    if (!current) return answer('¿Cuál plan quieres contratar?', []);
    if (selected && sameProduct(selected,current) && changedOffer(selected,current)) {
      return answer(`El catálogo se actualizó. ${current.name} figura por ${offerPrice(current)}. ${confirmCommercialPurchase}`, [current], remember(current,true));
    }
    return {type:'handoff',route:'consulta_planes',pending:commercialHandoff,commercial_plan:current,
      reason:`Tu solicitud para contratar ${current.name} quedó en espera de un asesor. Puedes seguir escribiendo aquí.`};
  }
  if (action === 'select') {
    return current ? answer(`Elegiste ${current.name}, por ${offerPrice(current)}. Puedes preguntarme por sus condiciones o decirme si quieres contratarlo.`, [current], remember(current))
      : answer('¿Cuál es el nombre del plan que te interesa?', scoped);
  }
  if (action === 'price') return current ? answer(`${current.name} cuesta ${offerPrice(current)}.`, [current]) : undefined;
  if (action === 'detail' && current) {
    const feature = query.match(/^(?:incluye|trae|tiene)\s+([\p{L}\p{N}][\p{L}\p{N} +\-]{1,60})$/u)?.[1];
    const rows = current.citation.excerpt.split('\n');
    const row = rows.findIndex(line=>clean(line).startsWith(clean(current.name)+' '));
    if (row >= 0) {
      const following = rows.slice(row + 1).findIndex(line => /\$[\d.]+|^\s*(?:[•*]|\d+\.)/.test(line));
      const details = rows.slice(row, following >= 0 ? row + following + 1 : row + 4).join(' ').replace(/\s+/g,' ');
      const index = feature ? normalize(details).indexOf(feature) : -1;
      if (feature && index >= 0) return answer(`Sí. ${current.name} incluye ${details.slice(index,index+feature.length)} según el catálogo vigente.`, [current]);
      const included = details.replace(/^.*?\$[\d.]+\s*/, '').replace(/^Todo lo anterior\s*\+\s*/i,'').trim();
      if (/^(?:que|cuales son los|dime que)\s+(?:incluye|trae|tiene|beneficios)\b/.test(query) && included && included.length<=220) {
        return answer(`Entre los beneficios de ${current.name}, el catálogo menciona ${included.replace(/[.!?]$/u,'')}.`, [current]);
      }
    }
  }
}
