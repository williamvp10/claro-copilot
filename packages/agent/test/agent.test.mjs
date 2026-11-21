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
