import type { MigrationInterface, QueryRunner } from 'typeorm';
/** Evidence is written only by the local replay verifier after it reads platform state. */
export class PromptReplayEvidence1795260000013 implements MigrationInterface {
 async up(db:QueryRunner) { await db.query(`CREATE TABLE prompt_platform_evidence (
  candidate_revision text NOT NULL REFERENCES prompt_revision(revision), scenario_id text NOT NULL,
  report_fingerprint text NOT NULL, case_id text NOT NULL REFERENCES attention_case(id), run_ids jsonb NOT NULL,
  proposal_id text NOT NULL REFERENCES retention_proposal(id), operation_id text NOT NULL REFERENCES integration_operation(id),
  evidence jsonb NOT NULL, verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(candidate_revision,scenario_id,report_fingerprint)
 )`); }
 async down(db:QueryRunner) { await db.query('DROP TABLE prompt_platform_evidence'); }
}

/** Zero-effect replays have no proposal or operation; effect proofs retain both foreign keys. */
export class PromptZeroEffectEvidence1795260000014 implements MigrationInterface {
 async up(db:QueryRunner) {
  await db.query(`ALTER TABLE prompt_platform_evidence
   ALTER COLUMN proposal_id DROP NOT NULL,
   ALTER COLUMN operation_id DROP NOT NULL,
   ADD COLUMN proof_kind text;
   UPDATE prompt_platform_evidence SET proof_kind='confirmed_effect';
   ALTER TABLE prompt_platform_evidence ALTER COLUMN proof_kind SET NOT NULL,
   ADD CONSTRAINT prompt_platform_evidence_kind_check CHECK (
     (proof_kind='confirmed_effect' AND scenario_id IN ('CC-E11','CC-E13') AND proposal_id IS NOT NULL AND operation_id IS NOT NULL)
     OR (proof_kind='zero_effect' AND scenario_id IN ('CC-E03','CC-E10','CC-E12') AND proposal_id IS NULL AND operation_id IS NULL)
   )`);
 }
 async down(db:QueryRunner) {
  // A rollback with zero-effect records is deliberately rejected instead of deleting evidence.
  await db.query(`ALTER TABLE prompt_platform_evidence DROP CONSTRAINT prompt_platform_evidence_kind_check,
   ALTER COLUMN proposal_id SET NOT NULL, ALTER COLUMN operation_id SET NOT NULL, DROP COLUMN proof_kind`);
 }
}

/** Golden account proofs are distinct from conversational critical-case proofs. */
export class PromptGoldenEvidence1795260000015 implements MigrationInterface {
 async up(db:QueryRunner) { await db.query(`CREATE TABLE prompt_golden_evidence (
  candidate_revision text NOT NULL REFERENCES prompt_revision(revision), golden_id text NOT NULL CHECK(golden_id IN ('GQ-25','GQ-26','GQ-27','GQ-28')),
  report_fingerprint text NOT NULL, case_id text NOT NULL REFERENCES attention_case(id), run_id text NOT NULL REFERENCES agent_run(id),
  proposal_id text REFERENCES retention_proposal(id), operation_id text REFERENCES integration_operation(id),
  evidence jsonb NOT NULL, verified_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((golden_id='GQ-28' AND proposal_id IS NOT NULL AND operation_id IS NOT NULL) OR
         (golden_id<>'GQ-28' AND proposal_id IS NULL AND operation_id IS NULL)),
  PRIMARY KEY(candidate_revision,golden_id,report_fingerprint)
 )`); }
 async down(db:QueryRunner) { await db.query('DROP TABLE prompt_golden_evidence'); }
}
