import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';

const datasetName='claro-catalogo-contratacion-v1';
const bytes=await readFile(new URL('../../../docs/agente/catalogo-contratacion-evals.v1.jsonl',import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
const suiteSha=sha(bytes);
const suite=bytes.toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
const [targetFile,outputFile,...flags]=process.argv.slice(2);
const publish=flags.includes('--publish');
const cases=flags.filter(flag=>flag.startsWith('--case=')).flatMap(flag=>flag.slice(7).split(','));
assert.ok(targetFile&&outputFile&&flags.every(arg=>['--publish','--require-pass'].includes(arg)||arg.startsWith('--case=')),
 'Usage: eval-commercial-web.mjs TARGETS.json REPORT.json [--case=COM-01,COM-02] [--publish] [--require-pass]');
assert.ok(cases.every(id=>suite.some(item=>item.id===id)),'Unknown commercial case');
assert.equal(process.env.DEMO_MODE,'true','Use an isolated synthetic demo');
const targets=JSON.parse(await readFile(targetFile,'utf8'));
const advisor=targets.advisor;
assert.ok(advisor?.email&&advisor?.password,'Supply a synthetic advisor in the private target file');
function loopback(value,protocols) {
  const url=new URL(value);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&protocols.includes(url.protocol),'Use a loopback target');
  return url;
}
const cookie=response=>response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
const chatPath='/api/v1/web-chat/';
async function api(origin,path,data,session) {
  const response=await fetch(new URL(path,origin), {method:data===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(8000),
    headers:{Origin:origin,...session?{Cookie:session}:{},...data===undefined?{}:{'Content-Type':'application/json'}},
    body:data===undefined?undefined:JSON.stringify(data)});
  if(!response.ok) throw Error(`${path} HTTP ${response.status}`);
  return response;
}
async function until(read,label) {
  for(let attempt=0;attempt<80;attempt++){
    const value=await read();
    if(value) return value;
    await delay(150);
  }
  throw Error(`Timed out waiting for ${label}`);
}

async function checkPdf(origin,source,db) {
  assert.ok(source,'Missing public PDF reference');
  const prefix=`/api/v1/knowledge/sources/${source.publication}/${source.key}`;
  const metadata=await (await api(origin,prefix)).json();
  assert.equal(metadata.pdf_available,true);
  const file=await api(origin,prefix+'/document?download=1');
  assert.match(file.headers.get('content-disposition')??'',/^attachment\b/);
  const buffer=Buffer.from(await file.arrayBuffer());
  const {rows:[entry]}=await db.query('SELECT manifest FROM knowledge_publication WHERE sha256=$1',[source.publication]);
  assert.equal(sha(buffer),entry?.manifest?.files?.[source.key]?.sha256);
  return {edition:metadata.version,sha256:sha(buffer)};
}

function verifyTurns(id,turns) {
  const answer=index=>turns[index]?.answer??'';
  const before=turns.map(turn=>turn.awaiting_advisor);
  switch(id) {
    case 'COM-01':
      assert.match(answer(0),/hola/i);
      assert.match(answer(1),/hogar.*móvil/i);
      assert.match(answer(2),/Pospago.*Claro Max 60 GB.*69\.900.*Prepago.*Paquete Semanal.*15\.000.*7 días/is);
      assert.equal(turns[3].selection?.name,'Claro Max 60 GB');
      assert.match(answer(4),/Claro Max 60 GB incluye Claro Video/i);
      assert.equal(turns[5].selection?.name,'Claro Max 60 GB');
      assert.match(answer(6),/Claro Max 60 GB.*espera.*asesor/i);
      assert.deepEqual(before,[false,false,false,false,false,false,true,true]);
      break;
    case 'COM-02':
      assert.match(answer(1),/Pospago.*Prepago/s);
      assert.doesNotMatch(answer(2),/Paquete Semanal/);
      assert.match(answer(4),/Claro Max 25 GB.*49\.900.*mes/i);
      break;
    case 'COM-03': assert.match(answer(1),/Hogar Fibra 300.*89\.900/s); break;
    case 'COM-04': assert.equal(turns[1].selection?.name,'Claro Max Ilimitado'); break;
    case 'COM-05': assert.match(answer(0),/cuál plan/i);assert.deepEqual(before,[false,true]); break;
    case 'COM-06':
      assert.match(answer(2),/actualizó.*confirmas/is);
      assert.equal(turns[2].selection?.version,'CAT-2026 v2.0');
      assert.deepEqual(before,[false,false,false,true]);
      break;
    case 'COM-07': assert.match(answer(0),/Prepago.*Falta confirmar Pospago/s);break;
    case 'COM-08': assert.match(answer(3),/Hogar Fibra 300.*89\.900.*mes/i);break;
    case 'COM-09': assert.match(answer(3),/Paquete Semanal.*15\.000 por 7 días/i);break;
    case 'COM-10': assert.match(answer(2),/Conecta 42 GB.*57\.700.*mes/i);break;
  }
}
const handoffs=new Map([['COM-01','Claro Max 60 GB'],['COM-04','Claro Max Ilimitado'],['COM-05',null],
  ['COM-06','Claro Max 60 GB'],['COM-07',null],['COM-10','Conecta 42 GB']]);

async function replay(item,target) {
  const origin=loopback(target.origin,['http:']).origin;
  const later=target.laterOrigin ? loopback(target.laterOrigin,['http:']).origin : origin;
  const db=new pg.Client({connectionString:loopback(target.database,['postgresql:','postgres:']).href});
  await db.connect();
  try {
    const {rows:[configuration]}=await db.query('SELECT revision,manifest FROM prompt_revision WHERE activated');
    if(target.revision) assert.equal(configuration.revision,target.revision,'Unexpected active prompt revision');
    const sessionResponse=await api(origin,chatPath+'session',{});
    const session=cookie(sessionResponse);
    const seed=await sessionResponse.json();
    assert.ok(session&&seed.conversation_id&&seed.messages.length===0,'Expected a fresh public conversation');
    const turns=[];
    let previous=seed;
    for(const [index,text] of item.turns.entries()) {
      const endpoint=item.fixture==='edition-change'&&index>=2?later:origin;
      const after=await (await api(endpoint,chatPath+'messages',{text,idempotency_key:randomUUID()},session)).json();
      assert.equal(after.conversation_id,seed.conversation_id,'The edition transition must share platform state');
      const visible=await until(async()=>{
        const current=await (await api(endpoint,chatPath+'history',undefined,session)).json();
        const answer=current.messages.slice(previous.messages.length).find(message=>message.actor==='agente');
        return answer||current.awaiting_advisor ? {current,answer} : null;
      },'commercial response');
      previous=visible.current;
      const {rows:[state]}=await db.query("SELECT snapshot FROM attention_case WHERE snapshot->>'conversation_id'=$1",[seed.conversation_id]);
      const selected=state?.snapshot?.conversation_memory?.selected_plan;
      turns.push({turn:index+1,answer:visible.answer?.text??'',awaiting_advisor:previous.awaiting_advisor,
        citations:visible.answer?.citations?.map(item=>({id:item.id,version:item.version,source:item.source}))??[],
        selection:selected?{name:selected.name,price:selected.price,version:selected.citation.version}:undefined});
    }
    const {rows:[row]}=await db.query("SELECT id FROM attention_case WHERE snapshot->>'conversation_id'=$1",[seed.conversation_id]);
    const {rows:[before]}=await db.query(`SELECT count(*)::int AS waits FROM attention_event
      WHERE case_id=$1 AND kind='handoff_requested'`,[row.id]);
    const errors=[];
    let pdf=null, taken=false;
    try {
      verifyTurns(item.id,turns);
      assert.equal(before.waits,handoffs.has(item.id)?1:0);
      assert.equal(previous.awaiting_advisor,handoffs.has(item.id));
      if(item.id==='COM-01'||item.id==='COM-03') {
        const citation=turns[item.id==='COM-01'?5:0].citations[0];
        pdf=await checkPdf(origin,citation?.source,db);
        assert.equal(pdf.edition,'CAT-2026 v1.0');
      }
      if(handoffs.has(item.id)) {
        const operator=cookie(await api(later,'/api/auth/sign-in/email',advisor));
        await api(later,`/api/v1/cases/${row.id}/take`,{},operator);
        const name=handoffs.get(item.id);
        if(name) {
          const card=await until(async()=>{
            const {card}=await (await api(later,`/api/v1/cases/${row.id}`,undefined,operator)).json();
            return card;
          },'advisor dossier');
          assert.ok(card.summary.includes(name)&&card.citations.length&&card.pending.some(item=>item.includes('inscripción y facturación')));
        }
        const {rows:[count]}=await db.query("SELECT count(*)::int AS n FROM attention_event WHERE case_id=$1 AND kind='handoff_taken'",[row.id]);
        assert.equal(count.n,1);
        taken=true;
      }
    } catch(error) {
      errors.push(error.message);
    }
    const {rows:[safety]}=await db.query(`SELECT
      (SELECT count(*)::int FROM integration_operation WHERE case_id=$1) AS effects,
      (SELECT count(*)::int FROM attention_event WHERE case_id=$1 AND (
        kind IN ('crm_read','crm_services_read','billing_read','billing_invoice_read','billing_invoice_detail_read','tickets_read','retention_read') OR
        kind LIKE 'tool.crm.%' OR kind LIKE 'tool.billing.%')) AS private_reads`,[row.id]);
    assert.deepEqual(safety,{effects:0,private_reads:0},'Public commercial replay crossed the authorized boundary');
    const {rows:runtime}=await db.query(`SELECT DISTINCT metadata->>'runtime_sha256' AS hash FROM attention_event
      WHERE case_id=$1 AND kind='agent_completed' AND metadata ? 'runtime_sha256'`,[row.id]);
    assert.ok(runtime.length<=1,'App switches must keep the same code build');
    const {rows:revisions}=await db.query("SELECT DISTINCT turn->>'config_revision' AS revision FROM agent_run WHERE case_id=$1",[row.id]);
    assert.ok(revisions.every(item=>item.revision===configuration.revision),'Prompt revision changed within the replay');
    return {id:item.id,fixture:item.fixture,revision:configuration.revision,manifest_sha256:sha(JSON.stringify(configuration.manifest)),
      runtime:runtime[0]?.hash??target.runtime??null,turns,checks:{status:errors.length?'failed':'passed',errors,waits:before.waits,taken,pdf,...safety}};
  } finally { await db.end(); }
}

const evaluations=[];
const report={dataset:datasetName,suite_sha256:suiteSha,created_at:new Date().toISOString(),cases:evaluations};
for(const item of suite.filter(item=>!cases.length||cases.includes(item.id))) {
  const target=targets.fixtures?.[item.fixture];
  try {
    if(!target) throw Error(`Missing fixture ${item.fixture}`);
    if(item.fixture==='edition-change') assert.ok(target.laterOrigin,'Configure the next business date');
    const result=await replay(item,target);
    evaluations.push(result);
    console.log(item.id,result.checks.status);
  } catch(error) {
    evaluations.push({id:item.id,fixture:item.fixture,checks:{status:'error',errors:[error.message]}});
    console.log(item.id,'error');
  }
}
await writeFile(outputFile,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});

if(publish) {
  assert.ok(evaluations.length===suite.length&&evaluations.every(row=>row.turns&&row.runtime),'Publish only a complete replay with runtime evidence');
  const host=loopback(process.env.LANGFUSE_BASE_URL,['http:','https:']);
  assert.ok(process.env.LANGFUSE_PUBLIC_KEY&&process.env.LANGFUSE_SECRET_KEY,'Configure Langfuse credentials');
  const auth='Basic '+Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString('base64');
  const headers={Authorization:auth,'Content-Type':'application/json','X-Langfuse-Ingestion-Version':'4'};
  async function lf(path,body) {
    const response=await fetch(new URL('/api/public/'+path,host), {headers,method:body?'POST':'GET',
      body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(16000)});
    if(!response.ok) throw Error(`Langfuse ${path}: HTTP ${response.status}`);
    return response.json();
  }
  const dataset=await lf('v2/datasets/'+datasetName);
  assert.equal(dataset.metadata.sha256,suiteSha,'Import the matching dataset first');
  const experiment=randomUUID();
  for(const row of evaluations) {
    const item=suite.find(value=>value.id===row.id), itemId=`${datasetName}-${row.id}`;
    const stored=await lf('dataset-items/'+itemId);
    assert.equal(stored.datasetId,dataset.id);
    assert.equal(stored.metadata.suite_sha256,suiteSha);
    assert.deepEqual(stored.input,{turns:item.turns});
    assert.deepEqual(stored.expectedOutput,{intent:item.intent,required:item.required,forbidden:item.forbidden});
    const attributes=Object.entries({
      'langfuse.environment':'demo-catalogue', 'langfuse.experiment.id':experiment,
      'langfuse.experiment.name':`catalogo-web-${experiment.slice(0,8)}`, 'langfuse.experiment.dataset.id':dataset.id,
      'langfuse.experiment.item.id':itemId, 'langfuse.observation.type':'agent',
      'langfuse.experiment.metadata.runtime_sha256':row.runtime, 'langfuse.experiment.metadata.suite_sha256':suiteSha,
      'langfuse.experiment.metadata.prompt_revision':row.revision, 'langfuse.experiment.metadata.prompt_manifest_sha256':row.manifest_sha256,
      'langfuse.experiment.item.metadata.fixture':item.fixture, 'langfuse.observation.input':JSON.stringify(stored.input),
      'langfuse.observation.output':JSON.stringify(row.turns.map(({turn,answer,awaiting_advisor,citations})=>({turn,answer,awaiting_advisor,citations}))),
      'langfuse.observation.metadata.jev_rubric':JSON.stringify(stored.expectedOutput),
      'langfuse.experiment.item.expected_output':JSON.stringify(stored.expectedOutput),
      'langfuse.observation.metadata.platform':row.checks.status
    }).map(([key,value])=>({key,value:{stringValue:value}}));
    const traceId=randomBytes(16).toString('hex'), spanId=randomBytes(8).toString('hex');
    attributes.push({key:'langfuse.experiment.item.root_observation_id',value:{stringValue:spanId}});
    const now=BigInt(Date.now())*1000000n;
    const result=await lf('otel/v1/traces',{resourceSpans:[{scopeSpans:[{scope:{name:'claro-catalogue-web'},spans:[{
      traceId,spanId,name:`catalogue.${row.id}`,kind:1,startTimeUnixNano:String(now),endTimeUnixNano:String(now+1000000n),attributes
    }]}]}]});
    assert.equal(Number(result.partialSuccess?.rejectedSpans??result.partial_success?.rejected_spans??0),0,'Langfuse rejected spans');
  }
  console.log('Experimento publicado',experiment);
}
if(flags.includes('--require-pass')&&evaluations.some(row=>row.checks.status!=='passed'))process.exitCode=1;
