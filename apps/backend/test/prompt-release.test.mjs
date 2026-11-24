import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PromptReleases } from '../dist/prompt-releases.js';
import { bootstrapManifest, digestText, manifestDigest, promptEntry } from '../dist/prompt-catalog.js';
import { runtimeSha256 } from '../dist/runtime-revision.js';

function fixture() {
  const base = {revision:'base',manifest:bootstrapManifest(),prompts:{},activated:true,status:'active',
    approved_at:new Date(),base_revision:null,created_at:new Date()};
  const target = {revision:'candidate',manifest:{...base.manifest,public_answer:promptEntry('public_answer','Respuesta desde las fuentes.','langfuse',3)},
    prompts:{},activated:false,status:'passed',approved_at:null,base_revision:'base',created_at:new Date()};
  const audit = [];
  const report = {gate:'passed',evidence:{provider_mode:'live',runtime_sha256:runtimeSha256,golden_count:30,complementary_count:19,
    corpus_sha256:digestText('[]'),baseline_manifest_sha256:manifestDigest(base.manifest),candidate_manifest_sha256:manifestDigest(target.manifest)},
    proposed:{metrics:{accuracy:0.85,groundedness:0.9,recall_at_5:0.92,unresolved_critical:0,remote_generation_cases:10}}};
  const rows = [base,target];
  const tx = {
    async query(sql,args=[]) {
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return [];
      if (sql.startsWith('SELECT * FROM prompt_revision WHERE activated')) return [rows.find(row=>row.activated)];
      if (sql.startsWith('SELECT * FROM prompt_revision WHERE revision=$1')) return rows.filter(row=>row.revision===args[0]);
      if (sql.startsWith('SELECT id,version,document FROM knowledge_document')) return [];
      if (sql.startsWith('SELECT report FROM prompt_evaluation')) return [{report}];
      if (sql.startsWith('UPDATE prompt_revision SET activated=false')) {
        const row=rows.find(row=>row.revision===args[0]);
        row.activated=false;row.status='passed';
        return [];
      }
      if (sql.startsWith('UPDATE prompt_revision SET activated=true')) {
        const row=rows.find(row=>row.revision===args[0]);
        row.activated=true;row.status='active';row.approved_at??=new Date();
        return [[row],1];
      }
      if (sql.startsWith('INSERT INTO prompt_revision_audit')) { audit.push(args); return []; }
      throw new Error('Unexpected query '+sql);
    }
  };
  return {release:new PromptReleases({transaction:fn=>fn(tx)}),base,target,report,audit};
}

test('activation pins an evaluated manifest and rollback records its previous active revision', async () => {
  const {release,base,target,audit}=fixture();
  const approved=await release.activate('operator',target.revision);
  assert.equal(approved.manifest.public_answer.version,3);
  assert.equal(target.activated,true);
  assert.equal(base.activated,false);
  const restored=await release.activate('operator',base.revision,true);
  assert.equal(restored.manifest.public_answer.source,'git_bootstrap');
  assert.equal(base.activated,true);
  assert.equal(target.activated,false);
  assert.deepEqual(audit.map(row=>[row[0],row[2],row[3]]),[
    ['activated','candidate','base'],['reverted','base','candidate']
  ]);
});

test('a score for other bytes and a rollback to an unpublished candidate are both refused', async () => {
  const {release,base,target,report,audit}=fixture();
  report.evidence.candidate_manifest_sha256=manifestDigest(base.manifest);
  await assert.rejects(release.activate('operator',target.revision),error=>error.getStatus()===403);
  await assert.rejects(release.activate('operator',target.revision,true),error=>error.getStatus()===403);
  assert.equal(base.activated,true);
  assert.deepEqual(audit,[]);
});

test('activating a candidate requires a report for the running build',async()=>{
  for (const runtime of [undefined,'f'.repeat(64)]) {
    const {release,base,target,report,audit}=fixture();
    report.evidence.runtime_sha256=runtime;
    await assert.rejects(release.activate('operator',target.revision),error=>error.getStatus()===403);
    assert.equal(base.activated,true);
    assert.deepEqual(audit,[]);
  }
});
