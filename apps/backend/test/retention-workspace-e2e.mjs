import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

const origin=new URL(process.env.BETTER_AUTH_URL);
const base=process.argv.includes('--baseline');
assert.ok(['localhost','127.0.0.1'].includes(origin.hostname) && process.env.DEMO_MODE==='true','Use a fresh, isolated demo');
const target=process.env.PLATFORM_E2E_TARGET ?? origin;
const root='/api/v1';
const results={};
async function http(path,{cookie,body,status=body===undefined?200:201}={}) {
  const response=await fetch(new URL(path,target),{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(14000),
    headers:{Origin:origin.origin,...cookie?{Cookie:cookie}:{},...body===undefined?{}:{'Content-Type':'application/json'}},
    body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();
  assert.equal(response.status,status,`${path}: ${JSON.stringify(value.message ?? value.status)}`);
  return {value,cookie:response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ')};
}
const get=(path,cookie,status)=>http(root+path,{cookie,status}).then(result=>result.value);
const post=(path,cookie,body,status)=>http(root+path,{cookie,body,status}).then(result=>result.value);
const login=async kind=>(await http('/api/auth/sign-in/email',{status:200,body:{
  email:process.env['DEMO_'+kind+'_EMAIL'],password:process.env['DEMO_'+kind+'_PASSWORD']
}})).cookie;
async function until(read,label) {
  for (let i=0;i<82;i++) {
    const value=await read();
    if (value) return value;
    await wait(250);
  }
  throw Error('Timed out: '+label);
}

const [advisor,admin]=await Promise.all([login('ASESSOR'),login('ADMIN')]);
if (!base) {
  assert.equal((await get('/me',admin)).can_manage_administration,true);
  assert.equal((await get('/me',advisor)).can_manage_administration,false);
  await get('/admin/operators',advisor,403);
  await get('/admin/agent-models/catalog',advisor,403);
  assert.ok((await get('/admin/operators',admin)).length);
  assert.ok(await get('/admin/agent-models/catalog',admin));
  const legacyEmail=process.env.DEMO_SUPERADMIN_EMAIL;
  assert.ok(!(await get('/admin/operators',admin)).some(row=>row.email===legacyEmail));
  if (legacyEmail && process.env.DEMO_SUPERADMIN_PASSWORD) {
    const retired=await fetch(new URL('/api/auth/sign-in/email',target),{method:'POST',headers:{Origin:origin.origin,'Content-Type':'application/json'},
      body:JSON.stringify({email:legacyEmail,password:process.env.DEMO_SUPERADMIN_PASSWORD})});
    assert.ok(!retired.ok,'The retired account must not obtain a new session');
  }
  const current=await get('/me',admin);
  const rejected=await fetch(new URL(root+'/admin/operators/'+current.id,target),{method:'PATCH',headers:{
    Origin:origin.origin,Cookie:admin,'Content-Type':'application/json'
  },body:JSON.stringify({capabilities:[],specialties:[],enabled:false,available:false})});
  assert.equal(rejected.status,409);
}
const customer=await http(root+'/web-chat/session',{body:{fresh:true}});
const send=text=>post('/web-chat/messages',customer.cookie,{text,idempotency_key:randomUUID()});
await send('Quiero consultar mi factura.');
const challenge=await post('/web-chat/verification/start',customer.cookie,{identifier:'11111'});
await post('/web-chat/verification/confirm',customer.cookie,{challenge_id:challenge.verification.challenge_id,code:'135790'});
await send('Quiero hablar con un asesor.');
const item=await until(async()=> (await get('/cases?view=inbox',advisor)).available.find(row=>row.conversation_id===customer.value.conversation_id),'waiting case');
const path='/cases/'+item.id;
const snapshot=cookie=>get(path,cookie);
const operatorSend=(cookie,text)=>post(path+'/messages',cookie,{text,idempotency_key:randomUUID()});
await post(path+'/take',advisor,{});
const eligibleTurn=await send('Quiero cancelar el servicio porque es muy caro.');
const customerId=state=>state.messages.findLast(message=>message.actor==='cliente')?.id;
let card=await until(async()=>{
  const state=await snapshot(advisor);
  return state.card?.reason_codes.includes('retention_eligible') &&
    state.card?.summary_update?.turn_id===customerId(eligibleTurn) && state.card.advisor_draft ? state.card : null;
},'eligible retention card');
results['RET-01']={respuesta:card.advisor_draft,recomendaciones:{
  siguiente_paso:card.next_action,hechos:card.facts,alternativas:card.retention_options,fuentes:card.citations.map(({title,version})=>({title,version}))
}};
if (!base) {
  assert.match(card.advisor_draft,/30\s*%.*seis meses.*mejora.*seis meses/i);
  assert.doesNotMatch(card.advisor_draft,/días de mora|límite de mora|RET-A/);
  assert.equal(card.retention_options.length,2);
  assert.equal((await get(path+'/integrations/operations',advisor)).length,0);
}
await operatorSend(advisor,'Puedo ofrecerte el descuento estándar del 30 % durante seis meses o la mejora de plan.');
const requestTurn=await send('¿Me puedes dar el 35 % de descuento?');
card=await until(async()=>{
  const state=await snapshot(advisor);
  return state.card?.summary_update?.turn_id===customerId(requestTurn) && state.card.advisor_draft ? state.card : null;
},'reply to the requested exception');
results['RET-02']={respuesta_a_solicitud:card.advisor_draft};
const transfer=async()=>{
  const before=await snapshot(advisor);
  const request=await post(path+'/escalations',advisor,{destination:'comercial_portabilidad',reason_text:'Revisión de excepción de retención.',
    case_revision:before.revision,idempotency_key:randomUUID()});
  const queue=await get('/escalations',admin);
  await post('/escalations/'+request.id+'/claim',admin,{case_revision:queue.find(row=>row.id===request.id).case_revision});
  await get(path,advisor,404);
};

if (base) {
  await transfer();
  await operatorSend(admin,'Voy a consultar las condiciones de la oferta.');
  await send('Listo, gracias.');
  await post(path+'/close',admin,{resolved:true},409);
  results['SEG-01']={confirmacion:(await snapshot(admin)).customer_resolution ?? null,resultado:'Cierre resuelto rechazado. El caso sigue abierto.'};
} else {
  const change=async(cookie,action,input={},status=201)=>post(path+'/retention-discount',cookie,
    {action,case_revision:(await snapshot(cookie)).revision,idempotency_key:randomUUID(),...input},status);
  const profile=await get(path+'/integrations/crm',advisor);
  const service=profile.customer.servicios.find(item=>item.plan==='Hogar Fibra 500');
  assert.equal(service.valor_mensual,109900);
  await change(advisor,'prepare',{service_id:service.servicio_id,percentage:40,reason:'Porcentaje fuera del tope de prueba'},409);
  const prepared=await change(advisor,'prepare',{service_id:service.servicio_id,percentage:35,reason:'El cliente pide revisar la mensualidad'});
  assert.equal(prepared.status,'requested');
  await change(advisor,'authorize',{},403);
  await transfer();
  const authorized=await change(admin,'authorize');
  assert.equal(authorized.status,'authorized');
  assert.equal(authorized.terms.cycles,6);
  const approvedCard=await until(async()=>{
    const state=await snapshot(admin);
    return /35\s*%.*Hogar Fibra 500.*6 ciclos/i.test(state.card?.advisor_draft ?? '') ? state.card : null;
  },'approved message');
  results['RET-02'].respuesta_autorizada=approvedCard.advisor_draft;
  await operatorSend(admin,approvedCard.advisor_draft);
  const thanks=await send('Listo, gracias.');
  assert.equal((await snapshot(admin)).customer_resolution,undefined);
  await change(admin,'accept',{message_id:customerId(thanks)},409);
  await send('si!');
  await operatorSend(admin,'Política de retención y descuentos · POL-RET-2026 v3.1');
  const approval=await send('si acepto');
  const accepted=await change(admin,'accept',{message_id:customerId(approval)});
  assert.equal(accepted.status,'accepted');
  assert.equal(accepted.accepted_message_id,customerId(approval));
  const scheduled=await until(async()=>{
    const state=await snapshot(admin);
    if (state.retention_discount?.error) throw Error('Scheduling failed: '+state.retention_discount.error);
    return state.retention_discount?.status==='scheduled'?state.retention_discount:null;
  },'CRM receipt and billing schedule');
  assert.ok(scheduled.crm_ref);
  assert.equal(scheduled.schedule.last_invoice,undefined);
  results['RET-02'].antes_de_emitir='Confirmado en CRM, programado en Facturación. Pendiente de emitir la factura.';
  const first=await post(path+'/retention-discount/issue',admin,{period:scheduled.schedule.next_period});
  const retry=await post(path+'/retention-discount/issue',admin,{period:first.periodo});
  assert.equal(retry.factura_id,first.factura_id);
  assert.equal(first.descuentos.length,1);
  const [discount]=first.descuentos;
  assert.equal(discount.amount,38465);
  assert.equal(discount.net,71435);
  assert.equal(first.valor_total,130850);
  assert.ok(first.detalle.some(line=>line.valor===59415 && line.concepto.includes('Claro Max')));
  const original=await get(path+'/integrations/billing/invoices/F-5003',admin);
  assert.equal(original.valor_total,169315);
  for (let cycle=2;cycle<=7;cycle++) {
    const state=await snapshot(admin);
    const invoice=await post(path+'/retention-discount/issue',admin,{period:state.retention_discount.schedule.next_period});
    assert.equal(invoice.descuentos.length,cycle===7?0:1);
    assert.equal(invoice.valor_total,cycle===7?169315:130850);
  }
  results['RET-02'].factura_emitida={periodo:first.periodo,cargo_fijo:discount.base,porcentaje:discount.percentage,
    descuento:discount.amount,neto:discount.net,otra_linea:59415};
  await operatorSend(admin,'Veo el descuento en tu nueva factura. ¿Quedó resuelta tu consulta?');
  const answer=await send('Listo, gracias.');
  const confirmed=await snapshot(admin);
  assert.equal(confirmed.customer_resolution?.satisfied_message_id,customerId(answer));
  const day=new Date(Date.now()+86400000*8).toISOString().slice(0,10);
  const closeBody={resolved:false,completion:{case_revision:confirmed.revision,idempotency_key:randomUUID(),evidence:'pendientes',
    reason:'Confirmar que el cliente leyó el detalle durante el siguiente contacto.',follow_up_date:day}};
  const closed=await post(path+'/close',admin,closeBody);
  assert.equal((await post(path+'/close',admin,closeBody)).revision,closed.revision);
  assert.equal(closed.closure.outcome,'pending');
  const history=await get('/web-chat/history',customer.cookie);
  assert.equal(history.messages.filter(message=>message.attention_notice==='closed').length,1);
  assert.equal(history.status,'closed');
  const agenda=(await get('/follow-ups?status=agreed',admin)).items.find(item=>item.case_id===closed.id);
  assert.equal(agenda.due_date,day);
  assert.ok(!(await get('/follow-ups',advisor)).items.some(item=>item.case_id===closed.id));
  const newer=new Date(Date.now()+86400000*10).toISOString().slice(0,10);
  await post(path+'/ml/follow-up',admin,{status:'rescheduled',due_date:newer,event_id:randomUUID(),case_revision:agenda.case_revision});
  const rescheduled=(await get('/follow-ups?status=agreed',admin)).items.find(item=>item.case_id===closed.id);
  assert.equal(rescheduled.due_date,newer);
  await post(path+'/ml/follow-up',admin,{status:'completed',event_id:randomUUID(),case_revision:rescheduled.case_revision});
  const complete=(await get('/follow-ups?status=completed',admin)).items.find(item=>item.case_id===closed.id);
  assert.equal(complete.status,'completed');
  results['SEG-01']={agradecimiento_despues_de_oferta:'Sin confirmación de cierre ni aceptación del beneficio.',
    confirmacion_despues_de_pregunta:'El cliente confirmó que la consulta quedó resuelta.',
    resultado:'El operador registró cierre con un pendiente y fecha acordada.',
    seguimiento_al_cerrar:agenda.status,fecha_acordada:agenda.due_date,
    seguimiento_tras_comando_del_operador:complete.status};
}
if (process.env.CLARO_RETENTION_REPORT) {
  await writeFile(process.env.CLARO_RETENTION_REPORT,JSON.stringify({case_id:item.id,results},null,2)+'\n',{mode:0o600,flag:'wx'});
}
console.log(base?'Referencia de retención y cierre capturada.':'Retención, descuento en seis ciclos, cierre, agenda y permisos verificados por HTTP.');
