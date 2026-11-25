import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

assert.equal(process.env.DEMO_MODE,'true');
const origin=new URL(process.env.PLATFORM_E2E_TARGET ?? process.env.BETTER_AUTH_URL);
assert.ok(['localhost','127.0.0.1','[::1]'].includes(origin.hostname),'Use a local synthetic demo.');
const web='/api/v1/web-chat', admin='/api/v1/admin/agent-models', cases='/api/v1/cases';

async function request(path,{body,cookie,status,timeout=10000}={}) {
  const response=await fetch(new URL(path,origin),{method:body===undefined?'GET':'POST',
    headers:{Origin:origin.origin,...cookie?{Cookie:cookie}:{},...body===undefined?{}:{'Content-Type':'application/json'}},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
  const data=await response.json();
  if (status) assert.equal(response.status,status,`${path}: ${JSON.stringify(data)}`);
  else assert.ok(response.ok,`${path}: ${response.status} ${JSON.stringify(data)}`);
  return {data,cookie:response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ')};
}
async function login(operator) {
  const {cookie}=await request('/api/auth/sign-in/email',{body:{
    email:process.env[`DEMO_${operator}_EMAIL`],password:process.env[`DEMO_${operator}_PASSWORD`]
  }});
  assert.ok(cookie,'Session cookie missing');
  return cookie;
}
async function until(read,label) {
  for(let attempt=0;attempt<80;attempt++) {
    const value=await read();
    if (value) return value;
    await wait(200);
  }
  throw new Error(`Timeout waiting for ${label}`);
}
async function start() {
  const {data,cookie}=await request(web+'/session',{body:{}});
  assert.ok(cookie);
  return {
    conversation:data.conversation_id,
    async send(text) {return (await request(web+'/messages',{cookie,body:{text,idempotency_key:randomUUID()}})).data;},
    async history() {return (await request(web+'/history',{cookie})).data;}
  };
}

const advisor=await login('ASESSOR');
const superadmin=await login('SUPERADMIN');
await request(admin+'/catalog',{status:401});
await request(admin+'/catalog',{cookie:advisor,status:403});
const {data:catalog}=await request(admin+'/catalog',{cookie:superadmin});
assert.deepEqual([...new Set(catalog.models.map(item=>item.family))].sort(),['Anthropic','Google','Meta','Mistral','OpenAI']);

const live=process.argv.includes('--change-model');
if(live) {
  assert.ok(catalog.providers.openai&&catalog.providers.openrouter,'Provider credentials must be available for activation');
  const {data:history}=await request(admin+'/revisions',{cookie:superadmin});
  const prior=history.revisions.find(item=>item.revision===history.active);
  const policy=structuredClone(prior.policy);
  policy.steps.extract_turn={mode:'fixed',model:'mistralai/mistral-small-3.2-24b-instruct',fallback:'gpt-6-luna'};
  const create=await request(admin+'/revisions',{cookie:superadmin,body:{base_revision:prior.revision,policy,reason:'Prueba sintética de selección de proveedor'}});
  const id=create.data.revision;
  const apply={reason:'Verificación de enrutamiento de modelos',evidence:'multillm-web-e2e'};
  const validate=async revision=>{
    const {data}=await request(admin+`/revisions/${revision}/validate`,{cookie:superadmin,body:{},timeout:35000});
    assert.deepEqual(data.issues,[]);
  };
  await request(admin+`/revisions/${id}/activate`,{cookie:superadmin,body:{...apply,expected_revision:prior.revision},status:409});
  await validate(id);
  const responses=await Promise.allSettled([0,1].map(()=>request(admin+`/revisions/${id}/activate`,
    {cookie:superadmin,body:{...apply,expected_revision:prior.revision}})));
  assert.equal(responses.filter(result=>result.status==='fulfilled').length,1);
  assert.match(responses.find(result=>result.status==='rejected').reason.message,/409/);
  try {
    const chat=await start();
    await chat.send('¿Cómo funciona la portabilidad?');
    assert.ok(await until(async()=> (await chat.history()).messages.find(message=>message.actor==='agente'),'published live reply'));
    console.log('Live policy revision and conversation',id,chat.conversation);
  } finally {
    await validate(prior.revision);
    await request(admin+`/revisions/${prior.revision}/restore`,{cookie:superadmin,body:{...apply,expected_revision:id}});
  }
}

const chat=await start();
async function say(text,expect) {
  const before=await chat.history();
  await chat.send(text);
  return until(async()=>{
    const response=(await chat.history()).messages.slice(before.messages.length).find(message=>message.actor==='agente');
    if (!response) return null;
    assert.match(response.text,expect);
    return response;
  },'public reply');
}
await say('Hola',/hola/i);
await say('¿Qué planes ofrecen?',/hogar.*móvil/is);
await say('telefonía móvil',/Pospago.*Prepago/s);
const detail=await say('¿Qué incluye en Max Ilimitado?',/Claro Max Ilimitado.*99\.900/s);
assert.ok(detail.citations.some(item=>item.version==='CAT-2026 v1.0'));
await say('Gracias',/con gusto|gracias|ayudar|consulta|resolver/i);
const follow=await say('¿Incluye roaming?',/roaming/i);
assert.ok(follow.citations.length);
await say('Sí, pásame un asesor',/espera de un asesor/i);
const waited=await chat.send('Pásame un asesor, por favor');
assert.equal(waited.awaiting_advisor,true);
const result=await request(cases,{cookie:advisor});
const active=result.data.find(item=>item.conversation_id===chat.conversation);
assert.ok(active);
await request(cases+`/${active.id}/take`,{cookie:advisor,body:{}});
assert.equal((await chat.history()).attention_mode,'asistido');
const card=()=>request(cases+'/'+active.id,{cookie:advisor}).then(result=>result.data);
await until(async()=> (await card()).card?.advisor_draft,'first private draft');
await request(cases+`/${active.id}/messages`,{cookie:advisor,body:{
  text:'Te ayudo a revisar los beneficios del plan que vimos.',idempotency_key:randomUUID()
}});
assert.ok((await chat.history()).messages.some(message=>message.actor==='asesor' && message.text.includes('plan que vimos')));
await chat.send('¿Qué incluye Claro Max Ilimitado?');
const privateCard=await until(async()=>{
  const snapshot=await card();
  const suggestion=snapshot.card;
  const userMessage=snapshot.messages.findLast(item=>item.actor==='cliente');
  return suggestion?.advisor_draft_turn_seq===userMessage?.turn_seq && suggestion.citations.length ? snapshot : null;
},'private catalogue follow-up');
assert.match(privateCard.card.advisor_draft,/Claro Max Ilimitado/);
assert.equal(privateCard.conversation_context?.frames.consulta_planes?.last_reply?.actor,'asesor');
assert.ok(!Object.hasOwn(await chat.history(),'card'));
await chat.send('Sí, quedó resuelto. Puedes cerrar.');
assert.equal((await chat.history()).status,'open');
await until(async()=> (await card()).card?.reason_codes.includes('customer_resolution_confirmed'),'private closure suggestion');
console.log('Shared dialogue, catalogue, explicit handoff, assisted follow-up and requested closure',chat.conversation);
