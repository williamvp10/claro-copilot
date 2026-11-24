import type { KnowledgeDocument } from './index.js';

const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function mobileCommitmentQuestion(question: string) {
  const text=normalize(question);
  return /\b(?:movil\w*|pospago|celular)\b/.test(text) && /\b(?:permanencia|clausula)\b/.test(text);
}

export function mobileCommitmentReply(documents: KnowledgeDocument[]) {
  for (const doc of documents) {
    if (doc.type!=='contrato') continue;
    const evidence=doc.excerpt.replace(/\s+/g,' ');
    const main=evidence.match(/Los planes m[oó]viles pospago no tienen (?:cl[aá]usula de )?permanencia(?: m[ií]nima)?\./i)?.[0];
    const financed=evidence.match(/Si [^.]*\bequipo financiado\b[^.]*\./i)?.[0];
    if (main && financed) {
      return {text:`${main.replace(/cl[aá]usula de /i,'')} ${financed}`,docs:[doc]};
    }
  }
  return null;
}

export function advisorPromotionReply(question: string, documents: KnowledgeDocument[]) {
  const text=normalize(question);
  if (!/\bpromoci\w*\b/.test(text) || !/\bfibra\s*500\b/.test(text) ||
      !/\b(?:cliente\s+actual|cambi\w*|pasar\w*|mejorar\w*)\b/.test(text)) return null;
  const policy=documents.find(doc => doc.scope==='advisor' && /(?:actuales|cambi\w*)/.test(normalize(doc.excerpt)) &&
    /\b(?:unicamente|solo) a clientes nuevos de internet hogar\b/.test(normalize(doc.excerpt)) &&
    /\bclientes actuales[^.]*\bprecio de lista\b/.test(normalize(doc.excerpt)));
  if (!policy) return null;
  const rates=documents.filter(doc=>doc.type==='catalogo').flatMap(doc=>{
    const price=doc.excerpt.match(/^Hogar Fibra 500\s+500 Mbps\s+(\$[\d.,]+)/im)?.[1];
    return price ? [{doc,price}] : [];
  });
  const rate=new Set(rates.map(({price})=>price)).size===1 ? rates[0] : undefined;
  return {text:`La promoción es para altas nuevas (solo clientes nuevos de Internet Hogar). Para un cliente actual que cambia de plan, aplica el precio de lista${rate ? ` (${rate.price} al mes)` : ''}.`,
    docs:rate ? [policy,rate.doc] : [policy]};
}

function matchesTenure(label: string, tenure: number) {
  const range=normalize(label);
  const lower=range.match(/^mas de (\d+) meses$/)?.[1];
  const upper=range.match(/^menos de (\d+) meses$/)?.[1];
  const between=range.match(/^entre (\d+) y (\d+) meses$/);
  return (lower!==undefined && tenure>Number(lower)) || (upper!==undefined && tenure<Number(upper)) ||
    (between!==null && tenure>=Number(between[1]) && tenure<=Number(between[2]));
}

export function retentionOptionsReply(question: string, documents: KnowledgeDocument[]) {
  const text=normalize(question);
  const months=text.match(/\b(\d{1,3}) meses (?:de antiguedad|como cliente)\b/)?.[1];
  if (!months || !/\bretencion\b/.test(text) || /\bc-\d+\b/.test(text)) return null;
  const rows=documents.filter(doc=>doc.scope==='advisor' && doc.version.startsWith('POL-RET-')).flatMap(doc=>
    doc.excerpt.split(/\r?\n/).flatMap(line=>{
      const [label, first, second]=line.split('|').map(cell=>cell.trim());
      return first && second && matchesTenure(label,Number(months)) ? [{doc, first, second}] : [];
    }));
  if (rows.length!==1) return null;
  const [{doc,first,second}]=rows;
  return {text:`Si CRM confirma la elegibilidad, la política para ese tramo indica estas opciones. Opción A: ${first}. Opción B: ${second}.`,docs:[doc]};
}

export function portabilityTimingQuestion(question: string) {
  const text=normalize(question);
  return /\b(?:portab\w*|portacion|nip)\b/.test(text) &&
    /\b(?:tard\w*|demor\w*|plazo|vigencia|vence|dura|duracion|caduca|cuando se activa)\b/.test(text);
}

export function advisorEscalationReply(reason: string, documents: KnowledgeDocument[]) {
  if (reason==='requerimiento_legal_o_regulatorio') {
    const rule=documents.find(doc=>doc.type==='politica' && /escalamiento obligatorio a supervisor humano/.test(normalize(doc.excerpt)) &&
      /acciones legales/.test(normalize(doc.excerpt)));
    const trigger=rule?.excerpt.replace(/\r/g,'').match(/^El cliente menciona acciones legales:[^.\n]+\./im)?.[0];
    return rule && trigger ? {text:'Escalar a un supervisor humano. '+trigger,docs:[rule]} : null;
  }
  if (reason!=='los_rojo_mas_de_10_minutos') return null;
  const rule=documents.find(doc=>doc.type==='politica' && /los[^.]+por mas de 10 minutos[^.]*fibra/.test(normalize(doc.excerpt)) &&
    /soporte tecnico nivel 2/.test(normalize(doc.excerpt)));
  const procedure=documents.find(doc=>/\blos rojo\b/.test(normalize(doc.excerpt.replace(/\s+/g,' '))) &&
    /cable de fibra no este doblado ni desconectado/.test(normalize(doc.excerpt.replace(/\s+/g,' '))));
  if (!rule) return null;
  const cable=procedure ? 'Verificar que el cable de fibra esté conectado y sin dobleces. ' : '';
  return {text:`${cable}Si la luz LOS sigue roja por más de 10 minutos, escalar a soporte técnico nivel 2 por posible falla de fibra.`,
    docs:procedure ? [procedure,rule] : [rule]};
}
