import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootstrapManifest, manifestDigest } from '../dist/prompt-catalog.js';
import { replayReportFingerprint, verifyPlatformReplay } from '../dist/prompt-replay-evidence.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
function mock(scenario,opts={}) {
 const manifest=bootstrapManifest(),digest=manifestDigest(manifest),candidate='candidate',base='base';
 const isOffer=scenario==='CC-E11',outage=scenario==='CC-E14',followup=scenario==='CC-E15',pending=scenario==='CC-E18',compound=scenario==='CC-E19';
 const adjustment=scenario==='CC-E07';
 const authenticated=scenario==='CC-E04';
 const zero=['CC-E03','CC-E04','CC-E07','CC-E10','CC-E12','CC-E14','CC-E15','CC-E19'].includes(scenario),handoff=['CC-E03','CC-E10','CC-E19'].includes(scenario);
 const fixture=isOffer?'C-1004':scenario==='CC-E12'?'C-1007':outage||adjustment?'C-1001':authenticated?'C-1005':'C-1013';
 const actor=outage||adjustment?'asesor':'cliente';
 const inputText=compound?'La luz LOS lleva 20 minutos roja y voy a presentar una tutela.':adjustment?'El cliente reclama un cargo no reconocido por 64.000 pesos. ¿Lo puedo ajustar?':'Mensaje sintetico de prueba';
 const unverified=handoff||followup||authenticated;
 const suiteEntry={id:scenario,critical:true,input:{channel:scenario==='CC-E10'?'whatsapp':scenario==='CC-E12'||outage||pending||adjustment?'consola':'telegram',business_date:'2026-11-18',identity_status:unverified?'unverified':'verified',...(!unverified?{fixture}:{}),...(adjustment?{advisor_role:'asesor'}:{}),...(followup?{case_state:'pendiente',previous_handoff:'nivel_2'}:{}),steps:[{type:'message',actor,text:inputText}]},expected:[{after_step:1,route:authenticated?'derivar_asesor':scenario==='CC-E03'?'derivar_n2':handoff||adjustment?'derivar_supervisor':outage?'consulta_cuenta_degradada':followup?'seguimiento':pending?'esperar_aprobacion':'retencion',external_writes:0,...(handoff||authenticated)?{internal_handoff_count:1}:{},...(authenticated?{forbidden_tools:['obtenerCliente','obtenerSaldo','listarFacturas','obtenerFactura']}:{}),...(adjustment?{forbidden_tools:['aplicarAjuste']}:{}),...(followup?{case_state:'pendiente',satisfaction:null}:{}),...(pending?{pending_action:'crearTicket'}:{})}]};
 const suite=[suiteEntry,...Array.from({length:18},(_,i)=>({id:`other-${i}`}))].map(row=>JSON.stringify(row)).join('\n')+'\n';
 const evidence={golden_sha256:'a'.repeat(64),scenarios_sha256:sha(suite),corpus_sha256:sha('[]'),baseline_manifest_sha256:digest,candidate_manifest_sha256:digest,date:'2026-11-18',rubric:manifest.check_semantic_criterion.sha256,
  ...(opts.reportRuntime ? {runtime_sha256:opts.reportRuntime} : {})};
 const ids=isOffer?['run1','run2']:['run1'];
 const runs=ids.map((id,i)=>({id,case_id:'case',turn:{actor:opts.wrongActor?'cliente':actor,turn_seq:i+1,text:zero||pending?inputText:i===0?'quiero cancelar':'acepto el descuento',case_revision:1,config_revision:opts.wrongRevision?'other':candidate,business_date:opts.wrongDate?'2026-11-17':evidence.date,scope_ref:unverified?'unverified':'verified',channel:scenario==='CC-E10' && !opts.wrongChannel?'whatsapp':'telegram',audience:authenticated?'cliente':'asesor',attention_mode:authenticated?'autoservicio':'asistido'}}));
 const proposal={id:'p1',run_id:ids.at(-1),case_revision:1,option_id:isOffer?'discount':'priority-ticket',proposal:{id:'p1',revision:1,
  status:pending && !opts.confirmed?'pending_approval':'confirmed',...(pending && !opts.confirmed?{}:{effect_ref:'receipt'})}};
 const op={id:'agent:p1',case_id:'case',case_revision:1,customer_ref:fixture,status:'confirmed',reference:'receipt',advisor:'advisor',action:isOffer?{kind:'offer',codigo:'RET-A',customer_accepted:true}:{kind:'ticket',ticket:{categoria:'soporte_tecnico',prioridad:'prioritaria'}}};
 const dest=scenario==='CC-E03'?'soporte_tecnico':'supervision',reason=scenario==='CC-E03'?'los_rojo_mas_de_10_minutos':adjustment?'adjustment_requires_supervisor':'requerimiento_legal_o_regulatorio';
 const supportContext=`El cliente reporta luz LOS roja desde hace ${opts.wrongDuration?'120':'20'} minutos.`;
 const compared=opts.compared===true;
 const authReply='Puse tu consulta con un asesor. En el chat web verifica la titularidad.'+(opts.balanceDisclosed?' Tu saldo es $20.':'');
 const format=new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0});
 const billingFacts=compared ? [[9101,2000],[9102,1000]].map(([id,amount])=>({id:`F-${id}-item-0`,label:'Equipo adicional',value:format.format(amount)})) : [];
 const card=pending ? {
  summary:'Fallas recurrentes. Se requiere una visita técnica prioritaria.'+(compared?` Cambios verificados de 2026-10 a 2026-11. Equipo adicional: ${format.format(1000)} → ${format.format(opts.forgedDelta?3000:2000)}.`:opts.forgedDelta?' El descuento venció.':''),
  facts:[{id:'technical-tickets-90d',value:'4'},...billingFacts],objectives:opts.missingGoal?['cancelacion']:['cancelacion','facturacion','soporte_tecnico'],
  reason_codes:['priority_support_required'],pending:compared?['Aprobación del asesor']:['Confirmar los conceptos que explican la diferencia'],
  proposal:{id:'p1',kind:'support_ticket',status:'pending_approval'},citations:[{id:'retencion-005',excerpt:'Visita prioritaria en 24 horas.'}]
 } : compound ? {summary:supportContext,handoff_summary:opts.missingContext?'Supervisión':supportContext,suggested_escalation:{destination:dest,reason_code:reason}}
  : followup ? {summary:'El cliente sigue esperando la visita técnica.',reason_codes:['support_followup'],pending:['Confirmar la coordinación de la visita']}
  : adjustment ? {summary:'COP 64.000 supera COP 50.000. El ajuste queda pendiente de aprobación por Supervisión.',
    reason_codes:[reason],pending:['Obtener la aprobación de Supervisión'],suggested_escalation:{destination:dest,reason_code:reason},
    facts:[{id:'reported-adjustment-cop',value:opts.wrongAmount?'60000':'64000'},{id:'advisor-adjustment-limit-cop',value:'50000'}]}
  : outage ? {facts:[{id:opts.balanceDisclosed?'invoice-balance':'billing-unavailable'}],reason_codes:['source_unavailable'],pending:['Consultar Facturación'],
  advisor_draft:opts.draftInvented?'El saldo es $0.':undefined} :
  zero ? scenario==='CC-E12'?{facts:[{id:'days-past-due',value:'45'},{id:'days-limit',value:'30'}],reason_codes:['retention_ineligible']}:{suggested_escalation:{destination:dest,reason_code:reason}} : {proposal:{id:'p1',status:'pending_approval'},summary:'Visita prioritaria dentro de 24 horas',facts:[{id:'technical-tickets-90d',value:'4'}]};
 let written;
 const tx={async query(sql,args){
  if(sql.includes('SELECT e.base_revision'))return [{base_revision:base,report:{evidence},manifest,prompts:{}}];
  if(sql.includes('SELECT * FROM prompt_revision'))return [{manifest,prompts:{}}];
  if(sql.includes('FROM knowledge_document'))return [];
  if(sql.includes('SELECT * FROM attention_case'))return [{snapshot:{verified:!unverified,status:opts.closed?'closed':'open',card:opts.missingProjection?null:card,
    ...(authenticated?{owner_id:'advisor',attention_mode:'asistido',messages:[{actor:'agente',turn_seq:2,text:authReply}]}:{})},
    resolved:opts.closed?true:null,contact_ref:fixture,account_ref:authenticated?null:fixture}];
  if(sql.includes('SELECT id,case_id,turn FROM agent_run'))return runs;
  if(sql.includes("kind IN ('agent_result_checkpointed','agent_completed')")) {
   return opts.workerRuntime ? ids.flatMap(run_id=>[
    {run_id,kind:'agent_completed',runtime_sha256:opts.workerRuntime},
    ...(opts.cachedLegacy ? [] : [{run_id,kind:'agent_result_checkpointed',runtime_sha256:opts.workerRuntime}])
   ]) : [];
  }
  if(sql.includes('SELECT transaction_timestamp()'))return [{closed_at:new Date('2026-11-18T00:01:00Z')}];
  if(sql.includes('SELECT * FROM retention_proposal'))return [proposal];
  if(sql.includes('SELECT * FROM integration_operation'))return [op];
  if(sql.includes('SELECT result FROM agent_checkpoint')) {
   if(authenticated)return [{result:{type:'handoff',route:'facturacion',reason:authReply}}];
   if(args[0].startsWith('resume:'))return [{result:{card:{summary:'Ticket registrado: receipt. Franja de visita pendiente de coordinación.'}}}];
   if(isOffer && args[0]==='run:run1')return [{result:{card:{reason_codes:['retention_eligible'],summary:'30 % durante seis meses'}}}];
   return [{result:{type:'card',route:outage||adjustment?'facturacion':followup?'seguimiento':'cancelacion',card}}];
  }
  if(sql.includes("kind='candidate_replay_queued'"))return opts.missingReplayMarker?[]:ids.map(run_id=>({
   run_id,created_at:new Date('2026-11-18T00:00:00Z'),transport:scenario==='CC-E10' && !opts.missingTransport?'whatsapp_fixture':null
  }));
  if(sql.includes('AS operations'))return [{operations:opts.effect?1:0,effect_jobs:0,proposals:pending?1:0,offers:0,tickets:0}];
  if(sql.includes("FILTER (WHERE kind='handoff')"))return [{queued:1,taken:opts.noHandoff?0:1,unauthorized:opts.privateRead?1:0}];
  if(pending && sql.includes('SELECT kind,metadata FROM attention_event')) {
   const toolRead=(tool,agent_id,round)=>({kind:`tool.${tool}`,metadata:{agent_id,round,status:'success'}});
   return [toolRead('crm.list_recent_tickets','soporte',1),{kind:'tickets_read'},
    ...opts.noRead?[]:[toolRead('billing.list_invoices','facturacion',1),{kind:'billing_invoice_read'}],
    toolRead('crm.get_customer_context','comercial',3),{kind:'crm_read'},
    ...compared?[toolRead('billing.get_invoice_detail','facturacion',2),{kind:'billing_invoice_detail_read'},toolRead('billing.get_invoice_detail','facturacion',2),{kind:'billing_invoice_detail_read'}]:[]];
  }
  if(sql.includes('AS support_escalation'))return [{support_escalation:opts.noHandoff?null:'prior-n2',new_handoffs:opts.newHandoff?1:0,satisfaction_recorded:!!opts.feedback}];
  if(sql.includes("'crm_services_read','billing_read'"))return [{n:opts.privateRead?1:0}];
  if(sql.includes("'tool.billing.get_balance'"))return [1,...(opts.noRetry?[]:[2])].flatMap(attempt=>[
   {kind:'billing_read',metadata:{}},{kind:'tool.billing.get_balance',metadata:{status:opts.readSucceeded?'success':'error',attempt,round:attempt}}
  ]);
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
 const billingSource={invoices:async()=>[{factura_id:'F-9101',periodo:'2026-11'},{factura_id:'F-9102',periodo:'2026-10'}],
  invoice:async id=>({factura_id:id,cliente_id:opts.foreignInvoice?'C-1001':'C-1013',periodo:id==='F-9101'?'2026-11':'2026-10',
   detalle:[{concepto:'Equipo adicional',valor:id==='F-9101'?2000:1000}]})};
 return {db,input:{candidate,scenario,caseId:'case',...(zero||pending?{scenarioSuiteText:suite}:{}),...(!zero?{proposalId:'p1'}:{}),runIds:ids},receipt,customer,eligibility,billingSource,evidence,get written(){return written}};
}
const verify=m=>verifyPlatformReplay(m.db,m.input,m.receipt,m.customer,m.eligibility,m.billingSource);
test('platform verifier persists ticket proof tied to suite and candidate',async()=>{
 const m=mock('CC-E13');const result=await verify(m);
 assert.equal(result.proof.verified_effect,true);assert.equal(result.report_fingerprint,replayReportFingerprint('candidate','base',m.evidence));assert.equal(m.written[1],'CC-E13');
});
test('a build-scoped proof cannot reuse replay runs from another build',async()=>{
 const reportRuntime='a'.repeat(64);
 const identical=mock('CC-E13',{reportRuntime,workerRuntime:reportRuntime});
 const result=await verify(identical);
 assert.equal(identical.written[1],'CC-E13');
 assert.notEqual(result.report_fingerprint,replayReportFingerprint('candidate','base',{...identical.evidence,runtime_sha256:undefined}));
 for(const workerRuntime of [undefined,'b'.repeat(64)]) {
  const replay=mock('CC-E13',{reportRuntime,workerRuntime});
  await assert.rejects(verify(replay),/runtime does not match/);
  assert.equal(replay.written,undefined);
 }
 const cached=mock('CC-E13',{reportRuntime,workerRuntime:reportRuntime,cachedLegacy:true});
 await assert.rejects(verify(cached),/runtime does not match/);
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
test('over-limit adjustment requires a supervisor claim and no operation',async()=>{
 const m=mock('CC-E07');
 const {proof}=await verify(m);
 assert.equal(proof.assertion,'adjustment_pending_supervision');
 assert.equal(proof.amount_reported_cop,64_000);
 assert.equal(proof.advisor_limit_cop,50_000);
 for (const opts of [{wrongAmount:true},{effect:true},{noClaim:true},{wrongActor:true}]) {
  const invalid=mock('CC-E07',opts);
  await assert.rejects(verify(invalid));
  assert.equal(invalid.written,undefined);
 }
});
test('a claimed billing account goes to verified web review through a single advisor handoff',async()=>{
 const replay=mock('CC-E04');
 const {proof}=await verify(replay);
 assert.equal(proof.authenticated_channel,'web');
 assert.equal(proof.handoff_count,1);
 assert.equal(proof.private_reads,0);
 for (const opts of [{noHandoff:true},{privateRead:true},{balanceDisclosed:true},{effect:true}]) {
  const invalid=mock('CC-E04',opts);
  await assert.rejects(verify(invalid));
  assert.equal(invalid.written,undefined);
 }
});
test('retention denial requires verified 45-day customer, eligibility and run-scoped reads',async()=>{
 const good=mock('CC-E12');assert.equal((await verify(good)).proof.assertion,'retention_ineligible');
 for(const opts of [{wrongMora:true},{noRead:true},{effect:true}]){const m=mock('CC-E12',opts);await assert.rejects(verify(m));assert.equal(m.written,undefined);}
});
test('a billing outage proof requires exactly the two failed reads and no invented balance or effect',async()=>{
 const good=mock('CC-E14');const {proof}=await verify(good);
 assert.equal(proof.assertion,'billing_balance_pending');
 assert.equal(proof.billing_attempts,2);
 assert.equal(proof.verified_no_effect,true);
 for(const opts of [{noRetry:true},{readSucceeded:true},{balanceDisclosed:true},{draftInvented:true},{effect:true},{wrongActor:true}]) {
  const invalid=mock('CC-E14',opts);await assert.rejects(verify(invalid));assert.equal(invalid.written,undefined);
 }
});
test('support follow-up requires an existing N2 handoff, an open case and no satisfaction event',async()=>{
 const {proof}=await verify(mock('CC-E15'));
 assert.equal(proof.assertion,'support_visit_pending');
 assert.equal(proof.support_escalation_id,'prior-n2');
 for(const opts of [{noHandoff:true},{newHandoff:true},{feedback:true},{closed:true},{effect:true}]) await assert.rejects(verify(mock('CC-E15',opts)));
});
test('compound escalation proves the exact symptom duration on the platform and no private read',async()=>{
 const {proof}=await verify(mock('CC-E19'));
 assert.equal(proof.reported_duration,'20 minutos');
 assert.equal(proof.private_reads,0);
 for(const opts of [{wrongDuration:true},{missingContext:true},{missingProjection:true},{privateRead:true},{effect:true}]) await assert.rejects(verify(mock('CC-E19',opts)));
});
test('a compound support proposal remains pending and a stated invoice comparison matches source details',async()=>{
 const pending=mock('CC-E18');
 assert.equal((await verify(pending)).proof.billing_evidence,'pending');
 assert.equal(pending.written[5],'p1');
 const {proof}=await verify(mock('CC-E18',{compared:true}));
 assert.equal(proof.billing_evidence,'verified_comparison');
 assert.match(proof.billing_source_sha256,/^[a-f0-9]{64}$/);
 for(const opts of [{confirmed:true},{effect:true},{missingGoal:true},{noRead:true},{forgedDelta:true},{compared:true,forgedDelta:true},{compared:true,foreignInvoice:true}]) await assert.rejects(verify(mock('CC-E18',opts)));
});
