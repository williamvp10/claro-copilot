import assert from 'node:assert/strict';
import test from 'node:test';
import { initialAgentModelPolicy } from '@claro/contracts';
import { TurnModels, objectSchema, requestedAdvisor, acceptsAdvisorOffer } from '../dist/index.js';
import { authorizedHistory } from '../dist/turn-brief.js';

const output={answer:'Claro'};
const schema=objectSchema({answer:{type:'string'}});
const request={step:'write_public',profile:'economico',instructions:'Instrucción para síntesis',input:{topic:'planes'},schema,accept:value=>value?.answer==='Claro'?value:null};
function response(model) {
  return model.includes('/')
    ? Response.json({model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:30,completion_tokens:5,cost:0.001}})
    : Response.json({model,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}],usage:{input_tokens:30,output_tokens:5}});
}
function setup(policy,answer=(body)=>response(body.model),deadline=Date.now()+10000) {
  const calls=[],observations=[];
  const models=new TurnModels(policy,{openai:'direct',openrouter:'router'},'model-rev-a',deadline,
    item=>observations.push(item),async(url,init)=>{
      const body=JSON.parse(init.body);
      calls.push({url,body,auth:init.headers.Authorization});
      return answer(body);
    });
  return {models,calls,observations};
}

test('automatic model selection limits alternative providers to explicitly enabled steps and profiles',async()=>{
  const policy=structuredClone(initialAgentModelPolicy);
  policy.steps.write_public.alternatives=['mistralai/mistral-small-3.2-24b-instruct'];
  const {models,calls,observations}=setup(policy);
  assert.deepEqual(await models.call(request),output);
  assert.deepEqual(await models.call({...request,profile:'complejo'}),output);
  assert.deepEqual(await models.call({...request,step:'support_evidence'}),output);
  assert.deepEqual(calls.map(item=>[item.url,item.body.model,item.auth]),[
    ['https://openrouter.ai/api/v1/chat/completions','mistralai/mistral-small-3.2-24b-instruct','Bearer router'],
    ['https://api.openai.com/v1/responses','gpt-6.2-sol','Bearer direct'],
    ['https://api.openai.com/v1/responses','gpt-6-luna','Bearer direct']
  ]);
  assert.equal(calls[0].body.provider.require_parameters,true);
  assert.equal(calls[0].body.provider.zdr,true);
  assert.equal(calls[1].body.store,false);
  assert.deepEqual(observations.map(item=>item.metadata.cost_basis),['provider','rate_estimate','rate_estimate']);
  assert.ok(observations.every(item=>item.metadata.model_config_revision==='model-rev-a'));
});

test('policy provisions only one fallback and shares the turn budget across concurrent calls',async()=>{
  const policy=structuredClone(initialAgentModelPolicy);
  policy.steps.write_public={mode:'fixed',model:'gpt-6-luna',fallback:'gpt-6.1-terra'};
  const failed=setup(policy,()=>new Response(null,{status:429}));
  assert.equal(await failed.models.call(request),null);
  assert.deepEqual(failed.calls.map(call=>call.body.model),['gpt-6-luna','gpt-6.1-terra']);
  assert.deepEqual(failed.observations.map(item=>item.metadata.selection),['fixed','fallback']);
  policy.max_cost_usd=0.0004;
  const limited=setup(policy);
  const results=await Promise.all([limited.models.call(request),limited.models.call(request)]);
  assert.equal(results.filter(Boolean).length,1);
  assert.equal(limited.calls.length,1);
  const expired=setup(policy,undefined,Date.now());
  assert.equal(await expired.models.call(request),null);
  assert.equal(expired.calls.length,0);
});

test('provider response must identify the approved model',async()=>{
  const policy=structuredClone(initialAgentModelPolicy);
  policy.steps.write_public={mode:'fixed',model:'gpt-6-luna'};
  const {models,observations}=setup(policy,()=>response('different-model'));
  assert.equal(await models.call(request),null);
  assert.equal(observations[0].metadata.effective_model,'');
});

test('the conversation window is ordered and excludes both the current turn and verification', () => {
  const messages=Array.from({length:20},(_,i)=>({id:String(i+1),turn_seq:i+1,actor:i%2?'cliente':'asesor',
    text:'mensaje',created_at:'2026-11-24T00:00:00Z',...(i===10?{verification_input:true}:{})}));
  const result=authorizedHistory(messages.reverse(),20);
  assert.equal(result.length,15);
  assert.equal(result[0].turn_seq,4);
  assert.equal(result.at(-1).turn_seq,19);
  assert.ok(!result.some(message=>message.turn_seq===11));
});

test('human attention requires a request or a confirmed offer',()=>{
  for(const text of ['sí pásame un asesor','quiero que me atienda una asesora','¿Me pueden pasar a un asesor?','comunícame con una persona'])
    assert.equal(requestedAdvisor(text),true,text);
  for(const text of ['no me pases a un asesor','¿cuánto cuesta el plan del asesor?','sin hablar con un asesor','gracias'])
    assert.equal(requestedAdvisor(text),false,text);
  assert.equal(acceptsAdvisorOffer('Sí, por favor','¿Quieres hablar con uno?'),true);
  assert.equal(acceptsAdvisorOffer('Sí, por favor','¿Quieres ver los planes?'),false);
});

test('verified assisted billing and catalogue share a reading round',async()=>{
  const {createAgent}=await import('../dist/index.js');
  const observed=[],started=[];
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const read=async (name,result)=>{
    started.push(name);
    if (started.length===2) release();
    await gate;
    return result;
  };
  const citation={id:'plans-1',title:'Catálogo',version:'CAT-2026 v1.0',excerpt:'Claro Libre 20 GB $45.000'};
  const agent=createAgent({
    readCaseForRun:async()=>({messages:[],verified:true,pending:null}),
    getAgentConfig:async()=>({revision:'prompts-v1',prompts:{agent_objectives:'Ordena las tareas.'}}),
    getCustomerContext:async()=>[], getBilling:async()=>[],
    listInvoices:()=>read('invoice',[{id:'invoice-amount',label:'Valor de la factura',value:'COP 78.000'}]),
    getTickets:async()=>[], evaluateRetention:async()=>assert.fail('Unexpected eligibility'),
    createProposal:async()=>assert.fail('Unexpected effect'),
  },{turnTimeoutMs:1200,observe:(_,item)=>observed.push(item),knowledge:{
    search:async()=>[],
    catalog:()=>read('catalog',[{name:'Claro Libre',segment:'movil_pospago',price:45000,allowance:'20 GB',citation}]),
  }});
  const result=await agent.run({run_id:'parallel',case_id:'test',conversation_id:'conv',turn_id:'msg',channel:'web',
    actor:'cliente',turn_seq:1,case_revision:1,attention_mode:'asistido',audience:'asesor',scope_ref:'verified',config_revision:'prompts-v1',
    model_config_revision:'models-v1',business_date:'2026-11-24',text:'¿Por qué subió mi factura y qué planes de celular más baratos tienen?'});
  assert.equal(result.type,'card');
  assert.deepEqual([...started].sort(),['catalog','invoice']);
  assert.match(result.card.summary,/Claro Libre/);
  const rounds=observed.filter(item=>['tool.billing.list_invoices','tool.list_catalog_plans'].includes(item.name));
  assert.deepEqual(rounds.map(item=>item.metadata.round),[1,1]);
  assert.ok(observed.some(item=>item.name==='orchestrator.delegate' && item.metadata.max_parallel===2));
});
