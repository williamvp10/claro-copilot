export function resolutionSignals(input:string, question?:string) {
  const clauses=input.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().split(/[.,;!?]+/);
  const resolved=/\b(?:quedo (?:resuelto|solucionado|arreglado)|(?:ya )?(?:se|lo) (?:resolvio|resolvi|soluciono|solucione|arreglo|arregle)|(?:esta|todo) (?:bien|resuelto|solucionado)|ya (?:funciona|volvio)|estoy satisfech[oa])\b/;
  const close=/\b(?:puedes|puede|podemos|quiero|deseo|prefiero) (?:dar por terminad[oa]|cerrar|terminar|finalizar)(?: (?:el|la|este|esta) (?:caso|chat|consulta|conversacion|atencion))?(?=\s*$|\s+por favor\b)|\b(?:cierr[ae]|cerr[ae]mos|terminemos|finalicemos) (?:el |la |este |esta )?(?:caso|chat|consulta|conversacion|atencion)\b/;
  const negation=/\b(?:no|nunca|todavia no|aun no)\b.*$/;
  const denied=clauses.some(clause=>{
    const match=resolved.exec(clause) ?? close.exec(clause);
    return match && negation.test(clause.slice(0,match.index));
  });
  const followup=/\b(?:pero|sin embargo|sigo sin|tengo otra|otra pregunta|aun tengo|todavia tengo)\b/.test(clauses.join(' '));
  const normalized=question?.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase() ?? '';
  const affirmation=/^\s*(?:si|listo|claro|de acuerdo|correcto)(?:[\s,.!]+(?:muchas )?gracias)?[.!\s]*$/.test(clauses.join(' ').trim());
  const asked=affirmation && /¿|\?/.test(normalized);
  const resolvedQuestion=asked && /\b(?:quedo|esta|quedaron)\s+(?:tu (?:caso|consulta)\s+)?(?:resuelt[oa]|solucionad[oa])\b/.test(normalized);
  const closeQuestion=asked && /\b(?:puedo|deseas|quieres|podemos) (?:cerrar|terminar|dar por terminad[oa])\b/.test(normalized);
  return {satisfied:!denied&&!followup&&(resolvedQuestion || clauses.some(clause=>resolved.test(clause))),
    close:!denied&&!followup&&(closeQuestion || clauses.some(clause=>close.test(clause)))};
}
