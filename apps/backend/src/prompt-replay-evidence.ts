import { createHash } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { simulators } from './simulator-client.js';
import { effectiveManifest, manifestDigest } from './prompt-catalog.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
type Evidence = {golden_sha256:string;scenarios_sha256:string;corpus_sha256:string;baseline_manifest_sha256:string;candidate_manifest_sha256:string;date?:string;rubric?:string};
export function replayReportFingerprint(candidate:string,base:string,e:Evidence):string {
 return sha(JSON.stringify(['platform-replay-v2',candidate,base,e.golden_sha256,e.scenarios_sha256,e.corpus_sha256,e.baseline_manifest_sha256,e.candidate_manifest_sha256,e.date ?? null,e.rubric ?? null]));
}
/** A verifier input identifies existing records, never supplies claims or expected results. */
export async function verifyPlatformReplay(db:DataSource,input:{candidate:string;scenario:'CC-E03'|'CC-E10'|'CC-E11'|'CC-E12'|'CC-E13';caseId:string;runIds:string[];proposalId?:string;scenarioSuiteText?:string}, receiptRead:typeof simulators.receipt = simulators.receipt,
 customerRead:typeof simulators.customer=simulators.customer, eligibilityRead:typeof simulators.eligibility=simulators.eligibility) {
 const zero=['CC-E03','CC-E10','CC-E12'].includes(input.scenario);
 if (!['CC-E03','CC-E10','CC-E11','CC-E12','CC-E13'].includes(input.scenario) || !input.candidate || !input.caseId || (zero ? !!input.proposalId : !input.proposalId) || input.runIds.length !== (input.scenario==='CC-E11'?2:1) || new Set(input.runIds).size!==input.runIds.length) throw new Error('invalid replay identifiers');
 return db.transaction('REPEATABLE READ',async tx=>{
  const [record]=await tx.query(`SELECT e.base_revision,e.report,p.manifest,p.prompts FROM prompt_evaluation e JOIN prompt_revision p ON p.revision=e.candidate_revision WHERE e.candidate_revision=$1 AND NOT p.activated FOR UPDATE OF e`,[input.candidate]);
  if (!record) throw new Error('candidate evaluation unavailable');
  const [base]=await tx.query('SELECT * FROM prompt_revision WHERE revision=$1 AND activated',[record.base_revision]);
  const evidence=record.report?.evidence as Evidence | undefined;
  if (!base || !evidence || evidence.candidate_manifest_sha256!==manifestDigest(effectiveManifest(record)) || evidence.baseline_manifest_sha256!==manifestDigest(effectiveManifest(base)) || evidence.rubric!==effectiveManifest(base).check_semantic_criterion?.sha256 || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.date ?? '')) throw new Error('manifest or rubric mismatch');
  const docs=await tx.query('SELECT id,version,document FROM knowledge_document ORDER BY id,version');
  if (evidence.corpus_sha256!==sha(JSON.stringify(docs))) throw new Error('corpus mismatch');
  if (![evidence.golden_sha256,evidence.scenarios_sha256,evidence.corpus_sha256].every(x=>/^[a-f0-9]{64}$/.test(x))) throw new Error('invalid evaluation evidence');
  const [row]=await tx.query('SELECT * FROM attention_case WHERE id=$1 FOR UPDATE',[input.caseId]);
  const fixture=input.scenario==='CC-E11'?'C-1004':input.scenario==='CC-E12'?'C-1007':'C-1013';
  if (!row?.snapshot || (row.account_ref ?? row.contact_ref)!==fixture || (!zero && !row.snapshot.verified) || (input.scenario==='CC-E12' && !row.snapshot.verified)) throw new Error('fixture mismatch');
  const runs=await tx.query('SELECT id,case_id,turn FROM agent_run WHERE id=ANY($1::text[])',[input.runIds]);
  if (runs.length!==input.runIds.length || runs.some((r:{case_id:string;turn:{config_revision:string}})=>r.case_id!==input.caseId || r.turn.config_revision!==input.candidate || (r.turn as {business_date?:string}).business_date!==evidence.date)) throw new Error('run scope or revision mismatch');
  const queued=await tx.query(`SELECT metadata->>'run_id' AS run_id,metadata->>'transport' AS transport,created_at FROM attention_event WHERE case_id=$1 AND kind='candidate_replay_queued' AND metadata->>'candidate_revision'=$2 AND metadata->>'scenario_id'=$3 AND metadata->>'fixture'=$4 AND metadata->>'run_id'=ANY($5::text[])`,[input.caseId,input.candidate,input.scenario,fixture,input.runIds]);
  if (new Set(queued.map((item:{run_id:string})=>item.run_id)).size!==input.runIds.length) throw new Error('trusted candidate replay marker missing');
  if (input.scenario==='CC-E10' && !queued.every((item:{transport:string|null})=>item.transport==='whatsapp_fixture')) throw new Error('WhatsApp fixture transport marker missing');
  const ordered=input.runIds.map(id=>runs.find((run:{id:string})=>run.id===id));
  if (ordered.some((run:{turn:{actor:string;turn_seq:number}},i:number)=>run.turn.actor!=='cliente' || (i>0 && ordered[i-1].turn.turn_seq>=run.turn.turn_seq))) throw new Error('invalid run ordering');
  const start=new Date(Math.min(...queued.map((item:{created_at:string|Date})=>new Date(item.created_at).getTime())));
  if (!Number.isFinite(start.getTime())) throw new Error('invalid replay time');
  const [{closed_at}]=await tx.query('SELECT transaction_timestamp() AS closed_at');
  const closed=new Date(closed_at);
  if (!Number.isFinite(closed.getTime()) || closed<start) throw new Error('invalid replay window');
  const fingerprint=replayReportFingerprint(input.candidate,record.base_revision,evidence);
  if (zero) return verifyZero(tx,input,ordered[0],row,fixture,evidence,start,closed,fingerprint,customerRead,eligibilityRead);
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

async function verifyZero(tx:EntityManager,input:{candidate:string;scenario:string;caseId:string;runIds:string[];scenarioSuiteText?:string},run:any,row:any,fixture:string,evidence:Evidence,start:Date,closed:Date,fingerprint:string,customerRead:typeof simulators.customer,eligibilityRead:typeof simulators.eligibility) {
  if (!input.scenarioSuiteText || sha(input.scenarioSuiteText)!==evidence.scenarios_sha256) throw new Error('scenario suite mismatch');
  let suite:any[];
  try { suite=input.scenarioSuiteText.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)); } catch { throw new Error('invalid scenario suite'); }
  if (suite.length!==19 || new Set(suite.map(item=>item.id)).size!==19) throw new Error('invalid scenario suite');
  const scenario=suite.find(item=>item.id===input.scenario);
  const [step]=scenario?.input?.steps ?? [], [expected]=scenario?.expected ?? [];
  const handoff=input.scenario!=='CC-E12';
  const expectedRoute=input.scenario==='CC-E03'?'derivar_n2':input.scenario==='CC-E10'?'derivar_supervisor':'retencion';
  if (!scenario?.critical || scenario.input.steps.length!==1 || scenario.expected.length!==1 || step?.type!=='message' || step.actor!=='cliente' || step.text!==run.turn.text || expected?.after_step!==1 || expected.route!==expectedRoute || expected.external_writes!==0 ||
    (handoff && expected.internal_handoff_count!==1) || (!handoff && scenario.input.fixture!==fixture) ||
    scenario.input.business_date!==evidence.date || scenario.input.channel!==(handoff?run.turn.channel:'consola') || scenario.input.identity_status!==(handoff?'unverified':'verified') ||
    run.turn.scope_ref!==(handoff?'unverified':'verified') ||
    (input.scenario==='CC-E03' && run.turn.channel!=='telegram') || (input.scenario==='CC-E10' && run.turn.channel!=='whatsapp') ||
    (!handoff && (run.turn.audience!=='asesor' || run.turn.attention_mode!=='asistido'))) throw new Error('scenario input mismatch');
  const [checkpoint]=await tx.query('SELECT result FROM agent_checkpoint WHERE id=$1',[`run:${run.id}`]);
  const card=checkpoint?.result?.type==='card' ? checkpoint.result.card : null;
  if (!card || card.proposal) throw new Error('missing safe candidate checkpoint');
  const [counts]=await tx.query(`SELECT
    (SELECT count(*)::int FROM integration_operation WHERE case_id=$1 AND created_at >= $2 AND created_at <= $3) AS operations,
    (SELECT count(*)::int FROM outbox WHERE case_id=$1 AND kind IN ('effect','integration') AND created_at >= $2 AND created_at <= $3) AS effect_jobs,
    (SELECT count(*)::int FROM retention_proposal WHERE case_id=$1 AND run_id=ANY($4::text[])) AS proposals,
    (SELECT count(*)::int FROM crm_effect e JOIN retention_proposal p ON p.id=e.proposal_id WHERE p.case_id=$1 AND e.confirmed_at >= $2 AND e.confirmed_at <= $3) AS offers,
    (SELECT count(*)::int FROM support_ticket t JOIN retention_proposal p ON p.id=t.proposal_id WHERE p.case_id=$1 AND t.created_at >= $2 AND t.created_at <= $3) AS tickets`,[input.caseId,start,closed,input.runIds]);
  if (!counts || Object.values(counts).some(value=>Number(value)!==0)) throw new Error('unexpected effect or proposal');
  let detail:Record<string,unknown>;
  if (handoff) {
    const destination=input.scenario==='CC-E03'?'soporte_tecnico':'supervision';
    const reason=input.scenario==='CC-E03'?'los_rojo_mas_de_10_minutos':'requerimiento_legal_o_regulatorio';
    if (card.suggested_escalation?.destination!==destination || card.suggested_escalation?.reason_code!==reason) throw new Error('candidate escalation mismatch');
    const transitions=await tx.query(`SELECT id,destination,reason_code,status,requested_by,owner_id,request_revision,created_at FROM escalation
      WHERE case_id=$1 AND created_at >= $2 AND created_at <= $3`,[input.caseId,start,closed]);
    const escalation=transitions[0];
    if (transitions.length!==1 || escalation.destination!==destination || escalation.reason_code!==reason || !['tomado','resuelto'].includes(escalation.status) || !escalation.owner_id || escalation.request_revision!==run.turn.case_revision) throw new Error('authorized handoff missing');
    const claims=await tx.query(`SELECT id,metadata,created_at FROM attention_event WHERE case_id=$1 AND kind='escalation_claim' AND created_at >= $2 AND created_at <= $3 ORDER BY id`,[input.caseId,escalation.created_at,closed]);
    if (claims.length!==1 || claims[0].metadata?.destination!==destination || claims[0].metadata?.operator_id!==escalation.owner_id) throw new Error('claim evidence missing');
    detail={assertion:input.scenario==='CC-E03'?'n2_handoff':'supervisor_handoff',escalation_id:escalation.id,destination,reason_code:reason,claim_event_id:claims[0].id,
      ...(input.scenario==='CC-E10' ? {transport:'whatsapp_fixture'} : {})};
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
    VALUES($1,$2,$3,$4,$5,NULL,NULL,$6,'zero_effect',clock_timestamp()) ON CONFLICT(candidate_revision,scenario_id,report_fingerprint) DO UPDATE SET case_id=EXCLUDED.case_id,run_ids=EXCLUDED.run_ids,proposal_id=NULL,operation_id=NULL,evidence=EXCLUDED.evidence,proof_kind=EXCLUDED.proof_kind,verified_at=clock_timestamp()`,[input.candidate,input.scenario,fingerprint,input.caseId,JSON.stringify(input.runIds),proof]);
  return {scenario:input.scenario,report_fingerprint:fingerprint,proof};
}
