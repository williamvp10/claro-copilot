import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const [targetFile,reportFile,flag]=process.argv.slice(2);
assert.ok(targetFile && reportFile && (!flag || flag==='--publish'),'Use TARGETS.json REPORT.json [--publish]');
const targets=JSON.parse(await readFile(targetFile,'utf8'));
const corpus=await readFile(new URL('../../../docs/agente/atencion-asistida-evals.v1.jsonl',import.meta.url));
const cases=corpus.toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
const corpusHash=createHash('sha256').update(corpus).digest('hex');
const datasetName='claro-atencion-asistida-v1';
const web='/api/v1/web-chat';
const api='/api/v1';
const destinations=['soporte_tecnico','facturacion','supervision'];

function loopback(value) {
  const url=new URL(value);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname) && url.protocol==='http:' && !url.username && !url.password);
  return url;
}
async function request(origin,path,{cookie,data,optional=false}={}) {
  const response=await fetch(new URL(path,origin),{method:data===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(16000),
    headers:{Origin:origin.origin,...cookie?{Cookie:cookie}:{},...data===undefined?{}:{'Content-Type':'application/json'}},
    body:data===undefined?undefined:JSON.stringify(data)});
  if (optional && response.status===404) return null;
  assert.ok(response.ok,`${path} HTTP ${response.status}`);
  return {body:await response.json(),cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};
}
async function until(read) {
  for (let attempt=0;attempt<68;attempt++) {
    const value=await read();
    if (value) return value;
    await delay(250);
  }
  throw new Error('Timed out waiting for the case or private card');
}
async function replay(target,variant) {
  const origin=loopback(target.origin);
  const ask=(path,cookie,data,optional)=>request(origin,path,{cookie,data,optional});
  const signIn=async credentials=>(await ask('/api/auth/sign-in/email',undefined,credentials)).cookie;
  assert.ok(target.runtime && /^\d{4}-\d{2}-\d{2}$/.test(target.business_date));
  const advisor=await signIn(target.advisor);
  const receiver=await signIn(target.receiver);
  const supervisor=target.supervisor ? await signIn(target.supervisor) : receiver;
  const results=[];
  for (const item of cases) {
    assert.ok(destinations.includes(item.intent));
    const customer=await ask(web+'/session',undefined,{fresh:true});
    const send=async text=>(await ask(web+'/messages',customer.cookie,{text,idempotency_key:randomUUID()})).body;
    const [issue,assist,edited,followup]=item.turns;
    await send(issue);
    await send(assist);
    const queued=await until(async()=> (await ask(api+'/cases',advisor)).body.find(row=>row.conversation_id===customer.body.conversation_id));
    const path=api+'/cases/'+queued.id;
    await ask(path+'/take',advisor,{});
    await ask(path+'/messages',advisor,{text:edited,idempotency_key:randomUUID()});
    let current=(await ask(path,advisor)).body;
    const suggestion=(await ask(path+'/escalations/suggestion',advisor,{destination:item.intent,case_revision:current.revision},variant==='base'))?.body;
    const transferred=(await ask(path+'/escalations',advisor,{destination:item.intent,reason_code:'revision_especializada',
      ...(variant==='candidate' ? {reason_text:suggestion?.suggestion?.text || issue} : {}),
      case_revision:current.revision,idempotency_key:randomUUID()})).body;
    const received=await send(followup);
    const recipient=item.intent==='supervision' ? supervisor : receiver;
    const available=(await ask(api+'/escalations',recipient)).body.find(row=>row.id===transferred.id);
    assert.ok(available,`Escalation ${item.id} is missing from the receiver queue`);
    await ask(api+'/escalations/'+transferred.id+'/claim',recipient,{case_revision:available.case_revision});
    const lastCustomer=received.messages.findLast(message=>message.actor==='cliente');
    if (variant==='candidate') {
      current=await until(async()=>{
        const snapshot=(await ask(path,recipient)).body;
        return snapshot.card?.summary_update?.turn_id===lastCustomer.id && snapshot.card.advisor_draft ? snapshot : null;
      });
    } else current=(await ask(path,recipient)).body;
    const company=(await ask(web+'/history',customer.cookie)).body;
    const output={motivo:suggestion?.suggestion?.text ?? null,resumen:current.card?.summary ?? null,respuesta:current.card?.advisor_draft ?? null};
    results.push({id:item.id,case_id:queued.id,run_id:current.card?.advisor_draft_run_id,output,
      platform:{same_conversation:current.conversation_id===customer.body.conversation_id,
        advisor_assigned:company.attention?.stage==='assigned',escalation_notice:company.messages.some(message=>message.attention_notice==='escalated'),
        suggestion_status:suggestion?.status ?? 'unavailable'}});
    console.log(variant,item.id,results.at(-1).platform.suggestion_status);
  }
  return results;
}

const result={dataset:datasetName,corpus_sha256:corpusHash,revisions:{}};
assert.equal(targets.base.business_date,targets.candidate.business_date,'Use the same business date');
for (const label of ['base','candidate']) {
  const target=targets[label];
  result.revisions[label]={runtime:target.runtime,business_date:target.business_date,cases:await replay(target,label)};
}

if (flag==='--publish') {
  const langfuse=loopback(process.env.LANGFUSE_UI_URL);
  const {LANGFUSE_PUBLIC_KEY:publicKey,LANGFUSE_SECRET_KEY:secret}=process.env;
  assert.ok(publicKey&&secret,'Configure the Langfuse project keys');
  const headers={Authorization:'Basic '+Buffer.from(`${publicKey}:${secret}`).toString('base64'),
    'Content-Type':'application/json','X-Langfuse-Ingestion-Version':'4'};
  async function lf(path,body) {
    const response=await fetch(new URL('/api/public/'+path,langfuse),{headers,method:body?'POST':'GET',
      body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(16000)});
    assert.ok(response.ok,`Langfuse ${path} HTTP ${response.status}`);
    return response.json();
  }
  const dataset=await lf('v2/datasets/'+datasetName);
  assert.equal(dataset.metadata.sha256,corpusHash);
  for (const [label,revision] of Object.entries(result.revisions)) {
    revision.experiment_id=randomUUID();
    for (const row of revision.cases) {
      const id=`${datasetName}-${row.id}`;
      const item=await lf('dataset-items/'+id);
      assert.equal(item.datasetId,dataset.id);
      assert.equal(item.metadata.suite_sha256,corpusHash);
      const traceId=randomBytes(16).toString('hex'),spanId=randomBytes(8).toString('hex');
      row.trace_id=traceId;
      const attributes=Object.entries({
        'langfuse.environment':'demo-assisted','langfuse.experiment.id':revision.experiment_id,
        'langfuse.experiment.name':`atencion-asistida-${label}-${revision.experiment_id.slice(0,8)}`,
        'langfuse.experiment.dataset.id':dataset.id,'langfuse.experiment.item.id':id,
        'langfuse.experiment.item.root_observation_id':spanId,'langfuse.observation.type':'agent',
        'langfuse.experiment.metadata.runtime':revision.runtime,'langfuse.experiment.metadata.business_date':revision.business_date,
        'langfuse.observation.input':JSON.stringify(item.input),'langfuse.observation.output':JSON.stringify(row.output),
        'langfuse.observation.metadata.jev_rubric':JSON.stringify(item.expectedOutput),
        'langfuse.experiment.item.expected_output':JSON.stringify(item.expectedOutput)
      }).map(([key,stringValue])=>({key,value:{stringValue}}));
      const now=BigInt(Date.now())*1000000n;
      const ack=await lf('otel/v1/traces',{resourceSpans:[{scopeSpans:[{scope:{name:'claro-assisted-web'},spans:[{
        traceId,spanId,name:`assisted.${row.id}`,kind:1,startTimeUnixNano:String(now),endTimeUnixNano:String(now+1000000n),attributes
      }]}]}]});
      assert.equal(Number(ack.partialSuccess?.rejectedSpans ?? ack.partial_success?.rejected_spans ?? 0),0);
    }
    console.log('Experimento publicado',label,revision.experiment_id);
  }
}
await writeFile(reportFile,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
