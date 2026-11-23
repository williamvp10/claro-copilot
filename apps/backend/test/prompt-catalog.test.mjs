import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootstrapManifest, manifestDigest, presentRevision, promptEntry, runPromptConfig, validPrompt } from '../dist/prompt-catalog.js';
import { createLangfusePromptClient } from '../dist/langfuse-prompts.js';

test('an empty historical profile resolves all instructions with its bootstrap source', () => {
  const row = { revision:'agent_cfg_001',status:'active',activated:true,prompts:{},manifest:null };
  const resolved = presentRevision(row);
  assert.equal(Object.keys(resolved.manifest).length, 12);
  assert.equal(resolved.manifest.billing_reply.owner, 'facturacion');
  assert.equal(resolved.manifest.public_answer.source, 'git_bootstrap');
  assert.equal(resolved.manifest.public_answer.version, null);
  assert.ok(resolved.prompts.intent_decision.includes('criter'));
});

test('selection checks pinned template integrity and never resolves by a mutable label', async () => {
  const base = bootstrapManifest();
  const langfuse = promptEntry('public_answer', 'Redacta usando solo evidencia aprobada.', 'langfuse', 7);
  const manifest = { ...base, public_answer:langfuse };
  const row = {revision:'r7',manifest,prompts:{}};
  assert.equal(runPromptConfig(row).prompt_metadata.public_answer.version, 7);
  assert.notEqual(manifestDigest(base), manifestDigest(manifest));
  assert.equal(runPromptConfig({...row,manifest:{...manifest,public_answer:{...langfuse,template:'tampered'}}}).prompts.public_answer, undefined);

  const observed = [];
  const client = createLangfusePromptClient({
    base:'http://127.0.0.1:39085',demo:true,publicKey:'fixture-public',secretKey:'fixture-secret',
    request:async (url, init)=>{
      observed.push([url,init]);
      return Response.json({name:langfuse.name,type:'text',prompt:langfuse.template,version:7});
    }
  });
  assert.equal((await client.get(langfuse.name,{version:7})).prompt, langfuse.template);
  assert.equal(observed[0][0].searchParams.get('version'),'7');
  assert.equal(observed[0][0].searchParams.has('label'),false);
  await assert.rejects(client.get(langfuse.name,{version:6}),/mismatch/);
});

test('candidate preserves variables and Jev decision keys', () => {
  assert.equal(validPrompt('advisor_reply','{{domain_reply}}'),false);
  assert.equal(validPrompt('advisor_reply','{{empathy_sentence}} {{domain_reply}} {{next_step_sentence}}'),true);
  assert.equal(validPrompt('public_answer','{{prompt:foreign}}'),false);
  const original = bootstrapManifest().intent_decision.template;
  const value = JSON.parse(original);
  delete value.criteria.cancelacion;
  assert.equal(validPrompt('intent_decision',JSON.stringify(value)),false);
  assert.equal(validPrompt('intent_decision',original),true);
});
