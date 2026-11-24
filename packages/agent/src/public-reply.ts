import type { Channel, Message } from '@claro/contracts';
import type { KnowledgeDocument } from './index.js';

const normalize=(text:string)=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const namedPlan=/\b(?:(?:claro\s+)?max\s+ilimitado|plan\s+ilimitado)\b/;
const changeQuestion=/\b(?:(?:puedo|se puede|podria)\s+(?:hacer el cambio|cambiar(?:lo|me)?)|(?:cuando|como)\s+(?:puedo\s+)?cambiar|cambio de plan)\b/;

export function mobilePlanTopic(text:string, previous?:Message) {
  const value=normalize(text);
  const mobile=/\bplan\s+movil\b/.test(value) || namedPlan.test(value);
  const discussed=previous?.actor==='agente' && normalize(previous.text).includes('claro max ilimitado');
  return changeQuestion.test(value) && (mobile || discussed) ? 'change' :
    namedPlan.test(value) && /\b(?:incluye|trae|ofrece|tiene|plan|cuesta|precio)\b/.test(value) ? 'unlimited' : null;
}

export function asksToChangeMobilePlan(text:string, previous?:Message) {
  const value=normalize(text).trim();
  if (/\b(?:cambiame|quiero (?:cambiarme|pasarme) al) (?:al )?(?:(?:plan|claro max) )?ilimitado\b/.test(value)) return true;
  return previous?.actor==='agente' &&
    /\bnuevo plan\b|\bel cambio\b/.test(normalize(previous.text)) &&
    /siguiente ciclo de facturacion/.test(normalize(previous.text)) &&
    /^(?:(?:si[, ]+)?(?:hagale|hazlo|haz el cambio|hazme el cambio|procede|cambialo|quiero hacer el cambio))[. !]*$/.test(value);
}

export function publicReplyLimit(channel:Channel) {
  return channel==='voice' ? 235 : 340;
}

export function mobilePlanReply(topic:ReturnType<typeof mobilePlanTopic>, documents:KnowledgeDocument[], channel:Channel) {
  for (const doc of documents) {
    if (topic==='change' && /cambiar mi plan movil|cambiar mi plan móvil/i.test(doc.title+' '+doc.excerpt) &&
        /sin costo/i.test(doc.excerpt) && /siguiente ciclo de facturaci[oó]n/i.test(doc.excerpt)) {
      return {text:'Sí. Puedes cambiar tu plan móvil sin costo. El nuevo plan empieza en tu siguiente ciclo de facturación.',doc};
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

export function shortPublicEvidence(excerpt:string, channel:Channel) {
  const lines=excerpt.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const body=lines[0]?.startsWith('## ') ? lines.slice(1) : lines;
  if (body.length!==1) return null;
  const paragraph=body[0];
  if (/[|<>]|https?:\/\/|^(?:\d+[.)]|[-*•#])|^(?:¿|\?)/i.test(paragraph)) return null;
  const sentences=[...new Intl.Segmenter('es',{granularity:'sentence'}).segment(paragraph)];
  return paragraph.length<=publicReplyLimit(channel) && sentences.length<=3 ? paragraph : null;
}
