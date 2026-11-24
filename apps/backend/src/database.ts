import { PromptReplayEvidence1795260000013, PromptZeroEffectEvidence1795260000014, PromptGoldenEvidence1795260000015, PromptBillingOutageEvidence1795260000019, PromptHandoffContextEvidence1795260000020, PromptPendingProposalEvidence1795260000021, PromptAdjustmentReviewEvidence1795260000022, PromptPrivacyReplayEvidence1795260000023, PromptAuthenticatedHandoffEvidence1795260000024 } from './replay-schema.js';
import { PromptManifest1795260000011 } from './llmops-schema.js';
import { DataSource, type EntityManager, type MigrationInterface, type QueryRunner } from 'typeorm';
import { BoundBootstrapCatalog1795260000003, ContextualKnowledge1795260000017, Knowledge1795260000001 } from './knowledge.js';
import type { AccountInquiry } from './demo-accounts.js';
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

export class Feedback1795260000002 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`CREATE TABLE case_feedback(
      case_id text PRIMARY KEY REFERENCES attention_case(id), score smallint NOT NULL CHECK(score BETWEEN 1 AND 5),
      created_at timestamptz NOT NULL DEFAULT now());`);
  }
  async down(db: QueryRunner) { await db.query('DROP TABLE case_feedback'); }
}

export class SupportPriority1795260000004 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`ALTER TABLE telegram_contact DROP CONSTRAINT telegram_contact_fixture_check;
      ALTER TABLE telegram_contact ADD CHECK (fixture IN ('C-1001', 'C-1004', 'C-1007', 'C-1013'));
      CREATE TABLE support_ticket (
        id text PRIMARY KEY, proposal_id text UNIQUE NOT NULL REFERENCES retention_proposal(id),
        category text NOT NULL, priority text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );`);
  }
  async down(db: QueryRunner) {
    await db.query(`DROP TABLE support_ticket;
      ALTER TABLE telegram_contact DROP CONSTRAINT telegram_contact_fixture_check;
      ALTER TABLE telegram_contact ADD CHECK (fixture IN ('C-1001','C-1004','C-1007'));`);
  }
}

export class WebChat1795260000005 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`CREATE TABLE web_chat_session (
      token_hash text PRIMARY KEY, case_id text NOT NULL UNIQUE REFERENCES attention_case(id),
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX web_chat_expiry ON web_chat_session(expires_at);
    CREATE TABLE prompt_evaluation (
      candidate_revision text PRIMARY KEY REFERENCES prompt_revision(revision),
      base_revision text NOT NULL REFERENCES prompt_revision(revision),
      report jsonb NOT NULL, completed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE web_chat_rate (
      scope text PRIMARY KEY, bucket timestamptz NOT NULL, total integer NOT NULL
    );`);
  }
  async down(db: QueryRunner) { await db.query('DROP TABLE web_chat_rate, web_chat_session, prompt_evaluation'); }
}

export class WebDemoAccount1795260000006 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`CREATE TABLE demo_customer (
      ref text PRIMARY KEY, email text NOT NULL UNIQUE, phone text NOT NULL UNIQUE, profile jsonb NOT NULL
    );
    ALTER TABLE attention_case
      ADD COLUMN account_ref text REFERENCES demo_customer(ref),
      ADD COLUMN account_inquiry text CHECK (account_inquiry IN ('invoice','balance','plans','tickets')),
      ADD COLUMN account_challenge_ref text REFERENCES demo_customer(ref),
      ADD COLUMN account_challenge_id uuid,
      ADD COLUMN account_challenge_expires_at timestamptz;`);
  }
  async down(db: QueryRunner) {
    await db.query(`ALTER TABLE attention_case DROP COLUMN account_challenge_expires_at,
      DROP COLUMN account_challenge_id, DROP COLUMN account_challenge_ref, DROP COLUMN account_inquiry, DROP COLUMN account_ref;
      DROP TABLE demo_customer;`);
  }
}

export class SimulatorIntegration1795260000007 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`
      ALTER TABLE attention_case DROP CONSTRAINT attention_case_account_ref_fkey,
        DROP CONSTRAINT attention_case_account_challenge_ref_fkey;
      CREATE TABLE integration_operation (
        id text PRIMARY KEY, case_id text NOT NULL REFERENCES attention_case(id),
        case_revision integer NOT NULL, customer_ref text NOT NULL,
        advisor text NOT NULL REFERENCES "user"(id), supervisor text REFERENCES "user"(id),
        action jsonb NOT NULL, source_proposal_id text UNIQUE REFERENCES retention_proposal(id),
        status text NOT NULL CHECK (status IN ('queued','pending_supervisor','pending_verification','confirmed','rejected','expired')),
        reference text, failure_code text, started_at timestamptz,
        created_at timestamptz DEFAULT now(), expires_at timestamptz NOT NULL
      );
      CREATE INDEX integration_case_created ON integration_operation(case_id,created_at DESC);
      CREATE INDEX integration_approval ON integration_operation(expires_at) WHERE status='pending_supervisor';
      CREATE TABLE integration_observation (
        service text NOT NULL, minute timestamptz NOT NULL,
        requests integer NOT NULL, errors integer NOT NULL, PRIMARY KEY(service,minute)
      );
    `);
  }
  async down(db: QueryRunner) {
    await db.query('DROP TABLE integration_observation, integration_operation');
    // Accounts already bound to CRM remain valid platform references.
  }
}

export class ConversationalVerification1795260000008 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`ALTER TABLE attention_case DROP CONSTRAINT attention_case_account_inquiry_check,
      ADD CHECK (account_inquiry IN ('invoice','balance','plans','tickets','assistance'))`);
  }
  async down(db: QueryRunner) {
    await db.query(`UPDATE attention_case SET account_inquiry=NULL WHERE account_inquiry='assistance';
      ALTER TABLE attention_case DROP CONSTRAINT attention_case_account_inquiry_check,
      ADD CHECK (account_inquiry IN ('invoice','balance','plans','tickets'))`);
  }
}

export class ReleaseEvidence1795260000009 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`
      CREATE TABLE prompt_eval_job (
        id uuid PRIMARY KEY, revision text NOT NULL REFERENCES prompt_revision(revision),
        status text NOT NULL CHECK(status IN ('queued','running','completed','failed')),
        completed_cases integer NOT NULL DEFAULT 0 CHECK(completed_cases BETWEEN 0 AND 98),
        total_cases integer NOT NULL DEFAULT 98, failure_code text,
        created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
      );
      CREATE UNIQUE INDEX prompt_eval_job_active ON prompt_eval_job(revision) WHERE status IN ('queued','running');
      CREATE INDEX prompt_eval_job_latest ON prompt_eval_job(revision,created_at DESC);
      CREATE TABLE knowledge_publication (
        sha256 text PRIMARY KEY, manifest jsonb NOT NULL, published_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
  async down(db: QueryRunner) {
    await db.query('DROP TABLE knowledge_publication, prompt_eval_job');
  }
}

export class PlatformEvolution1795260000010 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`ALTER TABLE operator_role ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}',
      ADD COLUMN specialties text[] NOT NULL DEFAULT '{}', ADD COLUMN enabled boolean NOT NULL DEFAULT true,
      ADD COLUMN available boolean NOT NULL DEFAULT true;
      UPDATE operator_role SET capabilities=CASE WHEN role='asesor' THEN ARRAY['n1'] ELSE ARRAY['admin','supervisor'] END;
      CREATE TABLE escalation (
        id text PRIMARY KEY, case_id text NOT NULL REFERENCES attention_case(id), destination text NOT NULL,
        reason_code text NOT NULL, status text NOT NULL, requested_by text NOT NULL REFERENCES "user"(id),
        owner_id text REFERENCES "user"(id), idempotency_key text NOT NULL, request_revision integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(requested_by,idempotency_key)
      );
      CREATE UNIQUE INDEX escalation_active_case ON escalation(case_id) WHERE status IN ('en_cola','tomado');`);
  }
  async down(db: QueryRunner) {
    await db.query(`DROP TABLE escalation; ALTER TABLE operator_role DROP COLUMN capabilities, DROP COLUMN specialties, DROP COLUMN enabled, DROP COLUMN available`);
  }
}

export class MlAdvisory1795260000012 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`CREATE TABLE ml_customer_snapshot(customer_ref text NOT NULL, fecha_corte date NOT NULL, synthetic boolean NOT NULL, features jsonb NOT NULL, PRIMARY KEY(customer_ref,fecha_corte));
      CREATE TABLE case_ml_signal(case_id text PRIMARY KEY REFERENCES attention_case(id), intent jsonb, churn jsonb, churn_customer_ref text);
      CREATE TABLE ml_feedback(event_id text PRIMARY KEY, case_id text NOT NULL REFERENCES attention_case(id), kind text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());`);
  }
  async down(db: QueryRunner) { await db.query('DROP TABLE ml_feedback, case_ml_signal, ml_customer_snapshot'); }
}

export class MlAdvisoryTracking1795260000016 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`ALTER TABLE case_ml_signal ADD COLUMN churn_evaluation_revision integer;
      ALTER TABLE ml_feedback ADD COLUMN synchronized_at timestamptz;
      CREATE INDEX ml_intent_feedback_prediction ON ml_feedback ((payload->>'prediction_id'),created_at DESC) WHERE kind='intent';
      CREATE TABLE case_ml_follow_up (
        case_id text NOT NULL REFERENCES attention_case(id), customer_ref text NOT NULL,
        responsible_id text NOT NULL REFERENCES "user"(id), due_date date NOT NULL,
        model_version text NOT NULL, fecha_corte date NOT NULL,
        agreed_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
        PRIMARY KEY(case_id,customer_ref)
      );`);
  }
  async down(db: QueryRunner) {
    await db.query(`DROP TABLE case_ml_follow_up; DROP INDEX ml_intent_feedback_prediction;
      ALTER TABLE ml_feedback DROP COLUMN synchronized_at;
      ALTER TABLE case_ml_signal DROP COLUMN churn_evaluation_revision;`);
  }
}

export class OptionalChatIdentity1795260000018 implements MigrationInterface {
  async up(db:QueryRunner) {
    await db.query(`ALTER TABLE attention_case DROP CONSTRAINT attention_case_account_inquiry_check,
      ADD CONSTRAINT attention_case_account_inquiry_check CHECK (account_inquiry IN ('invoice','balance','plans','tickets','assistance','identify'))`);
  }
  async down(db:QueryRunner) {
    await db.query(`UPDATE attention_case SET account_inquiry=NULL,account_challenge_id=NULL,
      account_challenge_ref=NULL,account_challenge_expires_at=NULL WHERE account_inquiry='identify';
      ALTER TABLE attention_case DROP CONSTRAINT attention_case_account_inquiry_check,
      ADD CONSTRAINT attention_case_account_inquiry_check CHECK (account_inquiry IN ('invoice','balance','plans','tickets','assistance'))`);
  }
}

export class WebChatVisitor1795260000025 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query('ALTER TABLE attention_case ADD COLUMN web_visitor_ref text');
  }
  async down(db: QueryRunner) {
    await db.query('ALTER TABLE attention_case DROP COLUMN web_visitor_ref');
  }
}

export function createDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return new DataSource({
    type: 'postgres', url, migrations: [InitialSchema1795260000000, Knowledge1795260000001, Feedback1795260000002, BoundBootstrapCatalog1795260000003, SupportPriority1795260000004, WebChat1795260000005, WebDemoAccount1795260000006, SimulatorIntegration1795260000007, ConversationalVerification1795260000008, ReleaseEvidence1795260000009, PlatformEvolution1795260000010, PromptManifest1795260000011, MlAdvisory1795260000012, PromptReplayEvidence1795260000013, PromptZeroEffectEvidence1795260000014, PromptGoldenEvidence1795260000015, MlAdvisoryTracking1795260000016, ContextualKnowledge1795260000017, OptionalChatIdentity1795260000018, PromptBillingOutageEvidence1795260000019, PromptHandoffContextEvidence1795260000020, PromptPendingProposalEvidence1795260000021, PromptAdjustmentReviewEvidence1795260000022, PromptPrivacyReplayEvidence1795260000023, PromptAuthenticatedHandoffEvidence1795260000024, WebChatVisitor1795260000025],
    migrationsTableName: 'claro_migrations', synchronize: false
  });
}

export const DATABASE = Symbol('DATABASE');
export type CaseRow = {
  id: string; contact_ref: string; snapshot: CaseSnapshot; handoff_pending: string | null; intent_hint: Intent | null;
  web_visitor_ref?: string | null;
  account_ref?: string | null; account_inquiry?: AccountInquiry | null;
  account_challenge_ref?: string | null; account_challenge_id?: string | null; account_challenge_expires_at?: Date | null;
};
export type ContactRow = { ref: string; chat_id: string | null; display_name: string; direct_owner: string | null; enabled: boolean; fixture: string };
export type DraftPublication = {
  run_id: string; category: Intent; config_revision: string;
  terminal: 'invoice_explained' | 'catalog_answer_published' | 'portability_guidance_published' | 'guidance_published';
  source?: string;
};
export type JobPayloads = {
  run: AgentTurn;
  resume: RunResume;
  deliver: { text: string; sender: 'agente' | 'asesor' | 'sistema'; revision: number; turn_seq?: number; feedback_case_id?: string; draft_publication?: DraftPublication };
  effect: { proposal_id: string };
  integration: { operation_id: string };
  ml: AgentTurn;
  ml_churn: { case_revision: number; customer_ref: string };
  ml_label: { prediction_id: string; label: Intent; event_id: string; advisor_id:string; case_revision:number; turn_id:string };
  eval: { revision: string };
};
export type CaseJob = { [K in keyof JobPayloads]: { id: string; case_id: string; kind: K; payload: JobPayloads[K]; lease_token: string; attempts: number } }[keyof JobPayloads];

export async function audit(db: EntityManager, caseId: string | null, kind: string, metadata = {}) {
  await db.query('INSERT INTO attention_event(case_id,kind,metadata) VALUES ($1,$2,$3)', [caseId, kind, metadata]);
}

export async function enqueue<K extends Exclude<keyof JobPayloads, 'eval'>>(db: EntityManager, id: string, caseId: string, kind: K, payload: JobPayloads[K]) {
  await db.query('INSERT INTO outbox (id,case_id,kind,payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, caseId, kind, payload]);
}
