import { readFile } from 'node:fs/promises';
import { createDatabase } from '../dist/database.js';
import { verifyGoldenPlatform } from '../dist/golden-platform-evidence.js';
const [candidate,goldenId,caseId,runId,goldenPath,proposalId]=process.argv.slice(2);
if (!candidate || !['GQ-25','GQ-26','GQ-27','GQ-28'].includes(goldenId) || !caseId || !runId || !goldenPath || (goldenId==='GQ-28'?!proposalId:!!proposalId)) throw Error('Usage: verify-golden-platform CANDIDATE GQ-25|GQ-26|GQ-27|GQ-28 CASE_ID RUN_ID GOLDEN.jsonl [PROPOSAL_ID for GQ-28]');
const db=await createDatabase().initialize();
try { console.log(JSON.stringify(await verifyGoldenPlatform(db,{candidate,goldenId,caseId,runId,goldenSuiteText:await readFile(goldenPath,'utf8'),proposalId}))); }
finally { await db.destroy(); }
