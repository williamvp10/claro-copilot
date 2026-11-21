import { DataSource, type EntityManager, type MigrationInterface, type QueryRunner } from 'typeorm';
import { Knowledge1795260000001 } from './knowledge.js';
import type { AgentTurn, CaseSnapshot, Intent, RunResume } from '@claro/contracts';

export class InitialSchema1795260000000 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`
      CREATE TABLE "user" (
        id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
        "emailVerified" boolean NOT NULL DEFAULT false, image text,
        "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
      );
      CREATE TABLE session (
        id text PRIMARY KEY, token text UNIQUE NOT NULL, "expiresAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
        "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
      );
      CREATE INDEX session_user_idx ON session("userId");
      CREATE TABLE account (
        id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
        "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz,
        "refreshTokenExpiresAt" timestamptz, scope text, password text,
        "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
      );
      CREATE INDEX account_user_idx ON account("userId");
      CREATE TABLE verification (
        id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
        "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
      );
      CREATE INDEX verification_identifier_idx ON verification(identifier);
      CREATE TABLE operator_role (user_id text PRIMARY KEY REFERENCES "user"(id), role text NOT NULL CHECK (role IN ('asesor', 'admin')));
      CREATE TABLE attention_case (
        id text PRIMARY KEY, contact_ref text NOT NULL, snapshot jsonb NOT NULL,
        handoff_pending text, intent_hint text, created_at timestamptz NOT NULL DEFAULT now(), resolved boolean
      );
      CREATE UNIQUE INDEX active_contact ON attention_case(contact_ref) WHERE (snapshot->>'status') = 'open';
      CREATE TABLE telegram_contact (
        ref text PRIMARY KEY, chat_id text UNIQUE, display_name text NOT NULL,
        direct_owner text REFERENCES "user"(id), enabled boolean NOT NULL DEFAULT true,
        fixture text NOT NULL CHECK (fixture IN ('C-1001', 'C-1004', 'C-1007'))
      );
      CREATE TABLE idempotency (
        scope text NOT NULL, key text NOT NULL, fingerprint text NOT NULL,
        case_id text NOT NULL, PRIMARY KEY (scope, key)
      );
      CREATE TABLE agent_run (id text PRIMARY KEY, case_id text NOT NULL REFERENCES attention_case(id), turn jsonb NOT NULL);
      CREATE TABLE outbox (
        id text PRIMARY KEY, case_id text NOT NULL REFERENCES attention_case(id), kind text NOT NULL,
        payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued',
        created_at timestamptz NOT NULL DEFAULT now(), available_at timestamptz NOT NULL DEFAULT now(),
        lease_until timestamptz, lease_token text, attempts integer NOT NULL DEFAULT 0, error_code text
      );
      CREATE INDEX outbox_pending_idx ON outbox (available_at, created_at) WHERE status IN ('queued', 'processing');
      CREATE TABLE retention_proposal (
        id text PRIMARY KEY, case_id text NOT NULL REFERENCES attention_case(id),
        run_id text NOT NULL REFERENCES agent_run(id), case_revision integer NOT NULL,
        option_id text NOT NULL, proposal jsonb NOT NULL, expires_at timestamptz NOT NULL,
        UNIQUE (case_id, case_revision, option_id)
      );
      CREATE TABLE agent_checkpoint (id text PRIMARY KEY, result jsonb NOT NULL);
      CREATE TABLE message_dispatch (id text PRIMARY KEY, dispatched_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE crm_effect (
        id text PRIMARY KEY, proposal_id text UNIQUE NOT NULL REFERENCES retention_proposal(id),
        confirmed_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE attention_event (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, case_id text REFERENCES attention_case(id),
        kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), metadata jsonb NOT NULL DEFAULT '{}'
      );
      CREATE INDEX attention_event_kind_time ON attention_event(kind, created_at);
      CREATE TABLE prompt_revision (
        revision text PRIMARY KEY, base_revision text, prompts jsonb NOT NULL,
        status text NOT NULL, activated boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX one_active_revision ON prompt_revision (activated) WHERE activated;
      INSERT INTO prompt_revision (revision, prompts, status, activated) VALUES ('agent_cfg_001', '{}', 'active', true);
    `);
  }

  async down(db: QueryRunner) {
    await db.query(`DROP TABLE prompt_revision, attention_event, crm_effect, message_dispatch, agent_checkpoint, retention_proposal,
      outbox, agent_run, idempotency, telegram_contact, attention_case, operator_role,
      verification, account, session, "user"`);
  }
}

export function createDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return new DataSource({
    type: 'postgres', url, migrations: [InitialSchema1795260000000, Knowledge1795260000001],
    migrationsTableName: 'claro_migrations', synchronize: false
  });
}

export const DATABASE = Symbol('DATABASE');
export type CaseRow = { id: string; contact_ref: string; snapshot: CaseSnapshot; handoff_pending: string | null; intent_hint: Intent | null };
export type ContactRow = { ref: string; chat_id: string | null; display_name: string; direct_owner: string | null; enabled: boolean; fixture: string };
export type JobPayloads = {
  run: AgentTurn;
  resume: RunResume;
  deliver: { text: string; sender: 'agente' | 'asesor'; revision: number; turn_seq?: number };
  effect: { proposal_id: string };
  ml: AgentTurn;
  eval: { revision: string };
};
export type CaseJob = { [K in keyof JobPayloads]: { id: string; case_id: string; kind: K; payload: JobPayloads[K]; lease_token: string; attempts: number } }[keyof JobPayloads];

export async function audit(db: EntityManager, caseId: string | null, kind: string, metadata = {}) {
  await db.query('INSERT INTO attention_event(case_id,kind,metadata) VALUES ($1,$2,$3)', [caseId, kind, metadata]);
}

export async function enqueue<K extends Exclude<keyof JobPayloads, 'eval'>>(db: EntityManager, id: string, caseId: string, kind: K, payload: JobPayloads[K]) {
  await db.query('INSERT INTO outbox (id,case_id,kind,payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, caseId, kind, payload]);
}
