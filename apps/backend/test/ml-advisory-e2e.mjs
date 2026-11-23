import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

const origin = process.env.BETTER_AUTH_URL;
const target = process.env.PLATFORM_E2E_TARGET ?? origin;
const ml = process.env.ML_API_URL;
const token = process.env.ML_SERVICE_TOKEN;
if (!origin || !ml || !token || process.env.DEMO_MODE !== 'true') throw new Error('Run on an isolated seeded demo with both bundles');

async function request(path, { cookie, body, status = body === undefined ? 200 : 201 } = {}) {
  const response = await fetch(new URL(path,target), {
    method:body===undefined?'GET':'POST', headers:{Origin:origin,...cookie&&{Cookie:cookie},...body&&{'Content-Type':'application/json'}},
    body:body===undefined?undefined:JSON.stringify(body), signal:AbortSignal.timeout(7000)
  });
  const data=await response.json();
  assert.equal(response.status,status,`${path}: ${JSON.stringify(data)}`);
  return { data,cookie:response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ') };
}
const api='/api/v1';
const login=async role=>(await request('/api/auth/sign-in/email',{status:200,body:{
  email:process.env[`DEMO_${role}_EMAIL`],password:process.env[`DEMO_${role}_PASSWORD`]
}})).cookie;
async function until(read, label) {
  for (let attempt=0;attempt<100;attempt++) {
    const result=await read();
    if (result) return result;
    await wait(150);
  }
  throw new Error(`Timeout: ${label}`);
}
const info=await fetch(new URL('/readyz',ml),{signal:AbortSignal.timeout(7000)}).then(r=>r.json());
assert.equal(info.model_version,'intent-e5-svm-1');
assert.equal(info.churn_model_version,'churn-logistic-1');
assert.equal((await fetch(new URL('/internal/v1/model-metrics',ml))).status,401);

const [advisor,admin,specialist]=await Promise.all(['ASESSOR','ADMIN','N2'].map(login));
const {data:operator}=await request(api+'/me',{cookie:advisor});
const getCase=async id=>(await request(`${api}/cases/${id}`,{cookie:advisor})).data;
const command=(caseId,path,body,status,cookie=advisor)=>request(`${api}/cases/${caseId}/${path}`,{cookie,body:body??{},status});
const dashboard=async (channel='web')=>(await request(`${api}/admin/metrics/machine-learning?channel=${channel}`,{cookie:admin})).data;
const metric=(report,id)=>report.metrics.find(item=>item.id===id);
const count=(report,id)=>metric(report,id)?.value??0;
const baseline=await dashboard();

async function start(identifier) {
  const session=await request(api+'/web-chat/session',{body:{}});
  const send=text=>request(api+'/web-chat/messages',{cookie:session.cookie,body:{text,idempotency_key:randomUUID()}});
  const read=async()=>(await request(api+'/web-chat/history',{cookie:session.cookie})).data;
  await send('Quiero consultar mi factura');
  await send(`Mi número de prueba es ${identifier}.`);
  assert.equal((await read()).verification.stage,'code_sent');
  await send('El código que recibí es 729 413.');
  assert.equal((await read()).verification.stage,'verified');
  await send('Quiero hablar con un asesor.');
  const pending=await until(async()=>{
    const {data}=await request(api+'/cases',{cookie:advisor});
    return data.find(item=>item.conversation_id===session.data.conversation_id);
  },'case ready to take');
  return {id:pending.id,read,send,taken:(await command(pending.id,'take')).data};
}

const web=await start('11111');
assert.ok(web.taken.verified);
assert.equal(web.taken.owner_id,operator.id);
await request(`${api}/cases/${web.id}`,{cookie:specialist,status:404});
const withChurn=await until(async()=>{
  const entry=await getCase(web.id);
  return entry.ml.churn.status==='available'&&entry;
},'verified photo scored by FastAPI');
assert.equal(withChurn.ml.churn.fecha_corte,'2026-11-18');
assert.equal(withChurn.ml.churn.model_version,info.churn_model_version);
assert.equal(withChurn.ml.churn.synthetic,true);
assert.ok(withChurn.ml.churn.recommendation);
assert.equal('ml' in await web.read(),false);

const follow=(status,revision,extra={})=>({status,case_revision:revision,event_id:randomUUID(),...extra});
await command(web.id,'ml/follow-up',follow('completed',withChurn.revision),409);
await command(web.id,'ml/follow-up',follow('agreed',withChurn.revision+1,{due_date:'2027-01-04'}),409);
const agreement=follow('agreed',withChurn.revision,{due_date:'2027-01-04'});
const stream=await fetch(new URL(`${api}/cases/${web.id}/events`,target),{
  headers:{Cookie:advisor,'Last-Event-ID':String(withChurn.cursor)},signal:AbortSignal.timeout(10000)
});
assert.equal(stream.status,200);
assert.match(stream.headers.get('content-type'),/text\/event-stream/);
const reader=stream.body.getReader();
let delivery='';
let agreementSeen=false;
try {
  await Promise.all([command(web.id,'ml/follow-up',agreement),command(web.id,'ml/follow-up',agreement)]);
  const decoder=new TextDecoder();
  while (!agreementSeen) {
    const {value,done}=await reader.read();
    if (done) break;
    delivery+=decoder.decode(value,{stream:true});
    const frames=delivery.split('\n\n');
    delivery=frames.pop();
    for (const frame of frames) {
      const line=frame.split('\n').find(item=>item.startsWith('data: '));
      if (!line) continue;
      const event=JSON.parse(line.slice(6));
      if (event.type==='case.updated' && event.snapshot.ml?.follow_up?.status==='agreed') agreementSeen=true;
    }
  }
  assert.equal(agreementSeen,true);
} finally { await reader.cancel(); }
await command(web.id,'ml/follow-up',{...agreement,due_date:'2027-01-05'},409);
assert.deepEqual((await getCase(web.id)).ml.follow_up,{status:'agreed',due_date:'2027-01-04',responsible_name:operator.name});

await web.send('Quiero cancelar mi plan y dar de baja el servicio.');
const cancellation=await until(async()=>{
  const entry=await getCase(web.id);
  return entry.ml.intent?.label==='cancelacion'&&entry.ml.intent;
},'cancellation intent');
assert.equal(cancellation.requires_human_confirmation,true);
assert.equal(cancellation.recommendation,'confirm_cancellation_intent');
assert.ok(cancellation.prediction_id);
const confirm={prediction_id:cancellation.prediction_id,label:'cancelacion',event_id:randomUUID()};
await command(web.id,'ml/intent-label',confirm,404,specialist);
await command(web.id,'ml/intent-label',confirm);
await command(web.id,'ml/intent-label',confirm);
await until(async()=>(await getCase(web.id)).ml.intent?.feedback?.synchronized,'confirmation acknowledged by FastAPI');

await web.send('Tengo un problema con el cobro de la factura de noviembre.');
const another=await until(async()=>{
  const current=(await getCase(web.id)).ml.intent;
  return current&&current.prediction_id!==cancellation.prediction_id&&current;
},'new prediction ID');
await command(web.id,'ml/intent-label',{...confirm,event_id:randomUUID()},409);
const corrected=another.label==='facturacion'?'consulta_planes':'facturacion';
await command(web.id,'ml/intent-label',{prediction_id:another.prediction_id,label:corrected,event_id:randomUUID()});
assert.equal(await until(async()=>{
  const value=(await getCase(web.id)).ml.intent?.feedback;
  return value?.synchronized&&value.label;
},'correction acknowledged by FastAPI'),corrected);

const closed=(await command(web.id,'close',{resolved:true})).data;
assert.equal(closed.status,'closed');
assert.equal(closed.ml.follow_up.status,'agreed');
const complete=follow('completed',closed.revision);
await command(web.id,'ml/follow-up',complete);
await command(web.id,'ml/follow-up',complete);
await command(web.id,'ml/follow-up',{...complete,event_id:randomUUID()},409);
assert.equal((await getCase(web.id)).ml.follow_up.status,'completed');
assert.equal('ml' in await web.read(),false);

const uncovered=await start('11013');
await until(async()=>count(await dashboard(),'churn_missing')>count(baseline,'churn_missing'),'uncovered case counted');
assert.deepEqual((await getCase(uncovered.id)).ml.churn,{status:'unavailable'});
await command(uncovered.id,'ml/follow-up',follow('agreed',uncovered.taken.revision,{due_date:'2027-01-04'}),409);
await command(uncovered.id,'messages',{text:'Seguimos revisando tu consulta.',idempotency_key:randomUUID()});
assert.match((await uncovered.read()).messages.at(-1).text,/Seguimos revisando/);

const report=await dashboard();
for (const [id,delta] of Object.entries({intent_confirmed:1,intent_corrected:1,intent_synchronized:2,follow_ups_agreed:1,follow_ups_completed:1,churn_missing:1})) {
  assert.equal(count(report,id)-count(baseline,id),delta,id);
}
assert.equal(metric(report,'churn_photo_coverage').sample-metric(baseline,'churn_photo_coverage').sample,1);
assert.equal(metric(report,'churn_photo_coverage').denominator-metric(baseline,'churn_photo_coverage').denominator,2);
assert.equal(metric(report,'intent_f1').value.toFixed(3),'0.785');
assert.equal(metric(report,'churn_auc').value.toFixed(3),'0.716');
assert.equal(metric(report,'churn_capture').sample,37);
assert.equal(metric(report,'churn_capture').denominator,90);
assert.equal(count(await dashboard('telegram'),'follow_ups_completed'),0);
console.log('Both bundles, private web signals, OTP, supervision receipt, closure, idempotent follow-up and ML dashboard verified.');
