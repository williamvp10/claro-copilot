import { randomUUID } from 'node:crypto';
import {
  Balance, Customer, CustomerId, Eligibility, Invoice, InvoiceDetail, Receipt, Service, Ticket, type ManualAction
} from '@claro/contracts';
import { z } from 'zod';
import type { DataSource } from 'typeorm';

type Simulator = 'crm' | 'billing';
const prefixes = { crm:'CRM', billing:'BILLING' };
const failure = z.object({ codigo: z.string() });
type Options = { body?: unknown; key?: string; response?: 'empty' };
let observedDatabase: DataSource | undefined;

export function observeSimulators(db: DataSource) {
  observedDatabase = db;
}

function observe(service: Simulator, failed: boolean) {
  void observedDatabase?.query(`INSERT INTO integration_observation (service,minute,requests,errors)
    VALUES ($1,date_trunc('minute',now()),1,$2)
    ON CONFLICT (service,minute) DO UPDATE SET requests=integration_observation.requests+1,
      errors=integration_observation.errors+EXCLUDED.errors`,[service,failed ? 1 : 0]).catch(() => undefined);
}

export class SimulatorFailure extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfter = 0) {
    super(code);
  }
}

async function request<T>(service: Simulator, path: string, schema: z.ZodType<T>, options: Options = {}): Promise<T> {
  const prefix = prefixes[service];
  const base = process.env[prefix + '_API_URL'];
  const key = process.env[prefix + '_API_KEY'];
  const healthy = path === '/readyz';
  let failed = false;
  const deadline = AbortSignal.timeout(1800);
  try {
    if (!base || !key) throw new SimulatorFailure(503,'API_NO_CONFIGURADA');
    const url = healthy ? new URL(path,base) : base.replace(/\/$/,'') + path;
    const res = await fetch(url, {
      method: options.body === undefined ? 'GET' : 'POST',
      redirect:'error',
      headers: {
        'X-API-Key':key, 'X-Request-ID':randomUUID(),
        ...(options.body !== undefined ? {'Content-Type':'application/json'} : {}),
        ...(options.key ? {'Idempotency-Key':options.key} : {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: deadline
    });
    if (!res.ok) {
      const decoded = failure.safeParse(await res.json().catch(() => undefined));
      throw new SimulatorFailure(res.status,decoded.success ? decoded.data.codigo : 'API_ERROR',Number(res.headers.get('Retry-After')) || 0);
    }
    return schema.parse(options.response === 'empty' ? undefined : await res.json());
  } catch (error) {
    failed = !(error instanceof SimulatorFailure) || error.status === 401 || error.status === 429 || error.status >= 500;
    if (error instanceof SimulatorFailure) throw error;
    throw new SimulatorFailure(503,deadline.aborted || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'TimeoutError') ? 'API_TIMEOUT' : 'API_NO_DISPONIBLE');
  } finally {
    if (!healthy) observe(service,failed);
  }
}

const customerPath = (ref: string) => '/clientes/' + encodeURIComponent(ref);
const invoicePath = (ref: string) => '/facturas/' + encodeURIComponent(ref);

export const simulators = {
  alias: (alias: string) => request('crm','/identidades/resolver',z.object({ cliente_id:CustomerId }),{body:{alias}}),
  customer: (ref: string) => request('crm',customerPath(ref),Customer),
  services: (ref: string) => request('crm',customerPath(ref) + '/servicios',z.array(Service)),
  directory: (offset:number, limit:number, q:string, refs?:string[]) => {
    const query=new URLSearchParams({offset:String(offset),limit:String(limit),q});
    if (refs) query.set('refs',refs.join(','));
    return request('crm',`/admin/clientes?${query}`,z.array(z.object({cliente_id:CustomerId,nombre:z.string(),estado:z.string(),revision:z.number()})));
  },
  directoryCustomer: (ref:string) => request('crm',customerPath(ref),Customer.extend({revision:z.number(),celular:z.string(),email:z.string(),tipo_documento:z.string()})),
  customerCommand: (ref:string | null, body:unknown, key:string) => request('crm',ref ? '/admin/clientes/'+encodeURIComponent(ref) : '/admin/clientes',z.object({cliente_id:CustomerId,revision:z.number()}),{body,key}),
  tickets: (ref: string) => request('crm',customerPath(ref) + '/tickets',z.array(Ticket)),
  eligibility: (ref: string) => request('crm',customerPath(ref) + '/elegibilidad-retencion',Eligibility),
  invoices: (ref: string) => request('billing',customerPath(ref) + '/facturas?limite=12',z.array(Invoice)),
  balance: (ref: string) => request('billing',customerPath(ref) + '/saldo',Balance),
  invoice: (ref: string) => request('billing',invoicePath(ref),InvoiceDetail),
  receipt: (service: Simulator, key: string) => request(service,'/operaciones/' + encodeURIComponent(key),Receipt),
  async send(ref: string, action: ManualAction, advisor: string, supervisor: string | null, key: string) {
    if (action.kind === 'ticket') {
      await request('crm',customerPath(ref) + '/tickets',Ticket,{body:action.ticket,key});
    } else if (action.kind === 'offer') {
      await request('crm',customerPath(ref) + '/ofertas-retencion',z.undefined(),{
        body:{codigo:action.codigo,descripcion:'Oferta de política aceptada',asesor_id:advisor},key,response:'empty'
      });
    } else {
      await request('billing',invoicePath(action.invoice_id) + '/ajustes',z.undefined(),{
        body:{...action.adjustment,aprobado_por:supervisor},key,response:'empty'
      });
    }
  },
  async health(db: DataSource) {
    const totals: { service: Simulator; requests: number; errors: number }[] = await db.query(`SELECT service,
      sum(requests)::integer AS requests,sum(errors)::integer AS errors FROM integration_observation
      WHERE minute>=now()-interval '24 hours' GROUP BY service`);
    return Promise.all((['crm','billing'] as const).map(async service => {
      const started = Date.now();
      const available = await request(service,'/readyz',z.object({status:z.literal('ready')})).then(() => true, () => false);
      const total = totals.find(item => item.service === service);
      return { service, available, latency_ms:Date.now()-started, requests:total?.requests ?? 0, errors:total?.errors ?? 0 };
    }));
  }
};
