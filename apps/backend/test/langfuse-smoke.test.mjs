import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script=fileURLToPath(new URL('../scripts/smoke-langfuse.mjs',import.meta.url));
const fixture=`
let trace;
globalThis.fetch=async (raw,options={})=>{
  const url=new URL(raw), headers=options.headers ?? {};
  if (!String(headers.Authorization ?? '').startsWith('Basic ')) throw Error('missing auth');
  if (url.pathname==='/api/public/projects') return Response.json({data:[{id:process.env.BAD_PROJECT?'other':'synthetic-project'}]});
  if (url.pathname==='/api/public/v2/prompts/synthetic-prompt' && url.searchParams.get('version')==='5' && !options.method)
    return Response.json({name:'synthetic-prompt',type:'text',prompt:'safe fixture',version:5});
  if (url.pathname==='/api/public/otel/v1/traces' && options.method==='POST') {
    trace=JSON.parse(options.body).resourceSpans[0].scopeSpans[0].spans[0].traceId;
    return Response.json({});
  }
  if (url.pathname==='/api/public/v2/observations' && url.searchParams.get('traceId')===trace) {
    if (url.searchParams.get('fields')!=='core,basic,prompt' || !url.searchParams.get('fromStartTime') || !url.searchParams.get('toStartTime'))
      throw Error('unbounded or missing prompt fields');
    return Response.json({data:[
      {traceId:trace,name:'attention.run'},
      {traceId:trace,name:'tool.synthetic'},
      {traceId:trace,name:'generation.openai',promptName:'synthetic-prompt',promptVersion:5}
    ]});
  }
  throw Error('unexpected request');
};`;
function run(extra={}) {
  return spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(fixture),script,'synthetic-prompt','5'],{
    encoding:'utf8',env:{...process.env,LANGFUSE_BASE_URL:'http://127.0.0.1:39085',LANGFUSE_PUBLIC_KEY:'pk-fixture',LANGFUSE_SECRET_KEY:'secret-fixture',LANGFUSE_PROJECT_ID:'synthetic-project',DEMO_MODE:'true',...extra}
  });
}

test('Langfuse smoke verifies project, exact prompt and ingested synthetic tool without label writes',()=>{
  const result=run({LANGFUSE_BASE_URL:'http://127.0.0.1:39513'});
  assert.equal(result.status,0,result.stderr);
  const evidence=JSON.parse(result.stdout);
  assert.equal(evidence.project_id,'synthetic-project');
  assert.equal(evidence.prompt_version,5);
  assert.equal(evidence.synthetic,true);
  assert.match(evidence.trace_id,/^[a-f0-9]{32}$/);
  assert.ok(!result.stdout.includes('secret-fixture'));
});

test('Langfuse smoke refuses a project mismatch and nonlocal target',()=>{
  assert.notEqual(run({BAD_PROJECT:'1'}).status,0);
  assert.notEqual(run({LANGFUSE_BASE_URL:'https://example.com'}).status,0);
});
