import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PromptReplayEvidence1795260000013, PromptZeroEffectEvidence1795260000014 } from '../src/replay-schema.ts';
const connectionString=process.env.REPLAY_SCHEMA_TEST_DATABASE_URL;
test('replay migration preserves effect references and constrains zero-effect proofs', {skip:!connectionString}, async()=>{
 const client=new pg.Client({connectionString});await client.connect();
 try {
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE prompt_revision(revision text PRIMARY KEY); CREATE TEMP TABLE attention_case(id text PRIMARY KEY); CREATE TEMP TABLE retention_proposal(id text PRIMARY KEY); CREATE TEMP TABLE integration_operation(id text PRIMARY KEY);
  INSERT INTO prompt_revision VALUES ('candidate'); INSERT INTO attention_case VALUES ('case'); INSERT INTO retention_proposal VALUES ('p'); INSERT INTO integration_operation VALUES ('o');`);
  // PostgreSQL cannot create a permanent table referencing temporary tables, so isolate the new table in pg_temp too.
  const runner={query:(sql)=>client.query(sql.replace('CREATE TABLE prompt_platform_evidence','CREATE TEMP TABLE prompt_platform_evidence'))};
  await new PromptReplayEvidence1795260000013().up(runner);
  await client.query(`INSERT INTO prompt_platform_evidence VALUES ('candidate','CC-E11','old','case','[]','p','o','{}',now())`);
  await new PromptZeroEffectEvidence1795260000014().up(runner);
  const [old]= (await client.query("SELECT proof_kind FROM prompt_platform_evidence WHERE report_fingerprint='old'")).rows;
  assert.equal(old.proof_kind,'confirmed_effect');
  await client.query(`INSERT INTO prompt_platform_evidence(candidate_revision,scenario_id,report_fingerprint,case_id,run_ids,proposal_id,operation_id,evidence,proof_kind) VALUES ('candidate','CC-E03','new','case','[]',NULL,NULL,'{}','zero_effect')`);
  for(const [scenario,kind,proposal,operation] of [['CC-E11','zero_effect',null,null],['CC-E03','confirmed_effect','p','o'],['CC-E12','zero_effect','p',null],['CC-E13','confirmed_effect',null,'o']]) {
   await client.query('SAVEPOINT bad');
   await assert.rejects(client.query(`INSERT INTO prompt_platform_evidence(candidate_revision,scenario_id,report_fingerprint,case_id,run_ids,proposal_id,operation_id,evidence,proof_kind) VALUES ('candidate',$1,$2,'case','[]',$3,$4,'{}',$5)`,[scenario,`${scenario}-${kind}`,proposal,operation,kind]));
   await client.query('ROLLBACK TO SAVEPOINT bad');
  }
  await client.query('SAVEPOINT rollback_check');
  await assert.rejects(new PromptZeroEffectEvidence1795260000014().down(runner));
  await client.query('ROLLBACK TO SAVEPOINT rollback_check');
  assert.equal(Number((await client.query("SELECT count(*) AS n FROM prompt_platform_evidence WHERE proof_kind='zero_effect'")).rows[0].n),1);
 } finally { await client.query('ROLLBACK').catch(()=>{});await client.end(); }
});
