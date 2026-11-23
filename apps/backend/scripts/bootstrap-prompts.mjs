import { bootstrapManifest, digestText, promptCatalogRevision } from '../dist/prompt-catalog.js';
import { langfusePromptClient } from '../dist/langfuse-prompts.js';

const client = langfusePromptClient();
if (!client) throw new Error('Configure the Langfuse project before bootstrapping prompts');
const revisions = [];
for (const [key, prompt] of Object.entries(bootstrapManifest())) {
  let existing = await client.get(prompt.name, { label: 'bootstrap' });
  if (!existing || digestText(existing.prompt) !== prompt.sha256) {
    existing = await client.create(prompt.name, prompt.template, 'bootstrap');
  }
  revisions.push({ key, name: existing.name, version: existing.version, sha256: prompt.sha256 });
}
console.log(JSON.stringify({ catalog: promptCatalogRevision, versions: revisions }, null, 2));
