import { readFile } from 'node:fs/promises';
import { createDatabase } from '../dist/database.js';
import { verifyPlatformReplay } from '../dist/prompt-replay-evidence.js';
const [candidate,scenario,caseId,proposalArg,...rest]=process.argv.slice(2);
const zero=['CC-E03','CC-E10','CC-E12'].includes(scenario);
const marker=rest.indexOf('--scenario-suite');
const suitePath=marker>=0?rest[marker+1]:undefined;
const runIds=marker>=0?rest.slice(0,marker):rest;
if (!candidate || !['CC-E03','CC-E10','CC-E11','CC-E12','CC-E13'].includes(scenario) || !caseId || !proposalArg || !runIds.length || (zero ? proposalArg!=='-' || !suitePath || marker!==rest.length-2 : marker!==-1)) {
 throw Error('Usage: verify-platform-replay CANDIDATE SCENARIO CASE_ID PROPOSAL_ID RUN_ID [RUN_ID]; for CC-E03/E10/E12 use - for PROPOSAL_ID and append --scenario-suite SCENARIOS.jsonl');
}
const db=await createDatabase().initialize();
try { console.log(JSON.stringify(await verifyPlatformReplay(db,{candidate,scenario,caseId,proposalId:zero?undefined:proposalArg,runIds,...(suitePath?{scenarioSuiteText:await readFile(suitePath,'utf8')}:{})}))); }
finally { await db.destroy(); }
