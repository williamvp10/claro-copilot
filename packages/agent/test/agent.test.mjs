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
test('unverified account never accesses account ports',async()=>{const f=fixture({verified:false}); const out=await createAgent(f.ports).run(turn({text:'mi factura'})); assert.equal(out.type,'card'); assert.deepEqual(f.calls,[]);});
test('public plan answer has public citation; unavailable source abstains',async()=>{const f=fixture();const a=createAgent(f.ports);const out=await a.run(turn({audience:'cliente',attention_mode:'autoservicio',text:'¿Cuánto cuesta Fibra 500?'}));assert.equal(out.type,'answer');assert.ok(out.citations.length);assert.deepEqual(f.calls,[]);const b=createAgent(f.ports,{documents:[]});assert.equal((await b.run(turn({audience:'cliente',text:'precio Fibra 500'}))).type,'handoff');});
test('retention proposes only explicit customer acceptance and correct option',async()=>{const f=fixture({messages:[msg('quiero cancelar','cliente',1),msg('Le ofrezco descuento o mejora a Fibra 500','asesor',2),msg('Acepto el descuento','cliente',3)]});const a=createAgent(f.ports);const out=await a.run(turn({turn_seq:3,text:'Acepto el descuento'}));assert.equal(out.type,'card');assert.equal(out.card.proposal.detail,'discount');assert.deepEqual(f.calls.at(-1),{option_id:'discount',citation_ids:['policy']});await a.run(turn({turn_seq:3,text:'Acepto el descuento'}));assert.equal(f.calls.filter(x=>typeof x==='object').length,1);const resumed=await a.resume({run_id:'run1',effect_id:'p1',status:'confirmed',effect_ref:'crm-1'});assert.match(resumed.card.summary,/crm-1/);});
test('advisor statements and ineligible customers cannot create a proposal',async()=>{for(const scenario of [{actor:'asesor',eligible:true},{actor:'cliente',eligible:false}]){const f=fixture({eligible:scenario.eligible,messages:[msg('quiero cancelar','cliente',1)]});await createAgent(f.ports).run(turn({actor:scenario.actor,text:'Acepto el descuento'}));assert.equal(f.calls.filter(x=>typeof x==='object').length,0);}});
test('filters knowledge by date and audience',async()=>{const f=fixture();const a=createAgent(f.ports,{documents:[{id:'private',title:'Fibra',excerpt:'Secreto Fibra 500',version:'1',scope:'advisor',effective_from:'2026-01-01'},{id:'future',title:'Fibra',excerpt:'Futuro Fibra 500',version:'2',scope:'public',effective_from:'2026-12-01'}]});assert.equal((await a.run(turn({audience:'cliente',text:'Fibra 500'}))).type,'handoff');});

test('Jev receives only fixed categorical features and rejects uncertain decisions',async()=>{
 const {createJevDecisionAdapter}=await import('../dist/index.js');let body;
 const probabilities={soporte_tecnico:0.01,facturacion:0.9,consulta_planes:0.01,cancelacion:0.02,portabilidad:0.02,fuera_de_alcance:0.02,indeterminada:0.02};
 const fake=async(_url,init)=>{body=JSON.parse(init.body);return new Response(JSON.stringify({model:'typesafe/jev-1.14-20261101',answers:{intencion:{type:'choice',choice:'facturacion',probabilities},complejidad:{type:'choice',choice:'simple',probabilities:{simple:0.85,intermedia:0.05,compuesta:0.05,indeterminada:0.05}}}}),{status:200})};
 const adapter=createJevDecisionAdapter({apiKey:'test',model:'typesafe/jev-1.14',fetch:fake});const result=await adapter.classify('Mi factura de María 3101234567 maria@example.com');
 assert.equal(result.intent,'facturacion');assert.equal(body.state.senales,'facturacion');assert.doesNotMatch(JSON.stringify(body),/María|3101234567|example.com/);
 const uncertain=createJevDecisionAdapter({apiKey:'test',model:'typesafe/jev-1.14',fetch:async()=>new Response(JSON.stringify({model:'typesafe/jev-1.14',answers:{intencion:{type:'choice',choice:'facturacion',probabilities:{...probabilities,facturacion:0.3}}}}))});assert.equal(await uncertain.classify('factura'),null);
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
test('priority handoff never calls remote decision adapter',async()=>{const f=fixture();let calls=0;const a=createAgent(f.ports,{decision:{classify:async()=>{calls++;return null}}});await a.run(turn({text:'Quiero hablar con un supervisor'}));assert.equal(calls,0);});
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
test('knowledge adapter failures produce safe handoff',async()=>{const f=fixture();const a=createAgent(f.ports,{knowledge:{search:async()=>{throw Error('offline')}}});const result=await a.run(turn({audience:'cliente',text:'precio Fibra 500'}));assert.equal(result.type,'handoff');});

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
  assert.deepEqual(received, [['plan fibra', ['approved']]]);
});
