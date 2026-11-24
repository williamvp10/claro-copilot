import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { exportAgentSpan, traceIdentifier } from '../dist/telemetry.js';
import { promptEntry } from '../dist/prompt-catalog.js';

test('Langfuse export links the version and omits case text', async t=>{
  const original = {...process.env};
  process.env.LANGFUSE_PUBLIC_KEY='fixture';
  process.env.LANGFUSE_SECRET_KEY='fixture-secret';
  process.env.LANGFUSE_BASE_URL='http://langfuse-web:3000';
  process.env.KNOWLEDGE_INDEX_REVISION='a'.repeat(64);
  process.env.BETTER_AUTH_SECRET='test-correlation-key';
  t.after(()=>{
    for (const key of ['LANGFUSE_PUBLIC_KEY','LANGFUSE_SECRET_KEY','LANGFUSE_BASE_URL','KNOWLEDGE_INDEX_REVISION','BETTER_AUTH_SECRET']) {
      if (original[key]===undefined) delete process.env[key];
      else process.env[key]=original[key];
    }
  });
  const requests=[];
  let acknowledgment = {};
  t.mock.method(globalThis,'fetch',async (url,init)=>{
    requests.push({url:String(url),body:JSON.parse(init.body),redirect:init.redirect});
    return Response.json(acknowledgment);
  });
  const turn={run_id:'trace-test',conversation_id:'internal-conversation',channel:'web',audience:'cliente',config_revision:'test-v2',text:'Private transcript placeholder'};
  const now=Date.now();
  const prompt=promptEntry('public_answer','An approved immutable text','langfuse',9);
  const ok=await exportAgentSpan(turn,now,'consulta_planes','answer',[{
    name:'generation.openai',started:now,ended:now+10,
    metadata:{prompt_ref:'public_answer',status:'accepted',model:'gpt-6-luna',step_id:'draft_public_reply'}
  },{name:'context',started:now,ended:now,metadata:{decision:'ask',question_id:'motivo'}},
  {name:'tool.list_catalog_plans',started:now,ended:now,metadata:{
    reference_resolution:'memory',catalog_version:'CAT-2026 v1.0',decision:'answer',reason:'lowest_applicable_price'
  }},
  {name:'decision.jev',started:now,ended:now,metadata:{provider_attempted:'yes',model:'typesafe/jev-1.14',
    input_tokens:476,output_tokens:70,cost_usd:0.000019992,status:'fallback'}},
  {name:'decision.jev',started:now,ended:now,metadata:{provider_attempted:'yes',model:'typesafe/jev-1.14',status:'fallback'}}
  ],{public_answer:prompt},'private-contact-reference');
  assert.equal(ok,createHash('sha256').update(JSON.stringify(requests[0].body)).digest('hex'));
  assert.match(requests[0].url,/\/api\/public\/otel\/v1\/traces$/);
  assert.equal(requests[0].redirect,'error');
  const [root,generation,context,catalogue,jev,failedJev]=requests[0].body.resourceSpans[0].scopeSpans[0].spans;
  const expectedId=value=>createHmac('sha256','test-correlation-key').update(value).digest('hex');
  const correlationOf=span=>Object.fromEntries(span.attributes.filter(({key})=>['langfuse.session.id','langfuse.user.id'].includes(key))
    .map(({key,value})=>[key,value.stringValue]));
  const correlation={
    'langfuse.session.id':expectedId('langfuse:session:internal-conversation'),
    'langfuse.user.id':expectedId('langfuse:user:web:private-contact-reference')
  };
  for (const span of [root,generation,context,catalogue,jev,failedJev]) assert.deepEqual(correlationOf(span),correlation);
  assert.equal(root.traceId,traceIdentifier(turn.run_id));
  assert.equal(generation.parentSpanId,root.spanId);
  assert.equal(context.parentSpanId,root.spanId);
  assert.equal(catalogue.parentSpanId,root.spanId);
  const catalogueAttributes=Object.fromEntries(catalogue.attributes.map(({key,value})=>[key,value.stringValue]));
  assert.equal(catalogueAttributes['langfuse.observation.metadata.reference_resolution'],'memory');
  assert.equal(catalogueAttributes['langfuse.observation.metadata.catalog_version'],'CAT-2026 v1.0');
  assert.equal(catalogueAttributes['langfuse.observation.metadata.reason'],'lowest_applicable_price');
  assert.match(root.attributes.find(item=>item.key==='claro.index_revision').value.stringValue,/^a{64}$/);
  assert.match(root.attributes.find(item=>item.key==='claro.runtime_sha256').value.stringValue,/^[a-f0-9]{64}$/);
  const jevDetails=Object.fromEntries(jev.attributes.map(({key,value})=>[key,value.stringValue]));
  assert.equal(jevDetails['langfuse.observation.type'],'generation');
  assert.deepEqual(JSON.parse(jevDetails['langfuse.observation.usage_details']),{input:476,output:70});
  assert.deepEqual(JSON.parse(jevDetails['langfuse.observation.cost_details']),{total:0.000019992});
  assert.ok(!failedJev.attributes.some(item=>item.key==='langfuse.observation.cost_details'));
  assert.equal(context.attributes.find(item=>item.key==='claro.question_id').value.stringValue,'motivo');
  const attributes=Object.fromEntries(generation.attributes.map(({key,value})=>[key,value]));
  assert.equal(attributes['langfuse.observation.prompt.name'].stringValue,prompt.name);
  assert.equal(attributes['langfuse.observation.prompt.version'].intValue,'9');
  assert.doesNotMatch(JSON.stringify(requests[0].body),/Private transcript|An approved immutable text|private-contact-reference|internal-conversation/);
  await exportAgentSpan({...turn,run_id:'next-run',conversation_id:'another-conversation'},now,'consulta_planes','answer',[],{},'private-contact-reference');
  const next=correlationOf(requests[1].body.resourceSpans[0].scopeSpans[0].spans[0]);
  assert.equal(next['langfuse.user.id'],correlation['langfuse.user.id']);
  assert.notEqual(next['langfuse.session.id'],correlation['langfuse.session.id']);
  acknowledgment = {partialSuccess:{rejectedSpans:'1'}};
  assert.equal(await exportAgentSpan(turn,now,'consulta_planes','answer'),false);
  acknowledgment = {partial_success:{rejected_spans:1}};
  assert.equal(await exportAgentSpan(turn,now,'consulta_planes','answer'),false);
  acknowledgment = {partialSuccess:{rejectedSpans:'0',errorMessage:'Aviso sin pérdida'}};
  assert.match(await exportAgentSpan(turn,now,'consulta_planes','answer'),/^[a-f0-9]{64}$/);
  const previouslySent = requests.length;
  delete process.env.LANGFUSE_BASE_URL;
  assert.equal(await exportAgentSpan(turn,now,'consulta_planes','answer'),false);
  assert.equal(requests.length,previouslySent);
});
