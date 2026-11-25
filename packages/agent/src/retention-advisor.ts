import type { AdvisorCard, CaseDiscount, Message } from '@claro/contracts';

export function requestedDiscount(messages:Message[]) {
  const text=messages.filter(message=>message.actor==='cliente').at(-1)?.text ?? '';
  if (!/\b(quiero|quisiera|pueden|puedes|podr[ií]an|podr[ií]as|ofrecen|me dan|me das|necesito|mejor|llegar|subir)\b/i.test(text) &&
      !/^\s*¿?(?:y\s+)?(?:un\s+)?\d+\s*(?:%|por ciento)\s*\??$/i.test(text)) return undefined;
  const [,raw]=text.match(/\b(\d{1,3})\s*(?:%|por ciento)/i) ?? [];
  const value=Number(raw);
  return Number.isInteger(value) && value>=1 && value<=100 ? value : undefined;
}

export function retentionAdvisorReply(card:AdvisorCard,discount?:CaseDiscount) {
  if (discount) {
    const terms=discount.terms;
    if (discount.status==='requested') return 'Voy a pedir a Administración que revise el descuento que solicitaste. Te confirmaré las condiciones cuando tenga su respuesta.';
    if (discount.status==='authorized') return `Puedo ofrecerte un ${terms.percentage} % de descuento sobre el cargo fijo de ${terms.plan} durante ${terms.cycles} ciclos de facturación. ¿Aceptas estas condiciones?`;
    if (discount.status==='scheduled') {
      if (discount.schedule?.last_invoice) return `El descuento sobre el cargo fijo de ${terms.plan} aparece en la factura ${discount.schedule.last_invoice}. Puedo ayudarte a revisar el detalle.`;
      if (discount.schedule) return `Tu descuento del ${terms.percentage} % sobre el cargo fijo de ${terms.plan} quedó programado desde el ciclo ${discount.schedule.start_period}. Podrás verlo en el detalle de la factura cuando se emita.`;
    }
    return 'Gracias por confirmar las condiciones. Estoy gestionando el registro del beneficio y te confirmaré cuándo quede programado.';
  }
  if (card.reason_codes.includes('retention_ineligible')) return 'Entiendo tu solicitud. Voy a revisar contigo el siguiente paso para tramitarla.';
  if (card.reason_codes.includes('option_unclear')) return '¿Cuál de las alternativas que revisamos prefieres? Así puedo confirmar las condiciones contigo.';
  if (card.reason_codes.includes('retention_prepare_discount')) return 'Gracias por elegir el descuento. Voy a revisar a qué servicio se aplica y te compartiré los términos para confirmarlos contigo.';
  if (card.proposal?.kind==='retention_offer') return 'Gracias por elegir una alternativa. Voy a confirmar sus condiciones y gestionar el registro.';
  const options=card.retention_options;
  if (!options?.length) return undefined;
  const optionsText=options.map(option=>`${/^\d/.test(option.title)?'un ':''}${option.title.charAt(0).toLowerCase()}${option.title.slice(1)}, ${option.detail.charAt(0).toLowerCase()}${option.detail.slice(1).replace(/\.$/,'')}`).join(', o ');
  const different=card.requested_discount && !options.some(option=>option.title.includes(`${card.requested_discount} %`));
  return different
    ? `Puedo pedir que revisen el porcentaje que solicitaste. Por ahora puedo ofrecerte ${optionsText}. ¿Quieres que solicite la revisión?`
    : `Puedo ofrecerte ${optionsText}. ${options.length>1?'¿Cuál de estas alternativas prefieres?':'¿Te interesa esta alternativa?'}`;
}
