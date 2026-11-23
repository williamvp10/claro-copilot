const jest = import.meta.jest;
const pg = { Client:jest.fn(),Pool:jest.fn() };
jest.unstable_mockModule('pg',()=>pg);
const {database,operation} = await import('../storage.mjs');
const { retentionEligibility } = await import('../crm.mjs');
const { invoiceProjection, validateCredit } = await import('../billing.mjs');
const { invoiceForAccount } = await import('../../backend/dist/integration-operations.js');
const { simulators } = await import('../../backend/dist/simulator-client.js');

afterEach(()=>jest.restoreAllMocks());

test('pg double verifies replays skip side effects and conflicting payloads roll back', async () => {
  let stored;
  const query = jest.fn(async (sql,args)=>{
    if (sql.startsWith('SELECT *')) return {rows:stored?[stored]:[]};
    if (sql.startsWith('INSERT')) stored = {fingerprint:args[1],receipt:args[2],body:args[3]};
    return {rows:[]};
  });
  const release = jest.fn();
  pg.Pool.mockImplementation(()=>({connect:async()=>({query,release})}));
  const pool = database('postgresql://synthetic');
  const apply = jest.fn(async ()=>({type:'oferta'}));
  const first = await operation(pool,'op-unique-1',{option:'RET-A'},apply);
  const replay = await operation(pool,'op-unique-1',{option:'RET-A'},apply);
  expect(replay.receipt).toEqual(first.receipt);
  await expect(operation(pool,'op-unique-1',{option:'RET-B'},apply)).rejects.toMatchObject({code:'CLAVE_REUTILIZADA'});
  expect(apply).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(release).toHaveBeenCalledTimes(3);
});

test('retention policy boundaries and recurrent technical failure', () => {
  const profile = { estado:'activo',dias_mora:30,antiguedad_meses:24,servicios:[{estado:'activo',tipo:'hogar'}] };
  expect(retentionEligibility(profile,[],[]).options[0].title).toBe('20 % de descuento');
  expect(retentionEligibility({...profile,antiguedad_meses:25},[],[]).options[0].title).toBe('30 % de descuento');
  expect(retentionEligibility({...profile,antiguedad_meses:11},[],[]).options.map(o=>o.codigo)).toEqual(['RET-A']);
  expect(retentionEligibility({...profile,dias_mora:31},[],[]).eligible).toBe(false);
  expect(retentionEligibility(profile,[{}],[]).eligible).toBe(false);
  expect(retentionEligibility(profile,[],Array(3).fill({categoria:'soporte_tecnico'})).reason).toMatch(/visita técnica/);
});

test('adjustment boundaries and invoice ownership', () => {
  const invoice = invoiceProjection({body:{estado:'pendiente',valor_total:100_000,cliente_id:'C-1001'},adjusted:30_000});
  expect(()=>validateCredit(invoice,{valor:20_000})).not.toThrow();
  expect(()=>validateCredit(invoice,{valor:20_001})).toThrow(/aprobación/);
  expect(()=>validateCredit(invoice,{valor:20_001,aprobado_por:'admin'})).not.toThrow();
  expect(()=>validateCredit(invoice,{valor:70_001,aprobado_por:'admin'})).toThrow(/saldo/);
  expect(()=>invoiceForAccount(invoice,'C-1007')).toThrow(/no encontrada/);
});

test('typed HTTP double propagates quota, timeouts and keeps credentials server-side', async () => {
  process.env.CRM_API_URL='http://crm.test/v1';
  process.env.CRM_API_KEY='synthetic-crm-key';
  const http = jest.spyOn(globalThis,'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({codigo:'LIMITE_EXCEDIDO'}),{status:429,headers:{'Retry-After':'18'}}))
    .mockRejectedValueOnce(new DOMException('Timeout','TimeoutError'))
    .mockResolvedValueOnce(new Response(JSON.stringify({cliente_id:'C-1001'})));
  await expect(simulators.alias('11111')).rejects.toMatchObject({status:429,retryAfter:18});
  await expect(simulators.alias('11111')).rejects.toMatchObject({status:503,code:'API_TIMEOUT'});
  await expect(simulators.alias('11111')).resolves.toEqual({cliente_id:'C-1001'});
  expect(http).toHaveBeenLastCalledWith('http://crm.test/v1/identidades/resolver',expect.objectContaining({
    headers:expect.objectContaining({'X-API-Key':'synthetic-crm-key','X-Request-ID':expect.any(String)}),
    body:'{"alias":"11111"}'
  }));
});

test('CRM directory sends scope and search to PostgreSQL before pagination', async () => {
  const {crmRoutes}=await import('../crm.mjs');
  const handlers={};
  const router={get:(path,fn)=>{handlers[path]=fn;},post:()=>{}};
  const query=jest.fn(async()=>({rows:[{cliente_id:'C-1007',nombre:'Ana',estado:'activo',revision:1}]}));
  crmRoutes(router,{query},'2026-11-18',()=>{});
  const json=jest.fn();
  await handlers['/admin/clientes']({query:{q:' Ana ',offset:'25',limit:'10',refs:'C-1001,C-1007'}},{json});
  expect(query).toHaveBeenCalledWith(expect.stringContaining('ref=ANY($4::text[])'),[10,25,'Ana',['C-1001','C-1007']]);
  expect(json).toHaveBeenCalledWith([{cliente_id:'C-1007',nombre:'Ana',estado:'activo',revision:1}]);
  await expect(handlers['/admin/clientes']({query:{refs:'C-1001,unexpected'}},{json})).rejects.toThrow();
});
