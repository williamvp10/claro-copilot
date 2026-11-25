import type { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import type { MetricValues } from './metrics.js';

export class DeploymentObservations1795260000030 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`
      CREATE TABLE deployment_observation (
        id text PRIMARY KEY, sha text, status text NOT NULL,
        created_at timestamptz NOT NULL, finished_at timestamptz, verified_at timestamptz
      );
      CREATE INDEX deployment_observation_created_idx ON deployment_observation (created_at DESC);
      CREATE TABLE deployment_ci (
        sha text PRIMARY KEY, run_id bigint NOT NULL, attempt integer NOT NULL,
        status text NOT NULL, conclusion text, url text NOT NULL, commit_at timestamptz NOT NULL
      );
      CREATE TABLE deployment_https_probe (
        checked_at timestamptz PRIMARY KEY, passed boolean NOT NULL, sha text,
        chat_status integer, api_status integer
      );
      CREATE TABLE deployment_source (
        name text PRIMARY KEY, status text NOT NULL, checked_at timestamptz NOT NULL,
        last_success_at timestamptz
      )
    `);
  }

  async down(db: QueryRunner) {
    await db.query('DROP TABLE deployment_source, deployment_https_probe, deployment_ci, deployment_observation');
  }
}

export async function publicHttpsMetric(db: DataSource, days: number): Promise<MetricValues> {
  const rows: {date:string|null; attempts:number; passed:number; last:Date}[] = await db.query(`
    SELECT (checked_at AT TIME ZONE 'America/Bogota')::date::text AS date, count(*)::int AS attempts,
      count(*) FILTER (WHERE passed)::int AS passed, max(checked_at) AS last
    FROM deployment_https_probe WHERE checked_at >= now() - $1::int * interval '1 day'
    GROUP BY GROUPING SETS ((1), ()) ORDER BY date
  `, [days]);
  const total = rows.find(row => row.date === null);
  if (!total?.attempts) return {};
  return {
    value: total.passed * 100 / total.attempts, sample: total.passed, denominator: total.attempts,
    observed_at: total.last.toISOString(),
    ...(Date.now() - total.last.getTime() > 5 * 60_000 ? {status:'unavailable' as const} : {}),
    series: rows.flatMap(({date, attempts, passed}) => date && attempts
      ? [{date, value:passed * 100 / attempts, sample: attempts}] : [])
  };
}

type OutcomeCounts = {
  date:string|null; total:number; done:number; verified:number; comparable:number; lead:number|null;
};
type Source = {name:string; status:string; checked_at:Date; last_success_at:Date|null};
type Deployment = {
  id:string; sha:string|null; status:string; created_at:Date; finished_at:Date|null; verified_at:Date|null;
  ci_status:string|null; ci_conclusion:string|null; ci_url:string|null; lead_minutes:number|null;
};
type Probe = {
  checked_at:Date; passed:boolean; sha:string|null; chat_status:number|null; api_status:number|null;
  ci_status:string|null; ci_conclusion:string|null; ci_url:string|null;
};

export async function observationMetrics(db: DataSource, days: number) {
  const [sources, deployments, counts, probes]: [Source[], Deployment[], OutcomeCounts[], Probe[]] = await Promise.all([
    db.query(`
      SELECT name, CASE WHEN status='ok' AND checked_at < now() - interval '5 minutes'
        THEN 'unavailable' ELSE status END AS status, checked_at, last_success_at
      FROM deployment_source ORDER BY name
    `),
    db.query(`
      SELECT d.id,d.sha,d.status,d.created_at,d.finished_at,d.verified_at,c.status AS ci_status,
        c.conclusion AS ci_conclusion,c.url AS ci_url,
        CASE WHEN d.verified_at >= c.commit_at
          THEN EXTRACT(EPOCH FROM (d.verified_at-c.commit_at))::float / 60 END AS lead_minutes
      FROM deployment_observation d LEFT JOIN deployment_ci c USING (sha)
      WHERE d.created_at >= now() - $1::int * interval '1 day' ORDER BY d.created_at DESC LIMIT 30
    `, [days]),
    db.query(`
      SELECT (d.created_at AT TIME ZONE 'America/Bogota')::date::text AS date,
        count(*)::int AS total, count(*) FILTER (WHERE d.status='done')::int AS done,
        count(d.verified_at) FILTER (WHERE d.status='done')::int AS verified,
        count(*) FILTER (WHERE d.status='done' AND d.verified_at >= c.commit_at)::int AS comparable,
        percentile_cont(.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (d.verified_at-c.commit_at))::float / 60
        ) FILTER (WHERE d.status='done' AND d.verified_at >= c.commit_at) AS lead
      FROM deployment_observation d LEFT JOIN deployment_ci c USING (sha)
      WHERE d.created_at >= now() - $1::int * interval '1 day'
      GROUP BY GROUPING SETS ((1), ()) ORDER BY date
    `, [days]),
    db.query(`
      SELECT p.checked_at,p.passed,p.sha,p.chat_status,p.api_status,
        c.status AS ci_status,c.conclusion AS ci_conclusion,c.url AS ci_url
      FROM deployment_https_probe p LEFT JOIN deployment_ci c USING (sha)
      ORDER BY p.checked_at DESC LIMIT 1
    `)
  ]);
  const total = counts.find(row => row.date === null);
  const dokploy = sources.find(source => source.name === 'dokploy');
  const github = sources.find(source => source.name === 'github');
  const observed_at = dokploy?.last_success_at?.toISOString();
  const stale = dokploy?.status !== 'ok';
  const done: MetricValues = {
    value: observed_at ? total?.done : null, sample: observed_at ? total?.done : null,
    denominator: observed_at && total?.total ? total.total : null, observed_at,
    ...(stale ? {status:'unavailable' as const} : {}),
    series:counts.flatMap(row => row.date ? [{date:row.date,value:row.done,sample:row.total}] : [])
  };
  const verified: MetricValues = {
    value: total?.done ? total.verified * 100 / total.done : null,
    sample: total?.done ? total.verified : null, denominator: total?.done || null, observed_at,
    ...(stale ? {status:'unavailable' as const} : {})
  };
  const lead: MetricValues = {
    value: total?.lead ?? null, sample: total?.comparable || null, observed_at,
    ...(stale || github?.status !== 'ok' ? {status:'unavailable' as const} : {})
  };
  return {sources, deployments, done, verified, lead, current:probes[0] ?? null};
}
