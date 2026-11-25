import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { writeDocument } from '../dist/knowledge.js';

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
  const whatsappFixture = {contact_ref:'C-1013',channel:'whatsapp',text:'Solicitud de prueba',idempotency_key:randomUUID()};
  await request(api+'/demo/incoming',{method:'POST',body:whatsappFixture,status:401});
  if (process.env.LOCAL_PROMPT_REPLAY_SCENARIO!=='CC-E10') {
    await request(api+'/demo/incoming',{method:'POST',body:whatsappFixture,token:process.env.DEMO_INGRESS_TOKEN,status:404});
  }
  const cookie = await login('ASESSOR');
  const admin = await login('ADMIN');
  const post = async (path, body) => (await request(api+path, { cookie, method:'POST', body })).json;
  const get = async (path) => (await request(api+path, {cookie})).json;
  const cards = async (id, predicate) => until(async () => {
    const current = await get('/cases/'+id);
    return predicate(current) ? current : null;
  }, `card for ${id}`);
  const count = async (id, kind) => (await db.query('SELECT count(*)::integer AS n FROM attention_event WHERE case_id=$1 AND kind=$2', [id,kind])).rows[0].n;
  let updateId = 81000;
  const telegram = async (ref,chatId,text) => {
    if (!chatId || !process.env.TELEGRAM_WEBHOOK_SECRET) return incoming(ref,text);
    const res = await fetch(target+api+'/webhooks/telegram',{
      method:'POST', headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':process.env.TELEGRAM_WEBHOOK_SECRET},
      body:JSON.stringify({update_id:updateId++,message:{chat:{type:'private',id:Number(chatId)},text}}),signal:AbortSignal.timeout(5000)
    });
    assert.ok(res.ok,await res.text());
  };
  const verifyByChat = async (ref,chatId,alias) => {
    await telegram(ref,chatId,`Mi contacto es ${alias}.`);
    await telegram(ref,chatId,'El código que recibí es 729 413.');
  };

  await request(api+'/admin/dashboard', {cookie,status:403});
  assert.deepEqual((await request(api+'/cases', {cookie:admin})).json, []);
  const candidate = (await request(api+'/admin/prompts', {cookie:admin,method:'POST',body:{prompts:{public_answer:'Responde en español con evidencia vigente y citas verificadas.'}}})).json;
  assert.equal(candidate.status, 'candidate');
  if (process.env.PROMPT_EVAL_ENABLED === 'true') {
    const queued = await request(api+`/admin/prompts/${candidate.revision}/eval`, {cookie:admin,method:'POST'});
    assert.ok(['queued','running'].includes(queued.json.status));
  } else {
    await request(api+`/admin/prompts/${candidate.revision}/eval`, {cookie:admin,method:'POST',status:503});
  }
  await request(api+`/admin/prompts/${candidate.revision}/activate`, {cookie:admin,method:'POST',status:403});

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
  await sendWeb('Mi correo es Cliente1@Example.test.');
  const challenge = (await readWeb()).verification;
  assert.equal(challenge.stage, 'code_sent');
  await verifyWeb(otherBrowser, 'confirm', {challenge_id:challenge.challenge_id, code:'123456'}, 409);
  await sendWeb('Mi código es 12345');
  assert.equal((await readWeb()).verification.stage,'code_sent');
  const verified = (await sendWeb('El código que recibí es 729 413.')).json;
  assert.equal(verified.verification.stage, 'verified');
  assert.match(verified.messages.at(-1).text, /169\.315/);
  assert.equal(verified.conversation_id, publicAnswer.conversation_id);
  assert.doesNotMatch(JSON.stringify(verified),/12345|729 413|cliente1@example\.test|account_ref/i);
  await verifyWeb(firstBrowser, 'start', {identifier:'22222'}, 409);
  await sendWeb('¿Qué plan tengo?');
  assert.match((await readWeb()).messages.at(-1).text, /Hogar Fibra 500/);

  await sendWeb('Quiero consultar mi factura', randomUUID(), otherBrowser);
  const otherChallenge = (await verifyWeb(otherBrowser, 'start', {identifier:'Cliente2@example.test'})).json.verification;
  const otherVerified = (await verifyWeb(otherBrowser, 'confirm', {challenge_id:otherChallenge.challenge_id, code:'000000'})).json;
  assert.equal(otherVerified.verification.stage, 'verified');
  assert.match(otherVerified.messages.at(-1).text, /89\.900.*pagada/);
  assert.doesNotMatch(JSON.stringify(otherVerified),/169\.315|example\.test/);

  const cancellationBrowser=await startWeb();
  const cancelText='Quiero cancelar mi factura.';
  const cancelStarted=(await sendWeb(cancelText,randomUUID(),cancellationBrowser)).json;
  assert.equal(cancelStarted.verification.stage,'required');
  assert.equal(cancelStarted.awaiting_advisor,false);
  await sendWeb('Mi correo es Cliente2@example.test.',randomUUID(),cancellationBrowser);
  const cancelConfirmed=(await sendWeb('El código es 351740.',randomUUID(),cancellationBrowser)).json;
  assert.equal(cancelConfirmed.verification.stage,'verified');
  assert.equal(cancelConfirmed.awaiting_advisor,true);
  assert.match(cancelConfirmed.messages.at(-1).text,/cancelación.*en espera de un asesor/i);
  assert.doesNotMatch(JSON.stringify(cancelConfirmed),/última factura|saldo pendiente|89\.900/i);
  await sendWeb(cancelText,randomUUID(),cancellationBrowser);
  const cancellationCase=(await get('/cases?view=inbox')).available.find(item=>item.conversation_id===cancelConfirmed.conversation_id);
  assert.ok(cancellationCase,'The invoice cancellation is available in the advisor queue');
  assert.match((await get('/cases/'+cancellationCase.id)).handoff_reason,/cancelar su factura/i);
  assert.equal(await count(cancellationCase.id,'handoff_requested'),1);
  assert.equal(await count(cancellationCase.id,'billing_read'),0);

  const verifiedCancellation=(await sendWeb('Necesito anular el recibo.',randomUUID(),otherBrowser)).json;
  assert.equal(verifiedCancellation.verification.stage,'verified');
  assert.equal(verifiedCancellation.awaiting_advisor,true);
  assert.match(verifiedCancellation.messages.at(-1).text,/cancelación.*en espera de un asesor/i);
  const afterInquiryCase=(await get('/cases?view=inbox')).available.find(item=>item.conversation_id===verifiedCancellation.conversation_id);
  assert.equal(await count(afterInquiryCase.id,'billing_read'),1,'Only the earlier invoice inquiry reads billing');

  const switchingBrowser=await startWeb();
  await sendWeb('Quiero consultar mi factura.',randomUUID(),switchingBrowser);
  await sendWeb('Mi correo es Cliente2@example.test.',randomUUID(),switchingBrowser);
  const switched=(await sendWeb('Quiero anular mi última factura.',randomUUID(),switchingBrowser)).json;
  assert.equal(switched.verification.stage,'code_sent');
  assert.ok(switched.messages.some(message=>message.actor==='cliente' && /anular mi última factura/i.test(message.text)));
  const switchedConfirmed=(await sendWeb('El código es 452871.',randomUUID(),switchingBrowser)).json;
  assert.equal(switchedConfirmed.awaiting_advisor,true);
  assert.doesNotMatch(JSON.stringify(switchedConfirmed),/última factura \(20|saldo pendiente|89\.900/i);

  await sendWeb('Quiero hablar con un asesor.');
  const webCase=await until(async()=> (await get('/cases')).find(c=>c.conversation_id===publicAnswer.conversation_id),'web handoff to advisor');
  assert.equal((await post(`/cases/${webCase.id}/take`)).verified, true);
  await sendWeb('¿Cuánto debo de mi factura de noviembre?');
  await cards(webCase.id,x=>x.card?.facts.some(f=>f.value.replace(/\s/g,'')==='$169.315'));
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
  const billingChat = process.env.DEMO_BILLING_CHAT_ID;
  await telegram('C-1001',billingChat,'Quiero consultar mi última factura.');
  const [unverifiedBilling] = (await db.query("SELECT id,snapshot FROM attention_case WHERE contact_ref='C-1001'")).rows;
  assert.match(unverifiedBilling.snapshot.messages.at(-1).text,/correo o teléfono de prueba/);
  await telegram('C-1001',billingChat,'Mi número es 22222.');
  await telegram('C-1001',billingChat,'Mi código es 354920.');
  assert.equal(await count(unverifiedBilling.id,'billing_read'),0);
  await verifyByChat('C-1001',billingChat,'11111');
  const [verifiedBilling] = (await db.query('SELECT snapshot FROM attention_case WHERE id=$1',[unverifiedBilling.id])).rows;
  assert.equal(verifiedBilling.snapshot.verified,true);
  assert.match(verifiedBilling.snapshot.messages.at(-1).text,/169\.315/);
  assert.doesNotMatch(JSON.stringify(verifiedBilling),/11111|22222|354920|729 413/);
  if (billingChat) await until(async () => (await count(unverifiedBilling.id,'telegram_simulated'))>=3,'verification replies through Telegram outbox');
  await telegram('C-1001',billingChat,'Quiero hablar con un asesor.');
  const billingCase = await until(async () => (await get('/cases')).find(c=>c.display_name==='Cliente C-1001'), 'handoff');
  assert.equal(billingCase.id,unverifiedBilling.id);
  const taken = await post(`/cases/${billingCase.id}/take`);
  assert.equal(taken.attention_mode, 'asistido');
  assert.equal(taken.verified, true);
  await telegram('C-1001',billingChat,'¿Cuánto debo de mi factura de noviembre?');
  await cards(taken.id,x=>x.card?.facts.some(f=>f.value.replace(/\s/g,'')==='$169.315'));
  if (process.env.ML_API_URL) await until(async ()=>(await count(taken.id,'ml_unavailable'))>0 || (await count(taken.id,'ml_predicted'))>0, 'independent shadow inference');

  const eligible = await post('/cases', {contact_ref:'C-1004',text:'Hola, soy tu asesor Claro.',idempotency_key:randomUUID()});
  await incoming('C-1004','Quiero cancelar el servicio.');
  await verifyByChat('C-1004',process.env.DEMO_RETENTION_CHAT_ID,'cliente2@example.test');
  await cards(eligible.id, x=>x.card?.reason_codes.includes('retention_eligible'));
  await post(`/cases/${eligible.id}/messages`, {text:'Puedo ofrecer el descuento del 30 %.',idempotency_key:randomUUID()});
  await cards(eligible.id, x=>x.card?.reason_codes.includes('retention_awaiting_choice'));
  await incoming('C-1004','Acepto el descuento del 30 %.');
  const withdrawn=(await cards(eligible.id,x=>x.card?.proposal?.status==='pending_approval')).card.proposal;
  await incoming('C-1004','Ya no quiero cancelar. Mejor quiero cambiarme a un plan más barato.');
  await request(api+`/proposals/${withdrawn.id}/decision`,{cookie,method:'POST',status:409,
    body:{decision:'approved',revision:withdrawn.revision,idempotency_key:randomUUID()}});
  const [expired]=(await db.query("SELECT proposal->>'status' AS status FROM retention_proposal WHERE id=$1",[withdrawn.id])).rows;
  assert.equal(expired.status,'expired');
  assert.equal(await count(eligible.id,'retention_confirmed'),0);
  await incoming('C-1004','Quiero cancelar el servicio.');
  await cards(eligible.id,x=>x.card?.reason_codes.includes('retention_eligible') && !x.card.proposal);
  await post(`/cases/${eligible.id}/messages`, {text:'Puedo ofrecer el descuento del 30 %.',idempotency_key:randomUUID()});
  await incoming('C-1004','Acepto el descuento del 30 %.');
  const proposed = await cards(eligible.id, x=>x.card?.proposal?.status==='pending_approval');
  const p = proposed.card.proposal;
  assert.notEqual(p.id,withdrawn.id);
  const confirm = {decision:'approved',revision:p.revision,idempotency_key:randomUUID()};
  assert.equal(await count(eligible.id,'retention_confirmed'), 0);
  await Promise.all([post(`/proposals/${p.id}/decision`,confirm),post(`/proposals/${p.id}/decision`,confirm)]);
  await cards(eligible.id, x => x.card?.proposal?.status==='confirmed' && x.card.proposal.effect_ref);
  await post(`/proposals/${p.id}/decision`, {...confirm,idempotency_key:randomUUID()});
  assert.equal(await count(eligible.id,'retention_confirmed'), 1);

  await incoming('C-1007','Quiero cancelar. ¿Pueden ofrecer un descuento?');
  const denied = await until(async ()=>(await get('/cases')).find(c=>c.display_name==='Cliente C-1007'), 'direct assigned conversation');
  assert.equal(denied.attention_mode,'asistido');
  await verifyByChat('C-1007',process.env.DEMO_ASSIGNED_CHAT_ID,'33333');
  const blocked = await cards(denied.id, x=>x.card?.reason_codes.includes('retention_ineligible'));
  assert.ok(blocked.card.summary.includes('45 días de mora'));
  assert.equal(await count(denied.id,'retention_confirmed'),0);
  assert.match(blocked.messages.at(-1).text,/Cuenta de prueba verificada/);
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
    if (!process.env.KNOWLEDGE_INDEX_REVISION || process.env.KNOWLEDGE_INDEX_REVISION === 'legacy') {
      await writeDocument({query:async (sql,params)=>(await db.query(sql,params)).rows}, {
        id:'retencion-991',version:'POL-RET-CI v1',title:'Política de retención por fallas técnicas recurrentes',
        excerpt:'Con tres o más tickets técnicos en 90 días, gestionar una visita técnica prioritaria dentro de 24 horas antes de evaluar una oferta.',
        scope:'advisor',effective_from:'2026-11-01',type:'politica'
      });
    }
    await incoming('C-1013','Me quiero retirar porque el internet se cae todo el tiempo.');
    const support = await until(async ()=>(await get('/cases')).find(c=>c.display_name==='Cliente C-1013'), 'support case');
    await verifyByChat('C-1013',process.env.DEMO_SUPPORT_CHAT_ID,'11013');
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
  assert.equal(dashboard.daily.length,7);
  const webStats = (await request(api+'/admin/dashboard?days=30&channel=web',{cookie:admin})).json;
  assert.equal(webStats.daily.length,30);
  assert.equal(webStats.channel,'web');
  assert.equal(webStats.daily.reduce((sum,day)=>sum+day.cases,0),webStats.metrics.find(m=>m.id==='cases').value);
  assert.equal(webStats.metrics.find(m=>m.id==='retention').value,0);
  await request(api+'/admin/dashboard?days=90',{cookie:admin,status:400});
  assert.equal(dashboard.metrics.find(m=>m.id==='retention').value,1);
  console.log('C-1001, C-1004, C-1007 verified through HTTP, SSE and PostgreSQL.');

  const caseApis = `/cases/${webCase.id}/integrations`;
  const crm = await get(caseApis+'/crm');
  assert.equal(crm.customer.cliente_id,'C-1001');
  assert.equal(crm.customer.servicios.length,2);
  assert.doesNotMatch(JSON.stringify(crm),/example\.test|numero_documento|11111/);
  const billingView = await get(caseApis+'/billing');
  const payable = billingView.invoices.find(x=>x.factura_id==='F-5003');
  assert.equal(payable.saldo_abierto,169315);
  const detail = caseApis+'/billing/invoices/';
  await request(api+detail+'F-5019',{cookie,status:404});
  await request(api+caseApis+'/operations',{cookie,method:'POST',status:404,body:{
    idempotency_key:randomUUID(),action:{kind:'adjustment',invoice_id:'F-5019',adjustment:{valor:100,motivo:'Factura ajena'}}
  }});
  if (process.env.CRM_MCP_URL && process.env.BILLING_MCP_URL) {
    await sendWeb('¿Por qué subió mi factura F-5003 con el cambio de mi plan?');
    const planned = await cards(webCase.id,x=>x.card?.facts.some(f=>f.id.startsWith('F-5003-item-'))
      && x.card.facts.some(f=>crm.customer.servicios.some(s=>s.servicio_id===f.id)));
    const run = planned.card.advisor_draft_run_id;
    assert.ok(run);
    const tools = await until(async () => {
      const {rows} = await db.query(`SELECT kind, metadata->>'purpose' AS purpose FROM attention_event
        WHERE case_id=$1 AND metadata->>'run_id'=$2 AND kind LIKE 'tool.%' ORDER BY id`,[webCase.id,run]);
      return rows.length>=2 ? rows : null;
    },'scoped MCP invoice and service reads');
    assert.deepEqual(tools,[{kind:'tool.billing.get_invoice_detail',purpose:'inspect_invoice'},
      {kind:'tool.crm.list_services',purpose:'compare_billed_service'}]);
    assert.doesNotMatch(JSON.stringify(await readWeb()),/F-5003-item-|advisor_draft|Titular verificado/);
    await post(`/cases/${webCase.id}/messages`,{text:planned.card.advisor_draft,idempotency_key:randomUUID(),
      draft:{run_id:run,case_revision:planned.revision}});
    const {rows:publications} = await db.query(`SELECT metadata FROM attention_event WHERE case_id=$1
      AND kind='agent_task_outcome' AND metadata->>'run_id'=$2 AND metadata->>'terminal'='invoice_explained'`,[webCase.id,run]);
    assert.equal(publications.length,1);
    assert.equal(publications[0].metadata.outcome,'qualified_success');
    assert.equal(publications[0].metadata.category,'facturacion');
    const [suggestionRun] = (await db.query('SELECT turn FROM agent_run WHERE id=$1',[run])).rows;
    assert.equal(publications[0].metadata.config_revision,suggestionRun.turn.config_revision);
    assert.ok(!Object.hasOwn(publications[0].metadata,'text'));
  }
  const ticket = {
    idempotency_key:randomUUID(), action:{kind:'ticket',ticket:{categoria:'facturacion',descripcion:'Prueba de conciliación'}}
  };
  const accepted = await Promise.all([post(caseApis+'/operations',ticket),post(caseApis+'/operations',ticket)]);
  assert.equal(accepted[0].id,accepted[1].id);
  const operation = async (id,status) => until(async () =>
    (await get(caseApis+'/operations')).find(x=>x.id===id&&x.status===status), `${id} ${status}`);
  // The test CRM discards the response after committing; the worker must find the durable receipt.
  await operation(accepted[0].id,'pending_verification');
  const confirmed = await operation(accepted[0].id,'confirmed');
  assert.equal((await get(caseApis+'/crm')).customer.tickets_recientes.filter(x=>x.ticket_id===confirmed.reference).length,1);
  const credit = await post(caseApis+'/operations',{idempotency_key:randomUUID(),action:{
    kind:'adjustment',invoice_id:payable.factura_id,adjustment:{valor:55_000,motivo:'Validación del flujo de supervisión',aprobado_por:'inyectado'}
  }});
  assert.equal(credit.status,'pending_supervisor');
  const approvals = api+'/admin/integrations/approvals';
  await request(approvals+'/'+credit.id,{cookie,method:'POST',body:{approved:true},status:403});
  assert.ok((await request(approvals,{cookie:admin})).json.some(x=>x.id===credit.id));
  const approve = () => request(approvals+'/'+credit.id,{cookie:admin,method:'POST',body:{approved:true}});
  await Promise.all([approve(),approve()]);
  const adjustment = await operation(credit.id,'confirmed');
  const updated = await get(detail+payable.factura_id);
  assert.equal(updated.saldo_abierto,114315);
  assert.equal(updated.ajustes.length,1);
  assert.equal(updated.ajustes[0].ajuste_id,adjustment.reference);
  assert.equal(updated.ajustes[0].aprobado_por,(await request(api+'/me',{cookie:admin})).json.id);

  const outage = state => fetch(new URL('/test-outage/'+state,process.env.CRM_API_URL),{method:'POST'});
  try {
    await outage('on');
    await request(api+caseApis+'/crm',{cookie,status:503});
    assert.equal((await get(caseApis+'/billing')).balance.saldo_pendiente,114315);
    const health = (await request(api+'/admin/integrations',{cookie:admin})).json;
    assert.equal(health.find(x=>x.service==='crm').available,false);
    assert.equal(health.find(x=>x.service==='billing').available,true);
    await post(`/cases/${webCase.id}/messages`,{text:'Sigo aquí para ayudarte.',idempotency_key:randomUUID()});
    assert.equal((await readWeb()).messages.at(-1).text,'Sigo aquí para ayudarte.');
  } finally {
    await outage('off');
  }
  console.log('Verified case API, foreign-invoice rejection, lost-response reconciliation, supervisor approval and isolated CRM outage.');

} finally {
  await db.end();
}
