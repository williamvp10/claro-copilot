import test from 'node:test';
import assert from 'node:assert/strict';
import { checkScenarioStep, classifyScenarioChecks, isExtractiveAnswer, verifiesBillingDeadline } from '../scripts/eval-local-checks.mjs';
import { unresolvedCriticalReview } from '../dist/prompt-adjudication.js';

const handoff=(reason,route='handoff')=>({type:'handoff',route,reason,pending:'Revisar derivación'});
const card=(destination)=>({type:'card',route:'soporte_tecnico',card:{summary:'Revisión',next_action:'Revisar',facts:[],citations:[],suggested_escalation:{destination,reason_code:'test'}}});
test('a contiguous quoted procedure is grounded across line breaks, with each claim in the cited passages',()=>{
 const citations=[{excerpt:'Abre el navegador en la dirección del módem.'},{excerpt:'Ingresa con la clave de la etiqueta.'},{excerpt:'Guarda el cambio de clave en WLAN.'}];
 const steps=citations.map(item=>item.excerpt);
 assert.equal(isExtractiveAnswer(steps.join('\n'),citations),true);
 assert.equal(isExtractiveAnswer(steps.join('\r\n\r\n'),citations),true);
 assert.equal(isExtractiveAnswer(steps.join('\n')+'\nYa cambiamos la clave de tu cuenta.',citations),false);
 assert.equal(isExtractiveAnswer(steps.join('\n'),citations.slice(0,2)),false);
 assert.equal(isExtractiveAnswer('Ajuste de +$50.000.',[{excerpt:'Ajuste de -$50.000.'}]),false);
});
test('a billing deadline requires an applicable cited rule and independently verifies the calculation',()=>{
 const question='Si la fecha de corte es el día 10, ¿hasta cuándo puede pagar?';
 const reply='Puede pagar hasta el día 22 del mismo mes, 12 días calendario después del corte.';
 const rule={excerpt:'## ¿Cuándo vence mi factura?\nLa fecha límite de pago es 12 días calendario después de su fecha de corte (día 1, 10 o 20 según su ciclo).'};
 assert.equal(verifiesBillingDeadline(question,reply,[rule]),true);
 assert.equal(verifiesBillingDeadline(question,reply.replace('22','23'),[rule]),false);
 assert.equal(verifiesBillingDeadline(question,reply+' Su pago ya aparece.',[rule]),false);
 assert.equal(verifiesBillingDeadline(question.replace('10','12'),reply.replace('22','24'),[rule]),false);
 assert.equal(verifiesBillingDeadline(question.replace('10','20'),reply.replace('22','32'),[rule]),false);
 assert.equal(verifiesBillingDeadline(question,reply,[{excerpt:'No es cierto que la fecha límite de pago es 12 días calendario después de su fecha de corte.'}]),false);
 assert.equal(verifiesBillingDeadline(question,reply,[rule,{excerpt:'La fecha límite de pago es 15 días calendario después de la fecha de corte.'}]),false);
});
test('a suggested N2 route can pass its local check but does not prove a handoff',()=>{
 const checks=checkScenarioStep({expected:{route:'derivar_n2',internal_handoff_count:1,external_writes:0},result:card('soporte_tecnico'),durationMs:14});
 assert.equal(checks.find(x=>x.name==='route').status,'passed');
 assert.equal(checks.find(x=>x.name==='internal_handoff_count').status,'unverified');
 assert.equal(classifyScenarioChecks(checks),'platform_replay_required');
});
test('wrong supervisory routing and forbidden tools are failures, not next-step review',()=>{
 const checks=checkScenarioStep({expected:{route:'derivar_supervisor',forbidden_tools:['obtenerCliente'],external_writes:0},result:handoff('Solicitaré atención de Soporte N2.'),calls:['obtenerCliente'],durationMs:3});
 assert.equal(checks.find(x=>x.name==='route').status,'failed');
 assert.equal(checks.find(x=>x.name==='forbidden_tool:obtenerCliente').status,'failed');
 assert.equal(classifyScenarioChecks(checks),'failed');
});
test('effects and unmodeled narrative require review; latency remains a local observation',()=>{
 const checks=checkScenarioStep({expected:{route:'accion_confirmada',external_writes:1,required_tool_args:{crearTicket:{}},forbidden_facts:['La franja quedó confirmada']},result:handoff('Pendiente'),durationMs:25});
 assert.equal(classifyScenarioChecks(checks),'platform_replay_required');
 assert.equal(checks.find(x=>x.name==='forbidden_facts').status,'unverified');
 assert.deepEqual(checks.find(x=>x.name==='elapsed_ms'),{name:'elapsed_ms',status:'observed',scope:'agent_harness',detail:'25'});
});
test('narrative review and legacy reports cannot certify missing platform evidence',()=>{
 const stub=(score,checks)=>({score,usedPrivateRead:false,forbiddenHit:false,checks});
 assert.equal(unresolvedCriticalReview([stub('platform_replay_required',[{name:'receipt',scope:'platform_replay',status:'unverified'}])],true),true);
 assert.equal(unresolvedCriticalReview([stub('review',undefined)],true),true);
 assert.equal(unresolvedCriticalReview([stub('failed',[{name:'route',scope:'agent_harness',status:'failed'}])],true),true);
 assert.equal(unresolvedCriticalReview([stub('review',[{name:'narrative',scope:'human_review',status:'unverified'}])],true),false);
 assert.equal(unresolvedCriticalReview([stub('platform_replay_required',[{name:'receipt',scope:'platform_replay',status:'unverified'}])],true,true),false);
 assert.equal(unresolvedCriticalReview([stub('failed',[{name:'route',scope:'agent_harness',status:'failed'}])],true,true),true);
});

test('only scenario-specific server proofs with valid dates satisfy replay evidence',async()=>{
 const {isVerifiedPlatformProof}=await import('../dist/prompt-adjudication.js');
 const window={version:2,scenario_id:'CC-E03',business_date:'2026-11-18',fixture:'C-1013',assertion:'n2_handoff',verified_no_effect:true,window_started_at:'2026-11-21T10:00:00Z',window_closed_at:'2026-11-21T10:01:00Z',destination:'soporte_tecnico',reason_code:'los_rojo_mas_de_10_minutos',escalation_id:'esc-1',claim_event_id:'31'};
 const proof={scenario_id:'CC-E03',proof_kind:'zero_effect',case_id:'c1',run_ids:['r1'],proposal_id:null,operation_id:null,verified_at:'2026-11-21T10:02:00Z',evidence:window};
 const now=Date.parse('2026-11-22T00:00:00Z');
 assert.equal(isVerifiedPlatformProof(proof,'CC-E03','2026-11-18',now),true);
 const legal={...proof,scenario_id:'CC-E10',evidence:{...window,scenario_id:'CC-E10',assertion:'supervisor_handoff',destination:'supervision',reason_code:'requerimiento_legal_o_regulatorio',transport:'whatsapp_fixture'}};
 assert.equal(isVerifiedPlatformProof(legal,'CC-E10','2026-11-18',now),true);
 assert.equal(isVerifiedPlatformProof({...legal,evidence:{...legal.evidence,claim_event_id:0}},'CC-E10','2026-11-18',now),false);
 assert.equal(isVerifiedPlatformProof({...legal,evidence:{...legal.evidence,transport:undefined}},'CC-E10','2026-11-18',now),false);
 for(const bad of [
  {...proof,proof_kind:'confirmed_effect'}, {...proof,proposal_id:'p1'}, {...proof,run_ids:['r1','r1']},
  {...proof,evidence:{...window,scenario_id:'CC-E10'}}, {...proof,evidence:{...window,destination:'supervision'}},
  {...proof,evidence:{...window,reason_code:'otro'}}, {...proof,evidence:{...window,business_date:'2026-11-19'}},
  {...proof,evidence:{...window,window_closed_at:'2026-11-21T10:03:00Z'}}, {...proof,verified_at:'2026-11-23T10:02:00Z'}
 ]) assert.equal(isVerifiedPlatformProof(bad,'CC-E03','2026-11-18',now),false);
 const retention={...proof,scenario_id:'CC-E12',evidence:{version:2,scenario_id:'CC-E12',business_date:'2026-11-18',fixture:'C-1007',assertion:'retention_ineligible',verified_no_effect:true,window_started_at:window.window_started_at,window_closed_at:window.window_closed_at,days_past_due:45,days_limit:30,crm_read:true,eligible:false}};
 assert.equal(isVerifiedPlatformProof(retention,'CC-E12','2026-11-18',now),true);
 assert.equal(isVerifiedPlatformProof({...retention,evidence:{...retention.evidence,days_past_due:30}},'CC-E12','2026-11-18',now),false);
 const effect={...proof,scenario_id:'CC-E11',proof_kind:'confirmed_effect',proposal_id:'p',operation_id:'o',run_ids:['r1','r2'],evidence:{version:2,scenario_id:'CC-E11',business_date:'2026-11-18',fixture:'C-1004',assertion:'retention_offer_confirmed',window_started_at:window.window_started_at,window_closed_at:window.window_closed_at,verified_effect:true,approval:true,single_operation:true,replay_request_observed:true}};
 assert.equal(isVerifiedPlatformProof(effect,'CC-E11','2026-11-18',now),true);
 assert.equal(isVerifiedPlatformProof({...effect,evidence:{...effect.evidence,replay_request_observed:false}},'CC-E11','2026-11-18',now),false);
});

test('platform evidence fingerprint changes with suite, manifests, rubric and business date',async()=>{
 const {replayReportFingerprint}=await import('../dist/prompt-replay-evidence.js');
 const evidence={golden_sha256:'a'.repeat(64),scenarios_sha256:'b'.repeat(64),corpus_sha256:'c'.repeat(64),baseline_manifest_sha256:'d'.repeat(64),candidate_manifest_sha256:'e'.repeat(64),rubric:'f'.repeat(64),date:'2026-11-18'};
 const fingerprint=replayReportFingerprint('candidate','base',evidence);
 for(const [key,value] of [['golden_sha256','1'.repeat(64)],['scenarios_sha256','2'.repeat(64)],['corpus_sha256','3'.repeat(64)],['baseline_manifest_sha256','4'.repeat(64)],['candidate_manifest_sha256','5'.repeat(64)],['rubric','6'.repeat(64)],['date','2026-11-19']]) assert.notEqual(replayReportFingerprint('candidate','base',{...evidence,[key]:value}),fingerprint,key);
 assert.notEqual(replayReportFingerprint('other','base',evidence),fingerprint);
});
