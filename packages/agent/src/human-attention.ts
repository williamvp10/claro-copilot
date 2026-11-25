const person = '(?:asesor(?:a)?|humano|persona|agente humano)';
const recipient = `(?:(?:a|con)\\s+)?(?:(?:un|una|el|la)\\s+|al\\s+)?${person}`;
const transfer = '(?:(?:pasa|pase|pasen|comunica|comunique|conecta|conecte|transfiere|transfiera|deriva|derive)me|me\\s+(?:(?:puede[ns]?|podria[n]?)\\s+(?:pasar|comunicar|conectar|transferir|derivar)|pasa[sn]?|pase[sn]?|pasar|comunica[sn]?|comunique[sn]?|comunicar|conecta[sn]?|conecte[sn]?|conectar|transfiere[sn]?|transfiera[sn]?|transferir|deriva[sn]?|derive[sn]?|derivar))';
const request = new RegExp(`\\b(?:${transfer}\\s+${recipient}|(?:hablar|comunicarme|comunicar|atencion)\\s+(?:con|de)\\s+${recipient}|(?:quiero|necesito|prefiero)\\s+(?:que me (?:ayude|atienda)\\s+)?${recipient})\\b`);
const negated = /\b(?:no|nunca|tampoco|sin)\b[^,;.!?]{0,45}$/;
const standalone = new RegExp(`^${person}$`);

export function requestedAdvisor(input: string): boolean {
  const normalized=input.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return normalized.split(/[,.!?;¡¿]+/).some(part=>{
    const sentence=part.trim().replace(/\s+/g,' ');
    if (standalone.test(sentence)) return true;
    const match=request.exec(sentence);
    return !!match && !negated.test(sentence.slice(0,match.index));
  });
}

export function acceptsAdvisorOffer(input: string, previous: string): boolean {
  return /¿(?:quieres|te gustaria|prefieres) (?:hablar con (?:uno|(?:un|una) asesor(?:a)?)|que te (?:comunique|pase) con (?:un|una) asesor(?:a)?)\?$/i
    .test(previous.normalize('NFD').replace(/[\u0300-\u036f]/g,'')) &&
    /^\s*(?:s[ií](?:,? por favor)?|por favor|de acuerdo|claro(?: que s[ií])?)[. !]*$/i.test(input);
}
