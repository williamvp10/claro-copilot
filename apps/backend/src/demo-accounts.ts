import type { Fact, Service } from '@claro/contracts';
import type { z } from 'zod';
import { simulators } from './simulator-client.js';

export const accountVerificationPrompt = 'Para verificar tu cuenta, escribe tu correo o teléfono de prueba en el chat.';

export type AccountInquiry = 'invoice' | 'balance' | 'plans' | 'tickets' | 'assistance';

export function accountInquiry(text: string): AccountInquiry | null {
  const value = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(mis tickets|mis casos|tickets abiertos|mis solicitudes)\b/.test(value)) return 'tickets';
  if (/\b(saldo|cuanto debo|cuanto adeudo|mi mora)\b/.test(value)) return 'balance';
  if (/^(?:facturas?|facturacion|vencimiento)[.?!]*$|\b(mi (?:ultima )?factura|mis facturas|mi recibo|consultar (?:la )?factura|factura de [a-z]+|vencimiento de mi factura)\b/.test(value)) return 'invoice';
  if (/\b(mi plan|mis planes|mis servicios|que plan tengo|que servicio tengo|plan (?:que tengo|contratado))\b/.test(value)) return 'plans';
  if (/\b(cancelar|cancelacion|dar de baja|retirar(?:me)?|portar mi (?:linea|numero)|portabilidad saliente)\b/.test(value)) return 'assistance';
  return null;
}

export function requestedAdvisor(text: string) {
  return /\b(?:hablar|comunicarme|atencion)\s+(?:con|de)\s+(?:un |una )?(?:asesor|asesora|humano|persona)\b|^\s*asesor[.!?]?\s*$/i
    .test(text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}


export function contactCandidates(text: string) {
  const emails = text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];
  const digits = text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' ')
    .match(/(?<![\w.])\+?\d(?:[ ()-]*\d){4,14}(?!\w|[.]\d)/g) ?? [];
  const phones = digits.map(number => number.replace(/\D/g, ''))
    .filter(number => number.length === 5 || number.length >= 10);
  return [...new Set([...emails.map(email => email.toLowerCase()), ...phones])];
}

export function codeCandidates(text: string) {
  const codes = text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' ')
    .match(/(?<![\w])(?:\d{6}|\d{3}[ -]\d{3})(?![\w])/g) ?? [];
  return [...new Set(codes.map(code => code.replace(/\D/g, '')))];
}

const formatAmount = new Intl.NumberFormat('es-CO');
const formatDate = new Intl.DateTimeFormat('es-CO', { dateStyle:'long', timeZone:'UTC' });
const amount = (value: number) => '$' + formatAmount.format(value);
const date = (value: string) => formatDate.format(new Date(value));
export const fact = (id: string, label: string, value: string): Fact => ({ id,label,value });

export function planFacts(services: z.infer<typeof Service>[]) {
  return services.filter(item => item.estado === 'activo').map(item => fact(item.servicio_id,item.plan,amount(item.valor_mensual)));
}

export async function billingFacts(ref: string) {
  const [balance,invoices] = await Promise.all([simulators.balance(ref),simulators.invoices(ref)]);
  const invoice = invoices[0];
  return [
    ...(invoice ? [fact('invoice-status',`Factura de ${invoice.periodo}`,invoice.estado)] : []),
    fact('invoice-balance','Saldo',amount(balance.saldo_pendiente)),
    ...(balance.proxima_fecha_limite ? [fact('invoice-due','Vencimiento',date(balance.proxima_fecha_limite))] : [])
  ];
}

export async function accountReply(ref: string, inquiry: Exclude<AccountInquiry, 'assistance'>) {
  if (inquiry === 'plans') {
    const plans = planFacts((await simulators.customer(ref)).servicios).map(plan => `${plan.label} (${plan.value} al mes)`);
    return plans.length ? `Tus planes activos son ${new Intl.ListFormat('es-CO').format(plans)}.` : 'Esta cuenta de prueba no tiene planes activos.';
  }
  if (inquiry === 'tickets') {
    const open = (await simulators.tickets(ref)).filter(ticket => ticket.estado === 'abierto').length;
    return open === 1 ? 'Tienes un ticket abierto de atención en los últimos 90 días.' : `Tienes ${open} tickets abiertos de atención en los últimos 90 días.`;
  }
  const [balance,invoices] = await Promise.all([simulators.balance(ref),inquiry === 'invoice' ? simulators.invoices(ref) : []]);
  const total = `Tu saldo pendiente es ${amount(balance.saldo_pendiente)}.`;
  const invoice = invoices[0];
  if (inquiry === 'balance' || !invoice) return total;
  const state = invoice.estado !== 'pagada' && invoice.saldo_abierto === 0 ? 'saldada por ajuste' : invoice.estado;
  return `Tu última factura (${invoice.periodo}) es por ${amount(invoice.valor_total)} y figura como ${state}. Su fecha límite fue fijada para el ${date(invoice.fecha_limite_pago)}. ${total}`;
}
