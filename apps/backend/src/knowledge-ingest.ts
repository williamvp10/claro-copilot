import 'reflect-metadata';
import { readFile, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createDatabase } from './database.js';
import { Document, hasKnowledgeEmbedding, writeDocument } from './knowledge.js';
import { encodeKnowledge } from './knowledge-embeddings.js';
import { KnowledgeManifest, knowledgeHash, validatePublicationFiles } from './knowledge-publication.js';

const [source,manifestPath] = process.argv.slice(2);
if (!source || (await stat(source)).size > 5_000_000) throw new Error('Pass a reviewed JSON array up to 5 MB');
const raw = await readFile(source);
const documents = z.array(Document).min(1).max(5000).parse(JSON.parse(raw.toString('utf8')));
const detectedAt = new Date().toISOString();
const checksum = knowledgeHash(raw);
const manifest = manifestPath ? KnowledgeManifest.parse(JSON.parse(await readFile(manifestPath,'utf8'))) : null;
if (manifest) {
  if (checksum!==manifest.sha256 || documents.length!==manifest.count) throw new Error('Publication does not match manifest');
  if (documents.some(d=>d.provider_approved && d.scope!=='public')) throw new Error('Provider approval requires public scope');
  validatePublicationFiles(manifest,documents);
  const v1=documents.filter(d=>d.id.startsWith('catalogo-v1-'));
  const v2=documents.filter(d=>d.id.startsWith('catalogo-v2-'));
  const initial=manifest.stage==='initial';
  if (!manifest.sources['catalogo-v1'] || !v1.length || (initial ? v2.length>0 : !v2.length || !manifest.sources['catalogo-v2']) ||
    v1.some(d=>d.version!=='CAT-2026 v1.0'||d.effective_from!=='2026-11-01'||d.effective_to!==(initial?undefined:'2026-12-01')) ||
    v2.some(d=>d.version!=='CAT-2026 v2.0'||d.effective_from!=='2026-12-01')) throw new Error('Invalid catalog validity transition');
}
const db = await createDatabase().initialize();
try {
  const contextual=manifest?.index_schema==='contextual-v1';
  const vectors:number[][]=[];
  if (contextual && await hasKnowledgeEmbedding(db,checksum)) {
    for (let offset=0;offset<documents.length;offset+=16) {
      const batch=documents.slice(offset,offset+16).map(doc=>`${doc.metadata!.context}\n${doc.excerpt}`);
      const result=await encodeKnowledge(batch,'passage');
      if (!result) throw new Error('Contextual publish requires the pinned E5 encoder when pgvector is installed');
      vectors.push(...result);
    }
  }
  const published = await db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('knowledge-publication'))");
    if (manifest) {
      const [existing]=await tx.query('SELECT manifest FROM knowledge_publication WHERE sha256=$1',[checksum]);
      if (existing) {
        const previous=KnowledgeManifest.parse(existing.manifest);
        if (previous.stage!==manifest.stage || previous.index_schema!==manifest.index_schema || previous.count!==manifest.count || !isDeepStrictEqual(previous.sources,manifest.sources) ||
          (previous.files && manifest.files && !isDeepStrictEqual(previous.files,manifest.files))) throw new Error('Existing publication has different source metadata');
        if (!previous.files && manifest.files) {
          await tx.query('UPDATE knowledge_publication SET manifest=manifest || $2::jsonb WHERE sha256=$1',[checksum,{files:manifest.files}]);
        }
        return false;
      }
      const [current]=await tx.query("SELECT 1 FROM knowledge_publication WHERE manifest->>'stage'='current' AND coalesce(manifest->>'index_schema','')=$1 LIMIT 1",[manifest.index_schema ?? '']);
      if (current && manifest.stage==='initial') throw new Error('Initial snapshot cannot replace a published catalog update');
    }
    if (manifest && contextual) {
      await tx.query('INSERT INTO knowledge_publication(sha256,manifest) VALUES($1,$2)',[checksum,{...manifest,detected_at:detectedAt}]);
      for (const [index,doc] of documents.entries()) {
        if (vectors.length) {
          await tx.query('INSERT INTO knowledge_contextual_document(revision,id,version,document,embedding) VALUES($1,$2,$3,$4,$5::vector)',
            [checksum,doc.id,doc.version,doc,JSON.stringify(vectors[index])]);
        } else {
          await tx.query('INSERT INTO knowledge_contextual_document(revision,id,version,document) VALUES($1,$2,$3,$4)',[checksum,doc.id,doc.version,doc]);
        }
      }
      return true;
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
