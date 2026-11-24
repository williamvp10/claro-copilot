import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAgent, catalogComparison, catalogPlans} from '../dist/index.js';

const digest='a'.repeat(64);
const makeDocument=(id,title,excerpt,version='CAT-2026 v1.0',date='2026-11-01')=>({
 id,title,excerpt,version,scope:'public',type:'catalogo',status:'ready',effective_from:date,
 source:{publication:digest,key:version.includes('v2.')?'catalogo-v2':'catalogo-v1',page:1}
});
const standard=[
 makeDocument('home','Internet Hogar','Hogar Fibra 300 300 Mbps $89.900 Módem WiFi 6'),
 makeDocument('mobile','Telefonía móvil pospago','Claro Max 25 GB 25 GB $49.900 Minutos y SMS\nClaro Max 60 GB 60 GB $69.900 Todo lo anterior + Claro Video\nClaro Max Ilimitado Ilimitados* $99.900 Música'),
 makeDocument('prepaid','Telefonía móvil prepago','Paquete Día 1 GB 24 horas $3.000\nPaquete Semanal 5 GB 7 días $15.000\nPaquete Mensual 20 GB 30 días $40.000')
];

function session(documents=standard){
 const messages=[];
 const calls=[];
 const observations=[];
 let conversation_memory, pending=null, seq=0, sources=documents;
 const noPrivate=()=>{throw Error('Commercial guidance must not read an account');};
 const agent=createAgent({readCaseForRun:async()=>({verified:false,messages,pending,conversation_memory}),
  getAgentConfig:async()=>({revision:'candidate',prompts:{agent_objectives:'Decide con evidencia.',handoff_summary:'{{reason}}\n{{pending_steps}}'}}),
  getCustomerContext:noPrivate,getBilling:noPrivate,getTickets:noPrivate,evaluateRetention:noPrivate,createProposal:noPrivate
 },{observe:(_,observation)=>observations.push(observation),knowledge:{
  catalog:async context=>{calls.push('catalogue');return catalogPlans(sources,context);},
  search:async()=>{calls.push('documents');return sources;}
 }});
 async function send(text, business_date='2026-11-24', audience='cliente', observed_context) {
  const id='turn-'+(++seq);
  messages.push({id,turn_seq:seq,actor:'cliente',text,created_at:'2026-11-24T12:00:00.000Z'});
  const result=await agent.run({run_id:'run-'+seq,case_id:'catalogue-test',conversation_id:'catalogue-test',turn_id:id,turn_seq:seq,case_revision:seq,
   channel:'web',actor:'cliente',audience,attention_mode:audience==='asesor'?'asistido':'autoservicio',scope_ref:'unverified',config_revision:'candidate',business_date,text,observed_context});
  if(result.type==='answer') {
   conversation_memory=result.route==='consulta_planes' ? result.conversation_memory ?? conversation_memory : undefined;
   messages.push({id:'output-'+seq,turn_seq:++seq,actor:'agente',text:result.answer,citations:result.citations,created_at:'2026-11-24T12:00:00.000Z'});
  }
  if(result.type==='handoff') {
   pending=result.pending;
   if(result.commercial_plan) conversation_memory={selected_plan:result.commercial_plan};
  }
  return result;
 }
 return {send,calls,observations,replaceDocuments(next){sources=next;}};
}

test('COM-01 lista las dos modalidades y conserva la elección hasta la ficha del asesor', async()=>{
 const {send,calls,observations}=session();
 assert.match((await send('Quiero conocer qué planes ofrecen')).answer,/hogar.*móvil/);
 const list=await send('plan movil');
 assert.match(list.answer,/Pospago.*Claro Max 60 GB.*\$69\.900.*Prepago.*Paquete Semanal.*5 GB.*\$15\.000 por 7 días/s);
 assert.deepEqual(list.citations.map(x=>x.id),['mobile','prepaid']);
 const selected=await send('Me quedo con el de 60 GB');
 assert.equal(selected.conversation_memory.selected_plan.name,'Claro Max 60 GB');
 const benefit=await send('¿Incluye Claro Video?');
 assert.match(benefit.answer,/Claro Max 60 GB incluye Claro Video/);
 assert.deepEqual(benefit.citations.map(x=>x.id),['mobile']);
 const download=await send('¿Me pasas el catálogo para descargarlo?');
 assert.equal(download.citations[0].source.key,'catalogo-v1');
 assert.equal(download.conversation_memory.selected_plan.name,'Claro Max 60 GB');
 const handoff=await send('Sí, quiero contratarlo');
 assert.equal(handoff.type,'handoff');
 assert.match(handoff.reason,/Claro Max 60 GB.*espera de un asesor/);
 const advisor=await send('Quiero contratarlo, ¿me ayudas?','2026-11-24','asesor',{decision:'prepare_commercial_handoff'});
 assert.match(advisor.card.summary,/Claro Max 60 GB.*69\.900/);
 assert.deepEqual(advisor.card.citations.map(x=>x.id),['mobile']);
 assert.ok(advisor.card.pending.some(item=>item.includes('inscripción y facturación')));
 assert.ok(calls.every(call=>call==='catalogue'));
 assert.ok(observations.some(item=>item.metadata.prompt_ref==='handoff_summary'&&item.metadata.step_id==='prepare_handoff'));
 const later=await send('¿Me pueden revisar mi factura?','2026-11-24','asesor');
 assert.equal(later.route,'facturacion');
 assert.ok(!later.card.reason_codes.includes('commercial_selection'));
});

test('interpreta categorías expresadas sin la palabra plan y recuerda las modalidades mostradas', async()=>{
 const extra=makeDocument('prepaid','Telefonía móvil prepago','Paquete Mensual 60 GB 30 días $40.000');
 const {send,calls}=session([...standard.slice(0,2),extra]);
 assert.match((await send('que planes tienen?')).answer,/hogar.*móvil/);
 const mobile=await send('telefonia movil');
 assert.match(mobile.answer,/Pospago.*Prepago/s);
 assert.deepEqual(mobile.conversation_memory.offered_segments,['movil_pospago','movil_prepago']);
 const ambiguous=await send('El de 60 GB');
 assert.match(ambiguous.answer,/Claro Max 60 GB o Paquete Mensual/);
 const prepaid=await send('prefiero recargas');
 assert.doesNotMatch(prepaid.answer,/Pospago/);
 assert.match((await send('¿Qué opciones hay?')).answer,/^Prepago/);
 assert.equal((await send('Me quedo con el de 60 GB')).conversation_memory.selected_plan.name,'Paquete Mensual');
 assert.equal((await send('Elijo Claro Max 60 GB')).conversation_memory.selected_plan.name,'Claro Max 60 GB');
 assert.match((await send('Internet para mi casa')).answer,/Internet Hogar/);
 assert.ok(calls.every(call=>call==='catalogue'));
});

test('a question about another row does not transfer its benefits to the selected plan', async()=>{
 const {send}=session();
 await send('plan móvil');
 await send('Elijo Claro Max 60 GB, gracias');
 const result=await send('¿Incluye Música?');
 assert.match(result.answer,/No puedo confirmar/);
 assert.equal(result.citations.length,0);
 assert.match((await send('¿Qué incluye?')).answer,/Claro Max 60 GB.*Claro Video/);
});

test('continúa el catálogo desde las opciones mostradas y recuerda el plan consultado sin seleccionarlo', async()=>{
 const mobile=makeDocument('mobile','Telefonía móvil pospago',standard[1].excerpt.replace('Ilimitados* $99.900 Música',
  'Ilimitados* $99.900 Todo lo anterior + Claro Música + 10 GB de\nroaming en las Américas.\n* Plan Ilimitado: tras consumir 150 GB, la velocidad baja a 1 Mbps.'));
 const {send,calls}=session([standard[0],mobile,standard[2]]);
 await send('que planes ofrecen?');
 await send('movil');
 const detail=await send('que incluye el ilimitado?');
 assert.equal(detail.route,'consulta_planes');
 assert.match(detail.answer,/Claro Max Ilimitado.*99\.900.*Claro Video.*10 GB de roaming.*150 GB.*1 Mbps/s);
 assert.deepEqual(detail.citations.map(x=>x.id),['mobile']);
 assert.equal(detail.conversation_memory.selected_plan,undefined);
 assert.equal(detail.conversation_memory.focused_plan.name,'Claro Max Ilimitado');
 assert.match((await send('¿Y el roaming?')).answer,/Claro Max Ilimitado.*10 GB de roaming/);
 assert.match((await send('¿Cuánto cuesta?')).answer,/Claro Max Ilimitado cuesta \$99\.900/);
 assert.match((await send('Quiero contratarlo')).answer,/Cuál plan/);
 assert.equal((await send('Me quedo con ese')).conversation_memory.selected_plan.name,'Claro Max Ilimitado');
 assert.ok(calls.every(call=>call==='catalogue'));
 const priceFirst=session();
 await priceFirst.send('planes móviles');
 await priceFirst.send('¿Cuánto cuesta el de 60 GB?');
 assert.match((await priceFirst.send('¿Qué incluye?')).answer,/Claro Max 60 GB.*Claro Video/);
});

test('recupera una preferencia de catálogo anterior a seis turnos dentro del mismo asunto', ()=>{
 const message=(text,turn_seq)=>({id:String(turn_seq),actor:'cliente',text,turn_seq,created_at:'2026-11-24T12:00:00.000Z'});
 const history=[message('Busco el plan más barato de pospago',1),...Array.from({length:8},(_,index)=>message('Entendido',index+2))];
 assert.equal(catalogComparison('Dime tú',history)?.segment,'movil_pospago');
 history.splice(2,1,message('Quiero revisar mi factura',3));
 assert.equal(catalogComparison('Dime tú',history),undefined);
});

test('revalida una elección al cambiar la edición y pide una nueva confirmación', async()=>{
 const {send,replaceDocuments}=session();
 await send('Planes móviles');
 await send('Elijo Claro Max 60 GB');
 replaceDocuments([makeDocument('mobile-v2','Telefonía móvil pospago','Claro Max 60 GB 60 GB $64.900 Claro Video','CAT-2026 v2.0','2026-12-01')]);
 const changed=await send('Quiero contratarlo','2026-12-01');
 assert.equal(changed.type,'answer');
 assert.match(changed.answer,/actualizó.*64\.900.*Confirmas/);
 assert.equal(changed.conversation_memory.purchase_confirmation,true);
 assert.equal((await send('Confirmo','2026-12-01')).commercial_plan.price,64900);
});

test('retiene solo la categoría coherente y admite un nombre nuevo en una tabla publicada', async()=>{
 const conflict=[...standard,makeDocument('conflict','Telefonía móvil pospago','Claro Max 60 GB 60 GB $100.900')];
 const list=await session(conflict).send('planes móviles');
 assert.match(list.answer,/Paquete Semanal.*Falta confirmar Pospago/s);
 assert.deepEqual(list.citations.map(x=>x.id),['prepaid']);
 const {send}=session([standard[2],makeDocument('reserved','Telefonía móvil pospago','Conecta 42 GB 42 GB $57.700 Aplicaciones incluidas')]);
 assert.match((await send('planes para el celular')).answer,/Conecta 42 GB.*57\.700/);
 await send('Elijo Conecta 42 GB');
 assert.match((await send('¿Cuánto cuesta?')).answer,/Conecta 42 GB cuesta \$57\.700 al mes/);
 assert.equal((await send('Quiero comprarlo')).commercial_plan.name,'Conecta 42 GB');
});
