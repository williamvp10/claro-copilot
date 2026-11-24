import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../dist/index.js';
const turn = (overrides={}) => ({run_id:'run1',case_id:'c1',conversation_id:'conv1',turn_id:'t1',channel:'web',actor:'cliente',turn_seq:1,case_revision:1,attention_mode:'asistido',audience:'asesor',scope_ref:'scope1',config_revision:'v1',business_date:'2026-11-18',text:'quiero cancelar',...overrides});
const msg = (text, actor, seq) => ({id:`m${seq}`,turn_seq:seq,actor,text,created_at:'2026-11-18T12:00:00Z'});
const policy = {id:'policy',title:'Política',excerpt:'Condiciones de retención',version:'1'};
function fixture({verified=true,messages=[],eligible=true}={}) {
 const calls=[]; const ports={
  readCaseForRun:async()=>({messages,verified,pending:null}), getAgentConfig:async()=>({revision:'v1',prompts:{}}),
  getCustomerContext:async()=>{calls.push('customer');return [{id:'age',label:'Antigüedad',value:'30 meses'}]},
  getBilling:async()=>{calls.push('billing');return [{id:'amount',label:'Factura',value:'169315'}]},
  getTickets:async()=>{calls.push('tickets');return []},
  evaluateRetention:async()=>{calls.push('retention');return {eligible,reason:eligible?'Cumple la política':'45 días de mora',facts:[],policy,options:eligible?[{id:'discount',title:'Descuento',detail:'30 % por seis meses'},{id:'upgrade',title:'Mejora Fibra 500',detail:'sin costo por seis meses'}]:[]}},
  createProposal:async(_run,input)=>{calls.push(input);return {id:'p1',revision:1,title:'Oferta',detail:input.option_id,status:'pending_approval'}}
 }; return {ports,calls};
}
function expectAnOfferToEscalate(result) {
 assert.equal(result.type,'answer');
 assert.deepEqual(result.citations,[]);
 assert.match(result.answer,/¿Quieres hablar con uno\?/);
}
test('unverified account never accesses account ports',async()=>{const f=fixture({verified:false}); const out=await createAgent(f.ports).run(turn({text:'mi factura'})); assert.equal(out.type,'card'); assert.deepEqual(f.calls,[]);});
test('public plan answer has public citation; unavailable source abstains',async()=>{const f=fixture();const a=createAgent(f.ports);const out=await a.run(turn({audience:'cliente',attention_mode:'autoservicio',text:'¿Cuánto cuesta Fibra 500?'}));assert.equal(out.type,'answer');assert.ok(out.citations.length);assert.deepEqual(f.calls,[]);const b=createAgent(f.ports,{documents:[]});expectAnOfferToEscalate(await b.run(turn({audience:'cliente',text:'precio Fibra 500'})));});
test('retention proposes only explicit customer acceptance and correct option',async()=>{const f=fixture({messages:[msg('quiero cancelar','cliente',1),msg('Le ofrezco descuento o mejora a Fibra 500','asesor',2),msg('Acepto el descuento','cliente',3)]});const a=createAgent(f.ports);const out=await a.run(turn({turn_seq:3,text:'Acepto el descuento'}));assert.equal(out.type,'card');assert.equal(out.card.proposal.detail,'discount');assert.deepEqual(f.calls.at(-1),{option_id:'discount',citation_ids:['policy']});await a.run(turn({turn_seq:3,text:'Acepto el descuento'}));assert.equal(f.calls.filter(x=>typeof x==='object').length,1);const resumed=await a.resume({run_id:'run1',effect_id:'p1',status:'confirmed',effect_ref:'crm-1'});assert.match(resumed.card.summary,/crm-1/);});
test('advisor statements and ineligible customers cannot create a proposal',async()=>{for(const scenario of [{actor:'asesor',eligible:true},{actor:'cliente',eligible:false}]){const f=fixture({eligible:scenario.eligible,messages:[msg('quiero cancelar','cliente',1)]});await createAgent(f.ports).run(turn({actor:scenario.actor,text:'Acepto el descuento'}));assert.equal(f.calls.filter(x=>typeof x==='object').length,0);}});
test('filters knowledge by date and audience',async()=>{const f=fixture();const a=createAgent(f.ports,{documents:[{id:'private',title:'Fibra',excerpt:'Secreto Fibra 500',version:'1',scope:'advisor',effective_from:'2026-01-01'},{id:'future',title:'Fibra',excerpt:'Futuro Fibra 500',version:'2',scope:'public',effective_from:'2026-12-01'}]});expectAnOfferToEscalate(await a.run(turn({audience:'cliente',text:'Fibra 500'})));});

test('plans guidance uses the active catalogue and follows the prior question on web and Telegram', async () => {
 const home={id:'catalogo-v2-003',title:'Catálogo · Internet Hogar',version:'CAT-2026 v2.0',scope:'public',type:'catalogo',
  effective_from:'2026-12-01',excerpt:'Internet Hogar\nHogar Fibra 300 300 Mbps $84.900 Módem WiFi 6\nHogar Fibra 500 500 Mbps $109.900 Módem WiFi 6 + 1 repetidor WiFi'};
 const mobile={...home,id:'catalogo-v2-004',title:'Catálogo · Telefonía móvil',excerpt:'Telefonía móvil pospago\nClaro Max 30 GB $49.900'};
 for (const channel of ['web','telegram']) {
  const messages=[];
  const {ports,calls}=fixture({verified:false,messages});
  const agent=createAgent(ports,{documents:[home,mobile]});
  async function send(text) {
   messages.push(msg(text,'cliente',messages.length+1));
   const result=await agent.run(turn({run_id:`r${messages.length}`,turn_seq:messages.length,channel,
     business_date:'2026-12-01',audience:'cliente',attention_mode:'autoservicio',text}));
   assert.equal(result.type,'answer');
   messages.push({...msg(result.answer+(channel==='telegram'?'\nFuente: Catálogo':''),'agente',messages.length+1),citations:result.citations});
   return result;
  }
  assert.match((await send('¿Qué planes tienen?')).answer,/hogar.*móvil.*¿Cuál/);
  assert.match((await send('Para mi casa')).answer,/qué tan grande/);
  const recommended=await send('Mi casa es grande y somos 6 personas');
  assert.match(recommended.answer,/Fibra 500.*109\.900.*repetidor/);
  assert.doesNotMatch(recommended.answer,/84\.900|Claro Max/);
  assert.deepEqual(recommended.citations.map(c=>c.id),[home.id]);
  assert.deepEqual(calls,[]);
 }
});

test('the orchestrator routes a billing turn using the case context',async()=>{
 const {ports,calls}=fixture();
 const spans=[];
 const result=await createAgent(ports,{observe:(_,span)=>spans.push(span)}).run(turn({text:'¿Cuál es mi saldo pendiente?'}));
 assert.equal(result.route,'facturacion');
 assert.deepEqual(calls,['billing']);
 const step=spans.find(span=>span.metadata.step_id==='classify_turn');
 assert.equal(step?.metadata.decision,'orchestrator');
 assert.equal(step?.metadata.intent,'facturacion');
});
test('OpenAI selector sends only signals and accepts only an authorized index',async()=>{
 const {createOpenAIEvidenceSelector}=await import('../dist/index.js');let body;
 const selector=createOpenAIEvidenceSelector({apiKey:'test',models:{economico:'configured-model'},fetch:async(_url,init)=>{body=JSON.parse(init.body);return new Response(JSON.stringify({model:'configured-model',output:[{type:'message',content:[{type:'output_text',text:'1'}]}]}))}});
 const result=await selector.select('factura de María 123456789',[{id:'a',title:'plan',excerpt:'secreto María',version:'1'},{id:'b',title:'factura',excerpt:'cobro 123456789',version:'1'}],'economico');assert.equal(result,1);assert.doesNotMatch(JSON.stringify(body),/María|123456789|secreto/);assert.equal(body.store,false);
});
test('semantic evaluation blocks failed deterministic checks and does not promote lossy judgments',async()=>{
 const {createJevSemanticEvaluator}=await import('../dist/index.js');let calls=0,body;
 const evaluator=createJevSemanticEvaluator({apiKey:'test',model:'typesafe/jev-1.14',fetch:async(_url,init)=>{calls++;body=JSON.parse(init.body);return new Response(JSON.stringify({model:'typesafe/jev-1.14',answers:{q0:{type:'choice',choice:'presente',probabilities:{presente:0.9,ausente:0.05,ambiguo:0.05}}}}))}});
 const observation={question:'María consulta factura 123456789',answer:'La factura está pendiente de pago',evidence:['Factura pendiente'],requiredFacts:['Factura pendiente'],deterministicPassed:false};assert.equal((await evaluator.evaluate(observation)).status,'fail');assert.equal(calls,0);observation.deterministicPassed=true;assert.equal((await evaluator.evaluate(observation)).status,'review');assert.doesNotMatch(JSON.stringify(body),/María|123456789/);
});
test('priority handoff bypasses the orchestrator classification step',async()=>{
 const f=fixture();const spans=[];
 await createAgent(f.ports,{observe:(_,span)=>spans.push(span)}).run(turn({text:'Quiero hablar con un supervisor'}));
 assert.ok(!spans.some(span=>span.metadata.step_id==='classify_turn'));
});
test('MCP read-only adapter sends a minimized query and accepts structured documents',async()=>{
 const {createKnowledgeMcpAdapter}=await import('../dist/index.js');const requests=[];
 const fake=async(_url,init)=>{if (init.method==='GET') return new Response(null,{status:405});const body=init.body?JSON.parse(init.body):null;requests.push(body);
  if (!body?.id && body?.id!==0) return new Response(null,{status:202});
  const result=body.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:{content:[],structuredContent:{documents:[{id:'faq',title:'E-202',excerpt:'Refrescar señal',version:'v1',scope:'public',effective_from:'2026-01-01',status:'ready'}]}};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{status:200,headers:{'content-type':'application/json'}});
 };
 const adapter=createKnowledgeMcpAdapter({url:'http://localhost:3001/mcp',fetch:fake});const result=await adapter.search('María 3101234567 tiene error E-202 en televisor',{business_date:'2026-11-18',audience:'cliente',channel:'telegram'});
 assert.equal(result[0].id,'faq');const call=requests.find(r=>r?.method==='tools/call');assert.equal(call.params.name,'search_knowledge');assert.match(call.params.arguments.query,/E-202/);assert.doesNotMatch(JSON.stringify(call),/María|3101234567/);
});
test('knowledge adapter failures offer a handoff',async()=>{const f=fixture();const a=createAgent(f.ports,{knowledge:{search:async()=>{throw Error('offline')}}});const result=await a.run(turn({audience:'cliente',text:'precio Fibra 500'}));expectAnOfferToEscalate(result);});

test('public generation receives only current sources approved for the provider', async () => {
  const { ports } = fixture({ verified:false });
  const base = { title:'Fibra 500', excerpt:'Descripción del plan Fibra 500', version:'v1',
    scope:'public', effective_from:'2026-01-01' };
  const received = [];
  const agent = createAgent(ports, {
    documents: [
      { ...base, id:'local-only' },
      { ...base, id:'approved', provider_approved:true },
      { ...base, id:'internal', scope:'advisor', provider_approved:true },
      { ...base, id:'future', effective_from:'2026-12-01', provider_approved:true }
    ],
    writer: { write: async (topic, sources) => {
      received.push([topic, sources.map(source => source.id)]);
      return { answer:sources[0].excerpt, citations:sources };
    } }
  });
  const result = await agent.run(turn({ audience:'cliente', attention_mode:'autoservicio',
    text:'¿Qué incluye el plan fibra de María 3101234567?' }));
  assert.equal(result.type, 'answer');
  assert.deepEqual(received, [['incluye plan fibra', ['approved']]]);
});

test('an advisor can retrieve general policy without unlocking an account or publishing it to the customer', async () => {
  const f = fixture({verified:false});
  const document = {id:'policy-billing-001', title:'Reglas de facturación', excerpt:'El ajuste general requiere autorización del supervisor.',
    version:'1', scope:'advisor', effective_from:'2026-01-01'};
  const a = createAgent(f.ports,{documents:[document]});
  const question = '¿Cuál es la política de ajuste de facturación?';
  const advisor = await a.run(turn({text:question}));
  assert.deepEqual(advisor.card.citations.map(item=>item.id),[document.id]);
  assert.deepEqual(f.calls,[]);
  const customer = await a.run(turn({run_id:'public',audience:'cliente',attention_mode:'autoservicio',text:question}));
  expectAnOfferToEscalate(customer);
  assert.deepEqual(f.calls,[]);
});

test('a stock forecast never receives a catalog answer', async () => {
  const {ports} = fixture();
  const agent = createAgent(ports);
  const result = await agent.run(turn({audience:'cliente',attention_mode:'autoservicio',
    text:'¿Cuál será el precio de las acciones de una compañía?'}));
  assert.equal(result.type,'handoff');
  assert.equal(result.route,'fuera_de_alcance');
});

test('Jev question templates require exactly the fixed choice keys', async () => {
  const { parseJevQuestion } = await import('../dist/index.js');
  assert.equal(parseJevQuestion(JSON.stringify({instructions:'Choose',criteria:{a:'A',b:'B',extra:'X'}}),['a','b']),null);
  assert.deepEqual(parseJevQuestion(JSON.stringify({instructions:'Check {{rubric_statement}}',criteria:{a:'A',b:'B'}}),['a','b'],{rubric_statement:'safe'}),{instructions:'Check safe',criteria:{a:'A',b:'B'}});
});

test('billing subgraph reads billing only and a composed case activates the billing subgraph once', async () => {
 const billing=fixture();
 const invoice=await createAgent(billing.ports).run(turn({text:'Muéstrame mi factura'}));
 assert.equal(invoice.type,'card');
 assert.deepEqual(billing.calls,['billing']);
 const composed=fixture();
 const result=await createAgent(composed.ports).run(turn({text:'Quiero cancelar y revisar mi factura'}));
 assert.equal(result.type,'card');
 assert.equal(composed.calls.filter(x=>x==='billing').length,1);
 assert.ok(result.card.facts.some(f=>f.id==='amount'));
});

test('account billing selects balance, invoice list or a specific detail without arbitrary extra reads', async () => {
 const f=fixture();
 f.ports.listInvoices=async()=>{f.calls.push('invoices');return [{id:'F-1001',label:'Factura',value:'pendiente'}]};
 f.ports.getInvoiceDetail=async(_run,id)=>{f.calls.push(`detail:${id}`);return [{id:'detail',label:'Cargo',value:'100'}]};
 await createAgent(f.ports).run(turn({text:'Quiero saber mi saldo'}));
 assert.deepEqual(f.calls,['billing']); f.calls.length=0;
 await createAgent(f.ports).run(turn({text:'Muéstrame mi factura'}));
 assert.deepEqual(f.calls,['invoices']); f.calls.length=0;
 await createAgent(f.ports).run(turn({text:'Detalle de mi factura F-1001'}));
 assert.deepEqual(f.calls,['detail:F-1001']); f.calls.length=0;
 await createAgent(f.ports).run(turn({text:'Detalle de mi factura F-1001 y cuánto debo'}));
 assert.deepEqual(f.calls,['detail:F-1001','billing']);
});

test('a question about a billed plan reads the owned invoice first and compares the current service', async () => {
 const f=fixture(); const spans=[];
 f.ports.getInvoiceDetail=async(_run,id)=>{
  f.calls.push(`detail:${id}`);
  return id==='F-1001' ? [{id:'item',label:'Internet',value:'100'}] : [{id:'billing-unavailable',label:'Facturación',value:'No autorizado'}];
 };
 f.ports.listServices=async()=>{f.calls.push('services');return [{id:'service',label:'Fibra',value:'120'}];};
 const agent=createAgent(f.ports,{observe:(_run,item)=>spans.push(item)});
 const ask = id=>`¿Por qué subió mi factura ${id} con el cambio de mi plan?`;
 const answer=await agent.run(turn({text:ask('F-1001')}));
 assert.deepEqual(f.calls,['detail:F-1001','services']);
 assert.deepEqual(answer.card.facts.map(fact=>fact.id),['item','service']);
 assert.match(answer.card.next_action,/solo si los conceptos/);
 assert.deepEqual(spans.filter(item=>item.name.startsWith('tool.')).map(item=>[item.name,item.metadata.purpose]),[
  ['tool.billing.get_invoice_detail','inspect_invoice'],['tool.crm.list_services','compare_billed_service']]);
 assert.doesNotMatch(JSON.stringify(spans),/F-1001/);
 f.calls.length=0;
 await agent.run(turn({run_id:'foreign',text:ask('F-1002')}));
 assert.deepEqual(f.calls,['detail:F-1002']);
});

test('a compound cancellation checks support recurrence before any offer and reads billing once', async () => {
 const f=fixture(); const spans=[];
 f.ports.getTickets=async()=>{f.calls.push('tickets');return [{id:'technical-tickets-90d',label:'Tickets',value:'4'}];};
 f.ports.listInvoices=async()=>{f.calls.push('invoices');return [{id:'F-1001',label:'Factura',value:'pendiente'}];};
 const result=await createAgent(f.ports,{observe:(_run,item)=>spans.push(item)})
  .run(turn({text:'Quiero cancelar. Se cae el internet todos los días y también quiero saber por qué subió mi factura.'}));
 assert.equal(result.route,'cancelacion');
 assert.equal(result.card.proposal?.detail,'priority-ticket');
 assert.deepEqual(f.calls.slice(0,2).sort(),['customer','tickets']);
 assert.equal(f.calls.filter(call=>call==='invoices').length,1);
 assert.ok(!f.calls.includes('retention'));
 assert.equal(spans.find(item=>item.name==='tool.crm.list_recent_tickets')?.metadata.agent_id,'soporte');
});

test('advisor draft keeps authorized amounts and filters unsupported claims even in a local template', async () => {
 const f=fixture();
 f.ports.getAgentConfig=async()=>({revision:'v1',prompts:{
  advisor_empathy:'Entiendo lo incómodo que es {{reported_issue}}.',
  billing_reply:'Ya quedó confirmado el ajuste de 5.000. {{billing_fact_sentence}}'
 }});
 const draft=await createAgent(f.ports).run(turn({text:'Mi saldo subió y no entiendo el cargo'}));
 assert.match(draft.card.advisor_draft,/Entiendo lo incómodo/);
 assert.match(draft.card.advisor_draft,/169315/);
 assert.doesNotMatch(draft.card.advisor_draft,/confirmado|5\.000/);
 const neutral=await createAgent(f.ports).run(turn({text:'¿Cuál es mi saldo?'}));
 assert.doesNotMatch(neutral.card.advisor_draft,/incómodo/);
});
test('live mode does not call providers when approved templates are missing',async()=>{
 const f=fixture({verified:false});let calls=0;
 const agent=createAgent(f.ports,{requireApprovedPrompts:true,writer:{write:async()=>{calls++;return null}},evidenceSelector:{select:async()=>{calls++;return null}},documents:[{id:'p1',title:'Fibra',excerpt:'Fibra 500',version:'1',scope:'public',effective_from:'2026-01-01',provider_approved:true},{id:'p2',title:'Fibra',excerpt:'Fibra 500',version:'1',scope:'public',effective_from:'2026-01-01',provider_approved:true}]});
 const out=await agent.run(turn({attention_mode:'autoservicio',audience:'cliente',text:'Cuánto cuesta fibra 500'}));
 assert.equal(out.type,'answer');assert.equal(calls,0);
});

test('mandatory escalation is suggested before any model, tool or effect', async () => {
 const cases=[
  ['La luz LOS está roja hace 11 minutos','soporte_tecnico','los_rojo_mas_de_10_minutos'],
  ['LOS rojo hace más de diez minutos','soporte_tecnico','los_rojo_mas_de_10_minutos'],
  ['Ya reinicié el módem 4 veces','soporte_tecnico','mas_de_tres_reinicios'],
  ['La fibra está cortada','soporte_tecnico','dano_fisico'],
  ['Sospecho fraude y la luz LOS roja lleva 15 minutos','supervision','riesgo_de_fraude'],
  ['Presentaré una tutela por portabilidad','supervision','requerimiento_legal_o_regulatorio'],
  ['La cuenta es a nombre de mi madre','supervision','solicitud_de_tercero'],
  ['Soy una persona vulnerable','supervision','riesgo_o_vulnerabilidad']
 ];
 for (const [text,destination,reason] of cases) {
  const f=fixture();const spans=[];
  const agent=createAgent(f.ports,{observe:(_,span)=>spans.push(span)});
  const out=await agent.run(turn({text}));
  assert.equal(out.type,'card',text);assert.deepEqual(out.card.suggested_escalation,{destination,reason_code:reason},text);
  assert.ok(!spans.some(span=>span.metadata.step_id==='classify_turn'),text);assert.deepEqual(f.calls,[],text);
 }
});
test('LOS at ten minutes or without a duration does not assert the >10 minute policy', async () => {
 const {mandatoryPolicyRoute}=await import('../dist/index.js');
 assert.equal(mandatoryPolicyRoute('La luz LOS está roja desde hace 10 minutos'),undefined);
 assert.equal(mandatoryPolicyRoute('La luz LOS está roja'),undefined);
 assert.equal(mandatoryPolicyRoute('Reinicié el módem tres veces'),undefined);
});

test('duration supplied in the next turn completes the LOS escalation condition',async()=>{
 const f=fixture({messages:[msg('La luz LOS está roja','cliente',1),msg('¿Cuántos minutos lleva roja?','asesor',2),msg('Hace 15 minutos','cliente',3)]});
 const spans=[];
 const out=await createAgent(f.ports,{observe:(_,span)=>spans.push(span)}).run(turn({turn_seq:3,text:'Hace 15 minutos'}));
 assert.equal(out.type,'card');assert.equal(out.card.suggested_escalation?.reason_code,'los_rojo_mas_de_10_minutos');assert.ok(!spans.some(span=>span.metadata.step_id==='classify_turn'));assert.deepEqual(f.calls,[]);
});

test('WiFi change uses the three contiguous manual steps with their original citations',async()=>{
 const f=fixture({verified:false});
 const base={title:'Manual de módem ZTX-F680 · pág. 1',version:'MAN-ZTX-F680 Rev. B',scope:'public',effective_from:'2026-11-18',status:'ready'};
 const documents=[
  {...base,id:'modem-006',excerpt:'2. Restablecimiento de fábrica: presione RESET; se borran la contraseña WiFi personalizada.'},
  {...base,id:'modem-007',excerpt:'4. Cambiar el nombre y la contraseña de la red WiFi'},
  {...base,id:'modem-008',excerpt:'1. Conéctese a la red del módem por cable o WiFi.'},
  {...base,id:'modem-009',excerpt:'2. Abra un navegador e ingrese a http://192.168.1.1.'},
  {...base,id:'modem-010',excerpt:'3. Usuario: admin. Contraseña: la indicada en la etiqueta inferior del equipo.'},
  {...base,id:'modem-011',excerpt:'4. Vaya a Red > WLAN > SSID, cambie el nombre de red y la contraseña (mínimo 8 caracteres) y guarde.'}
 ];
 const agent=createAgent(f.ports,{documents});
 const result=await agent.run(turn({audience:'cliente',attention_mode:'autoservicio',text:'¿Cómo cambio la contraseña de mi WiFi?'}));
 assert.equal(result.type,'answer');
 assert.deepEqual(result.citations.map(c=>c.id),['modem-009','modem-010','modem-011']);
 assert.notEqual(result.answer,result.citations.map(c=>c.excerpt).join('\n'));
 assert.match(result.answer,/mínimo 8 caracteres/);
 assert.match(result.answer,/192\.168\.1\.1/);assert.match(result.answer,/admin/);assert.match(result.answer,/WLAN/);
 assert.doesNotMatch(result.answer,/RESET|fábrica|restablecimiento/i);
 assert.deepEqual(f.calls,[]);
});
test('WiFi procedure is not assembled across missing, expired or different-version steps',async()=>{
 const f=fixture({verified:false});
 const base={title:'Manual de módem',version:'v1',scope:'public',effective_from:'2026-01-01',status:'ready'};
 const first={...base,id:'modem-009',excerpt:'2. Abra un navegador e ingrese a http://192.168.1.1.'};
 const middle={...base,id:'modem-010',excerpt:'3. Usuario: admin. Contraseña: la indicada en la etiqueta inferior del equipo.'};
 const last={...base,id:'modem-011',excerpt:'4. Vaya a Red > WLAN > SSID, cambie la contraseña y guarde.'};
 for(const documents of [[first,last],[first,{...middle,version:'v2'},last],[first,{...middle,effective_to:'2026-11-18'},last]]) {
  const out=await createAgent(f.ports,{documents}).run(turn({audience:'cliente',attention_mode:'autoservicio',text:'¿Cómo cambio la contraseña de mi WiFi?'}));
  assert.equal(out.type,'answer');
  assert.equal(out.answer.includes('192.168.1.1') && out.answer.includes('admin') && out.answer.includes('WLAN'),false);
 }
});

test('complete WiFi procedure keeps all steps local and skips the writer',async()=>{
 const f=fixture({verified:false});const base={title:'Manual de módem',version:'v1',scope:'public',effective_from:'2026-01-01',status:'ready'};
 const docs=[
  {...base,id:'modem-009',excerpt:'2. Abra un navegador e ingrese a http://192.168.1.1.',provider_approved:true},
  {...base,id:'modem-010',excerpt:'3. Usuario: admin. Contraseña: la indicada en la etiqueta inferior del equipo.'},
  {...base,id:'modem-011',excerpt:'4. Vaya a Red > WLAN > SSID, cambie la contraseña y guarde.',provider_approved:true}
 ];
 let submitted=[];const writer={write:async(_topic,sources)=>{submitted=sources.map(source=>source.id);return null;}};
 const out=await createAgent(f.ports,{documents:docs,writer}).run(turn({audience:'cliente',attention_mode:'autoservicio',text:'¿Cómo cambio la contraseña de mi WiFi?'}));
 assert.deepEqual(submitted,[]);
 assert.equal(out.type,'answer');assert.match(out.answer,/admin/);assert.deepEqual(out.citations.map(c=>c.id),['modem-009','modem-010','modem-011']);
});

test('GQ-25 reads current services and balance only after verification',async()=>{
 const text='¿Cuál es el plan actual y el saldo pendiente del cliente C-1001?';
 const f=fixture();const spans=[];
 f.ports.listServices=async()=>{f.calls.push('services');return [{id:'home',label:'Hogar Fibra 500',value:'$109.900'},{id:'mobile',label:'Claro Max 60 GB',value:'$59.415'}]};
 f.ports.getBilling=async()=>{f.calls.push('billing');return [{id:'balance',label:'Saldo',value:'$169.315'},{id:'due',label:'Vencimiento',value:'2026-11-25'}]};
 const agent=createAgent(f.ports,{observe:(_,item)=>spans.push(item)});
 const out=await agent.run(turn({actor:'asesor',text}));
 assert.equal(out.type,'card');assert.equal(out.route,'facturacion');assert.deepEqual(f.calls,['billing','services']);
 assert.deepEqual(out.card.facts.map(x=>x.id),['balance','due','home','mobile']);
 assert.equal(spans.find(x=>x.name==='tool.crm.list_services')?.metadata.purpose,'review_current_plan');
 const denied=fixture({verified:false});
 const deniedOut=await createAgent(denied.ports).run(turn({actor:'asesor',text}));
 assert.equal(deniedOut.type,'card');assert.ok(deniedOut.card.reason_codes.includes('verification_required'));assert.deepEqual(denied.calls,[]);
 const publicCase=fixture({verified:false});
 const publicOut=await createAgent(publicCase.ports).run(turn({actor:'cliente',audience:'cliente',attention_mode:'autoservicio',text:'¿Cuál es mi plan actual y el saldo pendiente?'}));
 assert.equal(publicOut.type,'handoff');assert.equal(publicOut.verification_required,true);assert.deepEqual(publicCase.calls,[]);
});

test('GQ-28 inspects confirmed recurrence and leaves scheduling pending after ticket registration',async()=>{
 const text='El cliente C-1013 llama a cancelar por fallas. ¿Cuál es el siguiente paso?';
 const f=fixture();
 f.ports.getCustomerContext=async()=>{f.calls.push('customer');return [{id:'tenure',label:'Antigüedad',value:'26 meses'}]};
 f.ports.getTickets=async()=>{f.calls.push('tickets');return [{id:'technical-tickets-90d',label:'Tickets técnicos en 90 días',value:'4'}]};
 f.ports.createProposal=async(_id,input)=>{f.calls.push(input);return {id:'ticket-proposal',revision:1,title:'Ticket prioritario',detail:'Visita técnica prioritaria dentro de 24 horas',kind:'support_ticket',status:'pending_approval'}};
 const agent=createAgent(f.ports);
 const out=await agent.run(turn({actor:'asesor',text}));
 assert.equal(out.type,'card');assert.equal(out.route,'cancelacion');assert.deepEqual(f.calls.slice(0,2).sort(),['customer','tickets']);
 assert.deepEqual(f.calls[2],{option_id:'priority-ticket',citation_ids:['retention-recurrent-faults']});assert.ok(!f.calls.includes('retention'));
 assert.match(out.card.summary,/visita (?:técnica )?prioritaria.*24 horas/i);assert.equal(out.card.proposal.status,'pending_approval');
 const resumed=await agent.resume({run_id:'run1',effect_id:'ticket-proposal',status:'confirmed',effect_ref:'ticket-123'});
 assert.equal(resumed.type,'card');assert.match(resumed.card.summary,/ticket registrado.*pendiente de coordinación/i);assert.doesNotMatch(resumed.card.summary,/agendad[ao]|visita confirmada/i);
});

test('a cancellation attributed to faults without confirmed recurrence does not create a ticket',async()=>{
 const f=fixture();f.ports.getTickets=async()=>{f.calls.push('tickets');return [{id:'technical-tickets-90d',label:'Tickets',value:'2'}]};
 const out=await createAgent(f.ports).run(turn({actor:'asesor',text:'El cliente C-1013 llama a cancelar por fallas. ¿Cuál es el siguiente paso?'}));
 assert.equal(out.type,'card');assert.ok(f.calls.includes('tickets'));assert.equal(f.calls.some(x=>typeof x==='object'),false);
});
