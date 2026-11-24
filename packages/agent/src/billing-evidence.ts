import type { Fact } from '@claro/contracts';

export function claimedBillingAccount(text: string): boolean {
  return /\bC-\d{4}\b/i.test(text) && /\b(?:facturas?|facturaci[oó]n|recibos?|cobros?|cargos?|saldo)\b/i.test(text);
}

export function reportedAdjustmentAmount(text: string): number | undefined {
  if (!/\b(?:cargo|cobro|factura|facturacion|saldo)\b/.test(text) ||
      !/\b(?:ajust\w*|revers\w*|reintegr\w*|abon\w*)\b/.test(text)) return;
  const figures = [...text.matchAll(/(?<![\d.])(?:\$\s*|\bcop\s*)(\d{1,3}(?:\.\d{3})+|\d+)(?![\d.,])|(?<![\d.,])(\d{1,3}(?:\.\d{3})+|\d+)\s*(?:pesos|cop)\b/g)];
  const amounts = [...new Set(figures.map(match => Number((match[1] ?? match[2]).replaceAll('.', ''))))];
  if (amounts.length === 1 && Number.isSafeInteger(amounts[0]) && amounts[0] > 0) return amounts[0];
}

export function invoicePeriods(facts: Fact[], businessDate: string, requestedPeriod?: string) {
  const latestPeriod = requestedPeriod ?? businessDate.slice(0,7);
  return facts.flatMap((fact) => {
    const period = fact.label.match(/\b\d{4}-(?:0[1-9]|1[0-2])\b/)?.[0];
    return period && period <= latestPeriod && /^F-\d{4,10}$/.test(fact.id) ? [{ id: fact.id, period }] : [];
  }).sort((a, b) => b.period.localeCompare(a.period))
    .filter((invoice, index, all) => all.findIndex(other => other.period === invoice.period) === index)
    .slice(0, 2);
}

function conceptAmounts(facts: Fact[]) {
  const concepts = new Map<string, { label: string; amount: number }>();
  for (const {label, value} of facts) {
    const formatted = value.trim();
    if (!/^[-−]?\s*\$?\s*(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(formatted)) return null;
    const digits = formatted.replace(/[^\d]/g, '');
    if (!digits) continue;
    const key = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    const amount = Number(digits) * (/^[-−]/.test(formatted) ? -1 : 1);
    concepts.set(key, {label, amount: amount + (concepts.get(key)?.amount ?? 0)});
  }
  return concepts;
}

export function explainInvoiceChange(current: Fact[], previous: Fact[]) {
  const before = conceptAmounts(previous);
  const after = conceptAmounts(current);
  if (!before?.size || !after?.size) return null;
  const format = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  const changes = [...new Set([...before.keys(), ...after.keys()])].flatMap((key) => {
    const old = before.get(key);
    const next = after.get(key);
    const delta = (next?.amount ?? 0) - (old?.amount ?? 0);
    if (!delta) return [];
    return [`${next?.label ?? old!.label}: ${old ? format.format(old.amount) : 'sin registro'} → ${next ? format.format(next.amount) : 'sin registro'}`];
  });
  return changes.length ? changes.join('. ') + '.' : null;
}
