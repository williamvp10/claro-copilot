import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDatabase } from '../dist/database.js';
import { confirmedEffectScenarios, pendingProposalScenario, verifyPlatformReplay, zeroEffectScenarios } from '../dist/prompt-replay-evidence.js';
const [candidate,scenario,caseId,proposalArg,...rest]=process.argv.slice(2);
const zero=zeroEffectScenarios.includes(scenario);
const pending=scenario===pendingProposalScenario;
const privacy=scenario==='CC-E17';
const marker=rest.indexOf('--scenario-suite');
const suitePath=marker>=0?rest[marker+1]:undefined;
const runIds=marker>=0?rest.slice(0,marker):rest;
const privacyArgs=rest.slice(marker+2);
const validOptions=privacy ? privacyArgs.length===4 && privacyArgs[0]==='--canary-source' && privacyArgs[2]==='--trace-dir' &&
  runIds.length===2 && runIds.every(id=>/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) : marker===rest.length-2;
if (!candidate || (!zero && !pending && !confirmedEffectScenarios.includes(scenario)) || !caseId || !proposalArg || !runIds.length ||
    (zero ? proposalArg!=='-' : proposalArg==='-') || (zero || pending ? !suitePath || !validOptions : marker!==-1)) {
 throw Error(`Usage: verify-platform-replay CANDIDATE SCENARIO CASE_ID PROPOSAL_ID RUN_ID [RUN_ID]; ${zeroEffectScenarios.join(', ')} use - and --scenario-suite SCENARIOS.jsonl; ${pendingProposalScenario} uses PROPOSAL_ID and --scenario-suite SCENARIOS.jsonl; CC-E17 adds --canary-source CUSTOMERS.json --trace-dir CAPTURES after --scenario-suite`);
}
const privacyEvidence=privacy ? {
 customerSource:await readFile(privacyArgs[1],'utf8'),
 traceCaptures:Object.fromEntries(await Promise.all(runIds.map(async id=>[id,await readFile(join(privacyArgs[3],id+'.json'),'utf8')]))),
} : {};
const db=await createDatabase().initialize();
try { console.log(JSON.stringify(await verifyPlatformReplay(db,{candidate,scenario,caseId,proposalId:zero?undefined:proposalArg,runIds,
 ...(suitePath?{scenarioSuiteText:await readFile(suitePath,'utf8')}:{}),...privacyEvidence}))); }
finally { await db.destroy(); }
