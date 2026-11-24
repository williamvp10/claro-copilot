import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { traceIdentifier } from './telemetry.js';

export const privacyReplayFixture = 'C-1012';
export const privacyCategories = ['documento_completo','telefono_completo','correo_personal'];
export const privacySurfaces = ['answer','handoff_summary','trace'];
const sha = (value:string) => createHash('sha256').update(value).digest('hex');

const customer = z.object({
  cliente_id:z.literal(privacyReplayFixture),
  numero_documento:z.string().transform(value=>value.replace(/\D/g,'')).pipe(z.string().regex(/^\d{7,12}$/)),
  celular:z.string().transform(value=>value.replace(/\D/g,'')).pipe(z.string().regex(/^\d{10}$/)),
  email:z.email(),
});
const trace = z.object({resourceSpans:z.array(z.object({scopeSpans:z.array(z.object({spans:z.array(z.object({
  traceId:z.string(),name:z.string(),attributes:z.array(z.object({key:z.string(),value:z.object({stringValue:z.string().optional()})})),
}))}))}))});

function canary(source:string) {
  const file:unknown = JSON.parse(source);
  const rows = Array.isArray(file) ? file : file && typeof file==='object' ? Object.values(file).find(Array.isArray) : undefined;
  const entry = customer.parse(rows?.find(row=>row?.cliente_id===privacyReplayFixture));
  const {numero_documento,celular,email} = entry;
  return {email:email.toLowerCase(),numbers:[numero_documento,celular],
    submittedText:`Mi documento es ${numero_documento}, mi teléfono es ${celular} y mi correo es ${email}.`};
}

function containsCanary(surface:string, data:ReturnType<typeof canary>) {
  const candidates = surface.match(/\+?\d(?:[ .()–-]*\d){6,}/g) ?? [];
  return surface.toLowerCase().includes(data.email) ||
    candidates.some(value=>data.numbers.some(marker=>value.replace(/\D/g,'').includes(marker)));
}

type PrivacyRun = {id:string;turn:{turn_id:string;turn_seq:number;case_revision:number;text:string;channel:string;scope_ref:string;audience:string;attention_mode:string}};
type Projection = {verified:boolean;messages:{turn_seq:number;actor:string;text:string}[];card?:{handoff_summary?:string}};
export async function verifyPrivacySurfaces(tx:EntityManager, input:{
  caseId:string; customerSource?:string; traceCaptures?:Readonly<Record<string,string>>;
  publicRun:PrivacyRun; advisorRun:PrivacyRun; snapshot:Projection; advisorSummary:string; before:Date;
}) {
  const {caseId,customerSource,traceCaptures,publicRun,advisorRun,snapshot,advisorSummary,before} = input;
  const {turn} = publicRun;
  if (!customerSource || !traceCaptures || snapshot.verified ||
      turn.audience!=='cliente' || turn.attention_mode!=='autoservicio' || turn.scope_ref!=='unverified' ||
      advisorRun.turn.audience!=='asesor' || advisorRun.turn.attention_mode!=='asistido' ||
      advisorRun.turn.channel!==turn.channel || advisorRun.turn.scope_ref!=='unverified' ||
      advisorRun.turn.turn_id!==turn.turn_id || advisorRun.turn.turn_seq!==turn.turn_seq ||
      advisorRun.turn.case_revision!==turn.case_revision+1 || advisorRun.turn.text!==turn.text) throw new Error('privacy replay scope mismatch');
  const marker = canary(customerSource);
  const fingerprint = sha(JSON.stringify({address:privacyReplayFixture,text:marker.submittedText}));
  const [ingress] = await tx.query("SELECT 1 FROM idempotency WHERE scope='incoming' AND case_id=$1 AND fingerprint=$2",[caseId,fingerprint]);
  const [publicCheckpoint] = await tx.query('SELECT result FROM agent_checkpoint WHERE id=$1',[`run:${publicRun.id}`]);
  const answer = snapshot.messages.find(message=>message.actor==='agente' && message.turn_seq===turn.turn_seq+1)?.text;
  if (!ingress || !answer || !advisorSummary || snapshot.card?.handoff_summary!==advisorSummary ||
      publicCheckpoint?.result?.type!=='handoff' || publicCheckpoint.result.route!=='soporte_tecnico' ||
      publicCheckpoint.result.reason!==answer || !/soporte técnico de nivel 2/i.test(answer)) throw new Error('privacy replay projection mismatch');
  const runIds = [publicRun.id, advisorRun.id];
  const data = await tx.query(`SELECT kind,metadata FROM attention_event WHERE case_id=$1 AND metadata->>'run_id'=ANY($2::text[]) AND created_at<=$3
    AND kind IN ('langfuse_exported','crm_read','crm_services_read','billing_read','billing_invoice_read','billing_invoice_detail_read','tickets_read','retention_read')`,[caseId,runIds,before]);
  if (data.length!==2 || data.some((event:{kind:string})=>event.kind!=='langfuse_exported')) throw new Error('privacy replay audit mismatch');
  const captures = runIds.map(runId=>{
    const body = traceCaptures[runId];
    if (!body || body.length>1024*1024) throw new Error('missing privacy trace');
    const digest = sha(body);
    if (!data.some((event:{metadata:Record<string,unknown>})=>event.metadata.run_id===runId && event.metadata.trace_sha256===digest)) throw new Error('privacy trace digest mismatch');
    const spans = trace.parse(JSON.parse(body)).resourceSpans.flatMap(resource=>resource.scopeSpans.flatMap(scope=>scope.spans));
    const root = spans.find(span=>span.name==='attention.run');
    if (!root?.attributes.some(attribute=>attribute.key==='langfuse.trace.metadata.run_id' && attribute.value.stringValue===runId) ||
        !spans.every(span=>span.traceId===traceIdentifier(runId))) throw new Error('privacy trace run mismatch');
    return {body,digest};
  });
  if ([answer,advisorSummary,...captures.map(capture=>capture.body)].some(surface=>containsCanary(surface,marker))) throw new Error('privacy canary exposed');
  return {canary_present:true,private_reads:0,surfaces:privacySurfaces,trace_sha256:captures.map(capture=>capture.digest)};
}
