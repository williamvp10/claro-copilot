import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootstrapManifest,manifestDigest } from '../dist/prompt-catalog.js';
import { verifyGoldenPlatform } from '../dist/golden-platform-evidence.js';
import { isVerifiedGoldenProof } from '../dist/prompt-adjudication.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(id,opts={}) {
 const manifest=bootstrapManifest(),digest=manifestDigest(manifest);
 const ref={'GQ-25':'C-1001','GQ-26':'C-1004','GQ-27':'C-1007','GQ-28':'C-1013'}[id];
 const text=`Consulta sintetica ${ref}`;
 const suite=[{id,pregunta:text,herramientas_esperadas:['obtenerCliente']},...Array.from({length:29},(_,i)=>({id:`other-${i}`}))].map(JSON.stringify).join('\n')+'\n';
 const evidence={golden_sha256:hash(suite),scenarios_sha256:'a'.repeat(64),corpus_sha256:hash('[]'),baseline_manifest_sha256:digest,candidate_manifest_sha256:digest,date:'2026-11-18',rubric:manifest.check_semantic_criterion.sha256};
 const customer={cliente_id:ref,antiguedad_meses:30,dias_mora:id==='GQ-27'?45:0,ofertas_retencion_12m:[],servicios:[{plan:'Hogar Fibra 500',valor_mensual:109900,estado:'activo'},{plan:'Claro Max 60 GB',valor_mensual:59415,estado:'activo'}]};
 const balance={cliente_id:ref,saldo_pendiente:169315,proxima_fecha_limite:'2026-11-25'};
 const invoice={periodo:'2026-11',estado:'pendiente',valor_total:169315,fecha_limite_pago:'2026-11-25'};
 const eligibility=id==='GQ-27'?{eligible:false,reason:'45 días de mora superan límite 30',options:[]}:{eligible:true,options:[{codigo:'RET-A',title:'30 % de descuento',detail:'Sobre $89.900 durante seis meses.'},{codigo:'RET-B',title:'Mejora a Fibra 500',detail:'Sin costo durante seis meses.'}]};
 const card=id==='GQ-25'?{facts:[{label:'Hogar Fibra 500',value:'$109.900'},{label:'Claro Max 60 GB',value:'$59.415'},{id:'invoice-balance',value:'$169.315'},{id:'invoice-due',value:'2026-11-25'}],reason_codes:[],summary:'Cuenta',next_action:'Explicar'}:id==='GQ-26'?{facts:[{id:'tenure',value:'30'},{id:'days-past-due',value:'0'},{id:'offers-year',value:'0'}],reason_codes:['retention_eligible'],summary:'30 % sobre $89.900 durante seis meses o Fibra 500 seis meses'}:id==='GQ-27'?{facts:[{id:'days-past-due',value:'45'},{id:'days-limit',value:'30'}],reason_codes:['retention_ineligible'],summary:'No elegible'}:{facts:[{id:'technical-tickets-90d',value:'4'}],reason_codes:[],summary:'Visita prioritaria dentro de 24 horas',proposal:{id:'p1',status:'pending_approval'}};
 const op={id:'agent:p1',case_id:'case',case_revision:1,customer_ref:ref,status:'confirmed',reference:'ticket',advisor:'advisor',created_at:new Date('2026-11-18T00:00:30Z'),action:{kind:'ticket',ticket:{categoria:'soporte_tecnico',prioridad:'prioritaria'}}};
 const proposal={id:'p1',run_id:'run',case_revision:1,option_id:'priority-ticket',proposal:{id:'p1',revision:1,status:'confirmed',effect_ref:'ticket'}};
 const counts=id==='GQ-28'?{operations:1,jobs:1,proposals:1}:{operations:opts.write?1:0,jobs:0,proposals:0};let written;
 const tx={async query(sql,args){
  if(sql.includes('SELECT e.base_revision'))return [{base_revision:'base',report:{evidence},manifest,prompts:{}}];
  if(sql.includes('SELECT * FROM prompt_revision'))return [{manifest,prompts:{}}];
  if(sql.includes('FROM knowledge_document'))return [];
  if(sql.includes('SELECT * FROM attention_case'))return [{snapshot:{verified:true,owner_id:'advisor'},contact_ref:ref}];
  if(sql.includes('SELECT id,case_id,turn'))return [{id:'run',case_id:'case',turn:{config_revision:opts.revision?'other':'candidate',business_date:evidence.date,text,scope_ref:'verified',actor:'cliente',attention_mode:'asistido',audience:'asesor',case_revision:1}}];
  if(sql.includes('candidate_replay_queued'))return opts.marker?[]:[{created_at:new Date('2026-11-18T00:00:00Z')}];
  if(sql.includes('SELECT transaction_timestamp'))return [{closed_at:new Date('2026-11-18T00:01:00Z')}];
  if(sql.includes('SELECT result FROM agent_checkpoint'))return args[0].startsWith('resume:')?[{result:{card:{summary:opts.agendado?'Visita agendada':'Ticket registrado y franja pendiente de coordinación'}}}]:[{result:{type:'card',card}}];
  if(sql.includes('SELECT kind FROM attention_event'))return ['crm_read',...opts.noBilling?[]:['billing_read'],'retention_read','tickets_read'].map(kind=>({kind}));
  if(sql.includes('AS operations'))return [counts];
  if(sql.includes('SELECT * FROM retention_proposal'))return [proposal];
  if(sql.includes('SELECT * FROM integration_operation'))return [op];
  if(sql.includes('SELECT key,fingerprint'))return [{key:'event',fingerprint:hash(JSON.stringify({decision:'approved',revision:1,idempotency_key:'event'}))}];
  if(sql.includes("kind='proposal_approved'"))return [{created_at:new Date('2026-11-18T00:00:20Z')}];
  if(sql.includes('SELECT count(*)'))return [{n:0}];
  if(sql.includes('SELECT id FROM support_ticket'))return [{id:'ticket'}];
  if(sql.includes('INSERT INTO prompt_golden_evidence')){written=args;return [];}
  throw Error('Unexpected query '+sql);
 }};
 const source={customer:async()=>customer,balance:async()=>balance,invoices:async()=>[invoice],eligibility:async()=>eligibility,receipt:async()=>({clave:'agent:p1',referencia:opts.badReceipt?'wrong':'ticket',tipo:'ticket'}),tickets:async()=>[1,2,3,4].map(n=>({categoria:'soporte_tecnico',ticket_id:`old${n}`})).concat({categoria:'soporte_tecnico',ticket_id:'ticket'})};
 return {db:{transaction:async(_level,fn)=>fn(tx)},input:{candidate:'candidate',goldenId:id,caseId:'case',runId:'run',goldenSuiteText:suite,...id==='GQ-28'?{proposalId:'p1'}:{}},source,get written(){return written}};
}
const verify=m=>verifyGoldenPlatform(m.db,m.input,m.source);
test('all golden checks require run-scoped evidence and real source agreement',async()=>{
 for(const id of ['GQ-25','GQ-26','GQ-27','GQ-28']){const m=fixture(id);const out=await verify(m);assert.equal(out.proof.golden_id,id);assert.ok(m.written);}
});
test('rejects wrong revision, missing marker, missing billing read or writes without approval',async()=>{
 for(const opts of [{revision:true},{marker:true},{noBilling:true},{write:true}]){const m=fixture('GQ-25',opts);await assert.rejects(verify(m));assert.equal(m.written,undefined);}
 const m=fixture('GQ-26');m.input.goldenSuiteText+=' ';await assert.rejects(verify(m),/suite or corpus/);
});
test('ticket proof fails on wrong receipt or a fabricated booked visit',async()=>{
 for(const opts of [{badReceipt:true},{agendado:true}]){const m=fixture('GQ-28',opts);await assert.rejects(verify(m));assert.equal(m.written,undefined);}
});
test('golden proof contract rejects forged IDs, timestamps and missing receipt',()=>{
 const proof={golden_id:'GQ-28',case_id:'c',run_id:'r',proposal_id:'p',operation_id:'o',verified_at:'2026-11-18T00:01:30Z',evidence:{version:1,golden_id:'GQ-28',fixture:'C-1013',business_date:'2026-11-18',window_started_at:'2026-11-18T00:00:00Z',window_closed_at:'2026-11-18T00:01:00Z',answer_sha256:'a'.repeat(64),assertion:'priority_ticket_verified',crm_read:true,tickets_read:true,approval:true,single_operation:true,receipt_sha256:'b'.repeat(64),visit_deadline_hours:24,visit_status:'pending_coordination'}};
 assert.equal(isVerifiedGoldenProof(proof,'GQ-28','2026-11-18'),true);
 assert.equal(isVerifiedGoldenProof({...proof,operation_id:null},'GQ-28','2026-11-18'),false);
 assert.equal(isVerifiedGoldenProof({...proof,evidence:{...proof.evidence,visit_status:'scheduled'}},'GQ-28','2026-11-18'),false);
});

test('a human correct label cannot bypass missing account platform proof',async()=>{
 const {adjudicatePromptRevision}=await import('../dist/prompt-adjudication.js');
 const evidence={golden_sha256:'a'.repeat(64),scenarios_sha256:'b'.repeat(64),corpus_sha256:'c'.repeat(64),baseline_manifest_sha256:'d'.repeat(64),candidate_manifest_sha256:'e'.repeat(64),date:'2026-11-18',rubric:'f'.repeat(64),provider_mode:'local'};
 const question={id:'GQ-25',score:'platform_replay_required',usedPrivateRead:false,forbiddenHit:false,citations:[],grounded:null};
 const report={evidence,proposed:{questions:[question],conversations:[],metrics:{recall_at_5:1,remote_generation_cases:0}}};
 const makeDb=(proofs)=>({transaction:async fn=>fn({query:async(sql)=>{
  if(sql.includes('SELECT e.base_revision'))return [{base_revision:'base',report,activated:false}];
  if(sql.includes('SELECT revision FROM prompt_revision'))return [{revision:'base'}];
  if(sql.includes('FROM prompt_eval_job'))return [];
  if(sql.includes('FROM prompt_platform_evidence'))return [];
  if(sql.includes('FROM prompt_golden_evidence'))return proofs;
  return [];
 }})});
 const review={evidence:{golden_sha256:evidence.golden_sha256,scenarios_sha256:evidence.scenarios_sha256,corpus_sha256:evidence.corpus_sha256},golden:{'GQ-25':{correct:true,grounded:true,artifact:'reviewed-artifact'}},critical:{}};
 assert.equal((await adjudicatePromptRevision(makeDb([]),'candidate',review)).metrics.accuracy,0);
 const proof={golden_id:'GQ-25',case_id:'c',run_id:'r',proposal_id:null,operation_id:null,verified_at:'2026-11-18T00:01:30Z',evidence:{version:1,golden_id:'GQ-25',fixture:'C-1001',business_date:'2026-11-18',window_started_at:'2026-11-18T00:00:00Z',window_closed_at:'2026-11-18T00:01:00Z',answer_sha256:'1'.repeat(64),source_sha256:'2'.repeat(64),assertion:'plans_balance_due_verified',verified_no_effect:true,crm_read:true,billing_read:true}};
 const accepted=await adjudicatePromptRevision(makeDb([proof]),'candidate',review);
 assert.equal(accepted.metrics.accuracy,1);
 assert.equal(accepted.gate,'review_required');
});
