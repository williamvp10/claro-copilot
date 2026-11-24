import type { Channel, Message } from '@claro/contracts';
import type { KnowledgeDocument } from './index.js';

const normalize=(text:string)=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const namedPlan=/\b(?:(?:claro\s+)?max\s+ilimitado|plan\s+ilimitado)\b/;
const changeQuestion=/\b(?:(?:puedo|se puede|podria)\s+(?:hacer el cambio|cambiar(?:lo|me)?)|(?:cuando|como)\s+(?:puedo\s+)?cambiar|cambio de plan)\b/;

const esim=/\be[ -]?sim\b/;

export function esimCompatibilityFilter(question:string):((doc:KnowledgeDocument)=>boolean)|undefined {
  const value=normalize(question);
  if (!esim.test(value) || !/\b(?:usar|compatib\w*|funciona\w*|sirve|admite|soporta)\b/.test(value)) return;
  const target=value.match(/\be[ -]?sim\b[^.!?]{0,35}?\b(?:en|con|para)\s+(?:(?:el|la|mi|un|una)\s+)?([a-z0-9][a-z0-9 -]{1,65}?)(?=\s+(?:comprad\w*|importad\w*|de|en|que)\b|[.!?,]|$)/)?.[1]
    ?? value.match(/\b(?:el|la|mi|un|una)\s+([a-z0-9][a-z0-9 -]{1,65}?)\s+(?:es compatible con|admite|soporta|funciona con)\s+(?:una?\s+)?e[ -]?sim\b/)?.[1];
  if (!target) return;
  const origin=value.match(/\b(?:comprad\w*|importad\w*)\s+(?:en|de|desde)\s+([a-z][a-z ]{1,35})(?=[.!?,]|$)/)?.[1].trim();
  return doc=>{
    const excerpt=normalize(doc.excerpt);
    return esim.test(excerpt) && excerpt.includes(target.trim()) &&
      (!origin || excerpt.includes(origin) || /\b(?:importad\w*|comprad\w* (?:en el exterior|fuera de colombia))\b/.test(excerpt));
  };
}

export function mobilePlanTopic(text:string, previous?:Message) {
  const value=normalize(text);
  const mobile=/\bplan\s+movil\b/.test(value) || namedPlan.test(value);
  const discussed=previous?.actor==='agente' &&
    /\b(?:plan movil|pospago|prepago|claro max)\b/.test(normalize(previous.text));
  return changeQuestion.test(value) && (mobile || discussed) ? 'change' :
    namedPlan.test(value) && /\bvelocidad\b.*\b(?:consum\w*|super\w*|agot\w*)\b/.test(value) ? 'limit' :
    namedPlan.test(value) && /\b(?:incluye|trae|ofrece|tiene|plan|cuesta|precio)\b/.test(value) ? 'unlimited' : null;
}

export function asksToChangeMobilePlan(text:string, previous?:Message) {
  const value=normalize(text).trim();
  if (/\b(?:cambiame|quiero (?:cambiarme|pasarme) al) (?:al )?(?:(?:plan|claro max) )?ilimitado\b/.test(value)) return true;
  return previous?.actor==='agente' &&
    /\bnuevo plan\b|\bel cambio\b|\bcambiar (?:tu|el) plan\b/.test(normalize(previous.text)) &&
    previous.citations?.some(source => /cambiar.*plan/i.test(source.title+' '+source.excerpt)) &&
    /^(?:(?:si[, ]+)?(?:hagale|hazlo|haz el cambio|hazme el cambio|procede|cambialo|quiero hacer el cambio))[. !]*$/.test(value);
}

export function publicReplyLimit(channel:Channel) {
  return channel==='voice' ? 235 : 340;
}

export function mobilePlanReply(topic:ReturnType<typeof mobilePlanTopic>, documents:KnowledgeDocument[], channel:Channel) {
  for (const doc of documents) {
    if (topic==='change' && /cambiar mi plan movil|cambiar mi plan móvil/i.test(doc.title+' '+doc.excerpt)) {
      const text = shortPublicEvidence(doc.excerpt.replace(/^.*(?:\?|¿)\s*(?:\r?\n| )/m,''),channel);
      if (text) return {text,doc};
    }
    if (topic==='limit') {
      const limit=doc.excerpt.match(/después de consumir\s+(\d+\s+GB)[\s\S]{0,100}?reduce a\s+(\d+\s+Mbps)\s+hasta el siguiente ciclo/i);
      if (limit) return {text:`Después de consumir ${limit[1]}, la velocidad baja a ${limit[2]} hasta el siguiente ciclo de facturación.`,doc};
    }
    if (topic!=='unlimited') continue;
    const plan=doc.excerpt.match(/^Claro Max Ilimitado\s+Ilimitados?\*?\s+(\$[\d.,]+)\s+([^*]+)/im);
    const limit=doc.excerpt.match(/después de consumir\s+(\d+\s+GB)[\s\S]{0,100}?reduce a\s+(\d+\s+Mbps)/i);
    const roaming=plan?.[2].match(/(\d+\s+GB)\s+de\s+roaming en las Américas/i);
    if (!plan || !limit || !roaming || !/Claro Música/i.test(plan[2]) || !/Minutos y SMS ilimitados/i.test(doc.excerpt) ||
        !/Claro Video/i.test(doc.excerpt) || !/Todo lo anterior/i.test(plan[2])) continue;
    const text=channel==='voice'
      ? `Claro Max Ilimitado vale ${plan[1]} al mes. Incluye minutos y SMS nacionales ilimitados, Claro Video, Claro Música y ${roaming[1]} de roaming en las Américas. Tras ${limit[1]} en el ciclo, navegas a ${limit[2]}.`
      : `Claro Max Ilimitado cuesta ${plan[1]} al mes. Incluye minutos y SMS nacionales ilimitados, Claro Video, Claro Música y ${roaming[1]} de roaming en las Américas. Después de ${limit[1]} en el ciclo, la velocidad baja a ${limit[2]}.`;
    return {text,doc};
  }
  return null;
}

export function triplePlayReply(question: string, documents: KnowledgeDocument[], channel: Channel) {
  const value=normalize(question);
  const number=value.match(/\btriple play (\d{2,4})\b/)?.[1];
  if (!number || !/\b(?:incluye|trae|ofrece|precio|cuesta)\b/.test(value)) return null;
  const row=new RegExp(`^Triple Play ${number} +\\d+ Mbps +(\\$[\\d.]+) +(.+)$`,'i');
  for (const doc of documents.filter(source=>source.type==='catalogo')) {
    const lines=doc.excerpt.split(/\r?\n/).map(line=>line.trim());
    const index=lines.findIndex(line=>row.test(line));
    const match=index<0 ? undefined : lines[index].match(row);
    if (!match) continue;
    const benefits=[match[2]];
    for (const line of lines.slice(index+1)) {
      if (!/^\p{Ll}/u.test(line)) break;
      benefits.push(line);
    }
    const included=benefits.join(' ').replace(/ \+ /g, ', ').replace(/\.$/,'');
    const text=`Triple Play ${number} cuesta ${match[1]} al mes e incluye ${included}.`;
    if (text.length<=publicReplyLimit(channel)) return {text,doc};
  }
  return null;
}

export function billingCycleReply(question: string, documents: KnowledgeDocument[]) {
  const value=normalize(question);
  const cutoff=value.match(/\bfecha de corte (?:de un cliente )?(?:es )?(?:del? |el )?(?:dia )?(\d{1,2})\b/)?.[1];
  if (!cutoff || !/\b(?:pagar|venc\w*|limite)\b/.test(value)) return null;
  for (const doc of documents) {
    const offset=normalize(doc.excerpt).match(/fecha limite de pago es (\d{1,2}) dias calendario despues de (?:su |la )?fecha de corte/)?.[1];
    const day=Number(cutoff)+Number(offset);
    if (Number(cutoff)>0 && Number(offset)>0 && day<=28) {
      return {text:`Puede pagar hasta el día ${day} del mismo mes, ${offset} días calendario después del corte.`,doc};
    }
  }
  return null;
}

export function homePlanReply(question:string, documents:KnowledgeDocument[], channel:Channel) {
  const topic=normalize(question);
  const speed=topic.match(/\bfibra\s*(\d{2,4})\b/)?.[1];
  if (!speed || !/\b(?:incluye|trae|tiene|que ofrece|precio|cuesta)\b/.test(topic) ||
      /\b(?:promocion|iva|instalacion|simetri\w*|permanencia|cargo|cobertura|descuento|cambiar|cambio|diferencia|compar\w*)\b/.test(topic)) return null;
  const row=new RegExp('^Hogar Fibra '+speed+' +'+speed+' Mbps +(\\$[\\d.,]+) +([^\\r\\n]+)','im');
  const matches=documents.filter(doc=>doc.type==='catalogo' && /\bprecio\s+mensual\b/i.test(doc.excerpt)).flatMap(doc=>{
    const values=doc.excerpt.match(row);
    return values?[{price:values[1],included:values[2].trim().replace(/ \+ /g,', ').replace(/\.$/,''),doc}]:[];
  });
  const details=new Set(matches.map(({price,included})=>JSON.stringify([price,included])));
  if (details.size!==1) return null;
  const [{price,included,doc}]=matches;
  const reply='Hogar Fibra '+speed+' cuesta '+price+' al mes e incluye '+speed+' Mbps, '+included+'.';
  return reply.length<=publicReplyLimit(channel) ? {text:reply,doc} : null;
}

export function shortPublicEvidence(excerpt:string, channel:Channel) {
  const lines=excerpt.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const body=lines[0]?.startsWith('## ') ? lines.slice(1) : lines;
  if (body.length!==1) return null;
  const paragraph=body[0];
  if (/[|<>]|https?:\/\/|^(?:\d+[.)]|[-*•#])|^(?:¿|\?)/i.test(paragraph)) return null;
  const sentences=[...new Intl.Segmenter('es',{granularity:'sentence'}).segment(paragraph)];
  return paragraph.length<=publicReplyLimit(channel) && sentences.length<=3 ? paragraph : null;
}

/** Prefer a compact verbatim answer when its source covers the requested policy or device. */
export function quotedPublicReply(question:string, documents:KnowledgeDocument[], channel:Channel) {
  const topic=normalize(question);
  const collapse=(value:string)=>value.replace(/\s+/g,' ').trim();
  if (/\b(?:descuento|beneficio|convergencia)\b/.test(topic) && /\binternet hogar\b/.test(topic) &&
      /\b(?:pospago|movil|celular)\b/.test(topic)) {
    const matching=documents.filter(doc=>/\bmismo titular\b/.test(normalize(doc.excerpt)) &&
      /\bcargo fijo (?:de su|del) plan m[oó]vil\b/i.test(collapse(doc.excerpt)));
    const percentages = new Set(matching.flatMap(doc=>[...collapse(doc.excerpt)
      .matchAll(/(\d+)\s*% de descuento sobre el cargo fijo (?:de su|del) plan móvil/gi)].map(match=>match[1])));
    if (percentages.size!==1) return null;
    for (const doc of matching) {
      const text=shortPublicEvidence(doc.excerpt,channel);
      if (text && /\btitular\b/.test(text)) return {text,doc};
    }
  }
  const model=topic.match(/\b[a-z][a-z\d]{1,10}-[a-z]*\d[a-z\d-]*\b/)?.[0];
  const reset = model && /\b(?:restable[cz]\w*|reset\w*)\b/.test(topic) && /\bfabrica\b/.test(topic);
  const namedDevice = topic.match(/\b(?:del (?:modelo )?|para el modelo )([a-z\d-]+(?:\s+\d[a-z\d]*)?)\b/)?.[1];
  const parental = namedDevice && /\bpin\b/.test(topic) && /\bcontrol parental\b/.test(topic) && /\b(?:inicial|defecto|cual)\b/.test(topic) &&
    !/\b(?:actual|olvid\w*|personaliz\w*)\b/.test(topic);
  if (!reset && !parental) return null;
  for (const doc of documents.filter(item=>item.type==='soporte')) {
    const excerpt=collapse(doc.excerpt);
    if (reset && normalize(doc.title).includes(model) && /^\d+\.\s+Restablecimiento de fábrica:\s/.test(excerpt) &&
        /\bRESET\b/i.test(excerpt) && /\bse borran\b/i.test(excerpt) && excerpt.length<=publicReplyLimit(channel)) {
      return {text:excerpt.replace(/^\d+\.\s+/,''),doc};
    }
    if (parental && normalize(doc.title).replace(/ /g,'').includes(namedDevice.replace(/ /g,'')) &&
        /^\d+\.\s+Control parental\s/.test(excerpt)) {
      const text=excerpt.replace(/^\d+\.\s+Control parental\s+/,'');
      if (/^El PIN de control parental por defecto es \d{4}\./.test(text) && text.length<=publicReplyLimit(channel)) return {text,doc};
    }
  }
  return null;
}
