import { createHash } from 'node:crypto';
import { AgentModelPolicy, initialAgentModelPolicy, localLlamaModel, ModelStep, type AgentModelRevision, type ModelValidation } from '@claro/contracts';
import type { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { probeModel } from './agent-providers.js';

export const initialModelRevision = 'agent-models-v1';

function canonical(value:unknown):unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value==='object') return Object.fromEntries(
    Object.entries(value).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>[key,canonical(item)]));
  return value;
}

export function agentModelDigest(policy:AgentModelPolicy) {
  return createHash('sha256').update(JSON.stringify(canonical(policy))).digest('hex');
}

export async function activeAgentModels(db:Pick<DataSource,'query'>) {
  const [current]=await db.query(`SELECT r.revision,r.digest FROM agent_model_config_active a
    JOIN agent_model_config_revision r USING(revision) WHERE a.singleton`);
  if (!current) throw new Error('No active agent model policy');
  return current as Pick<AgentModelRevision,'revision'|'digest'>;
}

export async function loadAgentModelPolicy(db:Pick<DataSource,'query'>, revision:string, digest?:string) {
  const [row]=await db.query('SELECT policy,digest FROM agent_model_config_revision WHERE revision=$1',[revision]);
  if (!row) throw new Error('Unknown agent model policy');
  const policy=AgentModelPolicy.parse(row.policy);
  if (agentModelDigest(policy)!==row.digest || (digest!==undefined && digest!==row.digest)) throw new Error('Agent model policy digest mismatch');
  return policy;
}

type RevisionRow=Omit<AgentModelRevision,'created_at'|'validation'> & {created_at:Date;validation:ModelValidation|null};
export function modelRevision(row:RevisionRow):AgentModelRevision {
  return {...row,policy:AgentModelPolicy.parse(row.policy),created_at:row.created_at.toISOString()};
}

export async function initializeLocalModelPolicy(db:DataSource, key:string) {
  const revision = 'agent-models-lmstudio-llama-v1';
  const [existing] = await db.query('SELECT revision FROM agent_model_config_revision WHERE revision=$1',[revision]);
  const active = await activeAgentModels(db);
  if (existing || active.revision !== initialModelRevision) return;
  const failure = await probeModel(localLlamaModel,key,{max_output_tokens:128});
  if (failure) throw new Error(`LM Studio structured output check failed (${failure})`);

  const policy = AgentModelPolicy.parse({
    ...initialAgentModelPolicy,
    max_call_ms:10000,
    steps:Object.fromEntries(ModelStep.options.map(step=>[step,{mode:'fixed',model:localLlamaModel.id}]))
  });
  const digest = agentModelDigest(policy);
  await db.transaction(async tx=>{
    const [current] = await tx.query('SELECT revision FROM agent_model_config_active WHERE singleton FOR UPDATE');
    const [created] = await tx.query('SELECT revision FROM agent_model_config_revision WHERE revision=$1',[revision]);
    if (created || current.revision !== initialModelRevision) return;
    await tx.query(`INSERT INTO agent_model_config_revision(revision,base_revision,digest,policy,created_by,reason)
      VALUES($1,$2,$3,$4,'bootstrap','Modelo local para el demo')`,[revision,initialModelRevision,digest,policy]);
    await tx.query('INSERT INTO agent_model_config_validation(revision,report) VALUES($1,$2)',
      [revision,{digest,checked_at:new Date().toISOString(),issues:[]}]);
    await tx.query('UPDATE agent_model_config_active SET revision=$1 WHERE singleton',[revision]);
    await tx.query(`INSERT INTO agent_model_config_event(kind,revision,previous_revision,operator_id,reason,evidence)
      VALUES('activate',$1,$2,'bootstrap','Modelo local para el demo','Respuesta JSON de LM Studio validada')`,
      [revision,initialModelRevision]);
  });
}

export class AgentModelPolicy1795260000026 implements MigrationInterface {
  async up(db:QueryRunner) {
    await db.query(`
      CREATE TABLE agent_model_config_revision (
        revision text PRIMARY KEY,
        base_revision text REFERENCES agent_model_config_revision(revision),
        digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
        policy jsonb NOT NULL, created_by text NOT NULL, reason text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE agent_model_config_validation (
        revision text PRIMARY KEY REFERENCES agent_model_config_revision(revision),
        report jsonb NOT NULL
      );
      CREATE TABLE agent_model_config_active (
        singleton boolean PRIMARY KEY CHECK(singleton),
        revision text NOT NULL REFERENCES agent_model_config_revision(revision)
      );
      CREATE TABLE agent_model_config_event (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, kind text NOT NULL,
        revision text NOT NULL REFERENCES agent_model_config_revision(revision),
        previous_revision text REFERENCES agent_model_config_revision(revision),
        operator_id text NOT NULL, reason text NOT NULL, evidence text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE FUNCTION agent_model_config_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Model policy snapshots are immutable'; END;
      $$;
      CREATE TRIGGER agent_model_config_immutable BEFORE UPDATE OR DELETE ON agent_model_config_revision
        FOR EACH ROW EXECUTE FUNCTION agent_model_config_immutable();
    `);
    await db.query(`INSERT INTO agent_model_config_revision(revision,digest,policy,created_by,reason)
      VALUES($1,$2,$3,'bootstrap','Política inicial de OpenAI directo')`,
    [initialModelRevision,agentModelDigest(initialAgentModelPolicy),initialAgentModelPolicy]);
    await db.query('INSERT INTO agent_model_config_active VALUES (true,$1)',[initialModelRevision]);
  }

  async down(db:QueryRunner) {
    await db.query('DROP TABLE agent_model_config_event,agent_model_config_active,agent_model_config_validation,agent_model_config_revision; DROP FUNCTION agent_model_config_immutable()');
  }
}
