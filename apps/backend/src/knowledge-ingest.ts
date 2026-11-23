import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { createDatabase } from './database.js';
import { Document, writeDocument } from './knowledge.js';

const [source,manifestPath] = process.argv.slice(2);
if (!source || (await stat(source)).size > 5_000_000) throw new Error('Pass a reviewed JSON array up to 5 MB');
const raw = await readFile(source);
const documents = z.array(Document).min(1).max(5000).parse(JSON.parse(raw.toString('utf8')));
const detectedAt = new Date().toISOString();
const checksum = createHash('sha256').update(raw).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const manifest = manifestPath ? z.object({
  sha256:digest, stage:z.enum(['initial','current']), sources:z.record(z.string(),digest), count:z.number().int()
}).parse(JSON.parse(await readFile(manifestPath,'utf8'))) : null;
if (manifest) {
  if (checksum!==manifest.sha256 || documents.length!==manifest.count) throw new Error('Publication does not match manifest');
  if (documents.some(d=>d.provider_approved && d.scope!=='public')) throw new Error('Provider approval requires public scope');
  const v1=documents.filter(d=>d.id.startsWith('catalogo-v1-'));
  const v2=documents.filter(d=>d.id.startsWith('catalogo-v2-'));
  const initial=manifest.stage==='initial';
  if (!manifest.sources['catalogo-v1'] || !v1.length || (initial ? v2.length>0 : !v2.length || !manifest.sources['catalogo-v2']) ||
    v1.some(d=>d.version!=='CAT-2026 v1.0'||d.effective_from!=='2026-11-01'||d.effective_to!==(initial?undefined:'2026-12-01')) ||
    v2.some(d=>d.version!=='CAT-2026 v2.0'||d.effective_from!=='2026-12-01')) throw new Error('Invalid catalog validity transition');
}
const db = await createDatabase().initialize();
try {
  const published = await db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('knowledge-publication'))");
    if (manifest) {
      const [existing]=await tx.query('SELECT 1 FROM knowledge_publication WHERE sha256=$1',[checksum]);
      if (existing) return false;
      const [current]=await tx.query("SELECT 1 FROM knowledge_publication WHERE manifest->>'stage'='current' LIMIT 1");
      if (current && manifest.stage==='initial') throw new Error('Initial snapshot cannot replace a published catalog update');
    }
    for (const document of documents) await writeDocument(tx,document);
    if (manifest) {
      // The two bootstrap passages provide a small fallback before the official corpus is present.
      await tx.query("UPDATE knowledge_document SET document=jsonb_set(document,'{status}','\"draft\"') WHERE id IN ('catalogo-2026-fibra500','faq-decodificador-e202')");
      await tx.query('INSERT INTO knowledge_publication(sha256,manifest) VALUES($1,$2)',[checksum,{...manifest,detected_at:detectedAt}]);
    }
    return true;
  });
  console.log(JSON.stringify({published,sha256:checksum,passages:documents.length,stage:manifest?.stage??'manual'}));
} finally {
  await db.destroy();
}
