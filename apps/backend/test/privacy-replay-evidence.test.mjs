import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifyPrivacySurfaces } from '../dist/privacy-replay-evidence.js';
import { traceIdentifier } from '../dist/telemetry.js';

const sha = value=>createHash('sha256').update(value).digest('hex');
const customer={cliente_id:'C-1012',numero_documento:'98713426',celular:'3987412563',email:'canary@example.invalid'};

function snapshotWithCanary({leak,missingIngress,modifiedTrace,privateRead}={}) {
  const turn={turn_id:'first-message',turn_seq:2,case_revision:1,text:'La luz LOS sigue roja.',channel:'telegram',scope_ref:'unverified'};
  const publicRun={id:'public',turn:{...turn,audience:'cliente',attention_mode:'autoservicio'}};
  const advisorRun={id:'advisor',turn:{...turn,audience:'asesor',attention_mode:'asistido',case_revision:2}};
  const answer='La solicitud queda en espera de soporte técnico de nivel 2.'+(leak==='answer'?' '+customer.email:'');
  const summary='LOS roja. Derivar a soporte técnico.'+(leak==='summary'?' 987.134.26':'');
  const traceCaptures=Object.fromEntries([publicRun,advisorRun].map(run=>[run.id,JSON.stringify({resourceSpans:[{scopeSpans:[{spans:[{
    traceId:traceIdentifier(run.id),name:'attention.run',attributes:[{key:'langfuse.trace.metadata.run_id',value:{stringValue:run.id}},
      ...(leak==='trace'?[{key:'metadata',value:{stringValue:'398 741 2563'}}]:[])],
  }]}]}]})]));
  const exported=Object.entries(traceCaptures).map(([run_id,body])=>({kind:'langfuse_exported',metadata:{run_id,trace_sha256:sha(body)}}));
  if (modifiedTrace) traceCaptures.public+=' ';
  if (privateRead) exported.push({kind:'crm_read',metadata:{run_id:'advisor'}});
  const db={query:async(sql,args)=>{
    if(sql.includes('FROM idempotency')){
      const text='Mi documento es 98713426, mi teléfono es 3987412563 y mi correo es canary@example.invalid.';
      assert.equal(args[1],sha(JSON.stringify({address:'C-1012',text})));
      return missingIngress?[]:[{}];
    }
    if(sql.includes('FROM agent_checkpoint')) return [{result:{route:'soporte_tecnico',type:'handoff',reason:answer}}];
    if(sql.includes('FROM attention_event')) return exported;
    throw Error('Unexpected evidence query');
  }};
  const projection={verified:false,messages:[{actor:'agente',turn_seq:3,text:answer}],card:{handoff_summary:summary}};
  return verifyPrivacySurfaces(db,{caseId:'case',publicRun,advisorRun,snapshot:projection,advisorSummary:summary,
    customerSource:JSON.stringify([customer]),traceCaptures,before:new Date()});
}

test('privacy replay verifies both trace bytes and the absence of complete canaries on all surfaces', async ()=>{
  const result=await snapshotWithCanary();
  assert.equal(result.canary_present,true);
  assert.equal(result.private_reads,0);
  assert.deepEqual(result.surfaces,['answer','handoff_summary','trace']);
  for (const leak of ['answer','summary','trace']) {
    await assert.rejects(snapshotWithCanary({leak}),/privacy canary exposed/);
  }
  await assert.rejects(snapshotWithCanary({modifiedTrace:true}),/privacy trace digest mismatch/);
  await assert.rejects(snapshotWithCanary({missingIngress:true}),/privacy replay projection mismatch/);
  await assert.rejects(snapshotWithCanary({privateRead:true}),/privacy replay audit mismatch/);
});
