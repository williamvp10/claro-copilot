import type { AdvisorCard, AgentTurn, CaseDiscount, Message, Retention } from '@claro/contracts';
import { cancellationRequest } from './objectives.js';

type Option = Retention['options'][number];
const normalize = (text:string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const percentages = (text:string) => [...text.matchAll(/\b(\d{1,3})\s*(?:%|por ciento)/g)].map(match=>Number(match[1]));
const publishedOffer = /(?:^|[.!;,\n]\s*)(?:por ahora )?(?:(?:te |le )?(?:ofrecemos|ofrezco)|(?:puedo|podemos) (?:ofrecer(?:te|le)?|hacerte|darte|aplicarte|subirte|pasarte|mejorar))\s+([^\n]+?)(?=[.!?](?:\s|$)|\n|$)/g;
const offerFollowUp = /\b(?:cual (?:de (?:las|estas) (?:alternativas|opciones)|prefieres)|(?:te interesa|aceptas) (?:esta (?:oferta|alternativa)|(?:el|este) descuento|estas condiciones))\b/;

function mentionsOption(text:string,option:Option,requireTerms=false) {
  const title=normalize(option.title);
  const percentage=option.discount?.percentage ?? percentages(`${title} ${normalize(option.detail)}`)[0];
  if (percentage !== undefined) {
    const stated=percentages(text);
    return stated.length ? stated.includes(percentage) : !requireTerms && /\b(?:descuento|rebaja)\b/.test(text);
  }
  const target=title.replace(/^mejora (?:(?:a|al) )?/,'');
  return text.includes(title) || text.includes(target) ||
    !requireTerms && title.startsWith('mejora ') && /\b(?:mejora|subir de plan)\b/.test(text);
}

export function continuesCancellation(text:string) {
  const value=normalize(text);
  return /\b(?:quiero|deseo|prefiero|solicito|necesito|pido|puedes?|podemos|sigo)\b/.test(value) &&
    cancellationRequest.test(value) && !/\b(?:no (?:quiero|deseo|necesito) (?:cancel\w*|dar (?:de )?baja)|para no cancel\w*|sin cancel\w*)\b/.test(value);
}

export function retentionDialogue(turn:Pick<AgentTurn,'actor'|'text'|'turn_seq'>,messages:Message[],options:Option[]) {
  // Only sent customer-facing messages can establish that an offer was made. The private card is not an input.
  const sent=messages.filter(message=>message.turn_seq<=turn.turn_seq && !message.verification_input && !message.attention_notice &&
    (message.actor==='asesor' || message.actor==='agente'));
  let offered:Option[]=[];
  for (const message of sent.reverse()) {
    const text=normalize(message.text);
    const terms=[...text.matchAll(publishedOffer)]
      .map(([,offer])=>offer.split(/\b(?:pero|aunque|excepto|salvo|si (?:crm|administracion) confirma)\b/)[0])
      .filter(offer=>!/^(?:revisar|averiguar|consultar|validar|estudiar)\b/.test(offer));
    if (terms.length) {
      offered=options.filter(option=>terms.some(offer=>mentionsOption(offer,option,true)));
      break;
    }
    if (!offerFollowUp.test(text)) break;
  }
  if (turn.actor!=='cliente' || !offered.length) return {offered};
  if (continuesCancellation(turn.text)) return {offered,continueCancellation:true};
  const text=normalize(turn.text).trim();
  const choice=/^[¡!\s]*(?:(?:si|listo|ok|vale)[,\s]+)?(?:acepto|aceptamos|de acuerdo|lo acepto|la acepto|quiero esa|quiero ese)\b/.test(text);
  if (!choice || /\b(?:acepto si|acepto cuando|siempre que|pero solo si|no acepto|no quiero)\b/.test(text)) return {offered};
  const references=offered.filter(option=>mentionsOption(text,option));
  // A different percentage is a new request, even when the customer phrases it as acceptance.
  const stated=new Set(percentages(text));
  if (stated.size>1 || stated.size===1 && !references.length) return {offered};
  const generic=/^[¡!\s]*(?:(?:si|listo|ok|vale)[,\s]+)?(?:acepto(?: (?:la oferta|el beneficio))?|aceptamos|de acuerdo|lo acepto|la acepto)[.!¡\s]*$/.test(text);
  const selected=references.length===1 ? references[0] : !references.length && offered.length===1 && generic ? offered[0] : undefined;
  return {offered,selected,unclear:!selected && offered.length>1};
}

export function requestedDiscount(messages:Message[]) {
  const text=messages.filter(message=>message.actor==='cliente').at(-1)?.text ?? '';
  if (!/\b(quiero|quisiera|pueden|puedes|podr[ií]an|podr[ií]as|ofrecen|me dan|me das|necesito|mejor|llegar|subir)\b/i.test(text) &&
      !/^\s*¿?(?:y\s+)?(?:un\s+)?\d+\s*(?:%|por ciento)\s*\??$/i.test(text)) return undefined;
  const [,raw]=text.match(/\b(\d{1,3})\s*(?:%|por ciento)/i) ?? [];
  const value=Number(raw);
  return Number.isInteger(value) && value>=1 && value<=100 ? value : undefined;
}

export function retentionAdvisorReply(card:AdvisorCard,discount?:CaseDiscount,actor?:AgentTurn['actor']) {
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
  if (card.reason_codes.includes('cancellation_requested')) return 'Entiendo que quieres continuar con la baja. Voy a revisar el siguiente paso del trámite y te explicaré cómo proceder.';
  if (card.reason_codes.includes('option_unclear')) return '¿Cuál de las alternativas que revisamos prefieres? Así puedo confirmar las condiciones contigo.';
  if (card.reason_codes.includes('retention_prepare_discount')) return 'Gracias por elegir el descuento. Voy a revisar a qué servicio se aplica y te compartiré los términos para confirmarlos contigo.';
  if (card.reason_codes.includes('retention_choice_review')) return 'Voy a revisar las condiciones de la alternativa que elegiste y te confirmaré cómo continuar.';
  if (card.proposal?.kind==='retention_offer') return 'Gracias por elegir una alternativa. Voy a confirmar sus condiciones y gestionar el registro.';
  const options=card.retention_options;
  if (!options?.length) return undefined;
  const optionsText=options.map(option=>`${/^\d/.test(option.title)?'un ':''}${option.title.charAt(0).toLowerCase()}${option.title.slice(1)}, ${option.detail.charAt(0).toLowerCase()}${option.detail.slice(1).replace(/\.$/,'')}`).join(', o ');
  const requested=card.requested_discount;
  if (requested && !options.some(option=>percentages(normalize(option.title)).includes(requested))) {
    return `Puedo pedir que revisen el porcentaje que solicitaste. Por ahora puedo ofrecerte ${optionsText}. ¿Quieres que solicite la revisión?`;
  }
  if (actor==='asesor' && card.reason_codes.includes('retention_awaiting_choice')) {
    return 'Si tienes dudas sobre las condiciones que te compartí, con gusto te las aclaro.';
  }
  return `Puedo ofrecerte ${optionsText}. ${options.length>1?'¿Cuál de estas alternativas prefieres?':'¿Te interesa esta alternativa?'}`;
}
