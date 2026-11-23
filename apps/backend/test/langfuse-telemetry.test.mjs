import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportAgentSpan, traceIdentifier } from '../dist/telemetry.js';
import { promptEntry } from '../dist/prompt-catalog.js';

test('Langfuse export links the version and omits case text', async t=>{
  const original = {...process.env};
  process.env.LANGFUSE_PUBLIC_KEY='fixture';
  process.env.LANGFUSE_SECRET_KEY='fixture-secret';
  process.env.LANGFUSE_BASE_URL='http://langfuse-web:3000';
  t.after(()=>{
    for (const key of ['LANGFUSE_PUBLIC_KEY','LANGFUSE_SECRET_KEY','LANGFUSE_BASE_URL']) {
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
  const turn={run_id:'trace-test',channel:'web',audience:'cliente',config_revision:'test-v2',text:'Private transcript placeholder'};
  const now=Date.now();
  const prompt=promptEntry('public_answer','An approved immutable text','langfuse',9);
  const ok=await exportAgentSpan(turn,now,'consulta_planes','answer',[{
    name:'generation.openai',started:now,ended:now+10,
    metadata:{prompt_ref:'public_answer',status:'accepted',model:'gpt-6-luna',step_id:'draft_public_reply'}
  }],{public_answer:prompt});
  assert.equal(ok,true);
  assert.match(requests[0].url,/\/api\/public\/otel\/v1\/traces$/);
  assert.equal(requests[0].redirect,'error');
  const [root,generation]=requests[0].body.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(root.traceId,traceIdentifier(turn.run_id));
  assert.equal(generation.parentSpanId,root.spanId);
  const attributes=Object.fromEntries(generation.attributes.map(({key,value})=>[key,value]));
  assert.equal(attributes['langfuse.observation.prompt.name'].stringValue,prompt.name);
  assert.equal(attributes['langfuse.observation.prompt.version'].intValue,'9');
  assert.doesNotMatch(JSON.stringify(requests[0].body),/Private transcript|An approved immutable text/);
  acknowledgment = {partialSuccess:{rejectedSpans:'1'}};
  assert.equal(await exportAgentSpan(turn,now,'consulta_planes','answer'),false);
  acknowledgment = {partial_success:{rejected_spans:1}};
  assert.equal(await exportAgentSpan(turn,now,'consulta_planes','answer'),false);
  acknowledgment = {partialSuccess:{rejectedSpans:'0',errorMessage:'Aviso sin pérdida'}};
  assert.equal(await exportAgentSpan(turn,now,'consulta_planes','answer'),true);
  const previouslySent = requests.length;
  delete process.env.LANGFUSE_BASE_URL;
  assert.equal(await exportAgentSpan(turn,now,'consulta_planes','answer'),false);
  assert.equal(requests.length,previouslySent);
});
