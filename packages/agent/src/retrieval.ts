import type { KnowledgeDocument } from './index.js';
import type { CaseIntake, KnowledgeSearchFilters } from '@claro/contracts';
import { mobilePlanTopic } from './public-reply.js';

const stopWords = new Set('al algo ante aqui asi bajo caso cual cuanto como con cuando debe debo del donde dos ella ellas ellos era esa ese eso esta estan estar este esto hay hasta hizo hoy los las mas me mi mismo mucha mucho nuestro otra otro para pero poco podemos puede puedo por que quien quiero recibo saber sea ser si sobre son sus tan tambien tengo teniendo tiene tipo todo tras una uno unos usan usa usted usan varios vez ya cliente clientes claro servicio servicios'.split(' '));
const related = [
  ['restablecer','reiniciar','reset','fabrica'],
  ['contrasena','clave','password'],
  ['cambio','cambiar','cambie','modificar','modifique'],
  ['cobro','cargo','costo','tarifa','precio'],
  ['instalacion','activacion','conexion'],
  ['cancelar','cancelacion','terminacion','rescindir','devolucion','retiro'],
  ['permanencia','penalidad','clausula','prorrateo','subsidio'],
  ['vencida','vencimiento','mora','deuda','cartera'],
  ['reconecta','reconectar','reconexion','reactivacion','suspension'],
  ['oferta','descuento','promocion','beneficio'],
  ['tarda','demora','plazo','tiempo','tiempos','duracion'],
  ['linea','movil','pospago'],
  ['falla','caida','intermitencia','incidente','interrupcion'],
  ['ajuste','compensacion','abono'],
  ['pqr','peticion','reclamo','queja'],
  ['agendar','programar','visita'],
  ['sic','tutela','supervisor','escalamiento']
];
const aliases = new Map(related.flatMap(group => group.map(term => [term,group] as const)));
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
  .replace(/\be[\s-]?202\b/g,' e202 ').replace(/\bztx[\s-]?f680\b/g,' ztxf680 ');

export function retentionPolicyQuery(query: string) {
  const text = normalize(query);
  return /\bretencion\b/.test(text) && !/\b(?:mi cuenta|quiero cancelar|dar de baja|mi oferta|mi descuento|acepto|me ofrecieron)\b/.test(text);
}

export function isRetentionPolicy(document: KnowledgeDocument) {
  return document.version.startsWith('POL-RET-') || /^retencion-\d+$/.test(document.id);
}

export function prepareKnowledgeQuery(input:string, intake?:CaseIntake): {query:string; retry:string; filters:KnowledgeSearchFilters} {
  input=input.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,' ').replace(/\+?\d(?:[ .()-]*\d){6,}/g,' ').trim();
  const value=normalize(input);
  if (mobilePlanTopic(input)==='change') return {query:input,retry:'cambiar plan móvil sin costo siguiente ciclo facturación',filters:{source:'faq',tags:['movil']}};
  if (retentionPolicyQuery(input)) {
    const eligibility=/\b(?:requisit\w*|condici\w*|elegib\w*|aplica|mora|antiguedad)\b/.test(value);
    const tags=eligibility ? ['retencion','elegibilidad'] : ['retencion'];
    return {query:eligibility ? `${input} criterios de elegibilidad` : input,
      retry:eligibility ? 'política de retención criterios elegibilidad mora antigüedad' : 'política de retención',
      filters:{source:'retencion',tags}};
  }
  if (/\be202\b/.test(value)) return {query:input,retry:'decodificador E-202 Mi Claro refrescar señal',filters:{tags:['e-202','tv']}};
  if (/\b(?:sin internet|falla masiva|incidente|caida del servicio)\b/.test(value) &&
      /\b(?:ajuste|compensacion|reembolso)\b/.test(value)) {
    return {query:`${input} compensación proporcional interrupción servicio hogar factura`,
      retry:'contrato hogar compensación interrupción falla masiva factura',filters:{tags:['facturacion','hogar']}};
  }
  if (intake?.intent==='soporte_tecnico' && intake.facts.sintoma==='Lentitud') {
    const medium=intake.facts.medio ?? '';
    return {query:`${input} internet hogar prueba de velocidad ${medium}`,retry:'medir velocidad internet hogar cable wifi',filters:{tags:['velocidad']}};
  }
  const plan=value.match(/\bfibra\s*(300|500|900)\b/);
  if (plan) return {query:input,retry:`catálogo internet hogar fibra ${plan[1]}`,filters:{tags:[`fibra-${plan[1]}`]}};
  const tags=plansDiscovery(input) ? ['catalogo'] : [];
  return {query:input,retry:retrievalTerms(input).join(' '),filters:{tags}};
}

export function plansDiscovery(query: string) {
  const text = normalize(query);
  if (/\b(?:mis? planes?|que plan tengo|precio|cuanto|costo|incluye|simetri\w*|iva|promocion|descuento|cobertura|instalacion|convergencia|max|triple play|\d+\s*(?:gb|mbps)|fibra\s*\d+)\b/.test(text)) return null;
  if (!/\bplanes?\b/.test(text)) return null;
  const mobile = /\b(?:movil|celular|pospago|prepago)\b/.test(text);
  const home = /\b(?:casa|hogar|fibra)\b/.test(text);
  if (mobile) return home ? 'general' : 'mobile';
  if (home) return 'home';
  return /\b(?:que planes?|cuales (?:son |planes )?|planes disponibles|ver planes|mostrar planes|muestrame los planes|opciones de planes)\b|^planes?[?.!]*$/.test(text) ? 'general' : null;
}

export function homePlanPreference(query: string) {
  const text = normalize(query);
  if (/\b(?:precio|cancel\w*|factur\w*|saldo|falla|sin internet|se cae|no funciona)\b/.test(text)) return null;
  if (/\b(?:grande|varios pisos|muchos dispositivos|muchos equipos|(?:[5-9]|\d{2,})\s+(?:personas|dispositivos|equipos))\b/.test(text)) return 'wide';
  if (/\b(?:pequen[oa]|apartamento|(?:[1-4]|una|dos|tres|cuatro)\s+(?:personas|dispositivos|equipos))\b/.test(text)) return 'basic';
  return null;
}

export function guidePlans(query: string, documents: KnowledgeDocument[], preference?: ReturnType<typeof homePlanPreference>) {
  const discovery = plansDiscovery(query);
  if (!discovery) return null;
  const catalog = documents.filter(doc => doc.type === 'catalogo' || /^CAT-\d/.test(doc.version));
  const home = catalog.find(doc => /^Hogar Fibra /im.test(doc.excerpt));
  const mobile = catalog.find(doc => /telefonia movil (?:pospago|prepago)/.test(normalize(doc.excerpt)));
  if (discovery === 'home' && home) {
    const tier = preference === 'wide' ? '500' : '300';
    const row = home.excerpt.match(new RegExp(`^Hogar Fibra ${tier} +${tier} Mbps +([$]\\d[\\d.,]*)`, 'im'));
    if (preference && row) {
      const detail = preference === 'wide' && /Hogar Fibra 500[^\n]+\b1 repetidor\b/i.test(home.excerpt) ? ' e incluye un repetidor WiFi' : '';
      return {answer:`Podríamos empezar por Hogar Fibra ${tier}. Ofrece ${tier} Mbps por ${row[1]} al mes${detail}. ¿Quieres que lo comparemos con otra opción?`,used:[home],needsClarification:false};
    }
    return {answer:'Tenemos planes de internet por fibra para el hogar. Para orientarte, ¿qué tan grande es tu vivienda?',used:[home],needsClarification:true,contextField:"vivienda"};
  }
  if (discovery === 'mobile' && mobile) {
    if (/\bprepago\b/.test(normalize(query))) {
      const prepaid = catalog.find(doc=>/telefonia movil prepago/.test(normalize(doc.excerpt)));
      const row=prepaid?.excerpt.match(/^Paquete Día (\d+ GB) (\d+ horas) (\$[\d.,]+)/im);
      if (prepaid && row) return {answer:`Si prefieres recargar cuando lo necesites, una opción es el Paquete Día. Incluye ${row[1]} durante ${row[2]} por ${row[3]}. ¿Quieres ver una opción de mayor duración?`,used:[prepaid],needsClarification:false};
    }
    if (/\bpospago\b/.test(normalize(query))) {
      const postpaid=catalog.find(doc=>/telefonia movil pospago/.test(normalize(doc.excerpt)));
      const row=postpaid?.excerpt.match(/^Claro Max (\d+ GB) \d+ GB (\$[\d.,]+)/im);
      if (postpaid && row) return {answer:`Una opción mensual es Claro Max ${row[1]} por ${row[2]} al mes. ¿Sueles usar más datos o priorizas el precio?`,used:[postpaid],needsClarification:false};
    }
    return {answer:'Tenemos opciones de telefonía móvil. ¿Buscas un plan mensual o prefieres recargar cuando lo necesites?',used:[mobile],needsClarification:true,contextField:"modalidad"};
  }
  if (discovery === 'general' && home && mobile) return {answer:'Tenemos opciones de internet para el hogar y telefonía móvil. ¿Cuál estás buscando?',used:[home,mobile],needsClarification:true,contextField:"producto"};
  const source = catalog[0];
  return source ? {answer:'Puedo ayudarte a elegir un plan. ¿Buscas una opción para el hogar o para tu celular?',used:[source],needsClarification:true,contextField:"producto"} : null;
}

function terms(value: string) {
  return (normalize(value).match(/[a-z0-9]+/g) ?? []).filter(word =>
    !stopWords.has(word) && (word.length >= 3 || /^\d+$/.test(word) || ['tv','gb','4k'].includes(word)));
}

function stem(word: string) {
  return word.length >= 6 ? word.replace(/(aciones|acion|ando|iendo|ados|idos|es|os|as|s)$/,'') : word;
}

function wifiConfiguration(words: string[]) {
  return words.includes('wifi') && words.some(word=>['contrasena','clave','password','ssid'].includes(word))
    && words.some(word=>['cambio','cambiar','cambie','modificar','modifique'].includes(word))
    && !words.some(word=>['reset','restablecer','fabrica'].includes(word));
}

export function retrievalTerms(query: string) {
  const direct = [...new Set(terms(query))].slice(0,24);
  return [...new Set([...direct, ...direct.flatMap(word => aliases.get(word) ?? []),
    ...(retentionPolicyQuery(query) ? ['politica','retencion','elegibilidad','antiguedad'] : []),
    ...(plansDiscovery(query) ? ['catalogo','fibra','hogar','movil','pospago','prepago'] : []),
    ...(wifiConfiguration(direct) ? ['wlan','ssid','admin','navegador'] : []),
    ...(direct.includes('e202') ? ['202','decodificador'] : []), ...(direct.includes('ztxf680') ? ['f680','modem'] : [])])].slice(0,48);
}

function documentSource(document: KnowledgeDocument) {
  if (document.id.startsWith('catalogo-2026-')) return 'catalogo-v1';
  if (document.id.startsWith('faq-decodificador-')) return 'faq';
  return document.id.replace(/-\d{3}$/,'');
}

/** Recognize an intact, consecutively numbered configuration procedure in one source/version. */
export function wifiConfigurationSteps(query:string, documents:KnowledgeDocument[]):KnowledgeDocument[] {
 if (!wifiConfiguration(terms(query))) return [];
 for (const first of documents) {
  const match=first.id.match(/^(.*)-(\d{3})$/);
  if (!match || !/^\s*2\./.test(first.excerpt) || !/\bnavegador\b/.test(normalize(first.excerpt)) || !/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(first.excerpt)) continue;
  const source=match[1],index=Number(match[2]);
  const next=(offset:number)=>documents.find(doc=>doc.id===`${source}-${String(index+offset).padStart(3,'0')}` && doc.version===first.version && doc.scope===first.scope);
  const credentials=next(1),change=next(2);
  if (!credentials || !change) continue;
  const credentialsText=normalize(credentials.excerpt), changeText=normalize(change.excerpt);
  if (!/^\s*3\./.test(credentials.excerpt) || !/\badmin\b/.test(credentialsText) || !/\betiqueta\b/.test(credentialsText) ||
      !/^\s*4\./.test(change.excerpt) || !/\bwlan\b/.test(changeText) || !/\bssid\b/.test(changeText) || !/\bcontrasena\b/.test(changeText) || !/\bguard(?:ar|e)\b/.test(changeText)) continue;
  const steps=[first,credentials,change];
  if (steps.some(doc=>/\b(reset|restablecimiento|fabrica)\b/.test(normalize(doc.excerpt))) || steps.map(doc=>doc.excerpt).join('\n').length>4096) continue;
  return steps;
 }
 return [];
}

export function rankKnowledge(query: string, documents: KnowledgeDocument[], filters?:KnowledgeSearchFilters) {
  const requested = terms(query);
  const direct = [...new Set(requested.map(stem))];
  if (!direct.length) return [];
  const wifi = wifiConfiguration(requested);
  const expanded = [...new Set(retrievalTerms(query).map(stem))].filter(word=>!direct.includes(word));
  const policy = retentionPolicyQuery(query);
  const discovery = plansDiscovery(query);
  const pool = policy ? documents.filter(isRetentionPolicy) : discovery
    ? documents.filter(doc => doc.type === 'catalogo' || /^CAT-\d/.test(doc.version)) : documents;
  const candidates = pool.map((document, position) => ({
    document, position, title:new Set(terms(document.title).map(stem)), body:new Set(terms(document.excerpt).map(stem))
  }));
  const weights = new Map([...direct,...expanded].map(word => {
    const frequency = candidates.filter(row => row.body.has(word) || row.title.has(word)).length;
    return [word, 1+Math.log((candidates.length+1)/(frequency+1))];
  }));
  const ranking = candidates.flatMap(row => {
    const matches = direct.filter(word => row.body.has(word) || row.title.has(word));
    const alternate = expanded.filter(word => row.body.has(word) || row.title.has(word));
    const substantive = matches.some(word=>!/^\d+$/.test(word)) || alternate.some(word=>!/^\d+$/.test(word));
    const tags = filters?.tags.filter(tag=>row.document.metadata?.tags.includes(tag)) ?? [];
    if (!substantive && !tags.length && !(filters?.source && row.document.metadata?.source===filters.source)) return [];
    const total = matches.reduce((sum,word) => sum + weights.get(word)! * (row.title.has(word) ? 1.7 : 1),0)
      + alternate.reduce((sum,word) => sum + weights.get(word)! * (row.title.has(word) ? 0.7 : 0.38),0);
    const coverage = matches.length / direct.length;
    const configurationFit = wifi ? (['wlan','ssid','admin','navegador'].some(word=>row.body.has(stem(word))) ? 4 : 0)
      - (['reset','restablecer','fabrica'].some(word=>row.body.has(stem(word))) ? 8 : 0) : 0;
    const isHeadingOnly = row.body.size < 10 && [...row.body].every(word=>row.title.has(word));
    const retentionOverview = policy && /^(?:la |cual es la |que dice la )?(?:politica de )?retencion(?: de clientes)?[.?!]*$/.test(normalize(query).trim());
    const policyFit = (retentionOverview || filters?.tags.includes('elegibilidad')) && row.title.has(stem('elegibilidad')) ? 18 : 0;
    const excerpt = normalize(row.document.excerpt);
    const homeSection = /^hogar fibra /m.test(excerpt);
    const mobileSection = /telefonia movil (?:pospago|prepago)/.test(excerpt) && /\$\d/.test(excerpt);
    const discoveryFit = discovery && ((discovery !== 'mobile' && homeSection) || (discovery !== 'home' && mobileSection)) ? 12 : 0;
    return [{...row, score:total * (0.65+coverage) / (1+0.13*Math.log1p(row.body.size/40)) + configurationFit + policyFit + discoveryFit + tags.length*2
      - (isHeadingOnly ? 4 : 0) + 0.2/(row.position+1)}];
  }).sort((a,b)=>b.score-a.score || a.position-b.position);

  const selected: KnowledgeDocument[] = [], deferred: KnowledgeDocument[] = [];
  const counts = new Map<string,number>();
  for (const { document } of ranking) {
    const source = documentSource(document);
    const count = counts.get(source) ?? 0;
    (count < (wifi ? 3 : 2) ? selected : deferred).push(document);
    counts.set(source,count+1);
  }
  const ordered=[...selected,...deferred];
  const steps=wifiConfigurationSteps(query,ordered);
  if (!steps.length) return ordered;
  const selectedIds=new Set(steps.map(doc=>`${doc.id}\0${doc.version}`));
  return [...steps,...ordered.filter(doc=>!selectedIds.has(`${doc.id}\0${doc.version}`))];
}
