import { knowledgeCorpus } from './knowledge.js';
import { createHash } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { effectiveManifest, manifestDigest } from './prompt-catalog.js';
import { replayReportFingerprint } from './prompt-replay-evidence.js';
import { simulators } from './simulator-client.js';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const fixtures={'GQ-25':'C-1001','GQ-26':'C-1004','GQ-27':'C-1007','GQ-28':'C-1013'} as const;
type GoldenId=keyof typeof fixtures;
const clean=(s:unknown)=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const digits=(s:unknown)=>String(s??'').replace(/\D/g,'');

/** Verify actual run and source records; caller supplies identifiers and the hashed golden, never assertions. */
export async function verifyGoldenPlatform(db:DataSource,input:{candidate:string;goldenId:GoldenId;caseId:string;runId:string;proposalId?:string;goldenSuiteText:string}, source:Pick<typeof simulators,'customer'|'balance'|'invoices'|'tickets'|'eligibility'|'receipt'>=simulators) {
 const fixture=fixtures[input.goldenId];
 if (!fixture || !input.candidate || !input.caseId || !input.runId || (input.goldenId==='GQ-28'?!input.proposalId:!!input.proposalId)) throw Error('invalid golden replay identifiers');
 return db.transaction('REPEATABLE READ',async tx=>{
  const [evaluation]=await tx.query(`SELECT e.base_revision,e.report,p.manifest,p.prompts FROM prompt_evaluation e JOIN prompt_revision p ON p.revision=e.candidate_revision WHERE e.candidate_revision=$1 AND NOT p.activated FOR UPDATE OF e`,[input.candidate]);
  if (!evaluation) throw Error('candidate evaluation unavailable');
  const [base]=await tx.query('SELECT * FROM prompt_revision WHERE revision=$1 AND activated',[evaluation.base_revision]);
  const evidence=evaluation.report?.evidence;
  if (!base || !evidence || evidence.baseline_manifest_sha256!==manifestDigest(effectiveManifest(base)) || evidence.candidate_manifest_sha256!==manifestDigest(effectiveManifest(evaluation)) || evidence.rubric!==effectiveManifest(base).check_semantic_criterion?.sha256 || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.date??'')) throw Error('manifest or rubric mismatch');
  const documents=await knowledgeCorpus(tx);
  if (evidence.corpus_sha256!==sha(JSON.stringify(documents)) || evidence.golden_sha256!==sha(input.goldenSuiteText) || !/^[a-f0-9]{64}$/.test(evidence.scenarios_sha256??'')) throw Error('suite or corpus mismatch');
  let suite:any[];
  try { suite=input.goldenSuiteText.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)); } catch { throw Error('invalid golden suite'); }
  if(suite.length!==30 || new Set(suite.map(row=>row.id)).size!==30) throw Error('invalid golden suite');
  const question=suite.find(row=>row.id===input.goldenId);
  if(typeof question?.pregunta!=='string' || !question.pregunta.includes(fixture) || !Array.isArray(question.herramientas_esperadas)) throw Error('golden fixture mismatch');
  const [row]=await tx.query('SELECT * FROM attention_case WHERE id=$1 FOR UPDATE',[input.caseId]);
  if (!row?.snapshot?.verified || !row.snapshot.owner_id || (row.account_ref??row.contact_ref)!==fixture) throw Error('case scope mismatch');
  const [run]=await tx.query('SELECT id,case_id,turn FROM agent_run WHERE id=$1',[input.runId]);
  if (!run || run.case_id!==input.caseId || run.turn?.config_revision!==input.candidate || run.turn?.business_date!==evidence.date || run.turn?.text!==question.pregunta || run.turn?.scope_ref!=='verified' || run.turn?.actor!=='cliente' || run.turn?.attention_mode!=='asistido' || run.turn?.audience!=='asesor') throw Error('golden run mismatch');
  const [queued]=await tx.query(`SELECT created_at FROM attention_event WHERE case_id=$1 AND kind='candidate_replay_queued' AND metadata->>'run_id'=$2 AND metadata->>'candidate_revision'=$3 AND metadata->>'scenario_id'=$4 AND metadata->>'fixture'=$5`,[input.caseId,input.runId,input.candidate,input.goldenId,fixture]);
  if(!queued) throw Error('trusted candidate replay marker missing');
  const start=new Date(queued.created_at),[{closed_at}]=await tx.query('SELECT transaction_timestamp() AS closed_at'),end=new Date(closed_at);
  if(!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end<start) throw Error('invalid replay window');
  const [checkpoint]=await tx.query('SELECT result FROM agent_checkpoint WHERE id=$1',[`run:${input.runId}`]);
  const card=checkpoint?.result?.type==='card'?checkpoint.result.card:null;
  if(!card || !Array.isArray(card.facts) || !Array.isArray(card.reason_codes)) throw Error('candidate checkpoint missing');
  const reads=await tx.query(`SELECT kind FROM attention_event WHERE case_id=$1 AND metadata->>'run_id'=$2 AND kind=ANY($3::text[])`,[input.caseId,input.runId,['crm_read','crm_services_read','billing_read','billing_invoice_read','tickets_read','retention_read']]);
  const has=(kind:string)=>reads.some((item:{kind:string})=>item.kind===kind);
  if(!has('crm_read') && !has('crm_services_read')) throw Error('customer read missing');
  const customer=await source.customer(fixture);
  if(customer.cliente_id!==fixture) throw Error('source scope mismatch');
  const fact=(id:string)=>card.facts.find((item:{id:string})=>item.id===id);
  const text=clean([card.summary,card.next_action,...card.facts.map((item:{label:string;value:string})=>`${item.label} ${item.value}`)].join(' '));
  const [counts]=await tx.query(`SELECT
    (SELECT count(*)::int FROM integration_operation WHERE case_id=$1 AND created_at >= $2 AND created_at <= $3) AS operations,
    (SELECT count(*)::int FROM outbox WHERE case_id=$1 AND kind IN ('effect','integration') AND created_at >= $2 AND created_at <= $3) AS jobs,
    (SELECT count(*)::int FROM retention_proposal WHERE case_id=$1 AND run_id=$4) AS proposals`,[input.caseId,start,end,input.runId]);
  let detail:Record<string,unknown>;
  let operationId:string|null=null;
  if(input.goldenId==='GQ-25') {
   if(!has('billing_read') && !has('billing_invoice_read')) throw Error('billing read missing');
   const [balance,invoices]=await Promise.all([source.balance(fixture),source.invoices(fixture)]);
   const invoice=invoices.find(item=>item.periodo==='2026-11');
   const plans=[['Hogar Fibra 500',109900],['Claro Max 60 GB',59415]] as const;
   if(!plans.every(([name,value])=>customer.servicios.some(item=>item.plan===name && item.valor_mensual===value && item.estado==='activo') && card.facts.some((f:{label:string;value:string})=>f.label===name && digits(f.value)===String(value))) || balance.cliente_id!==fixture || balance.saldo_pendiente!==169315 || balance.proxima_fecha_limite!=='2026-11-25' || !invoice || invoice.estado!=='pendiente' || invoice.valor_total!==169315 || invoice.fecha_limite_pago!=='2026-11-25' || digits(fact('invoice-balance')?.value)!=='169315' || !card.facts.some((f:{value:string})=>String(f.value).includes('2026-11-25'))) throw Error('account facts mismatch');
   detail={assertion:'plans_balance_due_verified',crm_read:true,billing_read:true,source_sha256:sha(JSON.stringify([customer.servicios,balance,invoice]))};
  } else if(input.goldenId==='GQ-26' || input.goldenId==='GQ-27') {
   if(!has('retention_read')) throw Error('eligibility read missing');
   const eligible=await source.eligibility(fixture);
   if(input.goldenId==='GQ-26') {
    if(customer.antiguedad_meses!==30 || customer.dias_mora!==0 || customer.ofertas_retencion_12m.length!==0 || !eligible.eligible || !eligible.options.some(x=>x.codigo==='RET-A' && /30\s*%/.test(x.title) && /seis meses/.test(x.detail) && /89[.,]900/.test(x.detail)) || !eligible.options.some(x=>x.codigo==='RET-B' && /fibra 500/i.test(x.title) && /seis meses/.test(x.detail)) || !card.reason_codes.includes('retention_eligible') || Number(fact('tenure')?.value)!==30 || Number(fact('days-past-due')?.value)!==0 || Number(fact('offers-year')?.value)!==0 || !/30\s*%/.test(text) || !/fibra 500/.test(text) || !/seis meses/.test(text) || !/89[.,]900/.test(text)) throw Error('eligible alternatives mismatch');
    detail={assertion:'retention_alternatives_verified',crm_read:true,eligible:true,source_sha256:sha(JSON.stringify(eligible))};
   } else {
    if(customer.dias_mora!==45 || eligible.eligible || eligible.options.length!==0 || !/45/.test(eligible.reason) || !/30/.test(eligible.reason) || !card.reason_codes.includes('retention_ineligible') || Number(fact('days-past-due')?.value)!==45 || Number(fact('days-limit')?.value)!==30) throw Error('ineligible retention mismatch');
    detail={assertion:'retention_denial_verified',crm_read:true,eligible:false,source_sha256:sha(JSON.stringify(eligible))};
   }
  } else {
   if(!has('tickets_read') || !input.proposalId) throw Error('technical history read missing');
   const [proposal]=await tx.query('SELECT * FROM retention_proposal WHERE id=$1 AND case_id=$2',[input.proposalId,input.caseId]);
   if(!proposal || proposal.run_id!==input.runId || proposal.case_revision!==run.turn.case_revision || proposal.option_id!=='priority-ticket' || proposal.proposal?.status!=='confirmed' || card.proposal?.id!==proposal.id || card.proposal.status!=='pending_approval' || Number(fact('technical-tickets-90d')?.value)!==4 || !/24\s*horas/.test(text) || !/prioritari/.test(text)) throw Error('priority proposal mismatch');
   const [op]=await tx.query('SELECT * FROM integration_operation WHERE source_proposal_id=$1',[proposal.id]);
   if(!op || op.id!==`agent:${proposal.id}` || op.case_id!==input.caseId || op.case_revision!==run.turn.case_revision || op.customer_ref!==fixture || op.status!=='confirmed' || op.action?.kind!=='ticket' || op.action.ticket?.categoria!=='soporte_tecnico' || op.action.ticket?.prioridad!=='prioritaria' || !op.reference || op.reference!==proposal.proposal.effect_ref || counts.operations!==1 || counts.jobs!==1 || counts.proposals!==1) throw Error('ticket operation mismatch');
   const approvals=await tx.query('SELECT key,fingerprint FROM idempotency WHERE scope=$1 AND case_id=$2',[`decision:${op.advisor}:${proposal.id}`,input.caseId]);
   if(!approvals.some((entry:{key:string;fingerprint:string})=>entry.fingerprint===sha(JSON.stringify({decision:'approved',revision:proposal.proposal.revision,idempotency_key:entry.key})))) throw Error('approval missing');
   const approvalsLogged=await tx.query(`SELECT created_at FROM attention_event WHERE case_id=$1 AND kind='proposal_approved' AND metadata->>'proposal_id'=$2 AND metadata->>'run_id'=$3 AND metadata->>'decision'='approved' AND created_at >= $4 AND created_at <= $5`,[input.caseId,proposal.id,input.runId,start,end]);
   if(approvalsLogged.length!==1 || new Date(op.created_at)<new Date(approvalsLogged[0].created_at))throw Error('approval event missing or out of order');
   const [prior]=await tx.query(`SELECT count(*)::int AS n FROM outbox WHERE case_id=$1 AND kind IN ('effect','integration') AND created_at >= $2 AND created_at < $3`,[input.caseId,start,approvalsLogged[0].created_at]);
   if(prior.n!==0)throw Error('effect occurred before approval');
   const [receipt,tickets]=await Promise.all([source.receipt('crm',op.id),source.tickets(fixture)]);
   const existing=tickets.filter(ticket=>ticket.categoria==='soporte_tecnico' && ticket.ticket_id!==receipt.referencia);
   if(receipt.clave!==op.id || receipt.tipo!=='ticket' || receipt.referencia!==op.reference || existing.length!==4 || !tickets.some(ticket=>ticket.ticket_id===receipt.referencia))throw Error('ticket receipt or history mismatch');
   const [effect]=await tx.query('SELECT id FROM support_ticket WHERE proposal_id=$1',[proposal.id]);
   const [resumed]=await tx.query('SELECT result FROM agent_checkpoint WHERE id=$1',[`resume:${input.runId}:${proposal.id}:confirmed:${op.reference}`]);
   const summary=clean(resumed?.result?.card?.summary);
   if(effect?.id!==receipt.referencia || !/ticket registrado/.test(summary) || !/pendiente de coordinacion/.test(summary) || /visita (?:ya )?(?:agendada|confirmada)/.test(summary))throw Error('ticket confirmation projection mismatch');
   operationId=op.id;
   detail={assertion:'priority_ticket_verified',crm_read:true,tickets_read:true,approval:true,receipt_sha256:sha(JSON.stringify(receipt)),single_operation:true,visit_deadline_hours:24,visit_status:'pending_coordination'};
  }
  if(input.goldenId!=='GQ-28' && (counts.operations!==0 || counts.jobs!==0 || counts.proposals!==0 || card.proposal)) throw Error('unexpected write or proposal');
  const proof={version:1,golden_id:input.goldenId,fixture,business_date:evidence.date,window_started_at:start.toISOString(),window_closed_at:end.toISOString(),answer_sha256:sha(JSON.stringify(card)),...(input.goldenId!=='GQ-28'?{verified_no_effect:true}:{}),...detail};
  const fingerprint=replayReportFingerprint(input.candidate,evaluation.base_revision,evidence);
  await tx.query(`INSERT INTO prompt_golden_evidence(candidate_revision,golden_id,report_fingerprint,case_id,run_id,proposal_id,operation_id,evidence,verified_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()) ON CONFLICT(candidate_revision,golden_id,report_fingerprint) DO UPDATE SET case_id=EXCLUDED.case_id,run_id=EXCLUDED.run_id,proposal_id=EXCLUDED.proposal_id,operation_id=EXCLUDED.operation_id,evidence=EXCLUDED.evidence,verified_at=clock_timestamp()`,[input.candidate,input.goldenId,fingerprint,input.caseId,input.runId,input.proposalId??null,operationId,proof]);
  return {golden_id:input.goldenId,report_fingerprint:fingerprint,proof};
 });
}
