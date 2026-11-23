import type { DataSource } from 'typeorm';
import type { Dashboard, DashboardDay, DashboardFilters, EvalComparison, EvalMetrics } from '@claro/contracts';
import { readModelMetrics, traceIdentifier } from './telemetry.js';

const TZ = 'America/Bogota';
type ReviewEntries<T> = Record<string,T> | ({id:string} & T)[];
type Report = {
  gate?: string; evidence?: { date?: string; rubric?: string; provider_mode?: string; golden_sha256?: string; scenarios_sha256?: string; corpus_sha256?: string };
  baseline?: Side; proposed?: Side;
  review?: { metrics?: EvalMetrics; golden?: ReviewEntries<{correct:boolean}>; critical?: ReviewEntries<{passed:boolean}>;
    platform_verified_ids?: string[]; platform_verified_golden_ids?: string[]; unresolved_critical_ids?: string[] };
};
type EvalStep = {score:string;checks?:{scope:string;status:string}[]};
type Conversation = {id:string;critical:boolean;steps:EvalStep[]};
type Side = {
  metrics: EvalMetrics;
  questions: {id:string;score:string}[];
  conversations: Conversation[];
};

function reviewEntries<T>(raw?:ReviewEntries<T>):Map<string,T> {
  return new Map(Array.isArray(raw) ? raw.map(item=>[item.id,item]) : Object.entries(raw??{}));
}

function conversationStatus(row:Conversation, reviewed?:boolean, platformVerified=false, unresolved=false) {
  if (reviewed===false || row.steps.some(step=>step.score==='failed')) return 'failed';
  if (!platformVerified && (row.steps.some(step => step.score==='platform_replay_required' ||
      step.checks?.some(check=>check.scope==='platform_replay' && check.status!=='passed')) ||
      (row.critical && row.steps.some(step=>!step.checks?.length)))) return 'platform_replay_required';
  return !unresolved && (reviewed || row.steps.every(step=>step.score==='verified_exact')) ? 'verified_exact' : 'review';
}

export function projectComparison(report: Report | undefined, detailed = true): EvalComparison | null {
  if (!report?.baseline || !report.proposed) return null;
  const baseline = new Map(report.baseline.questions.map(q => [q.id,q.score]));
  for (const item of report.baseline.conversations) baseline.set(item.id,conversationStatus(item));
  const golden = reviewEntries(report.review?.golden);
  const critical = reviewEntries(report.review?.critical);
  const checked = new Set(report.review?.platform_verified_ids);
  const unresolved = new Set(report.review?.unresolved_critical_ids);
  const checkedGolden = new Set(report.review?.platform_verified_golden_ids);
  return {
    gate:report.gate ?? 'review_required', baseline:report.baseline.metrics,
    candidate:{ ...report.proposed.metrics, ...report.review?.metrics },
    ...report.evidence && {
      date:report.evidence.date,rubric:report.evidence.rubric,provider_mode:report.evidence.provider_mode,
      evidence:{golden_sha256:report.evidence.golden_sha256,scenarios_sha256:report.evidence.scenarios_sha256,corpus_sha256:report.evidence.corpus_sha256}
    },
    cases: detailed ? [
      ...report.proposed.questions.map(q => ({
        id:q.id, baseline:baseline.get(q.id) ?? 'review',
        candidate:q.score==='failed' ? 'failed' : q.score==='platform_replay_required' && !checkedGolden.has(q.id) ? q.score
          : golden.has(q.id) ? golden.get(q.id)?.correct ? 'verified_exact' : 'failed' : checkedGolden.has(q.id) ? 'review' : q.score,
        human_review:!golden.has(q.id) && (checkedGolden.has(q.id) || !['verified_exact','failed','platform_replay_required'].includes(q.score))
      })),
      ...report.proposed.conversations.map(c => ({
        id:c.id, baseline:baseline.get(c.id) ?? 'review',
        candidate:conversationStatus(c,critical.get(c.id)?.passed,checked.has(c.id),unresolved.has(c.id)),
        human_review:c.critical && !critical.has(c.id)
      }))
    ] : []
  };
}

export function browserEndpoint(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) return null;
    return url.href.replace(/\/$/,'');
  } catch {
    return null;
  }
}

export async function readDashboard(db: DataSource, filters: DashboardFilters): Promise<Dashboard> {
  const days = Number(filters.days);
  const channel = filters.channel;
  // The same Bogotá calendar bounds are applied to totals and daily points.
  const rows = await db.query(`
    WITH bounds AS (
      SELECT (now() AT TIME ZONE $3)::date AS today
    ), calendar AS (
      SELECT (today-offset_days)::date AS day FROM bounds,generate_series(0,$1::int-1) AS offset_days
    ), scoped_events AS (
      SELECT e.kind,e.metadata,(e.created_at AT TIME ZONE $3)::date AS day,c.snapshot->>'channel' AS channel
      FROM attention_event e LEFT JOIN attention_case c ON c.id=e.case_id CROSS JOIN bounds
      WHERE e.created_at >= ((today-($1::int-1))::timestamp AT TIME ZONE $3)
        AND ($2='all' OR c.snapshot->>'channel'=$2)
    ), handled AS (
      SELECT c.resolved, e.day,
        EXTRACT(EPOCH FROM e.closed_at-COALESCE(t.taken_at,c.created_at))::float AS seconds
      FROM attention_case c
      JOIN LATERAL (
        SELECT created_at AS closed_at,(created_at AT TIME ZONE $3)::date AS day
        FROM attention_event WHERE case_id=c.id AND kind='closed' ORDER BY created_at DESC LIMIT 1
      ) e ON true
      LEFT JOIN LATERAL (
        SELECT MIN(created_at) AS taken_at FROM attention_event WHERE case_id=c.id AND kind='handoff_taken'
      ) t ON true CROSS JOIN bounds
      WHERE c.snapshot->>'owner_id' IS NOT NULL AND e.day BETWEEN today-($1::int-1) AND today
        AND ($2='all' OR c.snapshot->>'channel'=$2)
    ), event_days AS (
      SELECT day,count(*) FILTER(WHERE kind='opened')::int AS cases,
        count(*) FILTER(WHERE kind IN ('job_failed','ml_unavailable','telegram_failed'))::int AS errors,
        (percentile_cont(.95) WITHIN GROUP (ORDER BY (metadata->>'ms')::float)
          FILTER (WHERE kind='agent_latency' AND metadata ? 'ms'))::float AS latency_p95,
        count(*) FILTER(WHERE kind='agent_latency' AND metadata ? 'ms')::int AS latency_sample
      FROM scoped_events GROUP BY day
    ), handling_days AS (
      SELECT day,avg(seconds) FILTER(WHERE seconds>=0)::float AS aht,count(*) FILTER(WHERE seconds>=0)::int AS aht_sample
      FROM handled GROUP BY day
    )
    SELECT
      (SELECT COALESCE(jsonb_object_agg(kind,n),'{}') FROM (SELECT kind,count(*)::int AS n FROM scoped_events GROUP BY kind) counts) AS totals,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('date',calendar.day,'cases',COALESCE(e.cases,0),'errors',COALESCE(e.errors,0),
         'latency_p95',e.latency_p95,'latency_sample',COALESCE(e.latency_sample,0),'aht',h.aht,'aht_sample',COALESCE(h.aht_sample,0)) ORDER BY calendar.day),'[]')
        FROM calendar LEFT JOIN event_days e USING(day) LEFT JOIN handling_days h USING(day)) AS daily,
      (SELECT count(*) FILTER(WHERE resolved IS TRUE)::int FROM handled) AS resolved,
      (SELECT count(*) FILTER(WHERE resolved IS NOT NULL)::int FROM handled) AS resolution_sample,
      (SELECT avg(seconds) FILTER(WHERE seconds>=0)::float FROM handled) AS aht,
      (SELECT count(*) FILTER(WHERE seconds>=0)::int FROM handled) AS aht_sample,
      (SELECT percentile_cont(.95) WITHIN GROUP(ORDER BY (metadata->>'ms')::float)::float
        FROM scoped_events WHERE kind='agent_latency' AND metadata ? 'ms') AS p95,
      (SELECT sum((metadata->>'cost_usd')::float) FROM scoped_events WHERE kind='generation.openai' AND metadata ? 'cost_usd') AS cost,
      (SELECT count(*)::int FROM scoped_events WHERE kind='generation.openai' AND metadata ? 'cost_usd') AS cost_sample,
      (SELECT COALESCE(jsonb_agg(classes ORDER BY label),'[]') FROM (
        SELECT metadata->>'label' AS label,count(*)::int AS count FROM scoped_events
        WHERE kind='ml_predicted' AND metadata ? 'label' GROUP BY 1
      ) classes) AS prediction_classes,
      (SELECT COALESCE(jsonb_agg(traces),'[]') FROM (
        SELECT metadata->>'run_id' AS run_id,channel FROM scoped_events
        WHERE kind='langfuse_exported' AND metadata ? 'run_id' ORDER BY day DESC LIMIT 6
      ) traces) AS traces,
      (SELECT count(*)::int FROM case_feedback f JOIN attention_case c ON c.id=f.case_id CROSS JOIN bounds
        WHERE f.created_at >= ((today-($1::int-1))::timestamp AT TIME ZONE $3) AND ($2='all' OR c.snapshot->>'channel'=$2)) AS surveys,
      (SELECT count(*)::int FROM case_feedback f JOIN attention_case c ON c.id=f.case_id CROSS JOIN bounds
        WHERE f.created_at >= ((today-($1::int-1))::timestamp AT TIME ZONE $3) AND ($2='all' OR c.snapshot->>'channel'=$2) AND f.score>=4) AS satisfied
  `,[days,channel,TZ]);
  const row = rows[0];
  const [ml,[active],[quality]] = await Promise.all([
    readModelMetrics(days),
    db.query('SELECT revision FROM prompt_revision WHERE activated'),
    db.query(`SELECT report FROM prompt_evaluation
      ORDER BY (report->'evidence'->>'provider_mode'='live') DESC NULLS LAST,completed_at DESC LIMIT 1`)
  ]);
  const evalComparison = projectComparison(quality?.report,false);
  const count = (kind: string) => Number(row.totals[kind] ?? 0);
  const langfuse = browserEndpoint(process.env.LANGFUSE_UI_URL);
  const mlflow = browserEndpoint(process.env.MLFLOW_UI_URL);
  const project = encodeURIComponent(process.env.LANGFUSE_PROJECT_ID || 'claro-copiloto');
  const mlGroups = ml?.groups.filter(g=>channel==='all' || g.channel===channel) ?? [];
  const churn = ml?.churn;
  const churnEvaluation = churn?.offline;
  return {
    window_days:days,channel,timezone:TZ,sample:process.env.DEMO_MODE==='true'?'synthetic':'pilot',revision:active.revision,
    daily:row.daily as DashboardDay[], prediction_classes:row.prediction_classes, evaluation:evalComparison,
    evidence:{
      langfuse,mlflow:mlflow && ml?.deployment?.experiment_id && ml.deployment.run_id
        ? `${mlflow}/#/experiments/${encodeURIComponent(ml.deployment.experiment_id)}/runs/${encodeURIComponent(ml.deployment.run_id)}`
        : mlflow,
      model_version:ml?.deployment?.model_version,model_run_id:ml?.deployment?.run_id,
      traces:langfuse ? (row.traces as {run_id:string;channel:string}[]).map(trace=>({
        ...trace,url:`${langfuse}/project/${project}/traces/${traceIdentifier(trace.run_id)}`
      })) : []
    },
    providers:[
      {name:'Worker',status:count('agent_completed') ? 'Con ejecuciones' : 'Sin ejecuciones en la ventana'},
      {name:'Telegram',status:process.env.TELEGRAM_BOT_TOKEN ? 'Bot configurado' : 'Webhook de prueba'},
      {name:'Langfuse',status:count('langfuse_exported') ? 'Con exportaciones' : process.env.LANGFUSE_PUBLIC_KEY ? 'Sin trazas en la ventana' : 'Sin configurar'},
      {name:'Intención en sombra',status:ml?.deployment ? `${ml.deployment.model_version} · ${[...new Set(mlGroups.map(g=>g.drift?.status ?? 'Sin referencia'))].join(', ') || 'Sin referencia'}` : 'Sin modelo observado'},
      {name:'Churn a 90 días',status:churn ? `${churn.model_version} · cohorte ${churn.training_cohort}` : 'Sin modelo observado'}
    ],
    metrics:[
      {id:'cases',label:'Conversaciones abiertas',value:count('opened'),unit:'casos'},
      {id:'aht',label:'Tiempo medio con asesor',value:row.aht,unit:'s',denominator:row.aht_sample},
      {id:'resolved',label:'Resolución reportada',value:row.resolution_sample ? row.resolved*100/row.resolution_sample : null,unit:'%',denominator:row.resolution_sample},
      {id:'handoff',label:'Casos tomados por asesor',value:count('handoff_taken'),unit:'casos'},
      {id:'retention',label:'Ofertas confirmadas',value:count('retention_confirmed'),unit:'ofertas'},
      {id:'agent',label:'Ejecuciones completadas',value:count('agent_completed'),unit:'turnos'},
      {id:'discarded',label:'Salidas obsoletas descartadas',value:count('agent_stale'),unit:'turnos'},
      {id:'agent_errors',label:'Trabajos con error',value:count('job_failed'),unit:'eventos'},
      {id:'agent_p95',label:'Latencia del worker p95',value:row.p95,unit:'ms',denominator:row.daily.reduce((n:number,d:DashboardDay)=>n+d.latency_sample,0)},
      {id:'csat',label:'CSAT (4 o 5)',value:row.surveys ? row.satisfied*100/row.surveys : null,unit:'%',denominator:row.surveys},
      {id:'generation_cost',label:'Costo de generación pública',value:row.cost,unit:'USD',denominator:row.cost_sample},
      {id:'ml',label:'Predicciones en sombra',value:count('ml_predicted'),unit:'turnos'},
      {id:'ml_errors',label:'Fallos de inferencia en sombra',value:count('ml_unavailable'),unit:'turnos'},
      {id:'ml_labels',label:'Etiquetas supervisadas',value:ml ? mlGroups.reduce((n,g)=>n+g.labels_count,0):null,unit:'casos'},
      {id:'ml_f1',label:'F1 macro agrupado de ML',value:ml?.offline?.metrics.macro_f1 ?? null,unit:'F1'},
      {id:'ml_recall',label:'Recall de cancelación de ML',value:ml?.offline?.metrics.cancelacion_recall ?? null,unit:'recall'},
      ...(churnEvaluation ? [
        {id:'ml_churn_auc',label:'ROC-AUC de churn (prueba offline)',value:churnEvaluation.metrics.roc_auc,unit:'AUC',denominator:churnEvaluation.holdout.size},
        {id:'ml_churn_capture',label:'Bajas capturadas por churn en el 20 % superior (prueba offline)',
         value:100*churnEvaluation.metrics.recall_at_20,unit:'%',denominator:churnEvaluation.holdout.positives}
      ] : [])
    ]
  };
}
