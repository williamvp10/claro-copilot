import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { createSimulator } from '../server.mjs';
import { database } from '../storage.mjs';

const config = {
  crm: { url:process.env.CRM_DATABASE_URL, contract:'crm-api.yaml' },
  billing: { url:process.env.BILLING_DATABASE_URL, contract:'facturacion-api.yaml' }
};
if (!process.env.SIMULATOR_CONTRACT_TEST || Object.values(config).some(x=>!x.url)) {
  throw new Error('Use an isolated seeded PostgreSQL instance and set SIMULATOR_CONTRACT_TEST=1');
}
const apiKey = 'simulator-contract-tests';
const date = '2026-11-18';

async function simulator(t, service, overrides) {
  const { url,contract } = config[service];
  const pool = database(url);
  const server = createSimulator({service,pool,key:apiKey,date,faults:'test',...overrides}).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async () => {
    await new Promise(resolve=>server.close(resolve));
    await pool.end();
  });
  const endpoint = 'http://127.0.0.1:'+server.address().port+'/v1';
  const spec = parse(await readFile(new URL('../../../docs/openapi/'+contract,import.meta.url),'utf8'));
  const ajv = new Ajv({strict:false});
  addFormats(ajv);
  const specKey = 'https://example.test/'+contract;
  ajv.addSchema(spec,specKey);
  return async (path,{ method='GET',body,status=200,contractPath,headers={},signal,authorized=true } = {}) => {
    const res = await fetch(endpoint+path,{
      method,headers:{
        ...(authorized ? {'X-API-Key':apiKey} : {}),'X-Request-ID':'contract-request',
        ...(body ? {'Content-Type':'application/json'} : {}),...headers
      },body:body ? JSON.stringify(body) : undefined,signal
    });
    const raw = await res.text();
    const json = raw ? JSON.parse(raw) : undefined;
    assert.equal(res.status,status,raw);
    assert.equal(res.headers.get('X-Request-ID'),'contract-request');
    if (contractPath) {
      const declaration = spec.paths[contractPath][method.toLowerCase()].responses[String(status)];
      assert.ok(declaration,'HTTP status documented in supplied OpenAPI');
      const schema = (declaration.$ref ? spec.components.responses[declaration.$ref.split('/').at(-1)] : declaration).content?.['application/json']?.schema;
      if (schema) {
        const relocated = JSON.parse(JSON.stringify(schema).replaceAll('"#/components/','"'+specKey+'#/components/'));
        const validate = ajv.compile(relocated);
        assert.ok(validate(json),JSON.stringify(validate.errors));
      }
    }
    return {json,headers:res.headers};
  };
}

test('CRM official lookups, tickets and offers against PostgreSQL', async t => {
  const crm = await simulator(t,'crm');
  const { json: summary } = await crm('/clientes?tipo_documento=CC&numero_documento=91001',{contractPath:'/clientes'});
  assert.equal(summary.cliente_id,'C-1001');
  const { json: profile } = await crm('/clientes/C-1001',{contractPath:'/clientes/{clienteId}'});
  assert.equal(profile.nombre,'Cliente C-1001');
  assert.equal(profile.numero_documento,undefined);
  assert.equal(profile.celular,'11111');
  assert.equal((await crm('/identidades/resolver',{method:'POST',body:{alias:'CLIENTE1@example.test'}})).json.cliente_id,'C-1001');
  assert.equal((await crm('/clientes/C-1001/servicios',{contractPath:'/clientes/{clienteId}/servicios'})).json.length,2);
  assert.equal((await crm('/clientes/C-1013/tickets',{contractPath:'/clientes/{clienteId}/tickets'})).json.length,4);
  const ticket = {method:'POST',body:{categoria:'soporte_tecnico',descripcion:'Caso de contrato'},contractPath:'/clientes/{clienteId}/tickets',status:201};
  const key = 'ticket-contract-key';
  await assert.rejects(crm('/clientes/C-1005/tickets',{...ticket,headers:{'Idempotency-Key':key,'X-Simulator-Fault':'lost-after-commit'}}),/fetch failed/);
  const receipt = (await crm('/operaciones/'+key)).json;
  const retried = await crm('/clientes/C-1005/tickets',{...ticket,headers:{'Idempotency-Key':key}});
  assert.equal(retried.json.ticket_id,receipt.referencia);
  assert.equal((await crm('/clientes/C-1005/tickets')).json.filter(x=>x.ticket_id===receipt.referencia).length,1);

  const offer = { method:'POST',body:{codigo:'RET-A',descripcion:'Oferta aceptada'},contractPath:'/clientes/{clienteId}/ofertas-retencion' };
  await crm('/clientes/C-1007/ofertas-retencion',{...offer,status:409});
  const eligible = await crm('/clientes/C-1005/elegibilidad-retencion');
  assert.equal(eligible.json.options[0].title,'30 % de descuento');
  const requests = [1,2].map(i=>fetchOffer(i));
  async function fetchOffer(i) {
    try {
      return await crm('/clientes/C-1005/ofertas-retencion',{...offer,status:201,headers:{'Idempotency-Key':'offer-contract-'+i}});
    } catch (error) {
      assert.equal(error.actual,409);
      return null;
    }
  }
  assert.equal((await Promise.all(requests)).filter(Boolean).length,1);
  assert.equal((await crm('/clientes/C-1005')).json.ofertas_retencion_12m.length,1);
});

test('billing official reads and cumulative adjustments against PostgreSQL', async t => {
  const billing = await simulator(t,'billing');
  const { json: invoices } = await billing('/clientes/C-1007/facturas',{contractPath:'/clientes/{clienteId}/facturas'});
  assert.deepEqual(invoices.map(x=>x.periodo),['2026-11','2026-10','2026-09']);
  const { json: balance } = await billing('/clientes/C-1007/saldo',{contractPath:'/clientes/{clienteId}/saldo'});
  assert.equal(balance.saldo_pendiente,149700);
  assert.equal(balance.saldo_vencido,99800);
  assert.equal(balance.proxima_fecha_limite,'2026-12-05');
  const candidate = (await billing('/clientes/C-1006/facturas')).json.find(x=>x.saldo_abierto>50_001);
  assert.ok(candidate,'fixture with open balance greater than advisor limit');
  const invoice = '/facturas/'+candidate.factura_id;
  const detailPath = '/facturas/{facturaId}';
  const adjustments = invoice+'/ajustes';
  const adjust = (value,key,status,approved=null) => billing(adjustments,{
    method:'POST',body:{valor:value,motivo:'Ajuste de prueba',aprobado_por:approved},status,
    contractPath:status===409 ? undefined : '/facturas/{facturaId}/ajustes',headers:{'Idempotency-Key':key}
  });
  const duplicate = await Promise.all([adjust(50_000,'credit-exact-limit',201),adjust(50_000,'credit-exact-limit',201)]);
  assert.equal(duplicate[0].headers.get('X-Operation-Reference'),duplicate[1].headers.get('X-Operation-Reference'));
  await adjust(1,'credit-over-limit',403);
  await adjust(1,'credit-over-limit',201,'synthetic-supervisor');
  await adjust(candidate.saldo_abierto,'credit-invalid',409,'synthetic-supervisor');
  const detail = (await billing(invoice,{contractPath:detailPath})).json;
  assert.equal(detail.saldo_abierto,candidate.saldo_abierto-50_001);
  assert.equal(detail.ajustes.length,2);
  assert.equal(detail.valor_total,candidate.valor_total);
  assert.equal(detail.fecha_pago,candidate.fecha_pago);
  const race = candidate.saldo_abierto-50_001;
  const competing = ['credit-race-one','credit-race-two'].map(key =>
    adjust(race,key,201,'synthetic-supervisor').then(()=>true,error=>{assert.equal(error.actual,409);return false;}));
  assert.equal((await Promise.all(competing)).filter(Boolean).length,1);
  assert.equal((await billing(invoice)).json.saldo_abierto,0);
});

test('authentication, deterministic faults, timeout and rate scope', async t => {
  const crm = await simulator(t,'crm',{quota:3,faultDelay:120});
  const billing = await simulator(t,'billing');
  await crm('/clientes/C-1001',{authorized:false,status:401,contractPath:'/clientes/{clienteId}'});
  await crm('/clientes/C-1001',{status:503,headers:{'X-Simulator-Fault':'503'},contractPath:'/clientes/{clienteId}'});
  await assert.rejects(crm('/clientes/C-1001',{headers:{'X-Simulator-Fault':'timeout'},signal:AbortSignal.timeout(50)}),{name:'TimeoutError'});
  await crm('/clientes/C-1001');
  const limited = await crm('/clientes/C-1001',{status:429,contractPath:'/clientes/{clienteId}'});
  assert.ok(Number(limited.headers.get('Retry-After'))>0);
  await billing('/clientes/C-1001/saldo');
});

test('runtime roles have distinct connect permissions and immutable fixture ledgers', async () => {
  const urls = [process.env.PLATFORM_DATABASE_URL,config.crm.url,config.billing.url];
  for (const url of urls) {
    const source = new URL(url);
    const client = database(url);
    try {
      const {rows:[role]} = await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');
      assert.deepEqual(role,{rolsuper:false,rolcreatedb:false,rolcreaterole:false});
    } finally {
      await client.end();
    }
    for (const other of urls.filter(item=>item!==url)) {
      const target = new URL(source);
      target.pathname = new URL(other).pathname;
      const foreign = database(target.toString());
      try {
        await assert.rejects(foreign.query('SELECT 1'),{code:'42501'});
      } finally {
        await foreign.end();
      }
    }
  }
  const crm = database(config.crm.url);
  const billing = database(config.billing.url);
  try {
    assert.equal((await crm.query('SELECT count(*)::integer AS n FROM customer')).rows[0].n,20);
    assert.equal((await billing.query('SELECT count(*)::integer AS n FROM invoice')).rows[0].n,60);
    await assert.rejects(crm.query('DELETE FROM crm_offer'),{code:'42501'});
    await assert.rejects(billing.query('UPDATE credit SET amount=1'),{code:'42501'});
  } finally {
    await Promise.all([crm.end(),billing.end()]);
  }
});
