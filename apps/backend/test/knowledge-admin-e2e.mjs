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
assert.ok(['extractive','guided'].includes(nov.mode));
assert.ok(['extractive','guided'].includes(dec.mode));
assert.ok(nov.citations.some(item=>item.version==='CAT-2026 v1.0'));
assert.ok(dec.citations.some(item=>item.version==='CAT-2026 v2.0'));
assert.ok(nov.retrieved.length<=5 && dec.retrieved.length<=5);
const decoder=await ask('Me sale error E-202 en el decodificador. ¿Cómo refresco la señal?','2026-11-23','cliente','telegram');
assert.match(decoder.answer,/refresc/i);
if (decoder.search.revision!=='legacy') {
  assert.ok(decoder.search.tags.includes('e-202'));
  const citation=decoder.citations.find(item=>item.source?.key==='faq');
  assert.ok(citation,'E-202 cites the reviewed FAQ with a platform source reference');
  const path=`/api/v1/knowledge/sources/${citation.source.publication}`;
  const view=await json(path+'/faq');
  assert.ok(view.sections.some(section=>section.id===citation.id && /E-202/.test(section.title)));
  const pdf=await call(path+'/faq/document');
  assert.equal(pdf.headers.get('content-type'),'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
  await call(path+'/retencion',{status:404});
  await call(path+'/catalogo-v2/document',{status:404});
}
const advisorOnly='En el incidente de fibra en Chapinero, ¿qué dice el boletín sobre compensación?';
const publicResult=await ask(advisorOnly,'2026-11-23');
const staffResult=await ask(advisorOnly,'2026-11-23','asesor');
assert.ok(!publicResult.retrieved.some(item=>item.id.startsWith('boletin-incidente')));
assert.ok(staffResult.retrieved.some(item=>item.id.startsWith('boletin-incidente')));
const retention='Política de retención de clientes';
const staffPolicy=await ask(retention,'2026-11-23','asesor');
const targeted=await ask('¿Qué requisitos hay para retención?','2026-11-23','asesor');
assert.equal(targeted.search.source,'retencion');
assert.ok(targeted.search.tags.includes('elegibilidad'));
assert.equal(targeted.citations[0].id,'retencion-003');
const publicPolicy=await ask(retention,'2026-11-23');
assert.match(staffPolicy.answer,/mora mayor a 30 días/);
assert.ok(staffPolicy.retrieved.every(item=>item.version==='POL-RET-2026 v3.1'));
assert.equal(publicPolicy.answer,null);
assert.deepEqual(publicPolicy.retrieved,[]);
const plans=await ask('¿Qué planes tienen?','2026-11-23','cliente');
assert.equal(plans.mode,'guided');
assert.match(plans.answer,/hogar.*móvil.*¿Cuál/);
assert.doesNotMatch(plans.answer,/\$|Mbps/);
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

const fresh=await call('/api/v1/web-chat/session/new',{cookie:visitor,body:{}});
const nextVisitor=fresh.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ');
assert.notEqual((await fresh.json()).conversation_id,verified.conversation_id);
const sendNext=text=>json('/api/v1/web-chat/messages',{cookie:nextVisitor,body:{text,idempotency_key:randomUUID()}});
const readNext=()=>json('/api/v1/web-chat/history',{cookie:nextVisitor});
const asking=await sendNext('Quiero cancelar el servicio.');
assert.match(asking.messages.at(-1).text,/qué te lleva a cancelar/i);
assert.equal(asking.verification.stage,'idle');
const clarified=await sendNext('Porque está muy caro.');
assert.equal(clarified.verification.stage,'required');
await sendNext('Mi teléfono de prueba es 11003.');
const queued=await sendNext('El código que me pidieron es 123456.');
assert.equal(queued.verification.stage,'verified');
assert.equal(queued.awaiting_advisor,true);
const fromQueue=(await json('/api/v1/cases',{cookie:advisor})).find(item=>item.conversation_id===queued.conversation_id);
assert.match(fromQueue.handoff_reason,/cancelar el servicio/);
assert.match(fromQueue.handoff_reason,/precio/i);
assert.ok(!('handoff_reason' in queued));
const preview=await json(`/api/v1/cases/${fromQueue.id}`,{cookie:advisor});
assert.match(preview.handoff_reason,/cancelar el servicio/);
assert.deepEqual(preview.messages,[]);
assert.equal(preview.card,null);
assert.ok(!('ml' in preview));
assert.ok(!('intake' in preview));
await call(`/api/v1/cases/${fromQueue.id}`,{cookie:admin,status:404});
const assigned=await json(`/api/v1/cases/${fromQueue.id}/take`,{cookie:advisor,body:{}});
assert.match(assigned.handoff_reason,/cancelar el servicio/);
assert.equal(assigned.intake.facts.motivo,'Precio u otra oferta');
const following=await readNext();
assert.equal(following.conversation_id,queued.conversation_id);
assert.equal(following.awaiting_advisor,false);
assert.equal(following.attention_mode,'asistido');
assert.ok(!following.messages.some(message=>message.actor==='asesor'));
let cancellation;
for (let attempt=0;attempt<35;attempt++) {
  cancellation=await json(`/api/v1/cases/${fromQueue.id}`,{cookie:advisor});
  if (cancellation.card && cancellation.ml?.churn?.status==='available') break;
  await wait(350);
}
assert.ok(cancellation.card?.reason_codes.includes('retention_ineligible'));
assert.equal(cancellation.ml.churn.status,'available');

const reference=await call('/api/v1/web-chat/session/new',{cookie:visitor,body:{}});
const referenceCookie=reference.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ');
const sendReference=text=>json('/api/v1/web-chat/messages',{cookie:referenceCookie,body:{text,idempotency_key:randomUUID()}});
const expectAnswer=async(pattern)=>{
  for(let i=0;i<36;i++) {
    const history=await json('/api/v1/web-chat/history',{cookie:referenceCookie});
    const last=history.messages.at(-1);
    if (last?.actor==='agente' && pattern.test(last.text)) return last;
    await wait(250);
  }
  assert.fail(`Expected TRX-0012 answer ${pattern}`);
};
const hello=await sendReference('Hola, soy Cliente de Prueba');
assert.match(hello.messages.at(-1).text,/en qué te puedo ayudar/);
assert.doesNotMatch(JSON.stringify(hello),/soy Cliente/);
const identification=await sendReference('11111');
assert.equal(identification.verification.stage,'code_sent');
const identified=await sendReference('Mi código es 651409');
assert.equal(identified.verification.stage,'verified');
assert.equal(identified.awaiting_advisor,false);
await sendReference('Quiero saber qué incluye el plan Ilimitado.');
const unlimited=await expectAnswer(/Claro Max Ilimitado cuesta/);
assert.match(unlimited.text,/99\.900.*150 GB.*1 Mbps/);
assert.doesNotMatch(unlimited.text,/49\.900|69\.900|25 GB|60 GB/);
assert.ok(unlimited.text.length<=340 && unlimited.citations.some(c=>c.id.startsWith('catalogo')));
await sendReference('Bueno, me sirve. ¿Lo puedo cambiar ya?');
const change=await expectAnswer(/sin costo.*siguiente ciclo de facturación/);
assert.ok(change.citations.some(c=>c.id.startsWith('faq-')));
const handoffPlan=await sendReference('Hágale.');
assert.equal(handoffPlan.awaiting_advisor,true);
assert.match(handoffPlan.messages.at(-1).text,/un asesor.*tramitar el cambio/);
console.log(`${inventory.indexed_count} passages, verified original, dates, audience, lab isolation, web OTP, private case and ML metrics passed (${nov.transport}, pgvector ${nov.pgvector}).`);
