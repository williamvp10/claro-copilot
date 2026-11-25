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

test('a retired local model in an old policy cannot make an inference request',async()=>{
  const policy=structuredClone(initialAgentModelPolicy);
  policy.steps.write_public={mode:'fixed',model:'claro-llama'};
  const {models,calls}=setup(policy);
  assert.equal(await models.call(request),null);
  assert.equal(calls.length,0);
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

test('a response uses the approved OpenAI tuning and preserves the structured format',async()=>{
  const policy=structuredClone(initialAgentModelPolicy);
  policy.steps.write_public={mode:'fixed',model:'gpt-6.1-terra',tuning:{
    tone:'formal',reasoning:'none',temperature:0.45,verbosity:'low',max_output_tokens:320
  }};
  const {models,calls,observations}=setup(policy);
  assert.deepEqual(await models.call(request),output);
  const {body}=calls[0];
  assert.equal(body.reasoning.effort,'none');
  assert.equal(body.text.verbosity,'low');
  assert.equal(body.text.format.strict,true);
  assert.equal(body.temperature,0.45);
  assert.equal(body.max_output_tokens,320);
  assert.match(body.instructions,/profesional y formal/);
  assert.equal(observations[0].metadata.response_tone,'formal');
  assert.equal(observations[0].metadata.temperature,0.45);
});

test('an incompatible combination makes no call and OpenRouter receives the portable options',async()=>{
  const policy=structuredClone(initialAgentModelPolicy);
  policy.steps.write_public={mode:'fixed',model:'gpt-6.2-sol',tuning:{temperature:0.5}};
  const blocked=setup(policy);
  assert.equal(await blocked.models.call(request),null);
  assert.equal(blocked.calls.length,0);
  policy.steps.write_public={mode:'fixed',model:'mistralai/mistral-small-3.2-24b-instruct',
    tuning:{tone:'directo',max_output_tokens:384}};
  const routed=setup(policy);
  assert.deepEqual(await routed.models.call(request),output);
  assert.equal(routed.calls[0].body.max_tokens,384);
  assert.match(routed.calls[0].body.messages[0].content,/tono directo/);
  assert.equal(routed.calls[0].body.temperature,undefined);
});

test('a component shares its limits across calls in addition to the global turn budget',async()=>{
  const policy=structuredClone(initialAgentModelPolicy);
  policy.component_limits={orquestador:{max_cost_usd:0.0004,max_call_ms:750}};
  const {models,calls,observations}=setup(policy);
  const results=await Promise.all([
    models.call(request),models.call({...request,step:'write_advisor'}),
    models.call({...request,step:'support_evidence'})
  ]);
  assert.deepEqual(results.filter(Boolean),[output,output]);
  assert.equal(calls.length,2);
  const assistant=observations.filter(item=>item.metadata.agent_id==='copiloto');
  assert.equal(assistant.find(item=>item.metadata.status==='budget_exhausted').metadata.component_turn_cost_limit_usd,0.0004);
  assert.equal(assistant.find(item=>item.metadata.status==='accepted').metadata.component_call_timeout_ms,750);
});
