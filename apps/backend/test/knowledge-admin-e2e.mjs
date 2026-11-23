import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

const origin=process.env.BETTER_AUTH_URL;
const base=process.env.PLATFORM_E2E_TARGET??origin;
assert.ok(base && origin && process.env.DEMO_MODE==='true','Run on a seeded local demo with the reviewed corpus');
const route='/api/v1/admin/knowledge';

async function call(path,{cookie,body,status=body===undefined?200:201}={}) {
  const response=await fetch(new URL(path,base),{method:body===undefined?'GET':'POST',
    headers:{Origin:origin,...cookie&&{Cookie:cookie},...body&&{'Content-Type':'application/json'}},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  assert.equal(response.status,status,`${path}: ${response.status===status?'':await response.text()}`);
  return response;
}
const json=async(path,options)=>(await call(path,options)).json();
async function login(role) {
  const response=await call('/api/auth/sign-in/email',{status:200,body:{
    email:process.env[`DEMO_${role}_EMAIL`],password:process.env[`DEMO_${role}_PASSWORD`]
  }});
  return response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
}
const [admin,advisor]=await Promise.all([login('ADMIN'),login('ASESSOR')]);
const auth={cookie:admin};
await call(route+'/publications',{status:401});
await call(route+'/publications',{cookie:advisor,status:403});
const inventory=await json(route+'/publications',auth);
const publication=inventory.publications.find(item=>item.stage==='current');
assert.ok(publication?.files.length>=14);
assert.ok(inventory.indexed_count>=90);
const source=publication.files.find(item=>item.key==='catalogo-v2');
assert.match(source.file_name,/\.pdf$/i);
const filePath=`${route}/publications/${publication.sha256}/sources/${source.key}`;
const passages=await json(filePath+'/passages',auth);
assert.equal(passages.length,source.passage_count);
assert.ok(passages.every(item=>item.citation?.version===source.version));
await call(filePath+'/original',{cookie:advisor,status:403});
const download=await call(filePath+'/original',auth);
assert.match(download.headers.get('content-disposition'),/^attachment/);
assert.equal(createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex'),source.sha256);

const before=await json('/api/v1/cases',{cookie:advisor});
const ask=(question,business_date,audience='cliente',channel='web',mode='extractive')=>json(route+'/lab/query',{
  ...auth,body:{question,business_date,audience,channel,mode}
});
const nov=await ask('¿Cuánto cuesta el plan Hogar Fibra 500?','2026-11-30');
const dec=await ask('¿Cuánto cuesta el plan Hogar Fibra 500?','2026-12-01');
assert.ok(nov.revision&&dec.revision);
assert.equal(nov.mode,'extractive');
assert.equal(dec.mode,'extractive');
assert.ok(nov.citations.some(item=>item.version==='CAT-2026 v1.0'));
assert.ok(dec.citations.some(item=>item.version==='CAT-2026 v2.0'));
assert.ok(nov.retrieved.length<=5 && dec.retrieved.length<=5);
const decoder=await ask('Me sale error E-202 en el decodificador. ¿Cómo refresco la señal?','2026-11-23','cliente','telegram');
assert.match(decoder.answer,/refresc/i);
const advisorOnly='En el incidente de fibra en Chapinero, ¿qué dice el boletín sobre compensación?';
const publicResult=await ask(advisorOnly,'2026-11-23');
const staffResult=await ask(advisorOnly,'2026-11-23','asesor');
assert.ok(!publicResult.retrieved.some(item=>item.id.startsWith('boletin-incidente')));
assert.ok(staffResult.retrieved.some(item=>item.id.startsWith('boletin-incidente')));
assert.equal((await ask('asdfghjkl zxcvbnm qwertyuiop','2026-11-23')).reason,'no_evidence');
assert.equal((await ask('¿Cuánto cuesta Fibra 500?','2026-12-01','asesor','web','openai')).reason,'generation_disabled');
assert.deepEqual((await json('/api/v1/cases',{cookie:advisor})).map(item=>item.id),before.map(item=>item.id));

const web=await call('/api/v1/web-chat/session',{body:{}});
const visitor=web.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ');
const send=text=>json('/api/v1/web-chat/messages',{cookie:visitor,body:{text,idempotency_key:randomUUID()}});
await send('Quiero consultar mi factura');
await send('Mi número de prueba es 11111.');
const verified=await send('Mi código es 729 413.');
assert.equal(verified.verification.stage,'verified');
await send('Quiero hablar con un asesor.');
const summary=(await json('/api/v1/cases',{cookie:advisor})).find(item=>item.conversation_id===verified.conversation_id);
assert.ok(summary);
await call(`/api/v1/cases/${summary.id}/take`,{cookie:advisor,body:{}});
let snapshot;
for (let attempt=0;attempt<45;attempt++) {
  snapshot=await json(`/api/v1/cases/${summary.id}`,{cookie:advisor});
  if (snapshot.card && snapshot.ml?.churn?.status==='available') break;
  await wait(350);
}
assert.ok(snapshot.card);
assert.equal(snapshot.ml.churn.status,'available');
const metrics=await json('/api/v1/admin/metrics/machine-learning',auth);
assert.ok(metrics.metrics.find(item=>item.id==='intent_f1')?.value>0);
assert.ok(metrics.metrics.find(item=>item.id==='churn_auc')?.value>0);
console.log(`${inventory.indexed_count} passages, verified original, dates, audience, lab isolation, web OTP, private case and ML metrics passed (${nov.transport}, pgvector ${nov.pgvector}).`);
