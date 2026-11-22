import type { Fact } from '@claro/contracts';
import type { EntityManager } from 'typeorm';

type Invoice = {
  period: string;
  due: string;
  amount: number;
  status: 'pagada' | 'pendiente' | 'vencida';
};
type DemoProfile = {
  plans: { name: string; monthly: number }[];
  invoices: Invoice[];
  openTickets: number;
};
type DemoAccount = DemoProfile & { ref: string; email: string; phone: string };
export type AccountInquiry = 'invoice' | 'balance' | 'plans' | 'tickets';

export function accountInquiry(text: string): AccountInquiry | null {
  const value = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(mis tickets|mis casos|tickets abiertos|mis solicitudes)\b/.test(value)) return 'tickets';
  if (/\b(saldo|cuanto debo|cuanto adeudo|mi mora)\b/.test(value)) return 'balance';
  if (/^(?:facturas?|facturacion|vencimiento)[.?!]*$|\b(mi factura|mis facturas|consultar (?:la )?factura|factura de [a-z]+|vencimiento de mi factura)\b/.test(value)) return 'invoice';
  if (/\b(mi plan|mis planes|mis servicios|que plan tengo|que servicio tengo|plan (?:que tengo|contratado))\b/.test(value)) return 'plans';
  return null;
}

export function requestedAdvisor(text: string) {
  return /\b(?:hablar|comunicarme|atencion)\s+(?:con|de)\s+(?:un |una )?(?:asesor|asesora|humano|persona)\b|^\s*asesor[.!?]?\s*$/i
    .test(text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

export async function findDemoAccount(tx: EntityManager, identifier: string): Promise<string | undefined> {
  const value = identifier.trim().toLowerCase();
  const query = value.includes('@') ? value : value.replace(/[\s()+.-]/g, '');
  const [result] = await tx.query('SELECT ref FROM demo_customer WHERE email=$1 OR phone=$1', [query]);
  return result?.ref;
}

export async function demoAccount(tx: EntityManager, ref: string): Promise<DemoProfile | undefined> {
  const [result] = await tx.query('SELECT profile FROM demo_customer WHERE ref=$1', [ref]);
  return result?.profile;
}

const formatAmount = new Intl.NumberFormat('es-CO');
const formatDate = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'UTC' });
const amount = (value: number) => '$' + formatAmount.format(value);
const date = (value: string) => formatDate.format(new Date(value));
const fact = (id: string, label: string, value: string): Fact => ({id,label,value});
const balance = (account: DemoProfile) => account.invoices.filter(invoice => invoice.status !== 'pagada')
  .reduce((total, invoice) => total + invoice.amount, 0);

export function demoPlanFacts(account: DemoProfile) {
  return account.plans.map((plan, i) => fact(`demo-plan-${i+1}`, plan.name, amount(plan.monthly)));
}

export function demoBillingFacts(account: DemoProfile) {
  const invoice = account.invoices.at(-1);
  if (!invoice) return [];
  const period = new Intl.DateTimeFormat('es-CO', { month: 'long', timeZone: 'UTC' }).format(new Date(invoice.period+'-01'));
  return [
    fact('invoice-status', `Factura de ${period}`, invoice.status[0].toUpperCase()+invoice.status.slice(1)),
    fact('invoice-balance', 'Saldo', amount(balance(account))),
    fact('invoice-due', 'Vencimiento', date(invoice.due))
  ];
}

export function demoAccountReply(account: DemoProfile, request: AccountInquiry): string {
  if (request === 'plans') {
    if (!account.plans.length) return 'Esta cuenta de prueba no tiene planes activos.';
    const plans = account.plans.map(plan => `${plan.name} (${amount(plan.monthly)} al mes)`);
    return `Tus planes activos son ${new Intl.ListFormat('es-CO').format(plans)}.`;
  }
  if (request === 'tickets') {
    return account.openTickets === 1 ? 'Tienes un ticket abierto de atención.' : `Tienes ${account.openTickets} tickets abiertos de atención.`;
  }
  const total = `Tu saldo pendiente es ${amount(balance(account))}.`;
  if (request === 'balance') return total;
  const invoice = account.invoices.at(-1);
  if (!invoice) return 'Esta cuenta de prueba no tiene facturas registradas.';
  return `Tu última factura (${invoice.period}) es por ${amount(invoice.amount)} y figura como ${invoice.status}. Su fecha límite fue fijada para el ${date(invoice.due)}. ${total}`;
}

export async function seedDemoAccounts(tx: EntityManager) {
  for (const {ref, email, phone, ...profile} of demoFixtures) {
    await tx.query(`INSERT INTO demo_customer(ref,email,phone,profile) VALUES ($1,$2,$3,$4)
      ON CONFLICT (ref) DO UPDATE SET email=EXCLUDED.email,phone=EXCLUDED.phone,profile=EXCLUDED.profile`,
    [ref,email,phone,profile]);
  }
}

// Minimal projection of crm_clientes.json and facturas.json. The contact aliases are demo-only.
const demoFixtures: DemoAccount[] = [
  { ref:'C-1001', email:'cliente1@example.test', phone:'11111',
    plans: [{name:"Hogar Fibra 500",monthly:109900}, {name:"Claro Max 60 GB",monthly:59415}],
    openTickets: 0, invoices: [
      {period:'2026-09',due:'2026-09-25',amount:169315,status:'pagada'},
      {period:'2026-10',due:'2026-10-25',amount:169315,status:'pagada'},
      {period:'2026-11',due:'2026-11-25',amount:169315,status:'pendiente'},
    ] },
  { ref:'C-1004', email:'cliente2@example.test', phone:'22222',
    plans: [{name:"Hogar Fibra 300",monthly:89900}],
    openTickets: 0, invoices: [
      {period:'2026-09',due:'2026-09-16',amount:89900,status:'pagada'},
      {period:'2026-10',due:'2026-10-16',amount:89900,status:'pagada'},
      {period:'2026-11',due:'2026-11-16',amount:89900,status:'pagada'},
    ] },
  { ref:'C-1007', email:'cliente3@example.test', phone:'33333',
    plans: [{name:"Claro Max 25 GB",monthly:49900}],
    openTickets: 1, invoices: [
      {period:'2026-09',due:'2026-10-05',amount:49900,status:'vencida'},
      {period:'2026-10',due:'2026-11-04',amount:49900,status:'vencida'},
      {period:'2026-11',due:'2026-12-05',amount:49900,status:'pendiente'},
    ] },
];
