import { createHash } from 'node:crypto';
import { KnowledgeDigest, KnowledgeSourceKey } from '@claro/contracts';
import { z } from 'zod';
import type { Document } from './knowledge.js';

export const knowledgeHash = (content:string|Buffer) => createHash('sha256').update(content).digest('hex');
export const maxOriginalBytes=10_485_760;

const SourceFile=z.object({
  file_name:z.string().min(1).max(180).regex(/^[^/\\\x00-\x1f\x7f]+\.(?:pdf|docx|md|eml)$/i),
  title:z.string().min(1).max(250),sha256:KnowledgeDigest,size_bytes:z.number().int().min(1).max(maxOriginalBytes),
  version:z.string().min(1).max(128),scope:z.enum(['public','advisor']),type:z.string().min(1).max(60),
  effective_from:z.iso.date(),effective_to:z.iso.date().nullable(),
  passages:z.array(z.object({id:z.string().min(1).max(128),excerpt_sha256:KnowledgeDigest})).min(1).max(5000)
});

export const KnowledgeManifest=z.object({
  sha256:KnowledgeDigest,stage:z.enum(['initial','current']),sources:z.record(KnowledgeSourceKey,KnowledgeDigest),
  count:z.number().int().min(1).max(5000),files:z.record(KnowledgeSourceKey,SourceFile).optional()
});
export type KnowledgeManifest=z.infer<typeof KnowledgeManifest>;
export type KnowledgeSourceFile=z.infer<typeof SourceFile>;

export function validatePublicationFiles(manifest:KnowledgeManifest, documents:z.infer<typeof Document>[]) {
  if (!manifest.files) return;
  const indexed=new Map(documents.map(doc=>[doc.id,doc]));
  if (indexed.size!==documents.length || Object.keys(manifest.files).length!==Object.keys(manifest.sources).length) {
    throw new Error('Publication file inventory is incomplete or has duplicate passages');
  }
  for (const [key,file] of Object.entries(manifest.files)) {
    if (!Object.hasOwn(manifest.sources,key) || manifest.sources[key]!==file.sha256) throw new Error('Source file checksum differs from the manifest');
    for (const passage of file.passages) {
      const doc=indexed.get(passage.id);
      if (!doc || doc.id.slice(0,doc.id.lastIndexOf('-'))!==key || doc.version!==file.version || doc.scope!==file.scope ||
          doc.type!==file.type || doc.effective_from!==file.effective_from || (doc.effective_to??null)!==file.effective_to ||
          knowledgeHash(doc.excerpt)!==passage.excerpt_sha256) throw new Error('Source file does not match its indexed passage');
      indexed.delete(passage.id);
    }
  }
  if (indexed.size) throw new Error('Publication file inventory omits indexed passages');
}
