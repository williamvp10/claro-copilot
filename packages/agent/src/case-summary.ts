import type { AdvisorCard, CaseIntake, ConfirmedReceipt } from '@claro/contracts';

export function reportedHandoffAttempt(text:string, intake?:CaseIntake):string {
  const input=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if (/\b(?:no he|no pude|no logre|sin haber)\b[^.!?]{0,35}\b(?:refresc\w*|reinici\w*|segu\w*|prob\w*)\b/.test(input)) return '';
  const attempt=/\brefresque (?:la )?senal\b/.test(input) ? 'refrescó la señal'
    : /\breinicie (?:el )?(?:equipo|modem|decodificador)\b/.test(input) ? 'reinició el equipo'
    : /\b(?:segui (?:el )?procedimiento|probe (?:el )?procedimiento)\b/.test(input) ? 'siguió el procedimiento indicado' : '';
  if (!attempt) return '';
  const pending=intake?.facts.imagen==='Imagen aún ausente' || /\bno (?:volvio|regreso) la imagen\b/.test(input)
    ? ' y la imagen sigue sin volver'
    : /\b(?:sigo sin|no funciono|persiste|sigue igual)\b/.test(input) ? ' y la falla persiste' : '';
  return `El cliente informa que ${attempt}${pending}.`;
}

export function renderTemplate(template: string, values: Record<string,string>) {
  return template.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, key: string) => values[key] ?? '').trim();
}

export function renderCaseSummary(template: string, card: AdvisorCard, receipts: ConfirmedReceipt[]) {
  const label = { ticket: 'Ticket registrado', offer: 'Oferta registrada', adjustment: 'Ajuste registrado' };
  const recorded = receipts.map(({kind,reference}) => `${label[kind]} (${reference})`);
  const summary = renderTemplate(template, {
    reason: card.summary,
    verified_facts: card.facts.map(({label,value}) => `${label}: ${value}`).join('. ') || 'Sin hechos de cuenta.',
    source_refs: card.citations.map(({title,version}) => `${title} · ${version}`).join(', ') || 'Sin fuentes.',
    recorded_actions: recorded.join(', ') || 'Sin acciones confirmadas.',
    pending_steps: card.pending.join(', ') || card.next_action
  });
  return summary.slice(0, 4000);
}
