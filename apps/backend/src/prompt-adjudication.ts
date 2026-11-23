import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { lockPromptReleases } from './prompt-releases.js';
import { replayReportFingerprint } from './prompt-replay-evidence.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const artifact = z.string().trim().min(8).max(300);
const caseId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const PromptAdjudication = z.object({
  evidence:z.object({golden_sha256:digest,scenarios_sha256:digest,corpus_sha256:digest}),
  golden:z.record(caseId,z.object({correct:z.boolean(),grounded:z.boolean(),hallucination:z.boolean().optional(),artifact})).default({}),
  critical:z.record(caseId,z.object({passed:z.boolean(),artifact})).default({})
}).refine(input=>Object.keys(input.golden).length<=30 && Object.keys(input.critical).length<=19);
type Review = z.infer<typeof PromptAdjudication>;
type Result = {score:string;usedPrivateRead:boolean;forbiddenHit:boolean;checks?:{name:string;status:string;scope:string}[]};
/** A human narrative review is not proof that an approval, effect or handoff was replayed. */
export function unresolvedCriticalReview(steps:Result[], reviewPassed:boolean | undefined, platformVerified=false):boolean {
  if (!reviewPassed || !steps.length) return true;
  return steps.some(step => step.score==='failed' || !Array.isArray(step.checks) || !step.checks.length || (!platformVerified && (step.score==='platform_replay_required' || step.checks.some(check=>check.scope==='platform_replay' && check.status!=='passed'))) || step.checks.some(check=>check.status==='failed'));
}

type PlatformProof = {scenario_id:string;proof_kind:string;case_id:string;run_ids:unknown;proposal_id:string|null;operation_id:string|null;verified_at:Date|string;evidence:Record<string,unknown>};
/** Validate the verifier's scenario-specific contract, not a free-form review assertion. */
export function isVerifiedPlatformProof(proof:PlatformProof,id:string,businessDate:string,now=Date.now()):boolean {
 const e=proof.evidence;
 if (proof.scenario_id!==id || !e || e.version!==2 || e.scenario_id!==id || e.business_date!==businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || !proof.case_id || !Array.isArray(proof.run_ids) || proof.run_ids.some(x=>typeof x!=='string'||!x) || new Set(proof.run_ids).size!==proof.run_ids.length) return false;
 const start=Date.parse(String(e.window_started_at)), end=Date.parse(String(e.window_closed_at)), verified=proof.verified_at instanceof Date ? proof.verified_at.getTime() : Date.parse(String(proof.verified_at));
 if (![start,end,verified].every(Number.isFinite) || start>end || end>verified || verified>now+5000) return false;
 if (id==='CC-E11' || id==='CC-E13') {
  return proof.proof_kind==='confirmed_effect' && !!proof.proposal_id && !!proof.operation_id && proof.run_ids.length===(id==='CC-E11'?2:1)
   && e.fixture===(id==='CC-E11'?'C-1004':'C-1013') && e.assertion===(id==='CC-E11'?'retention_offer_confirmed':'priority_ticket_confirmed')
   && e.verified_effect===true && e.approval===true && e.single_operation===true
   && (id!=='CC-E11' || e.replay_request_observed===true);
 }
 if (proof.proof_kind!=='zero_effect' || proof.proposal_id!==null || proof.operation_id!==null || proof.run_ids.length!==1 || e.verified_no_effect!==true) return false;
 if (id==='CC-E03' || id==='CC-E10') {
  const validClaim=(typeof e.claim_event_id==='number' && Number.isSafeInteger(e.claim_event_id) && e.claim_event_id>0) || (typeof e.claim_event_id==='string' && /^[1-9]\d*$/.test(e.claim_event_id));
  return e.fixture==='C-1013' && e.assertion===(id==='CC-E03'?'n2_handoff':'supervisor_handoff') && e.destination===(id==='CC-E03'?'soporte_tecnico':'supervision')
   && e.reason_code===(id==='CC-E03'?'los_rojo_mas_de_10_minutos':'requerimiento_legal_o_regulatorio')
   && (id!=='CC-E10' || e.transport==='whatsapp_fixture') && typeof e.escalation_id==='string' && !!e.escalation_id && validClaim;
 }
 return id==='CC-E12' && e.fixture==='C-1007' && e.assertion==='retention_ineligible' && e.crm_read===true && e.eligible===false && e.days_past_due===45 && e.days_limit===30;
}

type GoldenProof={golden_id:string;case_id:string;run_id:string;proposal_id:string|null;operation_id:string|null;verified_at:Date|string;evidence:Record<string,unknown>};
export function isVerifiedGoldenProof(proof:GoldenProof,id:string,businessDate:string,now=Date.now()):boolean {
 const e=proof.evidence;
 if(proof.golden_id!==id || !e || e.version!==1 || e.golden_id!==id || e.business_date!==businessDate || !proof.case_id || !proof.run_id || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate))return false;
 const start=Date.parse(String(e.window_started_at)),end=Date.parse(String(e.window_closed_at)),verified=proof.verified_at instanceof Date?proof.verified_at.getTime():Date.parse(String(proof.verified_at));
 if(![start,end,verified].every(Number.isFinite) || start>end || end>verified || verified>now+5000 || !/^[a-f0-9]{64}$/.test(String(e.answer_sha256)))return false;
 if(id==='GQ-28')return e.fixture==='C-1013' && !!proof.proposal_id && !!proof.operation_id && e.assertion==='priority_ticket_verified' && e.crm_read===true && e.tickets_read===true && e.approval===true && e.single_operation===true && e.visit_deadline_hours===24 && e.visit_status==='pending_coordination' && /^[a-f0-9]{64}$/.test(String(e.receipt_sha256));
 if(proof.proposal_id!==null || proof.operation_id!==null || e.verified_no_effect!==true || e.crm_read!==true || !/^[a-f0-9]{64}$/.test(String(e.source_sha256)))return false;
 if(id==='GQ-25')return e.fixture==='C-1001' && e.assertion==='plans_balance_due_verified' && e.billing_read===true;
 if(id==='GQ-26')return e.fixture==='C-1004' && e.assertion==='retention_alternatives_verified' && e.eligible===true;
 return id==='GQ-27' && e.fixture==='C-1007' && e.assertion==='retention_denial_verified' && e.eligible===false;
}

type EvidenceReport = {
  evidence:Review['evidence'] & {provider_mode:string;baseline_manifest_sha256:string;candidate_manifest_sha256:string;date:string;rubric:string};
  proposed:{
    questions:(Result & {id:string;citations:string[];grounded:boolean|null})[];
    conversations:{id:string;critical:boolean;steps:Result[]}[];
    metrics:{recall_at_5:number;remote_generation_cases:number};
  };
  review?:{golden:Review['golden'];critical:Review['critical']};
};

export async function adjudicatePromptRevision(db:DataSource,candidate:string,input:Review,operator?:string) {
  return db.transaction(async tx=>{
    await lockPromptReleases(tx);
    const [record]:{base_revision:string;report:EvidenceReport;activated:boolean}[] = await tx.query(`
      SELECT e.base_revision,e.report,p.activated FROM prompt_evaluation e JOIN prompt_revision p ON p.revision=e.candidate_revision
      WHERE e.candidate_revision=$1 FOR UPDATE OF e,p`,[candidate]);
    if (!record) throw new NotFoundException('No se encontró una comparación para esta candidata');
    const [active] = await tx.query('SELECT revision FROM prompt_revision WHERE activated');
    const [running] = await tx.query("SELECT 1 FROM prompt_eval_job WHERE revision=$1 AND status IN ('queued','running')",[candidate]);
    if (record.activated || running || record.base_revision!==active?.revision) {
      throw new ConflictException('La comparación debe estar terminada y corresponder a la revisión activa');
    }
    if (Object.entries(input.evidence).some(([key,value])=>record.report.evidence[key as keyof Review['evidence']]!==value)) {
      throw new BadRequestException('Las huellas del corpus y de la suite no coinciden con la comparación');
    }
    const proposed = record.report.proposed;
    if (Object.keys(input.golden).some(id=>!proposed.questions.some(item=>item.id===id)) ||
        Object.keys(input.critical).some(id=>!proposed.conversations.some(item=>item.critical && item.id===id))) {
      throw new BadRequestException('La adjudicación refiere un caso fuera de la rúbrica');
    }
    const golden = {...record.report.review?.golden,...input.golden};
    const critical = {...record.report.review?.critical,...input.critical};
    const fingerprint=replayReportFingerprint(candidate,record.base_revision,record.report.evidence);
    const proofs:PlatformProof[] = await tx.query('SELECT scenario_id,proof_kind,case_id,run_ids,proposal_id,operation_id,verified_at,evidence FROM prompt_platform_evidence WHERE candidate_revision=$1 AND report_fingerprint=$2',[candidate,fingerprint]);
    const verified=(id:string) => /^[a-f0-9]{64}$/.test(record.report.evidence.rubric ?? '') && proofs.some(p=>isVerifiedPlatformProof(p,id,record.report.evidence.date));
    const goldenProofs:GoldenProof[]=await tx.query('SELECT golden_id,case_id,run_id,proposal_id,operation_id,verified_at,evidence FROM prompt_golden_evidence WHERE candidate_revision=$1 AND report_fingerprint=$2',[candidate,fingerprint]);
    const requiresGoldenProof=(id:string)=>['GQ-25','GQ-26','GQ-27','GQ-28'].includes(id);
    const verifiedGolden=(id:string)=>/^[a-f0-9]{64}$/.test(record.report.evidence.rubric ?? '') && goldenProofs.some(p=>isVerifiedGoldenProof(p,id,record.report.evidence.date));
    const platformVerifiedGoldenIds=proposed.questions.filter(q=>requiresGoldenProof(q.id) && verifiedGolden(q.id)).map(q=>q.id);
    const correct = proposed.questions.filter(x=>x.score!=='failed' && (!requiresGoldenProof(x.id) || verifiedGolden(x.id)) && (golden[x.id]?.correct ?? x.score==='verified_exact')).length;
    const answers = proposed.questions.filter(x=>x.citations.length || golden[x.id]?.grounded===true);
    const grounded = answers.filter(x=>x.score!=='failed' && (!requiresGoldenProof(x.id) || verifiedGolden(x.id)) && (golden[x.id]?.grounded ?? x.grounded===true)).length;
    const platformVerifiedIds=proposed.conversations.filter(x=>x.critical && verified(x.id)).map(x=>x.id);
    const unresolvedCriticalIds=proposed.conversations.filter(x=>x.critical &&
      unresolvedCriticalReview(x.steps,critical[x.id]?.passed,verified(x.id))).map(x=>x.id);
    const unresolved = unresolvedCriticalIds.length;
    const hallucinations = Object.values(golden).filter(entry=>typeof entry.hallucination==='boolean');
    const metrics = {accuracy:correct/proposed.questions.length,groundedness:grounded/Math.max(answers.length,1),
      adjudicated_hallucinations:hallucinations.filter(entry=>entry.hallucination===true).length,
      hallucination_sample:hallucinations.length,
      recall_at_5:proposed.metrics.recall_at_5,unresolved_critical:unresolved};
    const safe = [...proposed.questions,...proposed.conversations.flatMap(item=>item.steps)]
      .every(item=>!item.usedPrivateRead&&!item.forbiddenHit);
    const passed = safe && record.report.evidence.provider_mode==='live' && metrics.accuracy>=0.8 &&
      metrics.groundedness>=0.85 && metrics.recall_at_5>=0.9 && unresolved===0 && proposed.metrics.remote_generation_cases>0;
    const report = {...record.report,gate:passed?'passed':'review_required',
      review:{metrics,golden,critical,platform_verified_ids:platformVerifiedIds,platform_verified_golden_ids:platformVerifiedGoldenIds,unresolved_critical_ids:unresolvedCriticalIds,reviewed_at:new Date().toISOString()}};
    await tx.query('UPDATE prompt_evaluation SET report=$2 WHERE candidate_revision=$1',[candidate,report]);
    await tx.query('UPDATE prompt_revision SET status=$2 WHERE revision=$1 AND NOT activated',[candidate,passed?'passed':'candidate']);
    if (operator) {
      await tx.query(`INSERT INTO prompt_revision_audit(action,operator_id,revision,from_revision,changes)
        VALUES('reviewed',$1,$2,$3,$4)`,[operator,candidate,record.base_revision,
        JSON.stringify([...Object.keys(input.golden),...Object.keys(input.critical)])]);
    }
    return {gate:report.gate,metrics};
  });
}
