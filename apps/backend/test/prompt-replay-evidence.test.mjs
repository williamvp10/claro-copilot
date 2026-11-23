import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootstrapManifest, manifestDigest } from '../dist/prompt-catalog.js';
import { replayReportFingerprint, verifyPlatformReplay } from '../dist/prompt-replay-evidence.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
function mock(scenario,opts={}) {
 const manifest=bootstrapManifest(),digest=manifestDigest(manifest),candidate='candidate',base='base';
 const isOffer=scenario==='CC-E11',zero=['CC-E03','CC-E10','CC-E12'].includes(scenario),handoff=scenario==='CC-E03'||scenario==='CC-E10';
 const fixture=isOffer?'C-1004':scenario==='CC-E12'?'C-1007':'C-1013';
 const inputText='Mensaje sintetico de prueba';
 const suiteEntry={id:scenario,critical:true,input:{channel:scenario==='CC-E10'?'whatsapp':scenario==='CC-E12'?'consola':'telegram',business_date:'2026-11-18',identity_status:handoff?'unverified':'verified',...(scenario==='CC-E12'?{fixture}:{}),steps:[{type:'message',actor:'cliente',text:inputText}]},expected:[{after_step:1,route:scenario==='CC-E03'?'derivar_n2':scenario==='CC-E10'?'derivar_supervisor':'retencion',external_writes:0,...handoff?{internal_handoff_count:1}:{}}]};
 const suite=[suiteEntry,...Array.from({length:18},(_,i)=>({id:`other-${i}`}))].map(row=>JSON.stringify(row)).join('\n')+'\n';
 const evidence={golden_sha256:'a'.repeat(64),scenarios_sha256:sha(suite),corpus_sha256:sha('[]'),baseline_manifest_sha256:digest,candidate_manifest_sha256:digest,date:'2026-11-18',rubric:manifest.check_semantic_criterion.sha256};
 const ids=isOffer?['run1','run2']:['run1'];
 const runs=ids.map((id,i)=>({id,case_id:'case',turn:{actor:'cliente',turn_seq:i+1,text:zero?inputText:i===0?'quiero cancelar':'acepto el descuento',case_revision:1,config_revision:opts.wrongRevision?'other':candidate,business_date:opts.wrongDate?'2026-11-17':evidence.date,scope_ref:handoff?'unverified':'verified',channel:scenario==='CC-E10' && !opts.wrongChannel?'whatsapp':'telegram',audience:'asesor',attention_mode:'asistido'}}));
 const proposal={id:'p1',run_id:ids.at(-1),case_revision:1,option_id:isOffer?'discount':'priority-ticket',proposal:{id:'p1',revision:1,status:'confirmed',effect_ref:'receipt'}};
 const op={id:'agent:p1',case_id:'case',case_revision:1,customer_ref:fixture,status:'confirmed',reference:'receipt',advisor:'advisor',action:isOffer?{kind:'offer',codigo:'RET-A',customer_accepted:true}:{kind:'ticket',ticket:{categoria:'soporte_tecnico',prioridad:'prioritaria'}}};
 const dest=scenario==='CC-E03'?'soporte_tecnico':'supervision',reason=scenario==='CC-E03'?'los_rojo_mas_de_10_minutos':'requerimiento_legal_o_regulatorio';
 const card=zero ? scenario==='CC-E12'?{facts:[{id:'days-past-due',value:'45'},{id:'days-limit',value:'30'}],reason_codes:['retention_ineligible']}:{suggested_escalation:{destination:dest,reason_code:reason}} : {proposal:{id:'p1',status:'pending_approval'},summary:'Visita prioritaria dentro de 24 horas',facts:[{id:'technical-tickets-90d',value:'4'}]};
 let written;
 const tx={async query(sql,args){
  if(sql.includes('SELECT e.base_revision'))return [{base_revision:base,report:{evidence},manifest,prompts:{}}];
  if(sql.includes('SELECT * FROM prompt_revision'))return [{manifest,prompts:{}}];
  if(sql.includes('FROM knowledge_document'))return [];
  if(sql.includes('SELECT * FROM attention_case'))return [{snapshot:{verified:!handoff},account_ref:fixture}];
  if(sql.includes('SELECT id,case_id,turn FROM agent_run'))return runs;
  if(sql.includes('SELECT transaction_timestamp()'))return [{closed_at:new Date('2026-11-18T00:01:00Z')}];
  if(sql.includes('SELECT * FROM retention_proposal'))return [proposal];
  if(sql.includes('SELECT * FROM integration_operation'))return [op];
  if(sql.includes('SELECT result FROM agent_checkpoint')) {
   if(args[0].startsWith('resume:'))return [{result:{card:{summary:'Ticket registrado: receipt. Franja de visita pendiente de coordinación.'}}}];
   if(isOffer && args[0]==='run:run1')return [{result:{card:{reason_codes:['retention_eligible'],summary:'30 % durante seis meses'}}}];
   return [{result:{type:'card',card}}];
  }
  if(sql.includes("kind='candidate_replay_queued'"))return opts.missingReplayMarker?[]:ids.map(run_id=>({
   run_id,created_at:new Date('2026-11-18T00:00:00Z'),transport:scenario==='CC-E10' && !opts.missingTransport?'whatsapp_fixture':null
  }));
  if(sql.includes('AS operations'))return [{operations:opts.effect?1:0,effect_jobs:0,proposals:0,offers:0,tickets:0}];
  if(sql.includes('FROM escalation\n'))return opts.noHandoff?[]:[{id:'esc',destination:dest,reason_code:reason,status:'tomado',owner_id:'specialist',request_revision:1,created_at:new Date('2026-11-18T00:00:10Z')}];
  if(sql.includes("kind='escalation_claim'"))return opts.noClaim?[]:[{id:'42',metadata:{destination:dest,operator_id:'specialist'},created_at:new Date('2026-11-18T00:00:20Z')}];
  if(sql.includes('SELECT kind FROM attention_event'))return opts.noRead?[]:[{kind:'crm_read'},{kind:'retention_read'}];
  if(sql.includes('SELECT kind,metadata'))return isOffer?[{kind:'crm_read',run_id:'run1'},{kind:'retention_read',run_id:'run1'}]:[{kind:'crm_read',run_id:'run1'},{kind:'tickets_read',run_id:'run1'}];
  if(sql.includes('SELECT key,fingerprint'))return [{key:'approval-key',fingerprint:sha(JSON.stringify({decision:'approved',revision:1,idempotency_key:'approval-key'}))}];
  if(sql.includes('SELECT count(*)'))return [{n:opts.duplicate?2:1}];
  if(sql.includes('FROM crm_effect')||sql.includes('FROM support_ticket'))return [{id:'receipt',recorded_at:new Date()}];
  if(sql.includes('proposal_decision_replayed'))return opts.replay?[{id:1}]:[];
  if(sql.includes('INSERT INTO prompt_platform_evidence')){written=args;return [];}
  throw Error('unexpected SQL '+sql);
 }};
 const db={transaction:async(_isolation,fn)=>fn(tx)};
 const receipt=async()=>({clave:'agent:p1',referencia:opts.badReceipt?'bad':'receipt',tipo:isOffer?'oferta':'ticket'});
 const customer=async()=>({dias_mora:opts.wrongMora?0:45});
 const eligibility=async()=>({eligible:false,reason:'45 días de mora superan el límite de 30 días.',options:[]});
 return {db,input:{candidate,scenario,caseId:'case',...zero?{scenarioSuiteText:suite}:{proposalId:'p1'},runIds:ids},receipt,customer,eligibility,evidence,get written(){return written}};
}
const verify=m=>verifyPlatformReplay(m.db,m.input,m.receipt,m.customer,m.eligibility);
test('platform verifier persists ticket proof tied to suite and candidate',async()=>{
 const m=mock('CC-E13');const result=await verify(m);
 assert.equal(result.proof.verified_effect,true);assert.equal(result.report_fingerprint,replayReportFingerprint('candidate','base',m.evidence));assert.equal(m.written[1],'CC-E13');
});
test('offer replay evidence is required to close its final step',async()=>{
 const pending=mock('CC-E11');assert.equal((await verify(pending)).proof.replay_request_observed,false);
 const replay=mock('CC-E11',{replay:true});assert.equal((await verify(replay)).proof.replay_request_observed,true);
});
test('rejects wrong candidate revision/date, mismatched receipt and duplicated effects',async()=>{
 for(const opts of [{wrongRevision:true},{wrongDate:true},{badReceipt:true},{duplicate:true},{missingReplayMarker:true}]){const m=mock('CC-E13',opts);await assert.rejects(verify(m));assert.equal(m.written,undefined);}
});
test('zero-effect replay checks the actual candidate, case, suite and authorized handoff',async()=>{
 for(const scenario of ['CC-E03','CC-E10']) {const m=mock(scenario); const result=await verify(m);assert.equal(result.proof.verified_no_effect,true);assert.equal(result.proof.claim_event_id,'42');}
 for(const opts of [{effect:true},{noHandoff:true},{noClaim:true},{missingReplayMarker:true},{wrongDate:true}]){const m=mock('CC-E03',opts);await assert.rejects(verify(m));assert.equal(m.written,undefined);}
 const altered=mock('CC-E03');altered.input.scenarioSuiteText+=' ';await assert.rejects(verify(altered),/suite mismatch/);
 const wrongChannel=mock('CC-E10',{wrongChannel:true});await assert.rejects(verify(wrongChannel),/scenario input mismatch/);
 await assert.rejects(verify(mock('CC-E10',{missingTransport:true})),/WhatsApp fixture transport marker missing/);
});
test('retention denial requires verified 45-day customer, eligibility and run-scoped reads',async()=>{
 const good=mock('CC-E12');assert.equal((await verify(good)).proof.assertion,'retention_ineligible');
 for(const opts of [{wrongMora:true},{noRead:true},{effect:true}]){const m=mock('CC-E12',opts);await assert.rejects(verify(m));assert.equal(m.written,undefined);}
});
