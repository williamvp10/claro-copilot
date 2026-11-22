import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const origin = process.env.BETTER_AUTH_URL;
if (!origin || !process.env.DATABASE_URL || process.env.DEMO_MODE !== 'true') throw new Error('A dedicated seeded demo database and running backend are required');
const api = '/api/v1';
const target = process.env.PLATFORM_E2E_TARGET ?? origin;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function request(path, { cookie, body, method = 'GET', token, status } = {}) {
  const headers = { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(new URL(path, target), {method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000)}).catch(cause => { throw new Error(`HTTP ${method} ${path}`, {cause}); });
  const json = await res.json();
  if (status) assert.equal(res.status, status, JSON.stringify(json));
  else assert.ok(res.ok, JSON.stringify(json));
  return { json, cookie: res.headers.getSetCookie().map(v => v.split(';')[0]).join('; ') };
}

const login = async (who) => (await request('/api/auth/sign-in/email', { method:'POST', body: {
  email: process.env[`DEMO_${who}_EMAIL`], password: process.env[`DEMO_${who}_PASSWORD`]
} })).cookie;
const incoming = (ref, text) => request(api + '/demo/incoming', { method:'POST', token:process.env.DEMO_INGRESS_TOKEN, body:{contact_ref:ref, text, idempotency_key:randomUUID()} });
async function until(check, name) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await wait(100);
  }
  throw new Error(`Timeout: ${name}`);
}

try {
  await request(api+'/cases', {status:401});
  const cookie = await login('ASESSOR');
  const admin = await login('ADMIN');
  const post = async (path, body) => (await request(api+path, { cookie, method:'POST', body })).json;
  const get = async (path) => (await request(api+path, {cookie})).json;
  const cards = async (id, predicate) => until(async () => {
    const current = await get('/cases/'+id);
    return predicate(current) ? current : null;
  }, `card for ${id}`);
  const count = async (id, kind) => (await db.query('SELECT count(*)::integer AS n FROM attention_event WHERE case_id=$1 AND kind=$2', [id,kind])).rows[0].n;
  const verify = id => post(`/cases/${id}/verify-holder`, {verification_code:process.env.DEMO_HOLDER_CODE});

  await request(api+'/admin/dashboard', {cookie,status:403});
  await request(api+'/cases', {cookie:admin,status:403});
  const candidate = (await request(api+'/admin/prompts', {cookie:admin,method:'POST',body:{prompts:{orchestrator:'Prioriza fuentes vigentes.'}}})).json;
  assert.equal(candidate.status, 'candidate');
  const gated = (await request(api+`/admin/prompts/${candidate.revision}/eval`, {cookie:admin,method:'POST'})).json;
  assert.ok(['failed','passed'].includes(gated.status));
  if (gated.status === 'failed') await request(api+`/admin/prompts/${candidate.revision}/activate`, {cookie:admin,method:'POST',status:403});

  const startWeb = () => request(api+'/web-chat/session', {method:'POST',body:{}});
  const [firstBrowser, otherBrowser] = await Promise.all([startWeb(), startWeb()]);
  assert.notEqual(firstBrowser.json.conversation_id, otherBrowser.json.conversation_id);
  await request(api+'/web-chat/history', {status:401});
  const readWeb = async (session=firstBrowser) => (await request(api+'/web-chat/history',{cookie:session.cookie})).json;
  const sendWeb = (text, idempotency_key=randomUUID(), browser=firstBrowser) => request(api+'/web-chat/messages',{
    cookie:browser.cookie,method:'POST',body:{text,idempotency_key}
  });
  const verifyWeb = (browser, action, body, status) => request(api+'/web-chat/verification/'+action,{
    cookie:browser.cookie,method:'POST',body,status
  });
  const webKey=randomUUID();
  await Promise.all([sendWeb('¿Qué incluye el plan Fibra 500?',webKey),sendWeb('¿Qué incluye el plan Fibra 500?',webKey)]);
  const publicAnswer=await until(async()=>{const history=await readWeb();return history.messages.some(m=>m.citations?.length)?history:null;}, 'public web citation');
  assert.equal(publicAnswer.messages.filter(m=>m.actor==='cliente').length,1);
  assert.equal((await readWeb(otherBrowser)).messages.length,0);
  const events=await fetch(target+api+'/web-chat/events',{
    headers:{ Cookie:firstBrowser.cookie, 'Last-Event-ID':String(publicAnswer.cursor) },signal:AbortSignal.timeout(10000)
  });
  assert.ok(events.headers.get('content-type')?.includes('text/event-stream'));
  const readerWeb=events.body.getReader();
  await sendWeb('¿Cuánto debo de mi factura de noviembre?');
  let eventText='';
  while (!eventText.includes('event: conversation.updated')) {
    const {value,done}=await readerWeb.read();
    if(done) break;
    eventText+=new TextDecoder().decode(value);
  }
  await readerWeb.cancel();
  assert.match(eventText,/conversation.updated/);
  const awaitingVerification = await readWeb();
  assert.equal(awaitingVerification.verification.stage, 'required');
  assert.equal(awaitingVerification.awaiting_advisor, false);
  assert.doesNotMatch(JSON.stringify(awaitingVerification),/169\.315/);
  await verifyWeb(firstBrowser, 'start', {identifier:'99999'}, 404);
  const challenge = (await verifyWeb(firstBrowser, 'start', {identifier:'11111'})).json.verification;
  assert.equal(challenge.stage, 'code_sent');
  await verifyWeb(otherBrowser, 'confirm', {challenge_id:challenge.challenge_id, code:'123456'}, 409);
  await verifyWeb(firstBrowser, 'confirm', {challenge_id:challenge.challenge_id, code:'12345'}, 400);
  const verified = (await verifyWeb(firstBrowser, 'confirm', {challenge_id:challenge.challenge_id, code:'123456'})).json;
  assert.equal(verified.verification.stage, 'verified');
  assert.match(verified.messages.at(-1).text, /169\.315/);
  assert.equal(verified.conversation_id, publicAnswer.conversation_id);
  assert.doesNotMatch(JSON.stringify(verified),/123456|11111|account_ref/);
  assert.equal((await verifyWeb(firstBrowser, 'confirm', {challenge_id:challenge.challenge_id, code:'123456'})).json.cursor, verified.cursor);
  await verifyWeb(firstBrowser, 'start', {identifier:'22222'}, 409);
  await sendWeb('¿Qué plan tengo?');
  assert.match((await readWeb()).messages.at(-1).text, /Hogar Fibra 500/);

  await sendWeb('Quiero consultar mi factura', randomUUID(), otherBrowser);
  const otherChallenge = (await verifyWeb(otherBrowser, 'start', {identifier:'Cliente2@example.test'})).json.verification;
  const otherVerified = (await verifyWeb(otherBrowser, 'confirm', {challenge_id:otherChallenge.challenge_id, code:'000000'})).json;
  assert.equal(otherVerified.verification.stage, 'verified');
  assert.match(otherVerified.messages.at(-1).text, /89\.900.*pagada/);
  assert.doesNotMatch(JSON.stringify(otherVerified),/169\.315|example\.test/);

  await sendWeb('Quiero hablar con un asesor.');
  const webCase=await until(async()=> (await get('/cases')).find(c=>c.conversation_id===publicAnswer.conversation_id),'web handoff to advisor');
  assert.equal((await post(`/cases/${webCase.id}/take`)).verified, true);
  await sendWeb('¿Cuánto debo de mi factura de noviembre?');
  await cards(webCase.id,x=>x.card?.facts.some(f=>f.value==='$169.315'));
  const webHistory=await readWeb();
  assert.equal(webHistory.conversation_id,webCase.conversation_id);
  assert.equal(webHistory.attention_mode,'asistido');
  assert.equal(Object.hasOwn(webHistory,'card'),false);
  assert.equal(Object.hasOwn(webHistory,'owner_id'),false);
  assert.doesNotMatch(JSON.stringify(webHistory),/owner_id|account_ref|invoice-due/);
  await post(`/cases/${webCase.id}/messages`,{text:'Te confirmo que tu factura está pendiente.',idempotency_key:randomUUID()});
  assert.equal((await readWeb()).messages.at(-1).actor,'asesor');
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM outbox WHERE case_id=$1 AND kind='deliver'",[webCase.id])).rows[0].n,0);
  console.log('Web chat verified: persisted messages, demo OTP, scoped account access and same-thread advisor response.');

  await incoming('C-1001','Sale E-202 y no se ve ningún canal.');
  await until(async () => (await db.query("SELECT snapshot FROM attention_case WHERE contact_ref='C-1001'")).rows[0]?.snapshot.messages.some(m=>m.actor==='agente' && m.citations?.some(c=>c.id==='faq-decodificador-e202')), 'E-202 with correct retrieval');

  await incoming('C-1001','Quiero información del plan Fibra 500.');
  await until(async () => (await db.query("SELECT snapshot FROM attention_case WHERE contact_ref='C-1001'")).rows[0]?.snapshot.messages.some(m=>m.actor==='agente' && m.citations?.some(c=>c.id==='catalogo-2026-fibra500')), 'public plan citation');
  await incoming('C-1001','¿Cuánto debo de mi factura de noviembre?');
  const billingCase = await until(async () => (await get('/cases')).find(c=>c.display_name==='Cliente C-1001'), 'handoff');
  const billingId = billingCase.id;
  const taken = await post(`/cases/${billingId}/take`);
  assert.equal(taken.conversation_id, billingCase.conversation_id);
  assert.equal(taken.attention_mode, 'asistido');
  await cards(billingId, x => x.card?.reason_codes.includes('verification_required'));
  assert.equal(await count(billingId,'crm_read'), 0);
  assert.equal(await count(billingId,'billing_read'), 0);
  const stream = await fetch(target+api+`/cases/${billingId}/events?cursor=${(await get('/cases/'+billingId)).cursor}`, {headers:{Cookie:cookie},signal:AbortSignal.timeout(10000)});
  assert.ok(stream.headers.get('content-type').includes('text/event-stream'));
  const reader = stream.body.getReader();
  await verify(billingId);
  const billing = await cards(billingId, x => x.card?.facts.some(f=>f.value==='$169.315'));
  assert.equal(billing.messages.filter(m=>m.actor==='agente').length, 3);
  let received = '';
  do {
    const {value, done} = await reader.read();
    if (done) break;
    received += new TextDecoder().decode(value);
  } while (!received.includes('event: case.updated'));
  assert.match(received, /case.updated/);
  await reader.cancel();
  assert.equal(await count(billingId,'billing_read'), 1);
  if (process.env.ML_API_URL) await until(async ()=>(await count(billingId,'ml_unavailable'))>0 || (await count(billingId,'ml_predicted'))>0, 'independent shadow inference');

  const eligible = await post('/cases', {contact_ref:'C-1004',text:'Hola, soy tu asesor Claro.',idempotency_key:randomUUID()});
  await incoming('C-1004','Quiero cancelar el servicio.');
  await verify(eligible.id);
  await cards(eligible.id, x=>x.card?.reason_codes.includes('retention_eligible'));
  await post(`/cases/${eligible.id}/messages`, {text:'Puedo ofrecer el descuento del 30 %.',idempotency_key:randomUUID()});
  await cards(eligible.id, x=>x.card?.next_action.includes('Esperar la decisión'));
  await incoming('C-1004','Acepto el descuento del 30 %.');
  const proposed = await cards(eligible.id, x=>x.card?.proposal?.status==='pending_approval');
  const p = proposed.card.proposal;
  const confirm = {decision:'approved',revision:p.revision,idempotency_key:randomUUID()};
  assert.equal(await count(eligible.id,'retention_confirmed'), 0);
  await Promise.all([post(`/proposals/${p.id}/decision`,confirm),post(`/proposals/${p.id}/decision`,confirm)]);
  await cards(eligible.id, x => x.card?.proposal?.status==='confirmed' && x.card.proposal.effect_ref);
  await post(`/proposals/${p.id}/decision`, {...confirm,idempotency_key:randomUUID()});
  assert.equal(await count(eligible.id,'retention_confirmed'), 1);

  await incoming('C-1007','Quiero cancelar. ¿Pueden ofrecer un descuento?');
  const denied = await until(async ()=>(await get('/cases')).find(c=>c.display_name==='Cliente C-1007'), 'direct assigned conversation');
  assert.equal(denied.attention_mode,'asistido');
  await verify(denied.id);
  const blocked = await cards(denied.id, x=>x.card?.reason_codes.includes('retention_ineligible'));
  assert.ok(blocked.card.summary.includes('45 días de mora'));
  assert.equal(await count(denied.id,'retention_confirmed'),0);
  assert.equal(blocked.messages.filter(m=>m.actor==='agente').length,0);
  await post(`/cases/${denied.id}/close`,{resolved:false});
  if (process.env.DEMO_ASSIGNED_CHAT_ID && process.env.TELEGRAM_WEBHOOK_SECRET && !process.env.TELEGRAM_BOT_TOKEN) {
    const sendScore = (score) => fetch(target+api+'/webhooks/telegram', {
      method:'POST',
      headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':process.env.TELEGRAM_WEBHOOK_SECRET},
      body:JSON.stringify({update_id:84001+score,callback_query:{id:`test-score-${score}`,data:`csat:${denied.id}:${score}`,
        message:{chat:{type:'private',id:Number(process.env.DEMO_ASSIGNED_CHAT_ID)}}}}),
      signal:AbortSignal.timeout(5000)
    });
    assert.ok((await sendScore(5)).ok);
    assert.ok((await sendScore(1)).ok);
    const rows = (await db.query('SELECT score FROM case_feedback WHERE case_id=$1', [denied.id])).rows;
    assert.deepEqual(rows, [{score:5}]);
  }
  if (process.env.DEMO_SUPPORT_CHAT_ID) {
    await incoming('C-1013','Me quiero retirar porque el internet se cae todo el tiempo.');
    const support = await until(async ()=>(await get('/cases')).find(c=>c.display_name==='Cliente C-1013'), 'support case');
    await verify(support.id);
    const requested = await cards(support.id, x=>x.card?.reason_codes.includes('priority_support_required') && x.card.proposal);
    assert.equal(await count(support.id,'support_ticket_confirmed'),0);
    const p = requested.card.proposal;
    const approval = {decision:'approved',revision:p.revision,idempotency_key:randomUUID()};
    await Promise.all([post(`/proposals/${p.id}/decision`,approval),post(`/proposals/${p.id}/decision`,approval)]);
    const ticket = await cards(support.id,x=>x.card?.summary.includes('Ticket registrado'));
    assert.match(ticket.card.summary,/Franja de visita pendiente/);
    assert.equal(await count(support.id,'support_ticket_confirmed'),1);
    assert.equal(await count(support.id,'retention_confirmed'),0);
    assert.deepEqual((await db.query('SELECT category,priority FROM support_ticket WHERE proposal_id=$1',[p.id])).rows,
      [{category:'soporte_tecnico',priority:'prioritaria'}]);
    console.log('CC-E13 verified: one prioritized support ticket after approval, appointment pending.');
  }
  const dashboard = (await request(api+'/admin/dashboard',{cookie:admin})).json;
  assert.equal(dashboard.metrics.find(m=>m.id==='retention').value,1);
  console.log('C-1001, C-1004, C-1007 verified through HTTP, SSE and PostgreSQL.');
} finally {
  await db.end();
}
