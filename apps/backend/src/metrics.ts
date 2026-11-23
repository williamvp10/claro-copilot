import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { Intent } from '@claro/contracts';
import { browserEndpoint, projectComparison } from './dashboard.js';
import { readModelMetrics, traceIdentifier } from './telemetry.js';

export const MetricGroup = z.enum(['negocio', 'calidad-llm', 'tecnica', 'agentes', 'machine-learning', 'devops']);
type Group = z.infer<typeof MetricGroup>;
export const MetricFilters = z.object({
  days: z.enum(['7', '30']).default('7').transform(Number),
  channel: z.enum(['all', 'web', 'telegram']).default('all'),
  category: z.union([Intent, z.literal('all')]).default('all'),
  revision: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional()
});
export type Filters = z.infer<typeof MetricFilters>;

const timezone = 'America/Bogota';
type Status = 'measured' | 'no_sample' | 'pending_instrumentation' | 'target_only' | 'unavailable';
type Point = { date: string; value: number; sample?: number };
type Evidence = { label: string; url: string };
type Metric = {
  id: string; label: string; value: number | null; unit: string; sample: number | null; denominator: number | null;
  target: string | null; observed_at: string | null; source: string; status: Status; series?: Point[]; evidence?: Evidence;
};
type Input = Partial<Omit<Metric, 'id' | 'label' | 'unit' | 'source'>>;
function metric(id: string, label: string, unit: string, source: string, data: Input = {}): Metric {
  const value = data.value ?? null;
  return {
    id, label, unit, source, value, sample: data.sample ?? null, denominator: data.denominator ?? null,
    target: data.target ?? null, observed_at: data.observed_at ?? (value === null ? null : new Date().toISOString()),
    status: data.status ?? (value === null ? 'no_sample' : 'measured'),
    ...(data.series?.length ? { series: data.series } : {}), ...(data.evidence ? { evidence: data.evidence } : {})
  };
}

const rate = (numerator: number, denominator: number) => denominator ? numerator * 100 / denominator : null;
const platform = 'PostgreSQL · Eventos de plataforma';
const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const windowParams = (filters: Filters) => [filters.days, filters.channel, filters.category, timezone];
const all = 'all';
const timeline = `SELECT (now() AT TIME ZONE $4)::date AS today`;
const allCases = `
  SELECT c.id,c.contact_ref,c.account_ref,c.snapshot,c.created_at,c.resolved,
    COALESCE(c.intent_hint, (
      SELECT COALESCE(e.metadata->>'category',e.metadata->>'route') FROM attention_event e
      WHERE e.case_id=c.id AND e.kind IN ('agent_task_outcome','task_outcome','agent_completed')
      ORDER BY e.id DESC LIMIT 1
    )) AS category
  FROM attention_case c
`;
const scopedCases = `${allCases} WHERE $2='all' OR c.snapshot->>'channel'=$2`;

type EventDay = { date: string; kind: string; n: number };
async function events(db: DataSource, filters: Filters, kinds: string[]): Promise<EventDay[]> {
  return db.query(`
    WITH bounds AS (${timeline}), cases AS (${scopedCases})
    SELECT (e.created_at AT TIME ZONE $4)::date::text AS date,e.kind,count(*)::int AS n
    FROM attention_event e JOIN cases c ON c.id=e.case_id CROSS JOIN bounds b
    WHERE e.created_at>=((b.today-($1::int-1))::timestamp AT TIME ZONE $4) AND e.kind=ANY($5::text[])
      AND ($3='all' OR COALESCE(e.metadata->>'category',e.metadata->>'route',c.category)=$3)
    GROUP BY 1,2 ORDER BY 1,2`, [...windowParams(filters), kinds]);
}
function countSeries(rows: EventDay[], kind: string, hasPopulation = true): Input {
  const series = rows.filter(row => row.kind === kind).map(row => ({ date: row.date, value: row.n, sample: row.n }));
  const count = series.reduce((total, point) => total + point.value, 0);
  return { value: hasPopulation ? count : null, sample: hasPopulation ? count : null, series };
}

async function business(db: DataSource, filters: Filters) {
  const [rows, cohort, retention] = await Promise.all([
    events(db, filters, ['opened','handoff_taken','retention_confirmed','support_ticket_confirmed','billing_adjustment_confirmed']),
    db.query(`
      WITH bounds AS (${timeline}), cases AS (${scopedCases}), closed AS (
        SELECT c.*,e.created_at AS closed_at,(e.created_at AT TIME ZONE $4)::date::text AS date,
          EXTRACT(EPOCH FROM e.created_at-t.first_assisted)::float AS seconds
        FROM cases c JOIN LATERAL (
          SELECT created_at FROM attention_event WHERE case_id=c.id AND kind='closed' ORDER BY id DESC LIMIT 1
        ) e ON true
        LEFT JOIN LATERAL (
          SELECT MIN(created_at) AS first_assisted FROM attention_event WHERE case_id=c.id
            AND kind IN ('handoff_taken','human_attention_started')
        ) t ON true CROSS JOIN bounds b
        WHERE e.created_at>=((b.today-($1::int-1))::timestamp AT TIME ZONE $4) AND ($3='all' OR c.category=$3)
      ), fcr_population AS (
        SELECT c.*, CASE WHEN c.snapshot->>'verified'='true' THEN
          CASE WHEN c.account_ref ~ '^C-[0-9]{4}$' THEN c.account_ref
            WHEN c.snapshot->>'channel'='telegram' AND c.contact_ref ~ '^C-[0-9]{4}$' THEN c.contact_ref
            WHEN c.snapshot->>'channel'='web' AND c.contact_ref LIKE 'web-c1001:%' THEN 'C-1001'
            ELSE NULL END ELSE NULL END AS verified_account
        FROM (${allCases}) c
      ), fcr_closed AS (
        SELECT c.*,e.created_at AS closed_at,(e.created_at AT TIME ZONE $4)::date::text AS date,
          CASE WHEN e.metadata->>'resolved'='true' THEN true WHEN e.metadata->>'resolved'='false' THEN false ELSE NULL END AS first_resolved
        FROM fcr_population c JOIN LATERAL (
          SELECT created_at,metadata FROM attention_event WHERE case_id=c.id AND kind='closed' ORDER BY created_at,id LIMIT 1
        ) e ON true CROSS JOIN bounds b
        WHERE ($2='all' OR c.snapshot->>'channel'=$2) AND ($3='all' OR c.category=$3)
          AND e.created_at>=((b.today-($1::int-1))::timestamp AT TIME ZONE $4)
          AND e.created_at<=now()-interval '7 days'
          AND c.category IN ('soporte_tecnico','facturacion','consulta_planes','cancelacion','portabilidad')
          AND e.metadata->>'resolved' IN ('true','false')
      ), fcr_outcomes AS (
        SELECT f.date,f.first_resolved,
          EXISTS (SELECT 1 FROM fcr_population other WHERE other.id<>f.id AND other.category=f.category
            AND ((f.verified_account IS NOT NULL AND other.verified_account=f.verified_account)
              OR ((f.verified_account IS NULL OR other.verified_account IS NULL)
                AND other.snapshot->>'channel'=f.snapshot->>'channel' AND other.contact_ref=f.contact_ref))
            AND other.created_at>f.closed_at AND other.created_at<=f.closed_at+interval '7 days')
          OR EXISTS (SELECT 1 FROM attention_event event WHERE event.case_id=f.id AND event.kind='reopened'
            AND event.created_at>f.closed_at AND event.created_at<=f.closed_at+interval '7 days') AS repeated,
          EXISTS (SELECT 1 FROM attention_event event WHERE event.case_id=f.id
            AND event.kind IN ('escalation_requested','escalation_claim','escalation_claimed','escalation_forwarded','escalation_reassign')
            AND event.created_at<=f.closed_at) AS escalated
        FROM fcr_closed f
      ), fcr_days AS (
        SELECT date,count(*)::int AS fcr_n,
          count(*) FILTER(WHERE first_resolved IS TRUE AND NOT repeated AND NOT escalated)::int AS first_resolution
        FROM fcr_outcomes GROUP BY date
      ), assisted AS (
        SELECT e.case_id,MIN(e.created_at) AS accepted,
          BOOL_OR(e.kind IN ('escalation_claim','escalation_claimed')
            AND COALESCE(e.metadata->>'destination','') IN ('soporte_tecnico','facturacion','comercial_portabilidad')) AS n2
        FROM attention_event e JOIN cases c ON c.id=e.case_id CROSS JOIN bounds b
        WHERE e.created_at>=((b.today-($1::int-1))::timestamp AT TIME ZONE $4) AND ($3='all' OR c.category=$3)
          AND e.kind IN ('handoff_taken','human_attention_started','escalation_claim','escalation_claimed')
        GROUP BY e.case_id
      ), assisted_days AS (
        SELECT (accepted AT TIME ZONE $4)::date::text AS date,count(*)::int AS handled,count(*) FILTER(WHERE n2)::int AS n2
        FROM assisted GROUP BY 1
      ), closed_days AS (
        SELECT date,avg(seconds) FILTER(WHERE seconds>=0)::float AS aht,count(*) FILTER(WHERE seconds>=0)::int AS aht_n,
          count(*) FILTER(WHERE resolved)::int AS resolved,count(resolved)::int AS closed
        FROM closed GROUP BY date
      )
      SELECT date,aht,COALESCE(aht_n,0) AS aht_n,COALESCE(resolved,0) AS resolved,COALESCE(closed,0) AS closed,
        COALESCE(first_resolution,0) AS first_resolution,COALESCE(fcr_n,0) AS fcr_n,COALESCE(handled,0) AS handled,COALESCE(n2,0) AS n2
      FROM closed_days FULL JOIN fcr_days USING(date) FULL JOIN assisted_days USING(date) ORDER BY date`, windowParams(filters)),
    db.query(`
      WITH bounds AS (${timeline}),cases AS (${scopedCases}), outcomes AS (
        SELECT DISTINCT ON(e.case_id) (e.created_at AT TIME ZONE $4)::date::text AS date,e.metadata->>'outcome' AS outcome
        FROM attention_event e JOIN cases c ON c.id=e.case_id CROSS JOIN bounds b
        WHERE e.kind='retention_outcome' AND ($3='all' OR $3='cancelacion')
          AND e.created_at>=((b.today-($1::int-1))::timestamp AT TIME ZONE $4) ORDER BY e.case_id,e.id DESC
      ) SELECT date,count(*) FILTER(WHERE outcome='permanencia')::int AS stayed,
        count(*) FILTER(WHERE outcome IN ('permanencia','baja'))::int AS completed,
        count(*) FILTER(WHERE outcome='pendiente')::int AS pending FROM outcomes GROUP BY date ORDER BY date`,windowParams(filters))
  ]);
  type Cohort = { date:string; aht:number|null; aht_n:number; resolved:number; closed:number; first_resolution:number; fcr_n:number; handled:number; n2:number };
  const days = cohort as Cohort[];
  const sum = (key: Exclude<keyof Cohort, 'date'>) => days.reduce((total, day) => total + (day[key] ?? 0), 0);
  function proportion(num: 'resolved' | 'first_resolution' | 'n2', denom: 'closed' | 'fcr_n' | 'handled'): Input {
    const denominator = sum(denom);
    return {
      value: rate(sum(num), denominator), sample: sum(num), denominator,
      series: days.flatMap(day => day[denom] ? [{ date:day.date, value:rate(day[num],day[denom])!, sample:day[denom] }] : [])
    };
  }
  const retained = retention as {date:string;stayed:number;completed:number;pending:number}[];
  const retainedCount = retained.reduce((total,day)=>total+day.stayed,0);
  const retentionDenominator = retained.reduce((total,day)=>total+day.completed,0);
  const pendingRetention = retained.reduce((total,day)=>total+day.pending,0);
  const ahtSample = sum('aht_n');
  const hasPopulation = rows.some(row=>row.kind==='opened') || days.some(day=>day.handled>0 || day.closed>0);
  return [
    metric('cases','Conversaciones abiertas','casos',platform,countSeries(rows,'opened')),
    metric('aht','Tiempo medio con asesor','s',platform,{
      value: ahtSample ? days.reduce((total, day)=>total+(day.aht ?? 0)*day.aht_n,0)/ahtSample : null,
      sample:ahtSample, denominator:ahtSample, target:'−20 % frente a la línea base del piloto',
      series:days.flatMap(day=>day.aht===null?[]:[{date:day.date,value:day.aht,sample:day.aht_n}])
    }),
    metric('resolution','Resolución reportada','%',platform,proportion('resolved','closed')),
    metric('fcr','Resolución en el primer contacto (7 días)','%',platform,{...proportion('first_resolution','fcr_n'),target:'+10 pp frente a la línea base del piloto'}),
    metric('n2','Escalamiento tomado por N2','%',platform,{...proportion('n2','handled'),target:'−15 % frente a la línea base del piloto'}),
    metric('retention','Permanencia confirmada al cierre','%',platform,{value:rate(retainedCount,retentionDenominator),
      sample:retainedCount,denominator:retentionDenominator,series:retained.flatMap(day=>day.completed
        ? [{date:day.date,value:rate(day.stayed,day.completed)!,sample:day.completed}] : [])}),
    metric('retention_pending','Desenlaces de retención pendientes','casos',platform,{
      value:retained.length?pendingRetention:null,sample:retained.length?pendingRetention:null}),
    metric('offers_confirmed','Ofertas registradas con recibo','ofertas',platform,countSeries(rows,'retention_confirmed',hasPopulation)),
    metric('tickets_confirmed','Tickets registrados con recibo','tickets',platform,countSeries(rows,'support_ticket_confirmed',hasPopulation)),
    metric('adjustments_confirmed','Ajustes registrados con recibo','ajustes',platform,countSeries(rows,'billing_adjustment_confirmed',hasPopulation))
  ];
}

async function quality(db: DataSource, filters: Filters) {
  const [reports, votes] = await Promise.all([
    db.query(`SELECT candidate_revision,completed_at,report FROM prompt_evaluation
      WHERE ($1::text IS NULL OR candidate_revision=$1) AND completed_at >= now()-$2::int*interval '1 day'
      ORDER BY completed_at DESC LIMIT 30`, [filters.revision ?? null, filters.days]),
    events(db, filters, ['reply_feedback_positive','reply_feedback_negative'])
  ]);
  type ComparisonRow = { candidate_revision:string; completed_at:Date; report:Parameters<typeof projectComparison>[0] & {
    review?:{metrics?:{adjudicated_hallucinations?:number;hallucination_sample?:number}};
    evidence?:{ golden_count?:number }; proposed?:{ questions?:{required_fact_count:number;citations:string[];score:string;recall:number|null}[];
      metrics?:{grounded_evidence_count?:number} };
  } };
  const comparisons = reports as ComparisonRow[];
  const points = (id: 'accuracy'|'groundedness'|'recall_at_5') => comparisons.slice().reverse().flatMap(row => {
    const evals = projectComparison(row.report,false);
    const value = evals?.candidate[id];
    return typeof value === 'number' ? [{ date:new Date(row.completed_at).toISOString(),value }] : [];
  });
  const recent = comparisons[0];
  const evaluation = projectComparison(recent?.report,false);
  const evidence = recent ? { label:'Abrir comparación A/B', url:`/?view=evaluations&revision=${encodeURIComponent(recent.candidate_revision)}` } : undefined;
  const yes = countSeries(votes,'reply_feedback_positive').value ?? 0;
  const no = countSeries(votes,'reply_feedback_negative').value ?? 0;
  const n = recent?.report.evidence?.golden_count ?? null;
  const evalSource = 'Evaluación A/B · suite versionada';
  const auditedCount = recent?.report.review?.metrics?.hallucination_sample ?? 0;
  const hallucinations = recent?.report.review?.metrics?.adjudicated_hallucinations ?? 0;
  const coverage = recent?.report.proposed?.questions?.filter((q:{required_fact_count:number;citations:string[];score:string}) =>
    q.required_fact_count>0 && q.score!=='platform_replay_required') ?? [];
  const emptyCitations = coverage.filter((q:{citations:string[]})=>!q.citations.length).length;
  return {
    metrics:[
      metric('accuracy','Exactitud','proporción',evalSource,{value:evaluation?.candidate.accuracy, target:'≥ 0,80', denominator:n, observed_at:recent?.completed_at.toISOString(),series:points('accuracy'),evidence}),
      metric('groundedness','Fidelidad a las fuentes','proporción',evalSource,{value:evaluation?.candidate.groundedness,target:'≥ 0,85',
        sample:recent?.report.proposed?.metrics?.grounded_evidence_count, observed_at:recent?.completed_at.toISOString(),series:points('groundedness'),evidence}),
      metric('recall_at_5','Recall@5','proporción',evalSource,{value:evaluation?.candidate.recall_at_5,target:'≥ 0,90',
        denominator:recent?.report.proposed?.questions?.filter((q:{recall:number|null})=>q.recall!==null).length,
        observed_at:recent?.completed_at.toISOString(),series:points('recall_at_5'),evidence}),
      metric('no_citation','Respuestas sin cita','%',evalSource,{value:rate(emptyCitations,coverage.length),sample:emptyCitations,denominator:coverage.length,target:'≤ 5 %',evidence}),
      metric('hallucinations','Alucinaciones adjudicadas','%',evalSource,{
        value:rate(hallucinations,auditedCount),sample:hallucinations,denominator:auditedCount,target:'≤ 5 %',evidence}),
      metric('advisor_feedback','Feedback positivo del asesor','%',platform,{value:rate(yes,yes+no),sample:yes,denominator:yes+no,target:'≥ 80 %'})
    ],
    supporting:{ comparison:evaluation }
  };
}

type Health = {value:number|null; sample:number; denominator:number; series:Point[]; status:Status};
async function apiHealth(days: number): Promise<Partial<Health>> {
  const configured = process.env.PROMETHEUS_URL;
  if (!configured) return {status:'pending_instrumentation'};
  try {
    const base = new URL(configured);
    if (base.username || base.password || !['http:','https:'].includes(base.protocol)) return {status:'unavailable'};
    const end = Math.floor(Date.now()/60_000)*60;
    const expected = Math.ceil(days*24*60/5);
    const query = new URL('/api/v1/query_range',base);
    query.search = new URLSearchParams({query:'min(up{job="claro-api"})',start:String(end-(expected-1)*300),end:String(end),step:'300'}).toString();
    const response = await fetch(query,{signal:AbortSignal.timeout(1200),redirect:'error'});
    if (!response.ok) return {status:'unavailable'};
    const json = z.object({data:z.object({result:z.array(z.object({values:z.array(z.tuple([z.number(),z.enum(['0','1'])]))}))})})
      .parse(await response.json());
    const values = json.data.result[0]?.values ?? [];
    const daysSeen = new Map<string,number[]>();
    const formatter = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
    for (const [stamp,value] of values) {
      const day = formatter.format(new Date(stamp*1000));
      const observations = daysSeen.get(day) ?? [];
      observations.push(Number(value));
      daysSeen.set(day,observations);
    }
    return {value:rate(values.filter(x=>x[1]==='1').length,values.length),sample:values.length,denominator:expected,
      series:[...daysSeen].map(([date,observations])=>({date,value:avg(observations)!*100,sample:observations.length})),
      status:values.length?'measured':'no_sample'};
  } catch {
    return {status:'unavailable'};
  }
}

type Timing = {date:string|null;kind:string;p95:number;sample:number};
async function technical(db: DataSource, filters: Filters) {
  const [timing, costs, probes, freshness] = await Promise.all([
    db.query(`
      WITH bounds AS (${timeline}),cases AS (${scopedCases}), eligible AS (
        SELECT (e.created_at AT TIME ZONE $4)::date::text AS date,e.kind,(e.metadata->>'ms')::float AS ms
        FROM attention_event e JOIN cases c ON c.id=e.case_id CROSS JOIN bounds b
        WHERE e.created_at>=((b.today-($1::int-1))::timestamp AT TIME ZONE $4) AND
          e.kind IN ('agent_latency','conversation_publication','conversation_completed') AND
          jsonb_typeof(e.metadata->'ms')='number' AND ($3='all' OR COALESCE(e.metadata->>'category',e.metadata->>'route',c.category)=$3)
      ) SELECT date,kind,percentile_cont(.95) WITHIN GROUP(ORDER BY ms)::float AS p95,count(*)::int AS sample
        FROM eligible GROUP BY GROUPING SETS ((date,kind),(kind)) ORDER BY date,kind`,windowParams(filters)) as Promise<Timing[]>,
    db.query(`
      WITH bounds AS (${timeline}),cases AS (${scopedCases}), grouped AS (
        SELECT e.case_id,(e.created_at AT TIME ZONE $4)::date::text AS date,(e.metadata->>'cost_usd')::float AS amount
        FROM attention_event e JOIN cases c ON c.id=e.case_id CROSS JOIN bounds b
        WHERE e.created_at>=((b.today-($1::int-1))::timestamp AT TIME ZONE $4) AND e.kind='generation.openai'
          AND jsonb_typeof(e.metadata->'cost_usd')='number' AND ($3='all' OR c.category=$3)
      ) SELECT date,sum(amount)::float AS usd,count(DISTINCT case_id)::int AS total FROM grouped GROUP BY GROUPING SETS ((date),()) ORDER BY date`,windowParams(filters)),
    apiHealth(filters.days),
    db.query(`SELECT published_at,manifest->>'detected_at' AS detected_at FROM knowledge_publication
      WHERE published_at>=now()-$1::int*interval '1 day' AND manifest ? 'detected_at' ORDER BY published_at DESC LIMIT 30`,[filters.days])
  ]);
  const latency = (kind:string):Input => {
    const total = timing.find(row=>row.kind===kind && row.date===null);
    return {value:total?.p95,sample:total?.sample,denominator:total?.sample,
      series:timing.flatMap(row=>row.kind===kind && row.date ? [{date:row.date,value:row.p95,sample:row.sample}] : [])};
  };
  const cost = costs.find((row:{date:string|null})=>row.date===null);
  const fresh = freshness.flatMap((row:{published_at:Date;detected_at:string})=>{
    const ms = new Date(row.published_at).getTime()-new Date(row.detected_at).getTime();
    return Number.isFinite(ms) && ms>=0 ? [{date:new Date(row.published_at).toISOString(),value:ms/60_000}] : [];
  }).reverse() as Point[];
  return [
    metric('first_content_p95','Primer contenido emitido p95','ms',platform,{status:'pending_instrumentation',...latency('conversation_publication'),
      ...(timing.some(x=>x.kind==='conversation_publication')?{status:'measured'}:{}),target:'≤ 2 s'}),
    metric('reply_p95','Respuesta completa emitida p95','ms',platform,{status:'pending_instrumentation',...latency('conversation_completed'),
      ...(timing.some(x=>x.kind==='conversation_completed')?{status:'measured'}:{}),target:'≤ 8 s'}),
    metric('first_token_p95','Primer token p95','ms',platform,{status:'pending_instrumentation'}),
    metric('worker_p95','Latencia del worker p95','ms',platform,latency('agent_latency')),
    metric('availability','Disponibilidad de API','%','Prometheus · up',{...probes,target:'≥ 99 %'}),
    metric('cost_per_conversation','Costo de generación por conversación instrumentada','USD',platform,{
      value:cost?.total?cost.usd/cost.total:null,sample:cost?.total,denominator:cost?.total,
      series:costs.flatMap((row:{date:string|null;usd:number;total:number})=>row.date && row.total ? [{date:row.date,value:row.usd/row.total,sample:row.total}] : [])}),
    metric('generation_budget','Presupuesto de generación por turno','USD','Política de generación',{status:'target_only',target:'USD 0,02 por turno'}),
    metric('freshness','Detección a publicación del índice','min','PostgreSQL · Publicación de conocimiento',{
      value:fresh.at(-1)?.value,sample:fresh.length,series:fresh,target:'≤ 15 min',status:fresh.length?'measured':'pending_instrumentation'})
  ];
}

type AgentAggregate = {
  date: string | null; category: string | null; tasks: number; success: number; abstention: number; blocked: number;
  pending: number; failed: number; reads: number; tool_errors: number; tool_denials: number; loops: number;
  policy_violations: number; latency_p95: number | null; latency_n: number;
};
async function agents(db: DataSource, filters: Filters) {
  const [results, workflow, exported, dependencies] = await Promise.all([
    db.query(`
      WITH bounds AS (${timeline}),cases AS (${scopedCases}), observed AS (
        SELECT e.id,e.kind,e.metadata,e.case_id,e.created_at,
          (e.created_at AT TIME ZONE $4)::date::text AS date,
          COALESCE(e.metadata->>'category',e.metadata->>'route',c.category) AS category
        FROM attention_event e JOIN cases c ON c.id=e.case_id CROSS JOIN bounds b
        WHERE e.created_at>=((b.today-($1::int-1))::timestamp AT TIME ZONE $4)
          AND (e.kind LIKE 'tool.%' OR e.kind IN ('agent_task_outcome','task_outcome','agent_latency','agent_loop_stopped','agent_unauthorized_effect'))
          AND ($3='all' OR COALESCE(e.metadata->>'category',e.metadata->>'route',c.category)=$3)
      ), normalized AS (
        SELECT *,row_number() OVER (PARTITION BY case_id,category,COALESCE(metadata->>'run_id',id::text),kind ORDER BY
          (metadata->>'outcome' IN ('qualified_success','failed','blocked')) DESC NULLS LAST,id DESC) AS row
        FROM observed
      )
      SELECT date,category,
        count(*) FILTER(WHERE kind IN ('task_outcome','agent_task_outcome') AND row=1)::int AS tasks,
        count(*) FILTER(WHERE kind IN ('task_outcome','agent_task_outcome') AND row=1 AND metadata->>'outcome'='qualified_success')::int AS success,
        count(*) FILTER(WHERE kind IN ('task_outcome','agent_task_outcome') AND row=1 AND metadata->>'outcome'='expected_abstention')::int AS abstention,
        count(*) FILTER(WHERE kind IN ('task_outcome','agent_task_outcome') AND row=1 AND metadata->>'outcome'='blocked')::int AS blocked,
        count(*) FILTER(WHERE kind IN ('task_outcome','agent_task_outcome') AND row=1 AND metadata->>'outcome'='pending')::int AS pending,
        count(*) FILTER(WHERE kind IN ('task_outcome','agent_task_outcome') AND row=1 AND metadata->>'outcome'='failed')::int AS failed,
        count(*) FILTER(WHERE kind LIKE 'tool.%' AND metadata->>'status' IN ('ok','success','error','failed','timeout'))::int AS reads,
        count(*) FILTER(WHERE kind LIKE 'tool.%' AND metadata->>'status' IN ('error','failed','timeout'))::int AS tool_errors,
        count(*) FILTER(WHERE kind LIKE 'tool.%' AND metadata->>'status' IN ('denied','policy_denied','blocked'))::int AS tool_denials,
        count(*) FILTER(WHERE kind='agent_loop_stopped')::int AS loops,
        count(*) FILTER(WHERE kind='agent_unauthorized_effect')::int AS policy_violations,
        (percentile_cont(.95) WITHIN GROUP(ORDER BY CASE WHEN jsonb_typeof(metadata->'ms')='number' THEN (metadata->>'ms')::float END)
          FILTER(WHERE kind='agent_latency'))::float AS latency_p95,
        count(*) FILTER(WHERE kind='agent_latency' AND jsonb_typeof(metadata->'ms')='number')::int AS latency_n
      FROM normalized GROUP BY GROUPING SETS((date),(),(category)) ORDER BY date,category`,windowParams(filters)) as Promise<AgentAggregate[]>,
    events(db,filters,['proposal_created','proposal_approved','integration_confirmed_by_advisor','escalation_requested','escalation_claim']),
    db.query(`
      WITH bounds AS (${timeline}),cases AS (${scopedCases})
      SELECT e.metadata->>'run_id' AS run_id,c.snapshot->>'channel' AS channel,c.category,e.created_at
      FROM attention_event e JOIN cases c ON c.id=e.case_id CROSS JOIN bounds b
      WHERE e.kind='langfuse_exported' AND e.metadata ? 'run_id' AND ($3='all' OR c.category=$3)
        AND e.created_at>=((b.today-($1::int-1))::timestamp AT TIME ZONE $4) ORDER BY e.created_at DESC LIMIT 12`,windowParams(filters)),
    db.query(`
      WITH bounds AS (${timeline}),cases AS (${scopedCases})
      SELECT e.metadata->>'tool_id' AS tool_id,count(*)::int AS calls,
        count(*) FILTER(WHERE e.metadata->>'status' IN ('error','failed','timeout'))::int AS errors
      FROM attention_event e JOIN cases c ON c.id=e.case_id CROSS JOIN bounds b
      WHERE e.kind LIKE 'tool.%' AND e.metadata ? 'tool_id' AND ($3='all' OR COALESCE(e.metadata->>'route',c.category)=$3)
        AND e.created_at>=((b.today-($1::int-1))::timestamp AT TIME ZONE $4) GROUP BY 1 ORDER BY 1`,windowParams(filters))
  ]);
  const total = results.find(row=>row.date===null&&row.category===null);
  const days = results.filter(row=>row.date!==null);
  const count = (key:'tasks'|'abstention'|'blocked'|'pending'|'failed'|'tool_denials'|'loops'|'policy_violations'):Input => ({
    value:total?.tasks ? total[key] : null, sample:total?.tasks,
    series:days.map(row=>({date:row.date!,value:row[key],sample:row.tasks}))
  });
  const proportion = (numerator:'success'|'tool_errors',denominator:'tasks'|'reads'):Input => ({
    value:rate(total?.[numerator]??0,total?.[denominator]??0),sample:total?.[numerator],denominator:total?.[denominator],
    series:days.flatMap(row=>row[denominator] ? [{date:row.date!,value:rate(row[numerator],row[denominator])!,sample:row[denominator]}] : [])
  });
  const langfuse = browserEndpoint(process.env.LANGFUSE_UI_URL);
  const project = encodeURIComponent(process.env.LANGFUSE_PROJECT_ID || 'claro-copiloto');
  return {
    metrics:[
      metric('agent_success','Tareas con resultado exitoso','%',platform,{...proportion('success','tasks'),target:'≥ 90 %'}),
      metric('agent_abstentions','Abstenciones esperadas','turnos',platform,count('abstention')),
      metric('agent_pending','Tareas pendientes','turnos',platform,count('pending')),
      metric('agent_blocked','Tareas bloqueadas por política','turnos',platform,count('blocked')),
      metric('agent_failed','Tareas fallidas','turnos',platform,count('failed')),
      metric('subgraph_p95','Latencia del agente p95','ms',platform,{
        value:total?.latency_p95,sample:total?.latency_n,denominator:total?.latency_n,
        series:days.flatMap(row=>row.latency_p95===null?[]:[{date:row.date!,value:row.latency_p95,sample:row.latency_n}])}),
      metric('tool_error','Errores en tools ejecutadas','%',platform,{...proportion('tool_errors','reads'),target:'≤ 3 %'}),
      metric('tool_denied','Invocaciones de tools bloqueadas','eventos',platform,count('tool_denials')),
      metric('tool_retries','Reintentos de herramientas','eventos',platform,{status:'pending_instrumentation'}),
      metric('requested_approvals','Propuestas pendientes de confirmación humana registradas','eventos',platform,countSeries(workflow,'proposal_created',!!total?.tasks)),
      metric('escalations','Escalamientos solicitados','casos',platform,countSeries(workflow,'escalation_requested',!!total?.tasks)),
      metric('loops_stopped','Ciclos detenidos','eventos',platform,{...count('loops'),target:'0',
        ...(total?.loops ? {} : {status:'pending_instrumentation',value:null})}),
      metric('unauthorized_effects','Efectos indebidos observados','efectos',platform,{...count('policy_violations'),target:'0',
        ...(total?.policy_violations ? {} : {status:'pending_instrumentation',value:null})})
    ],
    supporting:{
      traces:langfuse ? exported.map((trace:{run_id:string;channel:string;category:string;created_at:Date})=>({
        ...trace,url:`${langfuse}/project/${project}/traces/${traceIdentifier(trace.run_id)}`
      })) : [],
      categories:results.filter(row=>row.category!==null && row.date===null),
      integrations:dependencies
    }
  };
}

async function machineLearning(db:DataSource, filters: Filters) {
  const [model, eventsByDay, operation, classes] = await Promise.all([
    readModelMetrics(filters.days),events(db,filters,['ml_predicted','ml_follow_up_agreed','ml_follow_up_completed']),
    db.query(`
      WITH bounds AS (${timeline}), cases AS (${scopedCases}), observed AS (
        SELECT e.* FROM attention_event e JOIN cases c ON c.id=e.case_id CROSS JOIN bounds b
        WHERE e.created_at>=((b.today-($1::int-1))::timestamp AT TIME ZONE $4)
          AND e.kind IN ('ml_predicted','ml_churn_evaluated','ml_unavailable')
          AND ($3='all' OR c.category=$3)
      ), predictions AS (
        SELECT DISTINCT ON (metadata->>'prediction_id') metadata->>'prediction_id' AS prediction_id,metadata->>'label' AS label
        FROM observed WHERE kind='ml_predicted' AND metadata ? 'prediction_id' ORDER BY metadata->>'prediction_id',id DESC
      ), supervision AS (
        SELECT p.label AS suggested,latest.label,latest.synchronized_at FROM predictions p LEFT JOIN LATERAL (
          SELECT m.payload->>'label' AS label,m.synchronized_at FROM ml_feedback m
          WHERE m.kind='intent' AND m.payload->>'prediction_id'=p.prediction_id
          ORDER BY m.created_at DESC,m.event_id DESC LIMIT 1
        ) latest ON true
      ), churn AS (
        SELECT DISTINCT ON (case_id) metadata->>'outcome' AS outcome,metadata->>'priority' AS priority
        FROM observed WHERE kind='ml_churn_evaluated' ORDER BY case_id,id DESC
      )
      SELECT (SELECT count(*)::int FROM observed WHERE kind='ml_unavailable' AND metadata->>'signal'='intent') AS intent_errors,
        (SELECT count(*)::int FROM supervision) AS predicted,(SELECT count(label)::int FROM supervision) AS labeled,
        (SELECT count(*)::int FROM supervision WHERE label=suggested) AS confirmed,
        (SELECT count(*)::int FROM supervision WHERE label<>suggested) AS corrected,
        (SELECT count(synchronized_at)::int FROM supervision) AS synchronized,
        count(*)::int AS evaluated, count(*) FILTER(WHERE outcome IN ('available','service_unavailable'))::int AS valid_photos,
        count(*) FILTER(WHERE outcome='available')::int AS scored, count(*) FILTER(WHERE outcome='no_snapshot')::int AS missing,
        count(*) FILTER(WHERE outcome='invalid_snapshot')::int AS invalid,
        count(*) FILTER(WHERE outcome='service_unavailable')::int AS churn_errors,
        count(*) FILTER(WHERE priority='alta')::int AS alta, count(*) FILTER(WHERE priority='media')::int AS media,
        count(*) FILTER(WHERE priority='habitual')::int AS habitual FROM churn`,windowParams(filters)),
    db.query(`
      WITH bounds AS (${timeline}),cases AS (${scopedCases})
      SELECT e.metadata->>'label' AS label,count(*)::int AS count
      FROM attention_event e JOIN cases c ON c.id=e.case_id CROSS JOIN bounds b
      WHERE e.kind='ml_predicted' AND e.metadata ? 'label'
        AND e.created_at>=((b.today-($1::int-1))::timestamp AT TIME ZONE $4)
        AND ($3='all' OR COALESCE(c.category,e.metadata->>'label')=$3) GROUP BY 1 ORDER BY 2 DESC,1`,windowParams(filters))
  ]);
  const groups = model?.groups.filter(row=>filters.channel===all || row.channel===filters.channel) ?? [];
  const intent = model?.offline?.metrics;
  const churn = model?.churn;
  const mlflow = browserEndpoint(process.env.MLFLOW_UI_URL);
  const modelEvidence = mlflow && model?.deployment?.run_id && model.deployment.experiment_id
    ? {label:'Abrir run de entrenamiento',url:`${mlflow}/#/experiments/${encodeURIComponent(model.deployment.experiment_id)}/runs/${encodeURIComponent(model.deployment.run_id)}`} : undefined;
  const churnEvidence = mlflow && churn?.run_id && churn.experiment_id
    ? {label:'Abrir run de churn',url:`${mlflow}/#/experiments/${encodeURIComponent(churn.experiment_id)}/runs/${encodeURIComponent(churn.run_id)}`} : undefined;
  const endpoint = 'FastAPI · /internal/v1/model-metrics';
  const unavailable = model ? {} : {status:'unavailable' as const};
  const [stats]=operation;
  const intentCount=(sample:number)=>({value:stats.predicted?sample:null,sample,denominator:stats.predicted});
  const churnCount=(sample:number)=>({value:stats.evaluated?sample:null,sample,denominator:stats.evaluated});
  const captured=churn?.offline.holdout.top_20_captured;
  return {
    metrics:[
      metric('intent_predictions','Predicciones de intención','turnos',platform,countSeries(eventsByDay,'ml_predicted')),
      metric('inference_errors','Errores de inferencia de intención','turnos',platform,{value:stats.intent_errors}),
      metric('intent_f1','F1 macro de intención · offline','F1',endpoint,{...unavailable,value:intent?.macro_f1,
        sample:model?.offline?.rows,evidence:modelEvidence,target:'≥ 0,80'}),
      metric('cancel_recall','Recall de cancelación · offline','proporción',endpoint,{...unavailable,value:intent?.cancelacion_recall,evidence:modelEvidence}),
      metric('label_coverage','Cobertura de etiquetas supervisadas','%',platform,{value:rate(stats.labeled,stats.predicted),sample:stats.labeled,denominator:stats.predicted}),
      metric('intent_confirmed','Intenciones confirmadas','predicciones',platform,intentCount(stats.confirmed)),
      metric('intent_corrected','Intenciones corregidas','predicciones',platform,intentCount(stats.corrected)),
      metric('intent_synchronized','Etiquetas sincronizadas con FastAPI','predicciones',platform,{
        value:stats.labeled?stats.synchronized:null,sample:stats.synchronized,denominator:stats.labeled}),
      metric('churn_auc','ROC-AUC de churn · offline','AUC',endpoint,{...unavailable,value:churn?.offline.metrics.roc_auc, denominator:churn?.offline.holdout.size,target:'≥ 0,75',evidence:churnEvidence}),
      metric('churn_capture','Bajas capturadas en el 20 % superior · offline','%',endpoint,{
        ...unavailable,value:churn ? churn.offline.metrics.recall_at_20*100:null,denominator:churn?.offline.holdout.positives,
        sample:captured ?? (churn?Math.round(churn.offline.metrics.recall_at_20*churn.offline.holdout.positives):null),evidence:churnEvidence}),
      metric('churn_predictions','Casos con banda de churn','casos',platform,churnCount(stats.scored)),
      metric('churn_photo_coverage','Casos con foto válida de churn','%',platform,{
        value:rate(stats.valid_photos,stats.evaluated),sample:stats.valid_photos,denominator:stats.evaluated}),
      metric('churn_missing','Casos sin foto de churn','casos',platform,churnCount(stats.missing)),
      metric('churn_invalid','Casos con foto inválida de churn','casos',platform,churnCount(stats.invalid)),
      metric('churn_unavailable','Casos sin inferencia por indisponibilidad','casos',platform,churnCount(stats.churn_errors)),
      ...(['alta','media','habitual'] as const).map(priority=>metric(`churn_band_${priority}`,`Churn · prioridad ${priority}`,'casos',platform,{
        value:stats.scored?stats[priority]:null,sample:stats[priority],denominator:stats.scored})),
      metric('follow_ups_agreed','Seguimientos acordados','casos',platform,countSeries(eventsByDay,'ml_follow_up_agreed')),
      metric('follow_ups_completed','Seguimientos completados','casos',platform,countSeries(eventsByDay,'ml_follow_up_completed'))
    ],
    supporting:{ deployment:model?.deployment ?? null, churn:churn ?? null, drift:groups, classes }
  };
}

export const ReleaseEvidence = z.object({
  sha:z.string().regex(/^[a-f0-9]{40}$/),
  digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),
  component:z.enum(['claro-copiloto','claro-ml']),
  workflow_url:z.url().refine(value=>new URL(value).hostname==='github.com' && new URL(value).protocol==='https:'),
  ci:z.enum(['passed','failed']),
  coverage_pct:z.number().min(0).max(100).nullable(),
  bytes:z.number().int().positive().safe(),
  critical:z.number().int().nonnegative(),
  scanned_at:z.iso.datetime({offset:true}),
  commit_at:z.iso.datetime({offset:true}),
  smoke:z.enum(['passed','failed','pending']),
  smoke_verified_at:z.iso.datetime({offset:true}).nullable()
}).strict().refine(value=>value.smoke==='pending' ? value.smoke_verified_at===null :
  value.smoke_verified_at!==null && Date.parse(value.smoke_verified_at)>=Date.parse(value.commit_at),
  {message:'Fecha de smoke incompatible con el commit'});

async function devops(db: DataSource, filters:Filters) {
  const rows = await db.query(`SELECT evidence,observed_at FROM release_metric
    WHERE ($1::text IS NULL OR digest=$1) AND observed_at>=now()-$2::int*interval '1 day'
    ORDER BY observed_at DESC LIMIT 30`,[filters.digest ?? null,filters.days]) as {
    evidence:z.infer<typeof ReleaseEvidence>; observed_at:Date
  }[];
  const rowsOf = (component:string) => rows.filter(row=>row.evidence.component===component);
  const source = 'GitHub Actions · evidencia por SHA y digest';
  const lead = (record:z.infer<typeof ReleaseEvidence>) => record.smoke==='passed'&&record.smoke_verified_at
    ? (Date.parse(record.smoke_verified_at)-Date.parse(record.commit_at))/60_000:null;
  const perComponent = ['claro-copiloto','claro-ml'].flatMap(component=>{
    const entries = rowsOf(component);
    const current = entries[0];
    const recorded = current?.evidence;
    const common = {observed_at:current?.observed_at?.toISOString(),...(recorded ? {evidence:{label:'Abrir ejecución de CI',url:recorded.workflow_url}} : {})};
    return [
      metric('image_size_'+component,`Tamaño de imagen · ${component}`,'bytes',source,{...common,value:recorded?.bytes}),
      metric('critical_'+component,`Hallazgos críticos · ${component}`,'hallazgos',source,{...common,value:recorded?.critical,target:'0'}),
      metric('lead_time_'+component,`Commit a despliegue verificado · ${component}`,'min',source,{
        ...common,value:recorded ? lead(recorded) : null,target:'< 30 min',
        series:entries.slice().reverse().flatMap(row=>lead(row.evidence)===null?[]:[{date:row.observed_at.toISOString(),value:lead(row.evidence)!}])})
    ];
  });
  const coverage = rowsOf('claro-copiloto')[0];
  return {
    metrics:[
      metric('coverage','Cobertura de pruebas','%',source,{value:coverage?.evidence.coverage_pct, target:'≥ 70 %',observed_at:coverage?.observed_at.toISOString()}),
      ...perComponent
    ],
    supporting:{releases:rows.map(({evidence,observed_at})=>({...evidence, observed_at}))}
  };
}

export async function readMetricGroup(db:DataSource, group:Group, filters:Filters) {
  // A filter only appears in the response when it applies to the requested population.
  const applied = {
    days:filters.days, timezone,
    ...(group!=='devops' ? {channel:filters.channel,category:filters.category} : {}),
    ...(group==='calidad-llm' && filters.revision ? {revision:filters.revision} : {}),
    ...(group==='devops' && filters.digest ? {digest:filters.digest} : {})
  };
  const data = group==='negocio' ? {metrics:await business(db,filters)}
    : group==='calidad-llm' ? await quality(db,filters)
    : group==='tecnica' ? {metrics:await technical(db,filters)}
    : group==='agentes' ? await agents(db,filters)
    : group==='machine-learning' ? await machineLearning(db,filters)
    : await devops(db,filters);
  return {group,filters:applied,...data};
}
