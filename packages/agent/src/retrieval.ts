import type { KnowledgeDocument } from './index.js';

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

export function rankKnowledge(query: string, documents: KnowledgeDocument[]) {
  const requested = terms(query);
  const direct = [...new Set(requested.map(stem))];
  if (!direct.length) return [];
  const wifi = wifiConfiguration(requested);
  const expanded = [...new Set(retrievalTerms(query).map(stem))].filter(word=>!direct.includes(word));
  const candidates = documents.map((document, position) => ({
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
    if (!substantive) return [];
    const total = matches.reduce((sum,word) => sum + weights.get(word)! * (row.title.has(word) ? 1.7 : 1),0)
      + alternate.reduce((sum,word) => sum + weights.get(word)! * (row.title.has(word) ? 0.7 : 0.38),0);
    const coverage = matches.length / direct.length;
    const configurationFit = wifi ? (['wlan','ssid','admin','navegador'].some(word=>row.body.has(stem(word))) ? 4 : 0)
      - (['reset','restablecer','fabrica'].some(word=>row.body.has(stem(word))) ? 8 : 0) : 0;
    const isHeadingOnly = row.body.size < 10 && [...row.body].every(word=>row.title.has(word));
    return [{...row, score:total * (0.65+coverage) / (1+0.13*Math.log1p(row.body.size/40)) + configurationFit
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
