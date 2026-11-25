import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DataSource, EntityManager } from 'typeorm';

type PromptSource = 'git_bootstrap' | 'langfuse' | 'legacy_override' | 'platform_candidate';
type PromptDefinition = {
  langfuse_name: string;
  type: 'text';
  data_scope: string;
  variables: string[];
  output_contract: string;
  template: string;
  format?: 'jev_question_json';
  optional?: true;
};
type Step = { id: string; mode: string; prompt_refs: string[] };
type Owner = { id: string; kind: string; steps: Step[]; prompts: Record<string, PromptDefinition> };
type Catalog = {
  schema_version: number;
  bootstrap_revision: string;
  agent: Owner & { subagents: Owner[] };
  evaluation: Owner;
};
type PromptMetadata = {
  name: string;
  version: number | null;
  sha256: string;
  owner: string;
  source: PromptSource;
  variables: string[];
  output_contract: string;
  data_scope: string;
  steps: string[];
};
export type PromptManifest = Record<string, PromptMetadata & { template: string }>;
export type PromptRevisionRow = {
  revision: string;
  base_revision: string | null;
  status: string;
  activated: boolean;
  created_at: Date;
  approved_at: Date | null;
  prompts: Record<string, unknown>;
  manifest: PromptManifest | null;
};
export type RunPromptConfig = {
  revision: string;
  prompts: Record<string, string>;
  prompt_metadata: Record<string, PromptMetadata>;
};

const catalog = JSON.parse(readFileSync(new URL('../../../docs/evolucion-mvp/prompts.claro-copiloto.json', import.meta.url), 'utf8')) as Catalog;
const owners = [catalog.agent, ...catalog.agent.subagents, catalog.evaluation];
const definitions = new Map(owners.flatMap(owner => Object.entries(owner.prompts).map(([key, prompt]) =>
  [key, { ...prompt, owner: owner.id, steps: owner.steps.filter(step => step.prompt_refs.includes(key)).map(step => step.id) }] as const)));
export const promptCatalogRevision = catalog.bootstrap_revision;

export const digestText = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export const manifestDigest = (manifest: PromptManifest) => digestText(JSON.stringify(Object.keys(manifest).sort().map(key => {
  const item = manifest[key]!;
  return [key, item.name, item.version, item.sha256, item.data_scope, item.output_contract, item.variables];
})));

const parameters = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const variableSignature = (text: string) => [...new Set([...text.matchAll(parameters)].map(match => match[1]!))].sort().join(',');
const containsInvalidMarker = (text: string) => /\{\{|\}\}/.test(text.replace(parameters, ''));

export function promptName(key: string) {
  return definitions.get(key)?.langfuse_name;
}

function validJevShape(definition: PromptDefinition, text: string) {
  try {
    const base = JSON.parse(definition.template);
    const value = JSON.parse(text);
    return Object.keys(value).sort().join(',') === 'criteria,instructions'
      && typeof value.instructions === 'string' && !!value.instructions.trim()
      && value.criteria && !Array.isArray(value.criteria) && typeof value.criteria === 'object'
      && Object.keys(value.criteria).sort().join(',') === Object.keys(base.criteria).sort().join(',')
      && Object.values(value.criteria).every(description => typeof description === 'string' && !!description.trim()
        && !/\{\{|\}\}/.test(description));
  } catch {
    return false;
  }
}

export function validPrompt(key: string, text: unknown): text is string {
  const definition = definitions.get(key);
  return !!definition && typeof text === 'string' && !!text.trim() && text.length <= 4000
    && variableSignature(text) === [...definition.variables].sort().join(',')
    && !containsInvalidMarker(text)
    && (definition.format !== 'jev_question_json' || validJevShape(definition, text));
}

export function promptEntry(key: string, template: string, source: PromptSource, version: number | null = null) {
  const definition = definitions.get(key);
  if (!definition || !validPrompt(key, template)) throw new Error('invalid_prompt');
  return {
    name: definition.langfuse_name, version, sha256: digestText(template), owner: definition.owner,
    source, variables: definition.variables, output_contract: definition.output_contract,
    data_scope: definition.data_scope, steps: definition.steps, template
  };
}

export function bootstrapManifest(legacy: Record<string, unknown> = {}): PromptManifest {
  return Object.fromEntries([...definitions].filter(([, definition]) => !definition.optional).map(([key, definition]) => {
    const old = legacy[key];
    // Prior revisions stored a style override for the public writer; preserve it beside the reviewed baseline.
    const inherited = key === 'public_answer' && typeof old === 'string' && old.trim()
      ? definition.template + '\n\nPauta de tono: ' + old.slice(0, 400) : old;
    return [key, validPrompt(key, inherited) ? promptEntry(key, inherited, 'legacy_override')
      : promptEntry(key, definition.template, 'git_bootstrap')];
  }));
}

function intact(key: string, item: PromptManifest[string]) {
  return item && validPrompt(key, item.template) && digestText(item.template) === item.sha256
    && item.name === promptName(key);
}

export function effectiveManifest(row: Pick<PromptRevisionRow, 'prompts' | 'manifest'>): PromptManifest {
  if (!row.manifest) return bootstrapManifest(row.prompts);
  return Object.fromEntries(Object.entries(row.manifest).filter(([key, entry]) => intact(key, entry)));
}

export function hasCompleteManifest(row: Pick<PromptRevisionRow, 'prompts' | 'manifest'>) {
  if (!row.manifest) return false;
  const effective = effectiveManifest(row);
  return Object.keys(row.manifest).length === Object.keys(effective).length
    && [...definitions].every(([key, definition]) => definition.optional || key in effective);
}

export function runPromptConfig(row: Pick<PromptRevisionRow, 'revision' | 'prompts' | 'manifest'>): RunPromptConfig {
  const manifest = effectiveManifest(row);
  const prompts: RunPromptConfig['prompts'] = {};
  const prompt_metadata: RunPromptConfig['prompt_metadata'] = {};
  for (const [key, { template, ...metadata }] of Object.entries(manifest)) {
    prompts[key] = template;
    prompt_metadata[key] = metadata;
  }
  return { revision: row.revision, prompts, prompt_metadata };
}

export function runPromptDigest(config:RunPromptConfig) {
  return digestText(JSON.stringify(Object.entries(config.prompt_metadata).sort(([a],[b])=>a.localeCompare(b))
    .map(([key,value])=>[key,value.version,value.sha256])));
}

export async function readRunPromptConfig(db: DataSource | EntityManager, revision: string, includeTurnBrief=false, assisted=false): Promise<RunPromptConfig> {
  const [row]: PromptRevisionRow[] = await db.query('SELECT revision,prompts,manifest FROM prompt_revision WHERE revision=$1', [revision]);
  if (!row) return { revision, prompts: {}, prompt_metadata: {} };
  const config=runPromptConfig(row);
  const fallbackKeys = [...(includeTurnBrief ? ['conversation_extract','orchestrated_public_answer'] : []),
    ...(assisted ? ['assisted_case_summary','escalation_reason','assisted_reply'] : [])];
  for (const key of fallbackKeys) {
    if (config.prompts[key]) continue;
    const definition=definitions.get(key)!;
    const {template,...metadata}=promptEntry(key,definition.template,'git_bootstrap');
    config.prompts[key]=template;
    config.prompt_metadata[key]=metadata;
  }
  return config;
}

export function presentRevision(row: PromptRevisionRow, base?: PromptRevisionRow) {
  const { prompts, prompt_metadata: manifest } = runPromptConfig(row);
  const previous = base ? effectiveManifest(base) : null;
  return {
    revision: row.revision, base_revision: row.base_revision, status: row.status, activated: row.activated,
    created_at: row.created_at, approved_at: row.approved_at, prompts, manifest,
    changed_keys: previous ? Object.entries(manifest).filter(([key,item]) =>
      previous[key]?.sha256 !== item.sha256 || previous[key]?.version !== item.version).map(([key]) => key) : []
  };
}
