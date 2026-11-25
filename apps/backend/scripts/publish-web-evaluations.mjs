import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

export async function publishWebEvaluations(result,{environment,prefix}) {
  const {dataset:datasetName,corpus_sha256:corpusHash}=result;
  const langfuse=new URL(process.env.LANGFUSE_UI_URL);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(langfuse.hostname) && langfuse.protocol==='http:' && !langfuse.username && !langfuse.password);
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
        'langfuse.environment':environment,'langfuse.experiment.id':revision.experiment_id,
        'langfuse.experiment.name':`${prefix}-${label}-${revision.experiment_id.slice(0,8)}`,
        'langfuse.experiment.dataset.id':dataset.id,'langfuse.experiment.item.id':id,
        'langfuse.experiment.item.root_observation_id':spanId,'langfuse.observation.type':'agent',
        'langfuse.experiment.metadata.runtime':revision.runtime,'langfuse.experiment.metadata.business_date':revision.business_date,
        'langfuse.observation.input':JSON.stringify(item.input),'langfuse.observation.output':JSON.stringify(row.output),
        'langfuse.observation.metadata.jev_rubric':JSON.stringify(item.expectedOutput),
        'langfuse.experiment.item.expected_output':JSON.stringify(item.expectedOutput)
      }).map(([key,stringValue])=>({key,value:{stringValue}}));
      const now=BigInt(Date.now())*1000000n;
      const ack=await lf('otel/v1/traces',{resourceSpans:[{scopeSpans:[{scope:{name:prefix},spans:[{
        traceId,spanId,name:`${prefix}.${row.id}`,kind:1,startTimeUnixNano:String(now),endTimeUnixNano:String(now+1000000n),attributes
      }]}]}]});
      assert.equal(Number(ack.partialSuccess?.rejectedSpans ?? ack.partial_success?.rejected_spans ?? 0),0);
    }
    console.log('Experimento publicado',label,revision.experiment_id);
  }
}
