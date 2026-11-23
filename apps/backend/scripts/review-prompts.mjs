import { readFile } from 'node:fs/promises';
import { createDatabase } from '../dist/database.js';
import { PromptAdjudication, adjudicatePromptRevision } from '../dist/prompt-adjudication.js';

const [candidateId, reviewPath] = process.argv.slice(2);
if (!candidateId || !reviewPath) throw new Error('Usage: quality:review CANDIDATE_ID REVIEW.json');
const review = PromptAdjudication.parse(JSON.parse(await readFile(reviewPath,'utf8')));
const db = await createDatabase().initialize();
try {
  console.log(JSON.stringify(await adjudicatePromptRevision(db,candidateId,review)));
} finally {
  await db.destroy();
}
