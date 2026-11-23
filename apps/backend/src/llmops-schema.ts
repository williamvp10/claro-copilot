import type { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrapManifest } from './prompt-catalog.js';

export class PromptManifest1795260000011 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`ALTER TABLE prompt_revision ADD COLUMN manifest jsonb, ADD COLUMN approved_at timestamptz;
      UPDATE prompt_revision SET approved_at=created_at WHERE activated;
      CREATE TABLE release_metric (
        digest text NOT NULL, component text NOT NULL, sha text NOT NULL, evidence jsonb NOT NULL,
        operator_id text NOT NULL REFERENCES "user"(id), observed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(digest,component,sha)
      );
      CREATE TABLE draft_event (
        event_id text PRIMARY KEY, case_id text NOT NULL REFERENCES attention_case(id),
        run_id text NOT NULL REFERENCES agent_run(id), operator_id text NOT NULL REFERENCES "user"(id),
        kind text NOT NULL CHECK(kind IN ('used','edited','sent','feedback_positive','feedback_negative')),
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(case_id,run_id,operator_id,kind)
      );
      CREATE UNIQUE INDEX draft_single_feedback ON draft_event(case_id,run_id,operator_id)
        WHERE kind IN ('feedback_positive','feedback_negative');
      CREATE TABLE prompt_revision_audit (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        action text NOT NULL CHECK(action IN ('created','imported','reviewed','activated','reverted')),
        operator_id text NOT NULL REFERENCES "user"(id),
        revision text NOT NULL REFERENCES prompt_revision(revision),
        from_revision text REFERENCES prompt_revision(revision),
        changes jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now()
      );`);
    const rows: { revision: string; prompts: Record<string, unknown> }[] =
      await db.query('SELECT revision,prompts FROM prompt_revision');
    for (const row of rows) {
      await db.query('UPDATE prompt_revision SET manifest=$2 WHERE revision=$1', [row.revision, bootstrapManifest(row.prompts)]);
    }
  }

  async down(db: QueryRunner) {
    await db.query(`DROP TABLE prompt_revision_audit, release_metric, draft_event;
      ALTER TABLE prompt_revision DROP COLUMN manifest, DROP COLUMN approved_at;`);
  }
}
