import type { CatalogPlan, CatalogSegment, Citation, ConversationMemory, RunResult } from '@claro/contracts';
import { plansDiscovery } from './retrieval.js';

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const clean = (value: string) => normalize(value).trim().replace(/^[¿¡]+|[.!?]+$/g, '').trim().replace(/\s+/g,' ');
const words = (value: string) => normalize(value).replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export const commercialHandoff = 'Solicitud de contratación';
export const confirmCommercialPurchase = '¿Confirmas que quieres continuar con un asesor?';
const labels: Record<CatalogSegment, string> = { hogar: 'Internet Hogar', movil_pospago: 'Pospago', movil_prepago: 'Prepago' };
type Action = 'list' | 'select' | 'price' | 'detail' | 'download' | 'purchase';
export type CatalogRequest = { action: Action; query: string; groups: CatalogSegment[] };

const categoryReply = /^(?:(?:me interesa |prefiero |quiero (?:ver )?|busco |opciones (?:de|para) ))?(?:(?:el|la|los|las|un|una) )?(?:plan(?:es)? )?(?:(?:de|para) )?(?:(?:mi|el|la) )?(?:(?:telefonia |linea )?movil(?:es)?(?: (?:pospago|prepago))?|celular(?:es)?|(?:internet (?:para (?:el |la |mi )?)?)?(?:hogar|casa)|(?:internet de )?fibra|pospago|prepago|recargas?)(?:,? por favor)?$/;
const overview = /^(?:y )?(?:(?:dime|cuentame) )?que (?:incluye|trae|tiene|beneficios (?:incluye|tiene))\b\s*(.*)$/;
const featureQuestion = /^(?:(.*?) )?(?:incluye|trae|tiene|cuenta con) (.+)$/;
const detailFollowUp = /^(?:y )?(?:(?:el|la|los|las) )?(roaming|velocidad|vigencia|condiciones|beneficios)$/;
const detailAlias = /^(?:(?:el|la) )?(?:(?:plan|paquete) )?(?:de )?(?:ilimitad[oa]|\d+\s*(?:gb|mbps)|semanal|mensual|diario)$/;

function referenceText(value: string) {
  return words(value).replace(/^(?:(?:en|de|del|sobre|el|la|un|una)\s+)+/, '').replace(/\s+por favor$/, '');
}

function matchesPlanReference(target: string, name: string) {
  const product=words(name);
  return !!target && (product===target || target.includes(' ') && product.endsWith(` ${target}`));
}

export function commercialRequest(text: string, contextualText: string, memory?: ConversationMemory): CatalogRequest | undefined {
  const query = clean(text);
  const reply = clean(contextualText);
  if (/\b(?:mi saldo|mi mora|mis? facturas?|mi plan actual|mis servicios|que plan tengo|plan contratado)\b/.test(query)) return;
  if (/\b(?:e-?202|no funciona|se cae|sin senal|sin internet|quiero cancelar|dar de baja)\b/.test(query)) return;
  const mobile = /\b(?:movil(?:es)?|celular(?:es)?|pospago|prepago|recargas?)\b/;
  const home = /\b(?:hogar|casa|fibra)\b/;
  const prepaid = /\b(?:prepago|recargas?)\b/.test(reply);
  const postpaid = /\bpospago\b/.test(reply);
  const groups: CatalogSegment[] = prepaid && postpaid ? ['movil_pospago','movil_prepago'] : postpaid ? ['movil_pospago'] : prepaid ? ['movil_prepago']
    : mobile.test(reply) && !home.test(reply) ? ['movil_pospago','movil_prepago'] : home.test(reply) && !mobile.test(reply) ? ['hogar'] : [];
  const request = (action: Action): CatalogRequest => ({ action, query, groups });
  const purchase = /\b(?:quiero (?:ya )?|deseo |quisiera |voy a )(?:contratar|comprar|adquirir)(?:lo|la)?\b|^(?:si,? )?(?:contratame|compra(?:lo|la)|contrata(?:lo|la)|procedamos con la contratacion)\b/;
  if (!/\b(?:no|tampoco|todavia no|aun no)\s+(?:(?:quiero|deseo|quisiera|voy a)\s+)?(?:contratar|comprar|adquirir)/.test(query)) {
    if (purchase.test(query) || memory?.purchase_confirmation && /^(?:si(?:,? por favor)?|confirmo|de acuerdo|adelante)$/.test(query)) return request('purchase');
  }
  if (/\bcatalogo\b/.test(query) && /\b(?:pdf|descarg\w*|pasas|envia\w*|compart\w*|abri\w*|ver|manda\w*)\b/.test(query)) return request('download');
  if (plansDiscovery(contextualText) || categoryReply.test(reply)) return request('list');
  if (/^(?:que ofrecen|que (?:otras )?opciones (?:hay|tienen)|cuales son las opciones)$/.test(query)) {
    const discussed = groups.length ? groups : memory?.offered_segments;
    if (discussed?.length) return {...request('list'),groups:discussed};
  }
  if ((memory || /\b(?:plan|paquete|gb|mbps)\b/.test(query)) &&
    !/\b(?:saber|conocer|comparar)\b/.test(query) &&
    /^(?:(?:si,? )?me (?:quedo con|interesa|gusta) |elijo |prefiero |escojo |selecciono |(?:el|la) de |(?:ese|esa|este|esta)(?: plan| paquete)?$)/.test(query)) return request('select');
  const price = /\b(?:precio|cuesta|cuestan|cuanto vale|cuanto valen|valor mensual)\b/;
  const hasCommercialSubject = memory?.focused_plan || memory?.selected_plan || memory?.offered_segments?.length || groups.length ||
    /\b(?:plan|paquete|catalogo|gb|mbps|ilimitad[oa])\b/.test(query);
  if (hasCommercialSubject && price.test(query)) return request('price');
  if (hasCommercialSubject && (overview.test(query) || featureQuestion.test(query) || detailFollowUp.test(query))) return request('detail');
  const reference=referenceText(query);
  if (memory?.presented_plans?.some(plan=>matchesPlanReference(reference,plan.name)) ||
      memory?.focused_plan && matchesPlanReference(reference,memory.focused_plan.name) ||
      memory?.selected_plan && matchesPlanReference(reference,memory.selected_plan.name)) return request('detail');
}

const money = (price: number) => '$' + new Intl.NumberFormat('es-CO').format(price);
export const offerPrice = (plan: CatalogPlan) => plan.validity ? `${money(plan.price)} por ${plan.validity}` : `${money(plan.price)} al mes`;
const reference = (plan: CatalogPlan) => `${plan.citation.id}\0${plan.citation.version}`;
const citations = (plans: CatalogPlan[]): Citation[] => [...new Map(plans.map(plan => [reference(plan), plan.citation])).values()];
function sameProduct(left: CatalogPlan, right: Pick<CatalogPlan,'name'|'segment'>) {
  return left.segment === right.segment && clean(left.name) === clean(right.name);
}

function publishedDetails(plan: CatalogPlan, plans: CatalogPlan[]) {
  const rows = plan.citation.excerpt.split('\n');
  const boundaries = rows.map((line,index)=>({line:line.trim(),index}));
  const entries = plans.filter(item=>item.segment===plan.segment && reference(item)===reference(plan))
    .map(item=>({item,index:rows.findIndex(line=>clean(line).startsWith(clean(item.name)+' '))}))
    .filter(item=>item.index>=0).sort((a,b)=>a.index-b.index);
  const benefits: string[] = [];
  for (const entry of entries) {
    const end = boundaries.find(({line,index})=>index>entry.index && (/\$[\d.]+|^(?:[•*]|\d+\.)/.test(line) || !line))?.index ?? rows.length;
    const row = rows.slice(entry.index,end).join(' ').replace(/\s+/g,' ');
    const description = row.replace(/^.*?\$[\d.]+\s*/, '').trim();
    if (!/^Todo lo anterior\b/i.test(description)) benefits.length = 0;
    benefits.push(...description.replace(/^Todo lo anterior\s*\+\s*/i,'').split(/\s+\+\s+|\.\s+/).map(text=>text.replace(/[.!?]$/u,'').trim()).filter(Boolean));
    if (!sameProduct(entry.item,plan)) continue;
    const starred = entries.filter(item=>rows[item.index]?.includes('*'));
    const notes = boundaries.filter(({line})=>line.startsWith('*'));
    const noteIndex = starred.length===1 && starred[0]?.index===entry.index && notes.length===1 ? notes[0]?.index : undefined;
    const condition = noteIndex===undefined ? '' : rows.slice(noteIndex).join(' ').replace(/^\*\s*[^:]{1,80}:\s*/,'').match(/^[^.]+\./)?.[0] ?? '';
    return {benefits,condition};
  }
  return {benefits:[],condition:''};
}

function matchingDescription(query: string, plans: CatalogPlan[]) {
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
  const answer = (text: string, used: CatalogPlan[], next = memory): Extract<RunResult,{type:'answer'}> => ({ type:'answer', route:'consulta_planes',
    answer:text, citations:citations(used), conversation_memory:next, ...(used.length ? {catalog_answer:true} : {}) });
  const focusOn = (plan: CatalogPlan): ConversationMemory => ({...memory,focused_plan:{name:plan.name,segment:plan.segment}});
  const remember = (plan: CatalogPlan, confirmation = false): ConversationMemory => ({
    ...memory,segment:plan.segment, anchor_plan:clean(plan.name), selected_plan:plan,
    focused_plan:{name:plan.name,segment:plan.segment},purchase_confirmation:confirmation
  });
  const unavailable = 'No puedo confirmar una oferta vigente para esa consulta. ¿Quieres hablar con un asesor?';
  if (action === 'list') {
    if (!scoped.length) return answer(unavailable, []);
    if (!groups.length && scoped.some(plan => plan.segment === 'hogar') && scoped.some(plan => plan.segment !== 'hogar')) {
      return answer('Tenemos opciones de internet para el hogar y telefonía móvil. ¿Cuál estás buscando?', scoped, {});
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
    return answer(listing.length <= 4000 ? listing : summary, scoped, {
      offered_segments:headings, ...(headings.length === 1 ? {segment:headings[0]} : {}),
      ...(listing.length <= 4000 && scoped.length <= 32 ? {presented_plans:headings.flatMap(group=>scoped
        .filter(plan=>plan.segment===group).map(({name,segment})=>({name,segment})))} : {}),
      ...(scoped.length === 1 ? {anchor_plan:clean(scoped[0]!.name)} : {})
    });
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
  // A full published name can change the topic. Short descriptions refer to the options shown.
  const overviewQuestion = action==='detail' ? query.match(overview) : null;
  const feature = action==='detail' && !overviewQuestion ? query.match(featureQuestion) : null;
  const target = action==='detail' ? referenceText(overviewQuestion?.[1] ?? (feature ? feature[1]==='y' ? '' : feature[1] ?? ''
    : detailFollowUp.test(query) ? '' : query)) : query;
  const named = scoped.filter(plan => (` ${words(target)} `).includes(` ${words(plan.name)} `));
  const offered = !groups.length ? memory?.offered_segments : undefined;
  const references = offered ? scoped.filter(plan=>offered.includes(plan.segment)) : scoped;
  const partialNames = named.length || detailAlias.test(referenceText(target)) ? []
    : references.filter(plan=>matchesPlanReference(referenceText(target),plan.name));
  const options = named.length ? named : partialNames.length ? partialNames
    : action!=='detail' || detailAlias.test(target) ? matchingDescription(target,references) : [];
  const currentSelection = selected && scoped.find(plan => sameProduct(plan, selected));
  const focus = memory?.focused_plan;
  const currentFocus = focus && scoped.find(plan=>sameProduct(plan,focus));
  const refersToOne = /\b(?:ese|esa|este|esta)\b/.test(query);
  const anchor = refersToOne && memory?.anchor_plan ? references.find(plan=>clean(plan.name)===memory.anchor_plan) : undefined;
  const current = options.length === 1 ? options[0] : options.length ? undefined
    : action === 'select' ? refersToOne ? currentFocus ?? currentSelection ?? anchor : undefined
      : action === 'detail' ? !target || /^(?:ese|esa|este|esta)(?: plan| paquete)?$/.test(target) ? currentFocus ?? currentSelection : undefined
      : !/\b(?:\d+\s*(?:gb|mbps)|ilimitad[oa])\b/.test(query) ? action==='price' ? currentFocus ?? currentSelection : currentSelection : undefined;
  if (options.length > 1) return answer(`Encontré más de una opción. ¿Te refieres a ${options.slice(0,4).map(plan=>plan.name).join(' o ')}?`, options);
  if (action === 'purchase') {
    if (!options.length && currentFocus && currentSelection && !sameProduct(currentFocus,currentSelection)) {
      return answer(`Habías elegido ${currentSelection.name} y acabamos de revisar ${currentFocus.name}. ¿Quieres contratar ${currentFocus.name} o ${currentSelection.name}?`, [currentFocus,currentSelection]);
    }
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
  if (action === 'price') return current ? answer(`${current.name} cuesta ${offerPrice(current)}.`, [current], focusOn(current)) : undefined;
  if (action === 'detail') {
    if (!current) return memory?.offered_segments?.length ? {
      ...answer('¿De cuál de los planes que te mostré quieres conocer los detalles?', []),needs_clarification:true
    } : undefined;
    const next = focusOn(current);
    const {benefits,condition} = publishedDetails(current,plans);
    const subject = feature?.[2] ?? query.match(detailFollowUp)?.[1];
    if (subject && !/^(?:beneficios|condiciones)$/.test(subject)) {
      const included = benefits.find(part=>normalize(part).includes(subject));
      if (included) return answer(`Sí. ${current.name} incluye ${included} según el catálogo vigente.`, [current], next);
      if (condition && normalize(condition).includes(subject)) return answer(`${current.name}. ${condition}`, [current], next);
      if (subject==='vigencia' && current.validity) return answer(`${current.name} tiene una vigencia de ${current.validity}.`, [current], next);
      return undefined;
    }
    const included = benefits.join(', ');
    const allowance = /^ilimitados?$/i.test(current.allowance) ? 'datos ilimitados' : current.allowance;
    const details = `${current.name} cuesta ${offerPrice(current)} y ofrece ${allowance}.${included ? ` Incluye ${included}.` : ''}${condition ? ` ${condition}` : ''}`;
    return answer(details, [current], next);
  }
}
