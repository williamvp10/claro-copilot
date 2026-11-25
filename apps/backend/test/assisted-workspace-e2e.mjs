import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

const origin=new URL(process.env.BETTER_AUTH_URL);
const target=process.env.PLATFORM_E2E_TARGET ?? origin;
assert.ok(['localhost','127.0.0.1'].includes(origin.hostname) && process.env.DEMO_MODE==='true','Use a seeded loopback demo');

async function http(path,{cookie,body,status=body===undefined ? 200 : 201}={}) {
  const response=await fetch(new URL(path,target),{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(12000),
    headers:{Origin:origin.origin,...cookie?{Cookie:cookie}:{},...body===undefined?{}:{'Content-Type':'application/json'}},
    body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();
  assert.equal(response.status,status,`${path}: ${JSON.stringify(data.message ?? data.status)}`);
  return {data,cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};
}
const get=(cookie,path,status)=>http(`/api/v1${path}`,{cookie,status}).then(result=>result.data);
const post=(cookie,path,body,status)=>http(`/api/v1${path}`,{cookie,body,status}).then(result=>result.data);
const operator=async role=>(await http('/api/auth/sign-in/email',{status:200,
  body:{email:process.env[`DEMO_${role}_EMAIL`],password:process.env[`DEMO_${role}_PASSWORD`]}})).cookie;
const message=(cookie,text)=>post(cookie,'/web-chat/messages',{text,idempotency_key:randomUUID()});
async function until(read) {
  for (let attempt=0;attempt<80;attempt++) {
    const data=await read();
    if (data) return data;
    await wait(200);
  }
  throw new Error('The assisted summary did not publish');
}

const [n1,admin]=await Promise.all([operator('ASESSOR'),operator('ADMIN')]);
const start=()=>http('/api/v1/web-chat/session',{body:{}});
const first=await start();
const second=await start();
assert.equal((await message(first.cookie,'Quiero hablar con un asesor.')).attention.stage,'waiting');
await wait(30);
await message(second.cookie,'Me pasas con un asesor, por favor.');
await message(first.cookie,'Mi módem sigue con la luz LOS roja después de revisar el cable.');

const inbox=await get(n1,'/cases?view=inbox');
const ordered=inbox.available.filter(item=>[first.data.conversation_id,second.data.conversation_id].includes(item.conversation_id));
assert.deepEqual(ordered.map(item=>item.conversation_id),[first.data.conversation_id,second.data.conversation_id]);
assert.ok(ordered.every(item=>item.last_message===null && item.messages===undefined && item.card===undefined));
const [waiting]=ordered;
const casePath=`/cases/${waiting.id}`;
await get(admin,casePath,404);
const taken=await post(n1,casePath+'/take',{});
assert.equal(taken.messages.at(-1).attention_notice,'assigned');
assert.equal((await post(n1,casePath+'/take',{})).messages.filter(item=>item.attention_notice==='assigned').length,1);

const reason='La luz LOS sigue roja después de verificar el cable. Falta revisar la conexión.';
const request={destination:'soporte_tecnico',reason_text:reason,case_revision:taken.revision,idempotency_key:randomUUID()};
const created=await post(n1,casePath+'/escalations',request);
assert.equal((await post(n1,casePath+'/escalations',request)).id,created.id);
assert.equal((await get(first.cookie,'/web-chat/history')).attention.stage,'escalated');
await post(n1,casePath+'/messages',{text:'Envío que debe rechazarse',idempotency_key:randomUUID()},409);
await message(first.cookie,'El servicio volvió unos minutos, pero volvió a caer.');
const queue=(await get(admin,'/escalations')).find(item=>item.id===created.id);
assert.ok(queue.can_claim);
assert.equal(queue.reason_text,undefined);
await post(admin,`/escalations/${created.id}/claim`,{case_revision:queue.case_revision});
const claimed=await get(admin,casePath);
assert.equal(claimed.tracking.escalation.reason_text,reason);
assert.ok(claimed.messages.some(item=>item.text.includes('volvió unos minutos')));
await get(n1,casePath,404);
const client=await get(first.cookie,'/web-chat/history');
assert.equal(client.attention.stage,'assigned');
assert.equal(client.attention.advisor_name,(await get(admin,'/me')).name);
assert.deepEqual(client.messages.flatMap(item=>item.attention_notice ?? []),['assigned','escalated','escalation_taken']);
assert.ok(!JSON.stringify(client).includes(reason));
await until(async()=>{
  const current=await get(admin,casePath);
  return current.card?.summary_update?.revision===claimed.revision && current.card.advisor_draft;
});
await post(admin,casePath+'/messages',{text:'Voy a continuar con la revisión técnica de tu conexión.',idempotency_key:randomUUID()});
assert.equal((await get(first.cookie,'/web-chat/history')).messages.at(-1).actor,'asesor');

const alternate=ordered[1];
const registrationPath=`/cases/${alternate.id}/customer-registration`;
await message(second.cookie,'El módem tiene la luz LOS roja y ya revisé el cable.');
const alternateTaken=await post(n1,`/cases/${alternate.id}/take`,{});
const identity={tipo_documento:'CC',numero_documento:`demo-${randomUUID()}`,case_revision:alternateTaken.revision};
await post(admin,registrationPath,{...identity,action:'lookup'},404);
assert.equal((await post(n1,registrationPath,{...identity,action:'lookup'})).status,'missing');
const registration={...identity,action:'create',cliente_id:`C-${randomInt(4000,9999)}`,nombre:'Cliente sintético de atención',
  celular:`310${randomInt(1000000,9999999)}`,email:`atencion-${randomUUID()}@example.test`,motivo:'Alta de prueba',idempotency_key:randomUUID()};
const registered=await post(n1,registrationPath,registration);
assert.deepEqual(await post(n1,registrationPath,registration),registered);
const alternateCase=await get(n1,`/cases/${alternate.id}`);
assert.equal(alternateCase.id,alternate.id);
assert.equal(alternateCase.customer_registration.customer_ref,registration.cliente_id);
assert.equal(alternateCase.verified,false);
await until(async()=>{
  const current=await get(n1,`/cases/${alternate.id}`);
  return current.card?.summary_update?.revision===alternateCase.revision && current.card.advisor_draft;
});
await get(n1,`/cases/${alternate.id}/integrations/billing`,403);
assert.equal((await get(second.cookie,'/web-chat/history')).verification.stage,'required');
const challenge=await post(second.cookie,'/web-chat/verification/start',{identifier:registration.email});
const verified=await post(second.cookie,'/web-chat/verification/confirm',{
  challenge_id:challenge.verification.challenge_id,code:process.env.DEMO_HOLDER_CODE
});
assert.equal(verified.verification.stage,'verified');
const crm=await get(n1,`/cases/${alternate.id}/integrations/crm`);
assert.equal(crm.customer.cliente_id,registration.cliente_id);
await get(n1,`/cases/${alternate.id}/integrations/billing`,404);
console.log('Bandeja por llegada, traspaso exclusivo, avisos web, toma de nivel 2, borrador privado y alta CRM verificados.');
