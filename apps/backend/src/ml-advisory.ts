import { z } from 'zod';
import type { DataSource, EntityManager } from 'typeorm';
import { CaseMlSignals, Intent, type AgentTurn } from '@claro/contracts';
import { audit, enqueue, type CaseRow } from './database.js';
import { customerReference, latestAnalyzable, loadCase, saveCase } from './cases.js';

const counts=z.object({cancelacion:z.number().int().nonnegative(),consulta_planes:z.number().int().nonnegative(),facturacion:z.number().int().nonnegative(),portabilidad:z.number().int().nonnegative(),soporte_tecnico:z.number().int().nonnegative(),categoria_no_disponible:z.number().int().nonnegative()}).strict();
export const ChurnFeatures=z.object({fecha_corte:z.iso.date(),ciudad:z.string().min(1).max(100).nullable(),tipo_servicio:z.enum(['hogar','movil','convergente']),plan_hogar:z.string().min(1).max(100).nullable(),plan_movil:z.string().min(1).max(100).nullable(),metodo_pago:z.string().min(1).max(100),valor_mensual:z.number().finite().nonnegative(),antiguedad_meses:z.number().int().nonnegative().nullable(),dias_mora:z.number().int().nonnegative(),tickets_90d:z.number().int().nonnegative(),tickets_tecnicos_90d:z.number().int().nonnegative(),caidas_servicio_90d:z.number().int().nonnegative().nullable(),uso_datos_gb_mes:z.number().finite().nonnegative().nullable(),nps_ultimo:z.number().int().min(0).max(10).nullable(),ofertas_retencion_12m:z.number().int().min(0).max(1),historial_30d:counts,historial_90d:counts,dias_desde_ultimo_ticket:z.number().finite().positive().nullable()}).strict().superRefine((v,ctx)=>{
  const sum=(o:Record<string,number>)=>Object.values(o).reduce((a,b)=>a+b,0);
  if (sum(v.historial_90d)!==v.tickets_90d || v.tickets_tecnicos_90d>v.tickets_90d || Object.keys(v.historial_30d).some(k=>v.historial_30d[k as keyof typeof v.historial_30d]>v.historial_90d[k as keyof typeof v.historial_90d]) || Boolean(v.tickets_90d)!==(v.dias_desde_ultimo_ticket!==null && v.dias_desde_ultimo_ticket<=90) || Boolean(sum(v.historial_30d))!==(v.dias_desde_ultimo_ticket!==null && v.dias_desde_ultimo_ticket<=30)) ctx.addIssue({code:'custom',message:'Historial inconsistente'});
});
const IntentResult=z.object({prediction_id:z.string().min(1).max(128),label:Intent,score:z.number().min(0).max(1),score_type:z.literal('uncalibrated'),model_version:z.string().min(1).max(128),mode:z.literal('shadow'),recommendation:z.enum(['confirm_cancellation_intent','suggest_intent_for_review','clarify_intent']),requires_human_confirmation:z.literal(true)});
const ChurnResult=z.object({model_version:z.string().min(1).max(128),mode:z.literal('shadow'),horizon_days:z.literal(90),fecha_corte:z.iso.date(),training_cohort:z.iso.date(),score:z.number().min(0).max(1),score_type:z.literal('uncalibrated'),priority:z.enum(['alta','media','habitual']),priority_reference:z.literal('development_cohort_p50_p80'),recommendation:z.enum(['review_retention_followup','check_unresolved_issues','standard_followup']),requires_human_confirmation:z.literal(true)});
const LabelReceipt=z.object({event_id:z.string(),prediction_id:z.string(),label:Intent});

type DemoCustomer = {
  ciudad:string; antiguedad_meses:number; dias_mora:number; valor_mensual_total:number;
  servicios:{tipo:string;plan:string;estado:string;fecha_activacion:string}[];
  tickets_recientes:{ticket_id:string;fecha:string;categoria:string;estado:string}[];
  ofertas_retencion_12m:{fecha:string}[];
};

export function demoChurnFeatures(customer:DemoCustomer, cutoff:string) {
  const nextDay=Date.parse(z.iso.date().parse(cutoff))+86_400_000;
  const daysSince=(date:string) => (nextDay-Date.parse(z.iso.date().parse(date)))/86_400_000;
  const services=customer.servicios.filter(service=>service.estado==='activo' && daysSince(service.fecha_activacion)>0);
  const home=services.find(service=>service.tipo==='hogar');
  const mobile=services.find(service=>service.tipo==='movil');
  if (!home && !mobile) throw new Error('Foto sin servicio activo');
  const empty=()=>counts.parse({cancelacion:0,consulta_planes:0,facturacion:0,portabilidad:0,soporte_tecnico:0,categoria_no_disponible:0});
  const history30=empty(), history90=empty();
  let daysSinceLast:number|null=null;
  for (const ticket of new Map(customer.tickets_recientes.map(ticket=>[ticket.ticket_id,ticket])).values()) {
    const days=daysSince(ticket.fecha);
    if (days<=0) continue;
    if (daysSinceLast===null || days<daysSinceLast) daysSinceLast=days;
    const parsed=Intent.safeParse(ticket.categoria);
    const category=ticket.estado==='cerrado' && parsed.success ? parsed.data : 'categoria_no_disponible';
    if (days<=90) history90[category]++;
    if (days<=30) history30[category]++;
  }
  const priorYear=new Date(Date.parse(cutoff));
  priorYear.setUTCFullYear(priorYear.getUTCFullYear()-1);
  return ChurnFeatures.parse({
    fecha_corte:cutoff,ciudad:customer.ciudad,tipo_servicio:home && mobile?'convergente':home?'hogar':'movil',
    plan_hogar:home?.plan ?? null,plan_movil:mobile?.plan ?? null,metodo_pago:'pse',
    valor_mensual:customer.valor_mensual_total,antiguedad_meses:customer.antiguedad_meses,dias_mora:customer.dias_mora,
    tickets_90d:Object.values(history90).reduce((total,value)=>total+value,0),tickets_tecnicos_90d:history90.soporte_tecnico,
    caidas_servicio_90d:null,uso_datos_gb_mes:null,nps_ultimo:null,
    ofertas_retencion_12m:Number(customer.ofertas_retencion_12m.some(offer=>daysSince(offer.fecha)>0 && Date.parse(offer.fecha)>=priorYear.valueOf())),
    historial_30d:history30,historial_90d:history90,dias_desde_ultimo_ticket:daysSinceLast
  });
}

async function call(path:string,body:unknown) {
  const url=process.env.ML_API_URL, token=process.env.ML_SERVICE_TOKEN;
  if (!url || !token) throw new Error('ML no configurado');
  const response=await fetch(new URL(path,url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body),signal:AbortSignal.timeout(1000)});
  if (!response.ok) throw new Error('ML no disponible');
  return response.json();
}
export async function queueChurn(tx:EntityManager,row:CaseRow) {
  const ref=customerReference(row);
  if (!ref || !row.snapshot.owner_id || !process.env.ML_API_URL) return;
  await enqueue(tx,`ml-churn:${row.id}:${row.snapshot.revision}`,row.id,'ml_churn',{case_revision:row.snapshot.revision,customer_ref:ref});
}
export async function privateSignals(db:Pick<EntityManager,'query'>,row:CaseRow):Promise<CaseMlSignals> {
  const ref=customerReference(row);
  const [signals]=await db.query(`SELECT s.intent,s.churn,s.churn_customer_ref,
      (SELECT jsonb_build_object('label',m.payload->>'label','synchronized',m.synchronized_at IS NOT NULL)
        FROM ml_feedback m WHERE m.case_id=c.id AND kind='intent' AND m.payload->>'prediction_id'=s.intent->>'prediction_id'
        ORDER BY m.created_at DESC,m.event_id DESC LIMIT 1) AS feedback,
      CASE WHEN f.case_id IS NOT NULL THEN jsonb_build_object('status',CASE WHEN f.completed_at IS NULL THEN 'agreed' ELSE 'completed' END,
        'due_date',to_char(f.due_date,'YYYY-MM-DD'),'responsible_name',u.name) END AS follow_up
    FROM attention_case c LEFT JOIN case_ml_signal s ON s.case_id=c.id
    LEFT JOIN case_ml_follow_up f ON f.case_id=c.id AND f.customer_ref=$2 LEFT JOIN "user" u ON u.id=f.responsible_id
    WHERE c.id=$1`,[row.id,ref]);
  const last=latestAnalyzable(row.snapshot);
  const intent=row.snapshot.status==='open' && signals?.intent && last?.actor==='cliente' && last.id===signals.intent.turn_id
    ? CaseMlSignals.shape.intent.parse({...signals.intent,case_revision:row.snapshot.revision,feedback:signals.feedback}) : null;
  const churn=CaseMlSignals.shape.churn.safeParse(ref && signals?.churn_customer_ref===ref ? signals.churn : null);
  return {intent,churn:churn.success?churn.data:{status:'unavailable'},follow_up:signals?.follow_up ?? null};
}
export async function predictIntent(db:DataSource,turn:AgentTurn) {
  try {
    const result=IntentResult.parse(await call('/internal/v1/predict-intent',{text:turn.text,turn_id:turn.turn_id,idempotency_key:turn.turn_id,channel:turn.channel,run_id:turn.run_id}));
    await db.transaction(async tx=>{
      const row=await loadCase(tx,turn.case_id,true);
      const last=latestAnalyzable(row.snapshot);
      if (row.snapshot.status!=='open' || last?.actor!=='cliente' || last.id!==turn.turn_id) return;
      const intent={prediction_id:result.prediction_id,turn_id:turn.turn_id,case_revision:row.snapshot.revision,label:result.label,model_version:result.model_version,
        recommendation:result.label==='cancelacion'?'confirm_cancellation_intent':result.recommendation,requires_human_confirmation:true};
      const [saved]=await tx.query(`INSERT INTO case_ml_signal(case_id,intent) VALUES($1,$2) ON CONFLICT(case_id) DO UPDATE SET intent=EXCLUDED.intent
        WHERE case_ml_signal.intent->>'prediction_id' IS DISTINCT FROM EXCLUDED.intent->>'prediction_id' RETURNING case_id`,[row.id,intent]);
      if (!saved) return;
      await audit(tx,row.id,'ml_predicted',{prediction_id:result.prediction_id,version:result.model_version,mode:result.mode,label:result.label,channel:turn.channel});
      await saveCase(tx,row);
    });
  } catch { await audit(db.manager,turn.case_id,'ml_unavailable',{signal:'intent'}); }
}
export async function predictChurn(db:DataSource,caseId:string,job:{case_revision:number;customer_ref:string}) {
  const current=(row:CaseRow)=>row.snapshot.revision===job.case_revision && !!row.snapshot.owner_id && customerReference(row)===job.customer_ref;
  if (!current(await loadCase(db.manager,caseId))) return;
  const [photo]=await db.query(`SELECT features,synthetic,to_char(fecha_corte,'YYYY-MM-DD') AS date
    FROM ml_customer_snapshot WHERE customer_ref=$1 AND fecha_corte<=(now() AT TIME ZONE 'America/Bogota')::date
    AND (NOT synthetic OR $2) ORDER BY fecha_corte DESC LIMIT 1`,[job.customer_ref,process.env.DEMO_MODE==='true']);
  const features=ChurnFeatures.safeParse(photo?.features);
  let outcome=photo?'invalid_snapshot':'no_snapshot';
  let churn:CaseMlSignals['churn']={status:'unavailable'};
  if (features.success && features.data.fecha_corte===photo.date) {
    try {
      const result=ChurnResult.parse(await call('/internal/v1/predict-churn',features.data));
      if (result.fecha_corte!==features.data.fecha_corte) throw new Error('Corte inconsistente');
      churn={status:'available',priority:result.priority,recommendation:result.recommendation,
        fecha_corte:result.fecha_corte,model_version:result.model_version,synthetic:photo.synthetic};
      outcome='available';
    } catch { outcome='service_unavailable'; }
  }
  await db.transaction(async tx=>{
    const row=await loadCase(tx,caseId,true);
    if (!current(row)) return;
    const [saved]=await tx.query(`INSERT INTO case_ml_signal(case_id,churn,churn_customer_ref,churn_evaluation_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT(case_id) DO UPDATE SET churn=EXCLUDED.churn,churn_customer_ref=EXCLUDED.churn_customer_ref,
      churn_evaluation_revision=EXCLUDED.churn_evaluation_revision
      WHERE case_ml_signal.churn_evaluation_revision IS DISTINCT FROM EXCLUDED.churn_evaluation_revision RETURNING case_id`,
    [caseId,churn,job.customer_ref,job.case_revision]);
    if (!saved) return;
    await audit(tx,caseId,'ml_churn_evaluated',{outcome,channel:row.snapshot.channel,...(churn.status==='available'
      ? {version:churn.model_version,priority:churn.priority,fecha_corte:churn.fecha_corte,synthetic:churn.synthetic} : {})});
    await saveCase(tx,row);
  });
}
export async function sendLabel(db:DataSource,caseId:string,job:{event_id:string}) {
  const [record]=await db.query(`SELECT payload,synchronized_at FROM ml_feedback WHERE event_id=$1 AND case_id=$2 AND kind='intent'`,[job.event_id,caseId]);
  if (!record || record.synchronized_at) return;
  const payload=LabelReceipt.parse(record.payload);
  const receipt=LabelReceipt.parse(await call('/internal/v1/intent-labels',payload));
  if (receipt.event_id!==payload.event_id || receipt.prediction_id!==payload.prediction_id || receipt.label!==payload.label) throw new Error('Recibo de etiqueta incoherente');
  await db.transaction(async tx=>{
    const row=await loadCase(tx,caseId,true);
    const [updated]=await tx.query(`WITH updated AS (
      UPDATE ml_feedback SET synchronized_at=now() WHERE event_id=$1 AND synchronized_at IS NULL RETURNING event_id
    ) SELECT event_id FROM updated`,[job.event_id]);
    if (updated) await saveCase(tx,row);
  });
}
