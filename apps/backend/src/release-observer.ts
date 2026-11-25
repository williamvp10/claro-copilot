import 'reflect-metadata';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { createDatabase } from './database.js';

const interval = 60_000;
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const dateSchema = z.iso.datetime({offset:true});
const dokployRow = z.object({
  deploymentId: z.string(), composeId: z.string(), status: z.enum(['running','done','error','cancelled']),
  description: z.string().nullish(), createdAt: dateSchema, finishedAt: dateSchema.nullish()
});
const workflowRuns = z.object({workflow_runs: z.array(z.object({
  id: z.number().int().positive().safe(), run_attempt: z.number().int().positive(), head_sha: shaSchema,
  status: z.string(), conclusion: z.string().nullable(), head_commit: z.object({timestamp: dateSchema}).nullable()
}))});
const readiness = z.object({status:z.literal('ready'), sha:shaSchema.nullable()});

const env = process.env;
const composeId = env.DOKPLOY_METRICS_COMPOSE_ID;
const dokployKey = env.DOKPLOY_METRICS_API_KEY;
const repository = env.GITHUB_METRICS_REPO;
const publicApp = httpsOrigin(env.PUBLIC_APP_URL);
const dokploy = httpsOrigin(env.DOKPLOY_METRICS_URL);
if (!repository || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) throw new Error('invalid_github_repository');

function httpsOrigin(value: string | undefined) {
  if (!value) throw new Error('missing_https_origin');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('invalid_https_origin');
  }
  return url.origin;
}

async function read(url: URL, schema: z.ZodType, headers: Record<string, string> = {}) {
  const response = await fetch(url, {headers, redirect:'error', signal:AbortSignal.timeout(12_000)});
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('release_source_http_' + response.status);
  }
  return schema.parse(await response.json());
}

const db = await createDatabase().initialize();
const shutdown = new AbortController();
process.once('SIGTERM', () => shutdown.abort());
process.once('SIGINT', () => shutdown.abort());

async function saveSource(name: string, status: 'ok'|'unavailable'|'not_configured') {
  await db.query(`
    INSERT INTO deployment_source (name,status,checked_at,last_success_at)
      VALUES ($1,$2,now(),CASE WHEN $2='ok' THEN now() END)
    ON CONFLICT (name) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,
      last_success_at=coalesce(excluded.last_success_at,deployment_source.last_success_at)
  `, [name,status]);
}

async function syncDokploy() {
  if (!dokployKey || !composeId) {
    await saveSource('dokploy','not_configured');
    return false;
  }
  try {
    const url = new URL('/api/deployment.allByCompose', dokploy);
    url.searchParams.set('composeId', composeId);
    const rows = await read(url, z.array(dokployRow), {'x-api-key':dokployKey}) as z.infer<typeof dokployRow>[];
    const cutoff = Date.now() - 32 * 86_400_000;
    const deployments = rows.filter(row => row.composeId === composeId && Date.parse(row.createdAt) >= cutoff).map(row => ({
      id: row.deploymentId, status: row.status, created_at: row.createdAt, finished_at: row.finishedAt ?? null,
      sha: row.description?.match(/^(?:Commit|Hash):\s*([a-f0-9]{40})\s*$/)?.[1] ?? null
    }));
    await db.query(`
      INSERT INTO deployment_observation (id,sha,status,created_at,finished_at)
        SELECT id,sha,status,created_at,finished_at
        FROM jsonb_to_recordset($1::jsonb) AS d(id text,sha text,status text,created_at timestamptz,finished_at timestamptz)
      ON CONFLICT (id) DO UPDATE SET sha=coalesce(excluded.sha,deployment_observation.sha),
        status=excluded.status,finished_at=excluded.finished_at,
        verified_at=CASE WHEN excluded.sha IS NOT NULL AND excluded.sha IS DISTINCT FROM deployment_observation.sha
          THEN NULL ELSE deployment_observation.verified_at END
    `, [JSON.stringify(deployments)]);
    await saveSource('dokploy','ok');
    return true;
  } catch (error) {
    console.warn('Dokploy sync failed', sourceError(error));
    await saveSource('dokploy','unavailable');
    return false;
  }
}

async function syncGitHub() {
  try {
    const url = new URL('/repos/' + repository + '/actions/workflows/ci.yml/runs', 'https://api.github.com');
    url.search = new URLSearchParams({branch:'main',event:'push',per_page:'100'}).toString();
    const token = env.GITHUB_METRICS_API_TOKEN;
    const result = await read(url, workflowRuns, {
      Accept:'application/vnd.github+json', ...(token ? {Authorization:'Bearer ' + token} : {})
    }) as z.infer<typeof workflowRuns>;
    const latest = new Map<string, typeof result.workflow_runs[number]>();
    for (const run of result.workflow_runs) {
      const known = latest.get(run.head_sha);
      if (run.head_commit && (!known || run.id > known.id || run.id === known.id && run.run_attempt > known.run_attempt)) {
        latest.set(run.head_sha,run);
      }
    }
    const records = [...latest.values()].map(run => ({
      sha:run.head_sha, run_id:run.id, attempt:run.run_attempt, status:run.status, conclusion:run.conclusion,
      url:'https://github.com/' + repository + '/actions/runs/' + run.id, commit_at:run.head_commit!.timestamp
    }));
    await db.query(`
      INSERT INTO deployment_ci (sha,run_id,attempt,status,conclusion,url,commit_at)
        SELECT sha,run_id,attempt,status,conclusion,url,commit_at FROM jsonb_to_recordset($1::jsonb)
          AS r(sha text,run_id bigint,attempt integer,status text,conclusion text,url text,commit_at timestamptz)
      ON CONFLICT (sha) DO UPDATE SET run_id=excluded.run_id,attempt=excluded.attempt,status=excluded.status,
        conclusion=excluded.conclusion,url=excluded.url,commit_at=excluded.commit_at
      WHERE (deployment_ci.run_id,deployment_ci.attempt) <= (excluded.run_id,excluded.attempt)
    `, [JSON.stringify(records)]);
    await saveSource('github','ok');
  } catch (error) {
    console.warn('GitHub sync failed', sourceError(error));
    await saveSource('github','unavailable');
  }
}

async function probeHttps() {
  const timeout = AbortSignal.timeout(10_000);
  const [chat, api] = await Promise.all([
    fetch(new URL('/chat',publicApp), {redirect:'error',signal:timeout}).then(async response => {
      const passed = response.ok && response.headers.get('content-type')?.includes('text/html') === true;
      await response.body?.cancel();
      return {status:response.status,passed};
    }).catch(() => ({status:null,passed:false})),
    fetch(new URL('/api/v1/health/deployment',publicApp), {
      redirect:'error',signal:timeout,headers:{'Cache-Control':'no-cache'}
    }).then(async response => {
      if (!response.ok) {
        await response.body?.cancel();
        return {status:response.status,ready:false,sha:null};
      }
      const parsed = readiness.safeParse(await response.json());
      return {status:response.status,ready:parsed.success,sha:parsed.data?.sha ?? null};
    }).catch(() => ({status:null,ready:false,sha:null}))
  ]);
  return {at:new Date(),passed:chat.passed && api.ready,sha:api.sha,chatStatus:chat.status,apiStatus:api.status};
}

async function recordProbe(probe: Awaited<ReturnType<typeof probeHttps>>, freshDeployments: boolean) {
  await db.transaction(async tx => {
    await tx.query(`
      INSERT INTO deployment_https_probe (checked_at,passed,sha,chat_status,api_status)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (checked_at) DO NOTHING
    `, [probe.at,probe.passed,probe.sha,probe.chatStatus,probe.apiStatus]);
    if (freshDeployments && probe.passed && probe.sha) {
      await tx.query(`
        UPDATE deployment_observation SET verified_at=$2
        WHERE id=(SELECT id FROM deployment_observation ORDER BY created_at DESC LIMIT 1)
          AND status='done' AND sha=$1 AND verified_at IS NULL AND finished_at <= $2
      `, [probe.sha,probe.at]);
    }
  });
}

function sourceError(error: unknown) {
  return error instanceof Error && /^release_source_http_\d+$/.test(error.message) ? error.message : 'request or data unavailable';
}

let nextGitHub = 0;
let nextCleanup = 0;
console.log('Release observer started');
try {
  while (!shutdown.signal.aborted) {
    try {
      // Read Dokploy before probing so that a just-completed deployment can be attributed safely.
      const startGitHub = Date.now() >= nextGitHub;
      const github = startGitHub ? syncGitHub() : Promise.resolve();
      if (startGitHub) nextGitHub = Date.now() + 2 * interval;
      await Promise.all([github,syncDokploy().then(async fresh => recordProbe(await probeHttps(),fresh))]);
      if (Date.now() >= nextCleanup) {
        await db.query("DELETE FROM deployment_https_probe WHERE checked_at < now() - interval '32 days'");
        await db.query("DELETE FROM deployment_observation WHERE created_at < now() - interval '32 days'");
        await db.query("DELETE FROM deployment_ci WHERE commit_at < now() - interval '90 days'");
        nextCleanup = Date.now() + 86_400_000;
      }
    } catch (error) {
      console.warn('Release observation failed', sourceError(error));
    }
    await delay(interval, undefined, {signal:shutdown.signal}).catch(() => undefined);
  }
} finally {
  await db.destroy();
}
