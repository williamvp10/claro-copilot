import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { Client } from 'pg';

const origin = process.env.BETTER_AUTH_URL;
const target = process.env.PLATFORM_E2E_TARGET ?? origin;
if (!origin || process.env.DEMO_MODE!=='true') throw new Error('Run on a seeded test system');
const db = new Client({connectionString:process.env.DATABASE_URL});
await db.connect();

async function http(path, {cookie,data,method='GET',status=200,token,endpoint=target}={},attempt=0) {
  const response = await fetch(endpoint+path,{
    method,headers:{Origin:origin,...cookie&&{Cookie:cookie},...token&&{Authorization:'Bearer '+token},
      ...data&&{'Content-Type':'application/json'}},body:data&&JSON.stringify(data),signal:AbortSignal.timeout(7000)
  });
  if (path==='/api/auth/sign-in/email' && response.status===429 && attempt<3) {
    await response.body?.cancel();
    await wait(11000);
    return http(path,{cookie,data,method,status,token,endpoint},attempt+1);
  }
  const body = await response.json();
  assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(body)}`);
  return {body, cookie:response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ')};
}
const api = '/api/v1';
const get = (cookie,path,status) => http(api+path,{cookie,status});
const write = (cookie,path,data,status=201,method='POST') => http(api+path,{cookie,data,method,status});
const signIn = async (email,password) => (await http('/api/auth/sign-in/email',{
  method:'POST',data:{email,password}
})).cookie;
const account = role => signIn(process.env['DEMO_'+role+'_EMAIL'],process.env['DEMO_'+role+'_PASSWORD']);
const ingress = (contact_ref,text) => http(api+'/demo/incoming',{
  method:'POST',token:process.env.DEMO_INGRESS_TOKEN,status:201,
  data:{contact_ref,text,idempotency_key:randomUUID()}
});
async function until(check, label) {
  for (let index=0;index<100;index++) {
    const value=await check();
    if (value) return value;
    await wait(120);
  }
  throw new Error('Timeout: '+label);
}

async function assertDirectoryBilling(admin, advisor) {
  const customerPath = '/crm/customers/C-1001';
  const billingPath = customerPath + '/billing';

  const page = (await get(admin, '/crm/customers?offset=0&limit=1')).body;
  assert.deepEqual(page.map(row => row.cliente_id), ['C-1001']);
  const nextPage = (await get(admin, '/crm/customers?offset=1&limit=1')).body;
  assert.equal(nextPage.length, 1);
  assert.notEqual(nextPage[0].cliente_id, page[0].cliente_id);
  const query = encodeURIComponent(page[0].nombre);
  assert.ok((await get(admin, `/crm/customers?q=${query}`)).body.some(row => row.cliente_id === 'C-1001'));

  const { customer } = (await get(admin, customerPath)).body;
  assert.equal(customer.cliente_id, 'C-1001');
  assert.match(customer.email, /^\*{3}.{0,3}$/);
  assert.match(customer.celular, /^\*{3}.{0,3}$/);
  assert.ok(customer.servicios.length > 0);

  assert.equal((await get(admin, '/me')).body.can_read_mock_billing, true);
  assert.equal((await get(advisor, '/me')).body.can_read_mock_billing, false);
  const { balance, invoices } = (await get(admin, billingPath)).body;
  assert.equal(balance.cliente_id, 'C-1001');
  assert.equal(invoices.length, 3);
  assert.ok(invoices.every(invoice => invoice.cliente_id === 'C-1001'));
  const invoicePath = billingPath + '/invoices/' + invoices[0].factura_id;
  const invoice = (await get(admin, invoicePath)).body;
  assert.ok(invoice.detalle.length > 0);
  assert.ok(invoice.ajustes.every(adjustment => !Object.hasOwn(adjustment, 'aprobado_por')));
  const crossAccount = await get(admin, invoicePath.replace('C-1001', 'C-1004'), 404);
  const missingInvoice = await get(admin, billingPath + '/invoices/F-9999999999', 404);
  assert.deepEqual(crossAccount.body, missingInvoice.body);
  await get(admin, billingPath + '/invoices/invalid', 400);
  for (const path of [billingPath, invoicePath]) {
    await get(undefined, path, 401);
    await get(advisor, path, 403);
  }

  const nonDemoTarget = process.env.PLATFORM_NON_DEMO_E2E_TARGET;
  if (nonDemoTarget) {
    const read = (cookie, path, status) => http(api + path, { cookie, status, endpoint: nonDemoTarget });
    assert.equal((await read(admin, '/me')).body.can_read_mock_billing, false);
    assert.equal((await read(admin, '/me')).body.can_manage_administration, false);
    await read(admin, billingPath, 403);
    await read(admin, invoicePath, 403);
    await read(admin, '/admin/operators', 403);
    assert.deepEqual((await read(admin, '/crm/customers?q=C-1001')).body, []);
  }
}

async function main() {
  const [admin,n1,n2,supervisor] = await Promise.all(
    ['ADMIN','ASESSOR','N2','SUPERVISOR'].map(account)
  );
  await assertDirectoryBilling(admin, n1);
  if (process.argv.includes('--directory-only')) {
    console.log('CRM directory and account billing verified through authenticated HTTP.');
    return;
  }

  const groupIds=['negocio','calidad-llm','tecnica','agentes','machine-learning','devops'];
  for (const group of groupIds) {
    const {body} = await get(admin,`/admin/metrics/${group}?days=7&channel=telegram`);
    assert.equal(body.group,group);
    assert.equal(body.filters.timezone,'America/Bogota');
    assert.ok(body.metrics.every(metric=>metric.status==='measured' ? Number.isFinite(metric.value) : metric.value===null));
  }
  await get(n1,'/admin/metrics/negocio',403);
  // This is a test fixture, not evidence of a real build or deployment.
  const syntheticDigest='sha256:'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
  const syntheticRelease={
    sha:randomUUID().replaceAll('-','').slice(0,40).padEnd(40,'a'),digest:syntheticDigest,component:'claro-copiloto',
    workflow_url:'https://github.com/example/synthetic-fixture/actions/runs/1',ci:'passed',coverage_pct:73,
    bytes:123456,critical:0,scanned_at:new Date().toISOString(),commit_at:new Date().toISOString(),
    smoke:'pending',smoke_verified_at:null
  };
  try {
    await write(n1,'/admin/releases/evidence',syntheticRelease,403);
    assert.equal((await write(admin,'/admin/releases/evidence',syntheticRelease)).body.accepted,true);
    const {body:devops}=await get(admin,`/admin/metrics/devops?days=7&digest=${encodeURIComponent(syntheticDigest)}`);
    const release=devops.supporting.releases.find(item=>item.digest===syntheticDigest);
    assert.ok(release,'Synthetic evidence should round-trip through authenticated HTTP');
    for (const [key,value] of Object.entries(syntheticRelease)) assert.deepEqual(release[key],value,`evidence ${key}`);
    assert.equal(devops.metrics.find(metric=>metric.id==='coverage').value,73);
    assert.equal(devops.metrics.find(metric=>metric.id==='critical_claro-copiloto').value,0);
    assert.equal(devops.metrics.find(metric=>metric.id==='image_size_claro-copiloto').value,123456);
    assert.equal(devops.metrics.find(metric=>metric.id==='lead_time_claro-copiloto').value,null);
  } finally {
    await db.query('DELETE FROM release_metric WHERE digest=$1',[syntheticDigest]);
  }

  const {body:revisions}=await get(admin,'/admin/prompts');
  const active=revisions.find(row=>row.activated);
  assert.equal(Object.keys(active.manifest).length,12);
  assert.ok(active.prompts.intent_decision);
  const candidate=(await write(admin,'/admin/prompts',{prompts:{advisor_empathy:'Lamento que estés pasando por {{reported_issue}}.'}})).body;
  assert.deepEqual(candidate.changed_keys,['advisor_empathy']);
  assert.equal(candidate.base_revision,active.revision);
  await write(admin,`/admin/prompts/${candidate.revision}/activate`,undefined,403);
  await write(admin,`/admin/prompts/${candidate.revision}/rollback`,undefined,403);
  await write(admin,'/admin/prompts',{prompts:{advisor_empathy:'Texto sin variable'}},400);
  assert.equal((await get(admin,'/admin/prompts')).body.find(row=>row.activated).revision,active.revision);

  await get(n1,'/admin/operators',403);
  const newOperator=(await write(admin,'/admin/operators',{
    name:'Segundo N2 de prueba',email:`n2-${randomUUID()}@example.test`,password:'Synthetic-operation-123',
    capabilities:['n2'],specialties:['soporte_tecnico'],enabled:true,available:true
  })).body;
  const otherN2=await signIn(newOperator.email,'Synthetic-operation-123');
  const crm=(await get(admin,'/crm/customers?q=C-1007')).body;
  assert.deepEqual(crm.map(row=>row.cliente_id),['C-1007']);
  await get(n2,'/crm/customers/C-1007',404);
  const {body:support} = await get(n1,'/cases');
  const scenario=support.find(row=>row.display_name==='Cliente C-1013');
  assert.ok(scenario,'Run the platform E2E suite with the support scenario first');
  await ingress('C-1013','La luz LOS está roja desde hace 15 minutos.');
  const suggested = await until(async()=>{
    const {body}=await get(n1,`/cases/${scenario.id}`);
    return body.card?.suggested_escalation?.destination==='soporte_tecnico' ? body : null;
  },'policy suggestion and private card');
  assert.ok(suggested.verified);
  await get(n2,`/cases/${scenario.id}`,404);
  const escalationRequest={
    destination:'soporte_tecnico',reason_code:suggested.card.suggested_escalation.reason_code,
    reason_text:'La luz LOS sigue roja y requiere una revisión técnica.',
    case_revision:suggested.revision,idempotency_key:randomUUID()
  };
  const escalated=(await write(n1,`/cases/${scenario.id}/escalations`,escalationRequest)).body;
  assert.equal((await write(n1,`/cases/${scenario.id}/escalations`,escalationRequest)).body.id,escalated.id);
  assert.equal((await get(admin,'/escalations')).body.find(row=>row.id===escalated.id)?.can_claim,true);
  assert.equal((await get(admin,'/escalations')).body.find(row=>row.id===escalated.id)?.reason_text,undefined);
  await write(n1,`/cases/${scenario.id}/messages`,{text:'No se debe enviar durante la espera.',idempotency_key:randomUUID()},409);
  const claim = (cookie) => fetch(target+`${api}/escalations/${escalated.id}/claim`,{
    method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({case_revision:escalated.case_revision})
  }).then(response=>({cookie,status:response.status}));
  const results=await Promise.all([claim(n2),claim(otherN2)]);
  assert.deepEqual(results.map(entry=>entry.status).sort(),[201,409]);
  const winner=results.find(entry=>entry.status===201).cookie;
  const handoff=(await get(winner,`/cases/${scenario.id}`)).body;
  assert.equal(handoff.revision,escalated.case_revision+1);
  assert.deepEqual(handoff.messages.filter(item=>!item.attention_notice),suggested.messages.filter(item=>!item.attention_notice));
  assert.deepEqual(handoff.messages.slice(-2).map(item=>item.attention_notice),['escalated','escalation_taken']);
  assert.equal(handoff.tracking.escalation.reason_text,escalationRequest.reason_text);
  await get(n1,`/cases/${scenario.id}`,404);
  await get(supervisor,`/cases/${scenario.id}`,404);

  const after=(await write(winner,`/cases/${scenario.id}/messages`,{
    text:'Estoy revisando las luces del módem contigo.',idempotency_key:randomUUID()
  })).body;
  await ingress('C-1013','¿Cómo reinicio el módem de fibra?');
  const draft=await until(async()=>{
    const {body}=await get(winner,`/cases/${scenario.id}`);
    return body.card?.advisor_draft_status==='current' && body.card.advisor_draft ? body : null;
  },'fresh private draft');
  assert.equal(draft.revision,after.revision);
  const reference={run_id:draft.card.advisor_draft_run_id,case_revision:draft.revision};
  const event={...reference,event_id:randomUUID(),kind:'used'};
  await write(n1,`/cases/${scenario.id}/draft-events`,event,404);
  await write(winner,`/cases/${scenario.id}/draft-events`,event);
  await write(winner,`/cases/${scenario.id}/draft-events`,event);
  await write(winner,`/cases/${scenario.id}/draft-events`,{...reference,event_id:randomUUID(),kind:'feedback_positive'});
  await write(winner,`/cases/${scenario.id}/messages`,{draft:reference,text:draft.card.advisor_draft,idempotency_key:randomUUID()});
  await write(winner,`/cases/${scenario.id}/draft-events`,{...reference,event_id:randomUUID(),kind:'edited'},409);
  const {rows} = await db.query('SELECT kind,count(*)::int AS n FROM draft_event WHERE run_id=$1 GROUP BY kind',[reference.run_id]);
  assert.deepEqual(Object.fromEntries(rows.map(row=>[row.kind,row.n])),{used:1,feedback_positive:1,sent:1});
  const metrics=(await get(admin,'/admin/metrics/calidad-llm')).body;
  assert.equal(metrics.metrics.find(m=>m.id==='advisor_feedback').value,100);
  // Continue on the same synthetic case: all handoffs preserve the original thread.
  const n1Id=(await get(n1,'/me')).body.id;
  let current=(await get(winner,`/cases/${scenario.id}`)).body;
  const reassign=async (escalationId,revision,recipient=n1Id) => write(supervisor,`/escalations/${escalationId}/reassign`,{
    case_revision:revision,operator_id:recipient,reason:'Prueba operativa sintetica'
  });
  await reassign(escalated.id,current.revision);
  current=(await get(n1,`/cases/${scenario.id}`)).body;
  await write(n1,`/escalations/${escalated.id}/resolve`,{case_revision:current.revision});
  const createdSpecialists=[];
  for (const specialty of ['facturacion','comercial_portabilidad']) {
    const created=(await write(admin,'/admin/operators',{
      name:`Especialista ${specialty} de prueba`,email:`${specialty}-${randomUUID()}@example.test`,password:'Synthetic-operation-123',
      capabilities:['n2'],specialties:[specialty],enabled:true,available:true
    })).body;
    createdSpecialists.push(created);
    const specialist=await signIn(created.email,'Synthetic-operation-123');
    current=(await get(n1,`/cases/${scenario.id}`)).body;
    const transfer=(await write(n1,`/cases/${scenario.id}/escalations`,{
      destination:specialty,reason_code:'revision_especializada',case_revision:current.revision,idempotency_key:randomUUID()
    })).body;
    assert.equal((await get(n1,`/cases/${scenario.id}`)).body.owner_id,n1Id);
    const specialistQueue=(await get(specialist,'/escalations')).body;
    const queued=specialistQueue.find(item=>item.id===transfer.id);
    assert.equal(queued.destination,specialty);
    assert.equal(queued.case_revision,transfer.case_revision);
    assert.equal(queued.messages,undefined);
    assert.ok(!(await get(otherN2,'/escalations')).body.some(item=>item.id===transfer.id));
    await get(specialist,`/cases/${scenario.id}`,404);
    await write(otherN2,`/escalations/${transfer.id}/claim`,{case_revision:transfer.case_revision},409);
    await write(specialist,`/escalations/${transfer.id}/claim`,{case_revision:transfer.case_revision});
    await get(n1,`/cases/${scenario.id}`,404);
    const assigned=(await get(specialist,`/cases/${scenario.id}`)).body;
    assert.equal(assigned.owner_id,created.id);
    assert.equal(assigned.conversation_id,suggested.conversation_id);
    assert.ok(assigned.messages.length>=suggested.messages.length);
    const status=(await get(n1,'/escalations')).body.find(item=>item.id===transfer.id);
    assert.equal(status.status,'tomado');
    const forwarded=(await write(specialist,`/cases/${scenario.id}/escalations`,{
      destination:'supervision',reason_code:'revision_politica',case_revision:assigned.revision,idempotency_key:randomUUID()
    })).body;
    await get(supervisor,`/cases/${scenario.id}`,404);
    const review=(await write(supervisor,`/cases/${scenario.id}/review`,{scope:'summary',reason:'Revision sintetica'})).body;
    assert.equal(review.id,scenario.id);
    assert.equal(review.messages,undefined);
    const supervisorQueue=(await get(supervisor,'/escalations')).body.find(item=>item.id===forwarded.id);
    assert.equal(supervisorQueue.destination,'supervision');
    await write(supervisor,`/escalations/${forwarded.id}/claim`,{case_revision:forwarded.case_revision});
    const supervised=(await get(supervisor,`/cases/${scenario.id}`)).body;
    assert.equal(supervised.conversation_id,suggested.conversation_id);
    await reassign(forwarded.id,supervised.revision);
    current=(await get(n1,`/cases/${scenario.id}`)).body;
    await write(n1,`/escalations/${forwarded.id}/resolve`,{case_revision:current.revision});
  }
  current=(await get(n1,`/cases/${scenario.id}`)).body;
  const cancelled=(await write(n1,`/cases/${scenario.id}/escalations`,{
    destination:'soporte_tecnico',reason_code:'cancelacion_prueba',case_revision:current.revision,idempotency_key:randomUUID()
  })).body;
  assert.ok((await get(admin,'/escalations')).body.some(item=>item.id===cancelled.id));
  const restored=(await write(n1,`/escalations/${cancelled.id}/cancel`,{case_revision:cancelled.case_revision})).body;
  await write(otherN2,`/escalations/${cancelled.id}/claim`,{case_revision:restored.case_revision},409);

  // A dedicated mock customer exercises directory permissions, revision fencing and idempotency.
  let customerRef;
  for (let index=0;index<100;index++) {
    const ref='C-'+String(8000+Math.floor(Math.random()*1000));
    if (!(await get(admin,`/crm/customers?q=${ref}`)).body.some(item=>item.cliente_id===ref)) { customerRef=ref; break; }
  }
  assert.ok(customerRef,'Need an unused synthetic customer id');
  const key=randomUUID(),suffix=randomUUID().slice(0,8),name=`Cliente sintetico ${suffix}`;
  const createCustomer={cliente_id:customerRef,nombre:name,tipo_documento:'CC',numero_documento:`test-${suffix}`,
    celular:`9${Date.now()}${Math.floor(Math.random()*100)}`,email:`synthetic-${suffix}@example.test`,motivo:'Alta sintetica',idempotency_key:key};
  await write(admin,'/admin/customers',createCustomer,403);
  const receipt=(await write(admin,'/admin/customers',createCustomer)).body;
  assert.deepEqual((await write(admin,'/admin/customers',createCustomer)).body,receipt);
  assert.equal(receipt.revision,1);
  assert.equal((await get(admin,`/crm/customers?q=${encodeURIComponent(name)}&offset=0&limit=1`)).body[0].cliente_id,customerRef);
  await get(n1,`/crm/customers/${customerRef}`,404);
  assert.match((await get(admin, `/crm/customers/${customerRef}/billing`, 404)).body.message, /no tiene registro/);
  const customer=(await get(admin,`/crm/customers/${customerRef}`)).body;
  assert.notEqual(customer.customer.email,createCustomer.email);
  assert.notEqual(customer.customer.celular,createCustomer.celular);
  assert.ok(Array.isArray(customer.customer.servicios) && Array.isArray(customer.customer.tickets_recientes));
  const update={revision:1,motivo:'Cambio sintetico',nombre:`${name} actualizado`,idempotency_key:randomUUID()};
  await write(n1, `/admin/customers/${customerRef}`, update, 403, 'PATCH');
  assert.equal((await write(admin,`/admin/customers/${customerRef}`,update,200,'PATCH')).body.revision,2);
  await write(admin,`/admin/customers/${customerRef}`,{...update,idempotency_key:randomUUID()},409,'PATCH');
  assert.equal((await get(admin,`/crm/customers/${customerRef}`)).body.customer.nombre,update.nombre);
  const history=(await get(admin,'/crm/customers/C-1013')).body.case_history;
  assert.ok(history.every(row=>row.case_id!==scenario.id));
  assert.ok(history.every(row=>row.messages===undefined && row.card===undefined));
  await get(admin, `/cases/${scenario.id}`, 404);
  const auditRows=(await get(admin,'/admin/audit')).body;
  assert.ok(auditRows.some(row=>row.kind==='customer_created' && row.metadata.customer_ref===customerRef));
  assert.ok(auditRows.some(row=>row.kind==='escalation_claim' && row.case_id===scenario.id));

  const disabled=createdSpecialists[0];
  const oldSession=await signIn(disabled.email,'Synthetic-operation-123');
  await write(admin,`/admin/operators/${disabled.id}`,{
    capabilities:disabled.capabilities,specialties:disabled.specialties,enabled:false,available:false
  },200,'PATCH');
  await get(oldSession,'/me',401);
  // With no available billing specialist, the waiting case remains with N1 and appears to supervision.
  const seededN2=(await get(admin,'/admin/operators')).body.find(operator=>operator.email===process.env.DEMO_N2_EMAIL);
  assert.ok(seededN2);
  const fields=operator=>({capabilities:operator.capabilities,specialties:operator.specialties,enabled:operator.enabled,available:operator.available});
  try {
    await write(admin,`/admin/operators/${seededN2.id}`,{...fields(seededN2),available:false},200,'PATCH');
    current=(await get(n1,`/cases/${scenario.id}`)).body;
    const waiting=(await write(n1,`/cases/${scenario.id}/escalations`,{
      destination:'facturacion',reason_code:'sin_especialista',case_revision:current.revision,idempotency_key:randomUUID()
    })).body;
    assert.ok((await get(supervisor,'/escalations')).body.some(item=>item.id===waiting.id));
    assert.equal((await get(n1,`/cases/${scenario.id}`)).body.owner_id,n1Id);
    await write(n1,`/escalations/${waiting.id}/cancel`,{case_revision:waiting.case_revision});
  } finally {
    await write(admin,`/admin/operators/${seededN2.id}`,fields(seededN2),200,'PATCH');
  }
  const self=(await get(admin,'/me')).body;
  await write(admin,`/admin/operators/${self.id}`,{
    capabilities:[],specialties:[],enabled:false,available:false
  },409,'PATCH');
  console.log('MVP evolution verified through HTTP: metric groups, synthetic release evidence, prompt gates, CRM scope, all escalation queues, CRM and operator administration, and private drafts.');
}

try {
  await main();
} finally {
  await db.end();
}
