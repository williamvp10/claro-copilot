import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { createDatabase } from '../dist/database.js';

const directory = process.env.PROMPT_EVAL_INPUT_DIR || '/eval-input';
const golden = join(directory,'golden_dataset.jsonl');
const scenarios = join(directory,'evals_atencion.jsonl');
const script = fileURLToPath(new URL('compare-prompts.mjs', import.meta.url));
const db = await createDatabase().initialize();
let stopping = false;
let child;
for (const signal of ['SIGTERM','SIGINT']) process.once(signal,() => {
  stopping = true;
  child?.kill();
});

async function run(job, report) {
  // Keep provider output private. Only summaries and case IDs are projected by NestJS.
  const result = await new Promise(resolve => {
    child = spawn(process.execPath,[script,golden,scenarios,job.revision,report],{
      env:{...process.env, PROMPT_EVAL_JOB_ID:job.id}, stdio:'ignore',signal:AbortSignal.timeout(14*60_000)
    });
    child.once('error',() => resolve(false));
    child.once('close',code => resolve(code===0));
  });
  child = undefined;
  return result;
}

try {
  while (!stopping) {
    const job = await db.transaction(async tx => {
      // Claim a single job across replicas and recover a process that never finished.
      if (!(await tx.query("SELECT pg_try_advisory_xact_lock(hashtext('prompt-eval-claim')) AS locked"))[0].locked) return;
      await tx.query(`UPDATE prompt_eval_job SET status='failed',failure_code='worker_interrupted',finished_at=now()
        WHERE status='running' AND started_at < now()-interval '16 minutes'`);
      if ((await tx.query("SELECT 1 FROM prompt_eval_job WHERE status='running' LIMIT 1")).length) return;
      const [next] = await tx.query("SELECT id,revision FROM prompt_eval_job WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED");
      if (next) await tx.query("UPDATE prompt_eval_job SET status='running',started_at=now() WHERE id=$1",[next.id]);
      return next;
    });
    if (!job) {
      await wait(500);
      continue;
    }
    const work = await mkdtemp(join(tmpdir(),'claro-eval-'));
    try {
      const reportPath = join(work,randomUUID()+'.json');
      if (!await run(job,reportPath)) throw new Error('runner_failed');
      const report = JSON.parse(await readFile(reportPath,'utf8'));
      await db.transaction(async tx => {
        await tx.query("UPDATE prompt_eval_job SET status='completed',finished_at=now() WHERE id=$1 AND status='running'",[job.id]);
        await tx.query("UPDATE prompt_revision SET status=$2 WHERE revision=$1 AND NOT activated",[job.revision,report.gate==='passed'?'passed':'candidate']);
      });
    } catch {
      await db.query("UPDATE prompt_eval_job SET status='failed',failure_code='runner_failed',finished_at=now() WHERE id=$1 AND status='running'",[job.id]);
    } finally {
      await rm(work,{recursive:true,force:true});
    }
  }
} finally {
  await db.destroy();
}
