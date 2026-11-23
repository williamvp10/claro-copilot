// Explicit, synthetic smoke for an already-running local/demo Langfuse project.
// Reads an exact existing prompt version; it never creates or relabels prompts.
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { langfusePromptClient } from '../dist/langfuse-prompts.js';
import { exportAgentSpan, traceIdentifier } from '../dist/telemetry.js';
import { digestText } from '../dist/prompt-catalog.js';

const { LANGFUSE_BASE_URL:base, LANGFUSE_PUBLIC_KEY:publicKey, LANGFUSE_SECRET_KEY:secret,
  LANGFUSE_PROJECT_ID:projectId, DEMO_MODE:demo } = process.env;
const [promptName,rawVersion] = process.argv.slice(2);
const version=Number(rawVersion);
if (!base || !publicKey || !secret || !projectId || demo!=='true' || !promptName || !Number.isSafeInteger(version) || version<1) {
  throw new Error('Set DEMO_MODE=true and Langfuse URL, keys, project ID; pass an existing prompt name and version');
}
const url=new URL(base);
if (url.protocol!=='http:' || !['127.0.0.1','localhost'].includes(url.hostname) && !(url.hostname==='langfuse-web' && url.port==='3000') || url.username || url.password || url.search || url.hash) {
  throw new Error('Smoke is restricted to the local demo Langfuse service');
}
const authorization='Basic '+Buffer.from(`${publicKey}:${secret}`).toString('base64');
async function read(path) {
  const response=await fetch(new URL(path,url),{headers:{Authorization:authorization},redirect:'error',signal:AbortSignal.timeout(3500)});
  if (response.status===404) return null;
  if (!response.ok) throw new Error(`Langfuse read failed: HTTP ${response.status}`);
  return response.json();
}
const projects=await read('/api/public/projects');
if (!Array.isArray(projects?.data) || !projects.data.some(project=>project.id===projectId)) throw new Error('Configured project does not match the API key');
const prompt=await langfusePromptClient().get(promptName,{version});
if (!prompt || prompt.version!==version) throw new Error('Exact prompt version was not found');
const runId=randomUUID(),traceId=traceIdentifier(runId),started=Date.now();
const turn={run_id:runId,case_id:randomUUID(),conversation_id:randomUUID(),turn_id:randomUUID(),
  channel:'web',actor:'cliente',turn_seq:1,case_revision:1,attention_mode:'asistido',audience:'asesor',
  scope_ref:'synthetic',config_revision:'smoke',business_date:new Date().toISOString().slice(0,10),text:'synthetic'};
const exported=await exportAgentSpan(turn,started,'synthetic-smoke','ok',[
  {name:'tool.synthetic',started,ended:Date.now(),metadata:{status:'synthetic'}},
  {name:'generation.openai',started,ended:Date.now(),metadata:{status:'synthetic',model:'claro-smoke',prompt_ref:'public_answer'}}
],{public_answer:{name:prompt.name,version:prompt.version,sha256:digestText(prompt.prompt),source:'langfuse'}});
if (!exported) throw new Error('Synthetic OTLP export was not accepted');
const query=new URLSearchParams({
  traceId,
  fromStartTime:new Date(started-60_000).toISOString(),
  toStartTime:new Date(started+60_000).toISOString(),
  fields:'core,basic,prompt',
  limit:'100'
});
let observations=[];
const accepted = () => observations.some(row=>row.traceId===traceId && row.name==='attention.run')
  && observations.some(row=>row.traceId===traceId && row.name==='tool.synthetic')
  && observations.some(row=>row.traceId===traceId && row.name==='generation.openai'
    && row.promptName===prompt.name && row.promptVersion===version);
for (let attempt=0;attempt<60;attempt++) {
  const result=await read(`/api/public/v2/observations?${query}`);
  observations=Array.isArray(result?.data)?result.data:[];
  if (accepted()) break;
  await wait(1000);
}
if (!accepted()) throw new Error('Trace, tool and prompt-linked generation were not visible in Langfuse v4');
console.log(JSON.stringify({project_id:projectId,trace_id:traceId,prompt_name:prompt.name,prompt_version:prompt.version,synthetic:true}));
