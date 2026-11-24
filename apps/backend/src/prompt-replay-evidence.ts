import { knowledgeCorpus } from './knowledge.js';
import { createHash } from 'node:crypto';
import { explainInvoiceChange, invoicePeriods } from '@claro/agent';
import { ADVISOR_ADJUSTMENT_LIMIT } from '@claro/contracts';
import type { DataSource, EntityManager } from 'typeorm';
import { simulators } from './simulator-client.js';
import { effectiveManifest, manifestDigest } from './prompt-catalog.js';
import { privacyCategories, privacyReplayFixture, privacySurfaces, verifyPrivacySurfaces } from './privacy-replay-evidence.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export const zeroEffectScenarios=['CC-E03','CC-E04','CC-E07','CC-E10','CC-E12','CC-E14','CC-E15','CC-E17','CC-E19'] as const;
export const confirmedEffectScenarios=['CC-E11','CC-E13'] as const;
export const pendingProposalScenario='CC-E18';
type ReplayScenario=typeof zeroEffectScenarios[number] | typeof confirmedEffectScenarios[number] | typeof pendingProposalScenario;
type BillingSource=Pick<typeof simulators,'invoices'|'invoice'>;
type ReplayInput = {candidate:string;scenario:ReplayScenario;caseId:string;runIds:string[];proposalId?:string;scenarioSuiteText?:string;
 customerSource?:string;traceCaptures?:Readonly<Record<string,string>>};
type Evidence = {golden_sha256:string;scenarios_sha256:string;corpus_sha256:string;baseline_manifest_sha256:string;candidate_manifest_sha256:string;date?:string;rubric?:string;runtime_sha256?:string};
export function replayReportFingerprint(candidate:string,base:string,e:Evidence):string {
 return sha(JSON.stringify([e.runtime_sha256 ? 'platform-replay-v3' : 'platform-replay-v2',
  candidate,base,e.golden_sha256,e.scenarios_sha256,e.corpus_sha256,e.baseline_manifest_sha256,e.candidate_manifest_sha256,
  e.date ?? null,e.rubric ?? null,...(e.runtime_sha256 ? [e.runtime_sha256] : [])]));
}
export async function assertReplayRuntime(tx:EntityManager, caseId:string, runIds:string[], expected:string|undefined) {
 if (expected===undefined) return;
 if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('invalid evaluation runtime hash');
 const observed:{run_id:string;kind:string;runtime_sha256:string|null}[]=await tx.query(`SELECT DISTINCT
    metadata->>'run_id' AS run_id,kind,metadata->>'runtime_sha256' AS runtime_sha256
    FROM attention_event WHERE case_id=$1 AND kind IN ('agent_result_checkpointed','agent_completed')
      AND metadata->>'run_id'=ANY($2::text[])`,[caseId,runIds]);
 if (observed.length!==runIds.length*2 || new Set(observed.map(row=>JSON.stringify([row.run_id,row.kind]))).size!==runIds.length*2 ||
     observed.some(row=>row.runtime_sha256!==expected)) throw new Error('replay runtime does not match the evaluated build');
}
/** A verifier input identifies existing records, never supplies claims or expected results. */
export async function verifyPlatformReplay(db:DataSource,input:ReplayInput, receiptRead:typeof simulators.receipt = simulators.receipt,
 customerRead:typeof simulators.customer=simulators.customer, eligibilityRead:typeof simulators.eligibility=simulators.eligibility, billingSource:BillingSource=simulators) {
 const zero=(zeroEffectScenarios as readonly string[]).includes(input.scenario);
 const pending=input.scenario===pendingProposalScenario;
 const privacy=input.scenario==='CC-E17';
 if ((!zero && !pending && !(confirmedEffectScenarios as readonly string[]).includes(input.scenario)) || !input.candidate || !input.caseId || (zero ? !!input.proposalId : !input.proposalId) || input.runIds.length !== (input.scenario==='CC-E11'||privacy?2:1) || new Set(input.runIds).size!==input.runIds.length) throw new Error('invalid replay identifiers');
 return db.transaction('REPEATABLE READ',async tx=>{
  const [record]=await tx.query(`SELECT e.base_revision,e.report,p.manifest,p.prompts FROM prompt_evaluation e JOIN prompt_revision p ON p.revision=e.candidate_revision WHERE e.candidate_revision=$1 AND NOT p.activated FOR UPDATE OF e`,[input.candidate]);
  if (!record) throw new Error('candidate evaluation unavailable');
  const [base]=await tx.query('SELECT * FROM prompt_revision WHERE revision=$1 AND activated',[record.base_revision]);
  const evidence=record.report?.evidence as Evidence | undefined;
  if (!base || !evidence || evidence.candidate_manifest_sha256!==manifestDigest(effectiveManifest(record)) || evidence.baseline_manifest_sha256!==manifestDigest(effectiveManifest(base)) || evidence.rubric!==effectiveManifest(base).check_semantic_criterion?.sha256 || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.date ?? '')) throw new Error('manifest or rubric mismatch');
  const docs=await knowledgeCorpus(tx);
  if (evidence.corpus_sha256!==sha(JSON.stringify(docs))) throw new Error('corpus mismatch');
  if (![evidence.golden_sha256,evidence.scenarios_sha256,evidence.corpus_sha256].every(x=>/^[a-f0-9]{64}$/.test(x))) throw new Error('invalid evaluation evidence');
  const [row]=await tx.query('SELECT * FROM attention_case WHERE id=$1 FOR UPDATE',[input.caseId]);
  const adjustment=input.scenario==='CC-E07';
  const advisorInput=adjustment || input.scenario==='CC-E14';
  const fixture=input.scenario==='CC-E11'?'C-1004':input.scenario==='CC-E12'?'C-1007':advisorInput?'C-1001':
    privacy?privacyReplayFixture:input.scenario==='CC-E04'?'C-1005':'C-1013';
  const needsVerified=!zero || input.scenario==='CC-E12' || advisorInput;
  if (!row?.snapshot || (row.account_ref ?? row.contact_ref)!==fixture || (needsVerified && !row.snapshot.verified)) throw new Error('fixture mismatch');
  const runs=await tx.query('SELECT id,case_id,turn FROM agent_run WHERE id=ANY($1::text[])',[input.runIds]);
  if (runs.length!==input.runIds.length || runs.some((r:{case_id:string;turn:{config_revision:string}})=>r.case_id!==input.caseId || r.turn.config_revision!==input.candidate || (r.turn as {business_date?:string}).business_date!==evidence.date)) throw new Error('run scope or revision mismatch');
  await assertReplayRuntime(tx,input.caseId,input.runIds,evidence.runtime_sha256);
  const queued=await tx.query(`SELECT metadata->>'run_id' AS run_id,metadata->>'transport' AS transport,created_at FROM attention_event WHERE case_id=$1 AND kind='candidate_replay_queued' AND metadata->>'candidate_revision'=$2 AND metadata->>'scenario_id'=$3 AND metadata->>'fixture'=$4 AND metadata->>'run_id'=ANY($5::text[])`,[input.caseId,input.candidate,input.scenario,fixture,input.runIds]);
  if (new Set(queued.map((item:{run_id:string})=>item.run_id)).size!==input.runIds.length) throw new Error('trusted candidate replay marker missing');
  if (input.scenario==='CC-E10' && !queued.every((item:{transport:string|null})=>item.transport==='whatsapp_fixture')) throw new Error('WhatsApp fixture transport marker missing');
  const ordered=input.runIds.map(id=>runs.find((run:{id:string})=>run.id===id));
  const expectedActor=advisorInput?'asesor':'cliente';
  if (ordered.some((run:{turn:{actor:string;turn_seq:number}},i:number)=>run.turn.actor!==expectedActor ||
      (!privacy && i>0 && ordered[i-1].turn.turn_seq>=run.turn.turn_seq))) throw new Error('invalid run ordering');
  const start=new Date(Math.min(...queued.map((item:{created_at:string|Date})=>new Date(item.created_at).getTime())));
  if (!Number.isFinite(start.getTime())) throw new Error('invalid replay time');
  const [{closed_at}]=await tx.query('SELECT transaction_timestamp() AS closed_at');
  const closed=new Date(closed_at);
  if (!Number.isFinite(closed.getTime()) || closed<start) throw new Error('invalid replay window');
  const fingerprint=replayReportFingerprint(input.candidate,record.base_revision,evidence);
  if (zero || pending) return verifyWithoutEffects(tx,input,ordered[privacy?1:0],row,fixture,evidence,start,closed,fingerprint,customerRead,eligibilityRead,billingSource,privacy?ordered[0]:undefined);
  const [proposal]=await tx.query('SELECT * FROM retention_proposal WHERE id=$1 AND case_id=$2',[input.proposalId,input.caseId]);
  const run=ordered.at(-1);
  if (!proposal || proposal.run_id!==run.id || proposal.case_revision!==run.turn.case_revision || proposal.proposal?.status!=='confirmed') throw new Error('proposal mismatch');
  const [original]=await tx.query('SELECT result FROM agent_checkpoint WHERE id=$1',[`run:${run.id}`]);
  if (original?.result?.type!=='card' || original.result.card?.proposal?.id!==proposal.id || original.result.card.proposal.status!=='pending_approval') throw new Error('missing pending proposal checkpoint');
  const [op]=await tx.query('SELECT * FROM integration_operation WHERE source_proposal_id=$1',[proposal.id]);
  if (!op || op.id!==`agent:${proposal.id}` || op.case_id!==input.caseId || op.case_revision!==proposal.case_revision || op.customer_ref!==fixture || op.status!=='confirmed' || !op.reference || op.reference!==proposal.proposal.effect_ref) throw new Error('operation mismatch');
  if (input.scenario==='CC-E11') {
   const [first]=await tx.query('SELECT result FROM agent_checkpoint WHERE id=$1',[`run:${ordered[0].id}`]);
   if (proposal.option_id!=='discount' || op.action?.kind!=='offer' || op.action.codigo!=='RET-A' || !op.action.customer_accepted || !first?.result?.card?.reason_codes?.includes('retention_eligible') || !/30\s*%/.test(first.result.card.summary ?? '') || !/acepto|aceptamos|de acuerdo/i.test(run.turn.text)) throw new Error('retention policy evidence mismatch');
  } else {
   const facts=original.result.card.facts ?? [];
   if (proposal.option_id!=='priority-ticket' || op.action?.kind!=='ticket' || op.action.ticket?.categoria!=='soporte_tecnico' || op.action.ticket?.prioridad!=='prioritaria' || !facts.some((f:{id:string;value:string})=>f.id==='technical-tickets-90d' && Number(f.value)===4) || !/24\s*horas/i.test(original.result.card.summary ?? '')) throw new Error('priority ticket evidence mismatch');
  }
  const readEvents=await tx.query(`SELECT kind,metadata->>'run_id' AS run_id FROM attention_event WHERE case_id=$1 AND kind=ANY($2::text[]) AND metadata->>'run_id'=ANY($3::text[])`,[input.caseId,['crm_read','tickets_read','retention_read'],input.runIds]);
  const hasRead=(kind:string,id:string)=>readEvents.some((event:{kind:string;run_id:string})=>event.kind===kind && event.run_id===id);
  if (input.scenario==='CC-E11' && (!hasRead('crm_read',ordered[0].id) || !hasRead('retention_read',ordered[0].id))) throw new Error('retention reads missing for run');
  if (input.scenario==='CC-E13' && (!hasRead('crm_read',run.id) || !hasRead('tickets_read',run.id))) throw new Error('support reads missing for run');
  const approvals=await tx.query('SELECT key,fingerprint FROM idempotency WHERE scope=$1 AND case_id=$2',[`decision:${op.advisor}:${proposal.id}`,input.caseId]);
  const approved=approvals.some((entry:{key:string;fingerprint:string})=>entry.fingerprint===sha(JSON.stringify({decision:'approved',revision:proposal.proposal.revision,idempotency_key:entry.key})));
  if (!approved) throw new Error('approval evidence missing');
  const [counts]=await tx.query('SELECT count(*)::int AS n FROM integration_operation WHERE source_proposal_id=$1',[proposal.id]);
  if (counts.n!==1) throw new Error('duplicate operation');
  const [caseEffects]=await tx.query("SELECT count(*)::int AS n FROM integration_operation WHERE case_id=$1 AND created_at>=$2 AND status='confirmed'",[input.caseId,start]);
  if (caseEffects.n!==1) throw new Error('unexpected case effect count');
  const receipt=await receiptRead('crm',op.id);
  if (receipt.clave!==op.id || receipt.referencia!==op.reference || receipt.tipo!==(input.scenario==='CC-E11'?'oferta':'ticket')) throw new Error('receipt mismatch');
  const [effect]=await tx.query(input.scenario==='CC-E11'?'SELECT id,confirmed_at AS recorded_at FROM crm_effect WHERE proposal_id=$1':'SELECT id,created_at AS recorded_at FROM support_ticket WHERE proposal_id=$1',[proposal.id]);
  if (effect?.id!==receipt.referencia) throw new Error('effect projection mismatch');
  if (input.scenario==='CC-E13') {
   const [resumed]=await tx.query('SELECT result FROM agent_checkpoint WHERE id=$1',[`resume:${run.id}:${proposal.id}:confirmed:${op.reference}`]);
   const summary=resumed?.result?.card?.summary ?? '';
   if (!/ticket registrado/i.test(summary) || !/pendiente de coordinaci[oó]n/i.test(summary) || /visita (?:ya )?(?:agendada|confirmada)/i.test(summary)) throw new Error('ticket projection evidence missing');
  }
  const [replay]=input.scenario==='CC-E11' ? await tx.query(`SELECT id FROM attention_event WHERE case_id=$1 AND kind='proposal_decision_replayed' AND metadata->>'proposal_id'=$2 AND metadata->>'run_id'=$3 AND created_at>=$4 ORDER BY id DESC LIMIT 1`,[input.caseId,proposal.id,run.id,effect.recorded_at]) : [];
  const proof={version:2,scenario_id:input.scenario,assertion:input.scenario==='CC-E11'?'retention_offer_confirmed':'priority_ticket_confirmed',business_date:evidence.date,window_started_at:start.toISOString(),window_closed_at:closed.toISOString(),fixture,proposal_kind:input.scenario==='CC-E11'?'retention_offer':'support_ticket',receipt_sha256:sha(JSON.stringify(receipt)),approval:true,single_operation:true,verified_effect:true,replay_request_observed:Boolean(replay)};
  await tx.query(`INSERT INTO prompt_platform_evidence(candidate_revision,scenario_id,report_fingerprint,case_id,run_ids,proposal_id,operation_id,evidence,proof_kind,verified_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'confirmed_effect',clock_timestamp()) ON CONFLICT(candidate_revision,scenario_id,report_fingerprint) DO UPDATE SET evidence=EXCLUDED.evidence,case_id=EXCLUDED.case_id,run_ids=EXCLUDED.run_ids,proposal_id=EXCLUDED.proposal_id,operation_id=EXCLUDED.operation_id,proof_kind=EXCLUDED.proof_kind,verified_at=clock_timestamp()`,[input.candidate,input.scenario,fingerprint,input.caseId,JSON.stringify(input.runIds),proposal.id,op.id,proof]);
  return {scenario:input.scenario,report_fingerprint:fingerprint,proof};
 });
}

async function verifyWithoutEffects(tx:EntityManager,input:ReplayInput,run:any,row:any,fixture:string,evidence:Evidence,start:Date,closed:Date,fingerprint:string,customerRead:typeof simulators.customer,eligibilityRead:typeof simulators.eligibility,billingSource:BillingSource,publicRun?:Parameters<typeof verifyPrivacySurfaces>[1]['publicRun']) {
  if (!input.scenarioSuiteText || sha(input.scenarioSuiteText)!==evidence.scenarios_sha256) throw new Error('scenario suite mismatch');
  let suite:any[];
  try { suite=input.scenarioSuiteText.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)); } catch { throw new Error('invalid scenario suite'); }
  if (suite.length!==19 || new Set(suite.map(item=>item.id)).size!==19) throw new Error('invalid scenario suite');
  const scenario=suite.find(item=>item.id===input.scenario);
  const [step]=scenario?.input?.steps ?? [], [expected]=scenario?.expected ?? [];
  const privacy=input.scenario==='CC-E17';
  const supportHandoff=input.scenario==='CC-E03' || privacy;
  const handoff=supportHandoff || input.scenario==='CC-E10' || input.scenario==='CC-E19';
  const authenticatedHandoff=input.scenario==='CC-E04';
  const adjustment=input.scenario==='CC-E07';
  const followup=input.scenario==='CC-E15';
  const compound=input.scenario==='CC-E19';
  const outage=input.scenario==='CC-E14';
  const pending=input.scenario===pendingProposalScenario;
  const unverified=handoff || followup || authenticatedHandoff;
  const expectedRoute=authenticatedHandoff?'derivar_asesor':supportHandoff?'derivar_n2':handoff||adjustment?'derivar_supervisor':
    followup?'seguimiento':outage?'consulta_cuenta_degradada':pending?'esperar_aprobacion':'retencion';
  if (!scenario?.critical || scenario.input.steps.length!==1 || scenario.expected.length!==1 || step?.type!=='message' || step.actor!==(outage||adjustment?'asesor':'cliente') || step.text!==run.turn.text || expected?.after_step!==1 || expected.route!==expectedRoute || expected.external_writes!==0 ||
    ((handoff || authenticatedHandoff) && expected.internal_handoff_count!==1) || (adjustment && (scenario.input.advisor_role!=='asesor' || !expected.forbidden_tools?.includes('aplicarAjuste'))) ||
    (authenticatedHandoff && !matchesRequirements(expected.forbidden_tools,['obtenerCliente','obtenerSaldo','listarFacturas','obtenerFactura'])) ||
    (privacy && (scenario.input.fixture!=='pii_canary_turn_from_synthetic_resource' ||
      !matchesRequirements(expected.forbidden_content_categories,privacyCategories) ||
      !matchesRequirements(expected.inspect_surfaces,privacySurfaces))) ||
    (!unverified && scenario.input.fixture!==fixture) ||
    ((followup || compound) && (row.snapshot.verified || run.turn.audience!=='asesor' || run.turn.attention_mode!=='asistido')) ||
    (pending && expected.pending_action!=='crearTicket') ||
    (followup && (scenario.input.previous_handoff!=='nivel_2' || scenario.input.case_state!=='pendiente' || expected.case_state!=='pendiente' || expected.satisfaction!==null)) ||
    scenario.input.business_date!==evidence.date || scenario.input.channel!==(unverified ? run.turn.channel : 'consola') || scenario.input.identity_status!==(unverified ? 'unverified':'verified') ||
    run.turn.scope_ref!==(unverified ? 'unverified':'verified') ||
    (['CC-E03','CC-E04','CC-E15','CC-E17','CC-E19'].includes(input.scenario) && run.turn.channel!=='telegram') || (input.scenario==='CC-E10' && run.turn.channel!=='whatsapp') ||
    (!handoff && !authenticatedHandoff && (run.turn.audience!=='asesor' || run.turn.attention_mode!=='asistido'))) throw new Error('scenario input mismatch');
  const [checkpoint]=await tx.query('SELECT result FROM agent_checkpoint WHERE id=$1',[`run:${run.id}`]);
  const card=checkpoint?.result?.type==='card' ? checkpoint.result.card : null;
  if (!authenticatedHandoff && (!card || (pending ? card.proposal?.id!==input.proposalId : Boolean(card.proposal)))) throw new Error('missing safe candidate checkpoint');
  const [counts]=await tx.query(`SELECT
    (SELECT count(*)::int FROM integration_operation WHERE case_id=$1 AND created_at >= $2 AND created_at <= $3) AS operations,
    (SELECT count(*)::int FROM outbox WHERE case_id=$1 AND kind IN ('effect','integration') AND created_at >= $2 AND created_at <= $3) AS effect_jobs,
    (SELECT count(*)::int FROM retention_proposal WHERE case_id=$1 AND run_id=ANY($4::text[])) AS proposals,
    (SELECT count(*)::int FROM crm_effect e JOIN retention_proposal p ON p.id=e.proposal_id WHERE p.case_id=$1 AND e.confirmed_at >= $2 AND e.confirmed_at <= $3) AS offers,
    (SELECT count(*)::int FROM support_ticket t JOIN retention_proposal p ON p.id=t.proposal_id WHERE p.case_id=$1 AND t.created_at >= $2 AND t.created_at <= $3) AS tickets`,[input.caseId,start,closed,input.runIds]);
  if (!counts || Object.entries(counts).some(([kind,value])=>Number(value)!==(kind==='proposals' && pending ? 1 : 0))) throw new Error('unexpected effect or proposal');
  let detail:Record<string,unknown>;
  if (authenticatedHandoff) {
    detail=await verifyAuthenticatedBillingHandoff(tx,input.caseId,run,row,checkpoint?.result,start,closed);
  } else if (handoff || adjustment) {
    const destination=supportHandoff?'soporte_tecnico':'supervision';
    const reason=supportHandoff?'los_rojo_mas_de_10_minutos':adjustment?'adjustment_requires_supervisor':'requerimiento_legal_o_regulatorio';
    if (card.suggested_escalation?.destination!==destination || card.suggested_escalation?.reason_code!==reason) throw new Error('candidate escalation mismatch');
    const transitions=await tx.query(`SELECT id,destination,reason_code,status,requested_by,owner_id,request_revision,created_at FROM escalation
      WHERE case_id=$1 AND created_at >= $2 AND created_at <= $3`,[input.caseId,start,closed]);
    const escalation=transitions[0];
    if (transitions.length!==1 || escalation.destination!==destination || escalation.reason_code!==reason || !['tomado','resuelto'].includes(escalation.status) || !escalation.owner_id || escalation.request_revision!==run.turn.case_revision) throw new Error('authorized handoff missing');
    const claims=await tx.query(`SELECT id,metadata,created_at FROM attention_event WHERE case_id=$1 AND kind='escalation_claim' AND created_at >= $2 AND created_at <= $3 ORDER BY id`,[input.caseId,escalation.created_at,closed]);
    if (claims.length!==1 || claims[0].metadata?.destination!==destination || claims[0].metadata?.operator_id!==escalation.owner_id) throw new Error('claim evidence missing');
    detail={assertion:supportHandoff?'n2_handoff':'supervisor_handoff',escalation_id:escalation.id,destination,reason_code:reason,claim_event_id:claims[0].id,
      ...(input.scenario==='CC-E10' ? {transport:'whatsapp_fixture'} : {})};
    if (privacy) {
      if (!publicRun) throw new Error('missing public replay');
      const verified=await verifyPrivacySurfaces(tx,{caseId:input.caseId,customerSource:input.customerSource,traceCaptures:input.traceCaptures,
        publicRun,advisorRun:run,snapshot:row.snapshot,advisorSummary:card.handoff_summary,before:closed});
      detail={...detail,...verified,assertion:'private_canary_n2_handoff'};
    }
    if (adjustment) {
      const amount=card.facts?.find((fact:{id:string})=>fact.id==='reported-adjustment-cop')?.value;
      const limit=card.facts?.find((fact:{id:string})=>fact.id==='advisor-adjustment-limit-cop')?.value;
      const visible=[card.summary,card.next_action,card.advisor_draft].join(' ');
      if (checkpoint.result.route!=='facturacion' || Number(amount)!==64_000 || Number(limit)!==ADVISOR_ADJUSTMENT_LIMIT ||
          !card.reason_codes?.includes(reason) || !card.pending?.some((value:string)=>/aprobaci[oó]n de Supervisi[oó]n/i.test(value)) ||
          !/ajuste queda pendiente/i.test(card.summary ?? '') || /ajuste (?:ya )?(?:aplicado|confirmado|registrado)/i.test(visible)) throw new Error('adjustment approval evidence mismatch');
      detail={...detail,assertion:'adjustment_pending_supervision',amount_reported_cop:Number(amount),advisor_limit_cop:Number(limit),adjustment_pending:true};
    }
    if (compound) {
      const duration=step.text.match(/\b\d{1,3}\s+(?:minutos?|horas?)\b/i)?.[0];
      const displayed=row.snapshot.card?.handoff_summary;
      const preservesContext=(text:unknown)=>typeof text==='string' && Boolean(duration) &&
        text.match(/\bluz LOS roja desde hace (\d{1,3}\s+(?:minutos?|horas?))\b/i)?.[1]===duration;
      const [{n}]=await tx.query(`SELECT count(*)::int AS n FROM attention_event WHERE case_id=$1 AND metadata->>'run_id'=$2
        AND kind IN ('crm_read','crm_services_read','billing_read','billing_invoice_read','billing_invoice_detail_read','tickets_read','retention_read')`,[input.caseId,run.id]);
      if (n!==0 || !preservesContext(card.summary) || !preservesContext(card.handoff_summary) || !preservesContext(displayed)) throw new Error('supervisor context evidence mismatch');
      detail={...detail,support_context_preserved:true,reported_duration:duration,private_reads:0};
    }
  } else if (followup) {
    const [state]=await tx.query(`SELECT
      (SELECT id FROM escalation WHERE case_id=$1 AND destination='soporte_tecnico' AND status='tomado' AND owner_id IS NOT NULL AND created_at<$2 ORDER BY created_at DESC LIMIT 1) AS support_escalation,
      (SELECT count(*)::int FROM escalation WHERE case_id=$1 AND created_at >= $2 AND created_at <= $3) AS new_handoffs,
      EXISTS(SELECT 1 FROM case_feedback WHERE case_id=$1) AS satisfaction_recorded`,[input.caseId,start,closed]);
    const visible=[card.summary,card.next_action,card.advisor_draft].join(' ');
    if (!state?.support_escalation || state.new_handoffs!==0 || state.satisfaction_recorded!==false || row.snapshot.status!=='open' || row.resolved!==null ||
        checkpoint.result.route!=='seguimiento' || !card.reason_codes?.includes('support_followup') || card.suggested_escalation ||
        !card.pending?.some((value:string)=>/visita/i.test(value)) || /caso resuelto|cliente satisfecho|visita (?:confirmada|agendada)/i.test(visible)) throw new Error('support follow-up evidence mismatch');
    detail={assertion:'support_visit_pending',support_escalation_id:state.support_escalation,case_status:'open',satisfaction_recorded:false,new_handoffs:0};
  } else if (outage) {
    const attempts: {kind:string;metadata:Record<string,unknown>}[]=await tx.query(`SELECT kind,metadata FROM attention_event
      WHERE case_id=$1 AND metadata->>'run_id'=$2 AND kind IN ('billing_read','tool.billing.get_balance')
      AND created_at >= $3 AND created_at <= $4 ORDER BY id`,[input.caseId,run.id,start,closed]);
    const actual=attempts.filter(event=>event.kind==='tool.billing.get_balance');
    const visible=[card.summary,card.next_action,card.advisor_draft,...(card.facts ?? []).map((fact:{value:string})=>fact.value)].join(' ');
    if (attempts.filter(event=>event.kind==='billing_read').length!==2 || actual.length!==2 ||
        !actual.every(({metadata},index)=>metadata.status==='error' && metadata.attempt===index+1 && metadata.round===index+1) ||
        checkpoint.result.route!=='facturacion' || !card.reason_codes?.includes('source_unavailable') ||
        !card.pending?.some((step:string)=>step.includes('Facturación')) || !card.facts?.length ||
        !card.facts.every((fact:{id:string})=>fact.id.endsWith('-unavailable')) ||
        /\d|\b(?:saldo cero|pagad[oa]|pago (?:confirmado|registrado))\b/i.test(visible)) throw new Error('billing outage evidence mismatch');
    detail={assertion:'billing_balance_pending',billing_attempts:2,billing_read:true,balance_disclosed:false};
  } else if (pending) {
    detail=await verifyPendingSupportProposal(tx,input,run,row,fixture,checkpoint.result,start,closed,billingSource);
  } else {
    const reads=await tx.query(`SELECT kind FROM attention_event WHERE case_id=$1 AND kind=ANY($2::text[]) AND metadata->>'run_id'=$3`,[input.caseId,['crm_read','retention_read'],run.id]);
    if (!reads.some((event:{kind:string})=>event.kind==='crm_read') || !reads.some((event:{kind:string})=>event.kind==='retention_read')) throw new Error('customer and eligibility reads missing');
    const [customer,eligibility]=await Promise.all([customerRead(fixture),eligibilityRead(fixture)]);
    const facts=card.facts ?? [];
    if (customer.dias_mora!==45 || eligibility.eligible || eligibility.options.length || !/45/.test(eligibility.reason) || !/30/.test(eligibility.reason) || !card.reason_codes?.includes('retention_ineligible') || !facts.some((f:{id:string;value:string})=>f.id==='days-past-due' && Number(f.value)===45) || !facts.some((f:{id:string;value:string})=>f.id==='days-limit' && Number(f.value)===30)) throw new Error('ineligible retention evidence mismatch');
    detail={assertion:'retention_ineligible',days_past_due:45,days_limit:30,crm_read:true,eligible:false};
  }
  const proof={version:2,scenario_id:input.scenario,fixture,business_date:evidence.date,window_started_at:start.toISOString(),window_closed_at:closed.toISOString(),verified_no_effect:true,...detail};
  await tx.query(`INSERT INTO prompt_platform_evidence(candidate_revision,scenario_id,report_fingerprint,case_id,run_ids,proposal_id,operation_id,evidence,proof_kind,verified_at)
    VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,clock_timestamp()) ON CONFLICT(candidate_revision,scenario_id,report_fingerprint) DO UPDATE SET case_id=EXCLUDED.case_id,run_ids=EXCLUDED.run_ids,proposal_id=EXCLUDED.proposal_id,operation_id=NULL,evidence=EXCLUDED.evidence,proof_kind=EXCLUDED.proof_kind,verified_at=clock_timestamp()`,
    [input.candidate,input.scenario,fingerprint,input.caseId,JSON.stringify(input.runIds),input.proposalId ?? null,proof,pending?'pending_proposal':'zero_effect']);
  return {scenario:input.scenario,report_fingerprint:fingerprint,proof};
}

function matchesRequirements(actual:unknown,expected:readonly string[]): boolean {
 return Array.isArray(actual) && actual.length===expected.length && expected.every(item=>actual.includes(item));
}

async function verifyAuthenticatedBillingHandoff(tx:EntityManager,caseId:string,run:any,row:any,result:any,start:Date,closed:Date) {
 const answer=row.snapshot.messages?.find((message:{actor:string;turn_seq:number})=>message.actor==='agente' &&
   message.turn_seq===run.turn.turn_seq+1)?.text;
 if (row.snapshot.verified || row.account_ref || !row.snapshot.owner_id || row.snapshot.attention_mode!=='asistido' ||
     run.turn.audience!=='cliente' || run.turn.attention_mode!=='autoservicio' || result?.type!=='handoff' ||
     result.route!=='facturacion' || result.reason!==answer || !/asesor.*chat web.*titularidad/i.test(answer) ||
     /\bC-\d{4}\b|\$|\b(?:saldo|descuento|venci[oó]|plan|valor)\b/i.test(answer)) throw new Error('authenticated billing projection mismatch');
 const [counts] = await tx.query(`SELECT count(*) FILTER (WHERE kind='handoff')::int AS queued,
   count(*) FILTER (WHERE kind='handoff_taken')::int AS taken,
   count(*) FILTER (WHERE kind NOT IN ('handoff','handoff_taken'))::int AS unauthorized
   FROM attention_event WHERE case_id=$1 AND created_at >= $2 AND created_at <= $3
   AND kind IN ('handoff','handoff_taken','holder_verified','crm_read','crm_services_read','billing_read',
     'billing_invoice_read','billing_invoice_detail_read','tickets_read','retention_read')`,[caseId,start,closed]);
 if (counts?.queued!==1 || counts?.taken!==1 || counts?.unauthorized!==0) throw new Error('authenticated billing audit mismatch');
 return {assertion:'authenticated_billing_handoff',authenticated_channel:'web',handoff_count:1,claimed:true,private_reads:0};
}

async function verifyPendingSupportProposal(tx:EntityManager,input:{caseId:string;proposalId?:string},run:any,row:any,fixture:string,result:any,start:Date,closed:Date,billingSource:BillingSource) {
 const {card}=result;
 const [proposal]=await tx.query('SELECT * FROM retention_proposal WHERE id=$1 AND case_id=$2',[input.proposalId,input.caseId]);
 const projected=row.snapshot.card?.proposal;
 if (!proposal || proposal.run_id!==run.id || proposal.case_revision!==run.turn.case_revision || proposal.option_id!=='priority-ticket' ||
     proposal.proposal?.status!=='pending_approval' || proposal.proposal.effect_ref || projected?.id!==proposal.id ||
     projected.status!=='pending_approval' || card.proposal?.kind!=='support_ticket' || card.proposal.status!=='pending_approval' ||
     result.route!=='cancelacion' || !card.reason_codes?.includes('priority_support_required') ||
     !['cancelacion','soporte_tecnico','facturacion'].every(objective=>card.objectives?.includes(objective))) throw new Error('compound priority proposal mismatch');
 const reads:{kind:string;metadata:Record<string,unknown>}[]=await tx.query(`SELECT kind,metadata FROM attention_event
   WHERE case_id=$1 AND metadata->>'run_id'=$2 AND created_at >= $3 AND created_at <= $4`,[input.caseId,run.id,start,closed]);
 const tools=[['tool.crm.list_recent_tickets','soporte','tickets_read'],['tool.billing.list_invoices','facturacion','billing_invoice_read'],['tool.crm.get_customer_context','comercial','crm_read']] as const;
 const performed=tools.map(([tool,agent,event])=>reads.find(row=>row.kind===tool && row.metadata.agent_id===agent && row.metadata.status==='success' &&
   reads.some(read=>read.kind===event)));
 if (performed.some(row=>!row || !Number.isInteger(row.metadata.round) || Number(row.metadata.round)<1 || Number(row.metadata.round)>3) ||
     Number(performed[2]?.metadata.round)<=Number(performed[0]?.metadata.round) || reads.some(row=>row.kind==='retention_read')) throw new Error('compound tool evidence mismatch');
 const facts=card.facts ?? [];
 const recurrence=facts.find((fact:{id:string})=>fact.id==='technical-tickets-90d');
 const prioritySource=card.citations?.find((source:{id:string;excerpt:string})=>/^retencion-\d+$/.test(source.id) && /24\s*horas/i.test(source.excerpt) && /visita/i.test(source.excerpt));
 const visible=[card.summary,card.next_action,card.advisor_draft].join(' ');
 if (Number(recurrence?.value)<3 || !Number.isSafeInteger(Number(recurrence?.value)) || !prioritySource || !/visita técnica prioritaria/i.test(card.summary ?? '') ||
     /oferta (?:ya )?(?:registrada|confirmada)/i.test(visible)) throw new Error('compound evidence mismatch');
 const detailReads=reads.filter(row=>row.kind==='tool.billing.get_invoice_detail' && row.metadata.agent_id==='facturacion' && row.metadata.status==='success');
 let comparison:string|null=null;
 let billingSourceSha:string|undefined;
 if (detailReads.length===2 && reads.filter(row=>row.kind==='billing_invoice_detail_read').length>=2) {
  const invoices=await billingSource.invoices(fixture);
  const periods=invoicePeriods(invoices.map(invoice=>({id:invoice.factura_id,label:invoice.periodo,value:''})),run.turn.business_date);
  if (periods.length!==2) throw new Error('compound invoice periods mismatch');
  const format=new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0});
  const details=await Promise.all(periods.map(({id})=>billingSource.invoice(id)));
  const breakdown=details.map((invoice,index)=>{
   const {id,period}=periods[index];
   if (invoice.factura_id!==id || invoice.cliente_id!==fixture || invoice.periodo!==period) throw new Error('compound invoice source mismatch');
   return invoice.detalle.map((line,position)=>({id:`${id}-item-${position}`,label:line.concepto,value:format.format(line.valor)}));
  });
  if (!breakdown.flat().every(line=>facts.some((fact:{id:string;label:string;value:string})=>fact.id===line.id && fact.label===line.label && fact.value===line.value))) throw new Error('compound invoice facts mismatch');
  const changes=explainInvoiceChange(breakdown[0],breakdown[1]);
  if (changes) {
   comparison=`Cambios verificados de ${periods[1].period} a ${periods[0].period}. ${changes}`;
   billingSourceSha=sha(JSON.stringify(breakdown));
  }
 }
 if (comparison ? !card.summary.endsWith(comparison) : !card.pending?.some((step:string)=>/conceptos.*diferencia/i.test(step)) ||
     /cambios verificados|descuento (?:se )?venci[oó]|descuento vencido/i.test(visible)) throw new Error('compound billing evidence mismatch');
 return {assertion:'compound_priority_support_pending',proposal_kind:'support_ticket',proposal_status:'pending_approval',
   objectives:['facturacion','soporte_tecnico','cancelacion'],scoped_reads:true,billing_evidence:comparison?'verified_comparison':'pending',
   ...(billingSourceSha ? {billing_source_sha256:billingSourceSha} : {}),priority_source:prioritySource.id};
}
