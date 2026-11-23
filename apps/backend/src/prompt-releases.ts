import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
  ServiceUnavailableException, Inject
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { DATABASE } from './database.js';
import { langfusePromptClient } from './langfuse-prompts.js';
import {
  digestText, effectiveManifest, hasCompleteManifest, manifestDigest, presentRevision, promptEntry, promptName, validPrompt,
  type PromptManifest, type PromptRevisionRow
} from './prompt-catalog.js';

export async function lockPromptReleases(db: EntityManager) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('claro-prompt-release'))");
}

@Injectable()
export class PromptReleases {
  constructor(@Inject(DATABASE) private readonly db: DataSource) {}

  async list() {
    const rows: PromptRevisionRow[] = await this.db.query(`SELECT * FROM prompt_revision
      ORDER BY activated DESC,created_at DESC LIMIT 50`);
    const baseIds = [...new Set(rows.map(row => row.base_revision).filter(Boolean))];
    const bases: PromptRevisionRow[] = baseIds.length ? await this.db.query(
      'SELECT * FROM prompt_revision WHERE revision=ANY($1::text[])', [baseIds]
    ) : [];
    const lookup = new Map(bases.map(base => [base.revision, base]));
    return rows.map(row => presentRevision(row, lookup.get(row.base_revision ?? '')));
  }

  async edit(operator: string, updates: Record<string,string>) {
    for (const [key, template] of Object.entries(updates)) {
      if (!validPrompt(key, template)) throw new BadRequestException('La plantilla o sus variables no coinciden con el catálogo: ' + key);
    }
    const active = await this.active();
    const current = effectiveManifest(active);
    const entries = Object.entries(updates).filter(([key, template]) => current[key]?.template !== template);
    if (!entries.length) throw new BadRequestException('La plantilla coincide con la revisión activa');
    const changed: PromptManifest = {};
    try {
      const client = langfusePromptClient();
      for (const [key, template] of entries) {
        const remote = client ? await client.create(promptName(key)!, template) : null;
        changed[key] = promptEntry(key, template, remote ? 'langfuse' : 'platform_candidate', remote?.version);
      }
    } catch {
      throw new ServiceUnavailableException('No se pudo guardar la versión en Langfuse');
    }
    return this.create(operator, active, changed, 'created');
  }

  async import(operator: string, key: string, version: number) {
    const name = promptName(key);
    if (!name) throw new BadRequestException('Plantilla desconocida');
    const active = await this.active();
    let remote;
    try {
      const client = langfusePromptClient();
      if (!client) throw new Error('langfuse_not_configured');
      remote = await client.get(name, { version });
    } catch {
      throw new ServiceUnavailableException('No se pudo consultar la versión en Langfuse');
    }
    if (!remote) throw new NotFoundException('Versión de Langfuse no encontrada');
    if (!validPrompt(key, remote.prompt)) {
      throw new BadRequestException('La plantilla de Langfuse no coincide con el contrato del catálogo');
    }
    const current = effectiveManifest(active)[key];
    if (current?.source === 'langfuse' && current.version === version) throw new ConflictException('La versión ya está activa');
    return this.create(operator, active, { [key]: promptEntry(key, remote.prompt, 'langfuse', version) }, 'imported');
  }

  async activate(operator: string, revision: string, rollback = false) {
    return this.db.transaction(async tx => {
      await lockPromptReleases(tx);
      const [active]: PromptRevisionRow[] = await tx.query('SELECT * FROM prompt_revision WHERE activated FOR UPDATE');
      const [target]: PromptRevisionRow[] = await tx.query('SELECT * FROM prompt_revision WHERE revision=$1 FOR UPDATE', [revision]);
      if (!target) throw new NotFoundException('Revisión no encontrada');
      if (!active || active.revision === target.revision) throw new ConflictException('La revisión ya está activa');
      if (!hasCompleteManifest(target)) {
        throw new ConflictException('El manifiesto de prompts no supera la comprobación de integridad');
      }
      if (rollback) {
        if (!target.approved_at) throw new ForbiddenException('Seleccione una revisión aprobada y activada con anterioridad');
      } else {
        await this.assertGate(tx, active, target);
      }
      await tx.query("UPDATE prompt_revision SET activated=false,status='passed' WHERE revision=$1", [active.revision]);
      const [[updated]] = await tx.query(`UPDATE prompt_revision SET activated=true,status='active',
        approved_at=COALESCE(approved_at,now()) WHERE revision=$1 RETURNING *`, [revision]);
      const projection = presentRevision(updated, target.base_revision === active.revision ? active : undefined);
      await tx.query(`INSERT INTO prompt_revision_audit(action,operator_id,revision,from_revision,changes)
        VALUES($1,$2,$3,$4,$5)`, [rollback ? 'reverted' : 'activated', operator, revision, active.revision,
        JSON.stringify(Object.keys(effectiveManifest(updated)).filter(key =>
          effectiveManifest(active)[key]?.sha256 !== effectiveManifest(updated)[key]?.sha256 ||
          effectiveManifest(active)[key]?.version !== effectiveManifest(updated)[key]?.version))]);
      return projection;
    });
  }

  private async active() {
    const [row]: PromptRevisionRow[] = await this.db.query('SELECT * FROM prompt_revision WHERE activated');
    if (!row) throw new ServiceUnavailableException('Catálogo de prompts indisponible');
    return row;
  }

  private async create(operator: string, base: PromptRevisionRow, change: PromptManifest, action: 'created' | 'imported') {
    return this.db.transaction(async tx => {
      await lockPromptReleases(tx);
      const [active] = await tx.query('SELECT revision FROM prompt_revision WHERE activated');
      if (active?.revision !== base.revision) throw new ConflictException('Cambió la revisión activa. Vuelve a abrir el catálogo.');
      const manifest = { ...effectiveManifest(base), ...change };
      if (!hasCompleteManifest({ prompts:{}, manifest })) {
        throw new ConflictException('La candidata no contiene todas las plantillas requeridas');
      }
      const [candidate]: PromptRevisionRow[] = await tx.query(`INSERT INTO prompt_revision(revision,base_revision,prompts,manifest,status)
        VALUES($1,$2,$3,$4,'candidate') RETURNING *`, [randomUUID(), base.revision, {}, manifest]);
      if (!candidate) throw new Error('candidate_insert_failed');
      await tx.query(`INSERT INTO prompt_revision_audit(action,operator_id,revision,from_revision,changes)
        VALUES($1,$2,$3,$4,$5)`, [action, operator, candidate.revision, base.revision, JSON.stringify(Object.keys(change))]);
      return presentRevision(candidate, base);
    });
  }

  private async assertGate(tx: EntityManager, active: PromptRevisionRow, target: PromptRevisionRow) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('knowledge-publication'))");
    const [version] = await tx.query(`SELECT report FROM prompt_evaluation WHERE candidate_revision=$1 AND base_revision=$2
      AND report->>'gate'='passed' AND NOT EXISTS (
        SELECT 1 FROM prompt_eval_job WHERE revision=$1 AND status IN ('queued','running')
      ) FOR UPDATE`, [target.revision, active.revision]);
    const report = version?.report;
    const result = { ...report?.proposed?.metrics, ...report?.review?.metrics };
    const currentCorpus = report ? await tx.query('SELECT id,version,document FROM knowledge_document ORDER BY id,version') : [];
    if (target.status !== 'passed' || target.base_revision !== active.revision || report?.evidence?.provider_mode !== 'live' ||
        report.evidence.corpus_sha256 !== digestText(JSON.stringify(currentCorpus)) ||
        report.evidence.baseline_manifest_sha256 !== manifestDigest(effectiveManifest(active)) ||
        report.evidence.candidate_manifest_sha256 !== manifestDigest(effectiveManifest(target)) ||
        report.evidence.golden_count !== 30 || report.evidence.complementary_count !== 19 ||
        !(result.accuracy >= 0.80 && result.groundedness >= 0.85 && result.recall_at_5 >= 0.9 &&
          result.unresolved_critical === 0 && result.remote_generation_cases > 0)) {
      throw new ForbiddenException('Se requiere evaluación aprobada para el manifiesto activo y la candidata');
    }
  }
}
