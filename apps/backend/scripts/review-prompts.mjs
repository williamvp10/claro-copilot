import { readFile } from 'node:fs/promises';
import { createDatabase } from '../dist/database.js';

const [candidateId, reviewPath] = process.argv.slice(2);
if (!candidateId || !reviewPath) throw new Error('Usage: quality:review CANDIDATE_ID REVIEW.json');
const review = JSON.parse(await readFile(reviewPath,'utf8'));
const db = await createDatabase().initialize();

function evidence(value) {
  return typeof value === 'string' && value.trim().length >= 8 && value.length <= 300;
}

try {
  const result = await db.transaction(async tx => {
    const [record] = await tx.query(`SELECT e.base_revision,e.report,p.activated FROM prompt_evaluation e
      JOIN prompt_revision p ON p.revision=e.candidate_revision WHERE e.candidate_revision=$1 FOR UPDATE OF e`,
    [candidateId]);
    if (!record || record.activated) throw new Error('Only pending revisions with a saved comparison may be reviewed');
    const [active] = await tx.query('SELECT revision FROM prompt_revision WHERE activated');
    if (record.base_revision!==active?.revision) throw new Error('Baseline changed; rerun the comparison');
    if (review.evidence?.golden_sha256!==record.report.evidence.golden_sha256 ||
        review.evidence?.scenarios_sha256!==record.report.evidence.scenarios_sha256 ||
        review.evidence?.corpus_sha256!==record.report.evidence.corpus_sha256) throw new Error('Review and comparison hashes differ');
    const proposed = record.report.proposed;
    const golden = review.golden ?? {}, critical = review.critical ?? {};
    for (const [id,item] of Object.entries(golden)) {
      if (!proposed.questions.some(question=>question.id===id) || typeof item.correct!=='boolean' ||
        typeof item.grounded!=='boolean' || !evidence(item.artifact)) throw new Error('Invalid golden adjudication');
    }
    for (const [id,item] of Object.entries(critical)) {
      if (!proposed.conversations.some(conversation=>conversation.id===id && conversation.critical) ||
        typeof item.passed!=='boolean' || !evidence(item.artifact)) throw new Error('Invalid critical adjudication');
    }
    const matches = proposed.questions.filter(x=>x.score!=='failed' && (golden[x.id]?.correct ?? x.score==='verified_exact')).length;
    const answers = proposed.questions.filter(x=>x.citations.length || golden[x.id]?.grounded===true);
    const grounded = answers.filter(x=>x.score!=='failed' && (golden[x.id]?.grounded ?? x.grounded===true)).length;
    const unresolved = proposed.conversations.filter(x=>x.critical &&
      (!critical[x.id]?.passed || x.steps.some(step=>step.score==='failed'))).length;
    const metrics = { accuracy:matches/proposed.questions.length, groundedness:answers.length?grounded/answers.length:0,
      recall_at_5:proposed.metrics.recall_at_5, unresolved_critical:unresolved };
    const safe = proposed.questions.every(x=>!x.usedPrivateRead&&!x.forbiddenHit)
      && proposed.conversations.every(x=>x.steps.every(step=>!step.usedPrivateRead&&!step.forbiddenHit));
    const passed = safe && record.report.evidence.provider_mode==='live' && metrics.accuracy>=0.8 &&
      metrics.groundedness>=0.85 && metrics.recall_at_5>=0.9 && unresolved===0 && proposed.metrics.remote_generation_cases>0;
    const report = { ...record.report, gate:passed?'passed':'review_required', review:{ metrics,golden,critical, reviewed_at:new Date().toISOString() } };
    await tx.query('UPDATE prompt_evaluation SET report=$2 WHERE candidate_revision=$1',[candidateId,report]);
    return { gate:report.gate, metrics };
  });
  console.log(JSON.stringify(result));
} finally {
  await db.destroy();
}
