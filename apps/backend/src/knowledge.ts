import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MigrationInterface, QueryRunner, DataSource, EntityManager } from 'typeorm';
import { Citation } from '@claro/contracts';
import type { KnowledgeAdapter, KnowledgeDocument } from '@claro/agent';

export const Document = Citation.extend({
  scope: z.enum(['public', 'advisor']), effective_from: z.iso.date(), effective_to: z.iso.date().optional(),
  status: z.enum(['ready', 'draft']).default('ready'), channels: z.array(z.string()).optional(),
  products: z.array(z.string()).optional(), type: z.string().optional()
}).refine(doc => !doc.effective_to || doc.effective_to > doc.effective_from, { message: 'Invalid validity interval' });

const publicDocuments: z.input<typeof Document>[] = [
  { id:'catalogo-2026-fibra500', title:'Catálogo Claro de planes y tarifas, pág. 1', version:'CAT-2026 v1.0',
    excerpt:'Hogar Fibra 500 ofrece 500 Mbps de descarga y subida por $109.900 al mes. Incluye módem WiFi 6 y un repetidor.',
    scope:'public', effective_from:'2026-11-01', type:'catalogo' },
  { id:'faq-decodificador-e202', title:'FAQ de atención · Decodificador E-202', version:'FAQ 2026',
    excerpt:'Ante E-202, refresca la señal en Mi Claro → Mi TV → Refrescar señal. Mantén el decodificador encendido hasta 15 minutos antes de evaluar una visita técnica.',
    scope:'public', effective_from:'2026-11-01', type:'soporte' }
];

const stop = new Set(['que','para','cual','como','donde','este','esta','sobre','los','las','del','con','por','una','uno','hola','quiero','saber','hay','mas','puedo','debo','tengo','dice']);
function terms(text: string) {
  const words = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  return [...new Set(words.filter(word => !stop.has(word)))].slice(0, 24);
}

function encode(text: string) {
  const embedding = Array<number>(128).fill(0);
  for (const term of terms(text)) {
    const hash = createHash('sha256').update(term).digest();
    embedding[hash[0] % embedding.length] += hash[1] % 2 ? -1 : 1;
  }
  return JSON.stringify(embedding);
}

export async function writeDocument(db: Pick<EntityManager, 'query'>, input: z.input<typeof Document>) {
  const doc = Document.parse(input);
  await db.query(`INSERT INTO knowledge_document(id,version,document) VALUES ($1,$2,$3)
    ON CONFLICT(id,version) DO UPDATE SET document=EXCLUDED.document`, [doc.id,doc.version,doc]);
  const [{ present }] = await db.query("SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector') AS present");
  if (present) await db.query('UPDATE knowledge_document SET embedding=$3::vector WHERE id=$1 AND version=$2',
    [doc.id,doc.version,encode(`${doc.title} ${doc.excerpt}`)]);
}

export class Knowledge1795260000001 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`CREATE TABLE knowledge_document(
      id text NOT NULL, version text NOT NULL, document jsonb NOT NULL,
      lexical tsvector GENERATED ALWAYS AS (to_tsvector('spanish'::regconfig, (document->>'title') || ' ' || (document->>'excerpt'))) STORED,
      PRIMARY KEY (id,version));
      CREATE INDEX knowledge_lexical ON knowledge_document USING GIN (lexical);`);
    const [{ available }] = await db.query("SELECT EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='vector') AS available");
    if (available) {
      await db.query('CREATE EXTENSION IF NOT EXISTS vector');
      await db.query('ALTER TABLE knowledge_document ADD COLUMN embedding vector(128)');
    }
    for (const doc of publicDocuments) await writeDocument(db.manager, doc);
  }
  async down(db: QueryRunner) {
    await db.query('DROP TABLE knowledge_document');
  }
}

type SearchContext = Parameters<KnowledgeAdapter['search']>[1];
type SearchRow = { id: string; version: string; document: KnowledgeDocument };
export function databaseKnowledge(db: DataSource): KnowledgeAdapter {
  return {
    async search(query: string, context: SearchContext) {
      const words = terms(query);
      if (!words.length) return [];
      const filter = `document->>'status'='ready' AND (document->>'scope'='public' OR $2='asesor')
        AND document->>'effective_from'<=$3 AND (document->>'effective_to' IS NULL OR document->>'effective_to'>$3)
        AND (document->'channels' IS NULL OR (document->'channels') ? $4)`;
      const params = [words.join(' | '), context.audience, context.business_date, context.channel];
      const [[{ dense }], lexical] = await Promise.all([
        db.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
          AND table_name='knowledge_document' AND column_name='embedding') AS dense`),
        db.query(`SELECT id,version,document FROM knowledge_document WHERE ${filter}
          AND lexical @@ to_tsquery('spanish',$1)
          ORDER BY ts_rank_cd(lexical,to_tsquery('spanish',$1)) DESC,id,version LIMIT 12`, params) as Promise<SearchRow[]>
      ]);
      const semantic: SearchRow[] = dense ? await db.query(`SELECT id,version,document FROM knowledge_document WHERE ${filter}
        AND $1<>'' AND embedding IS NOT NULL AND (embedding <=> $5::vector)<0.70
        ORDER BY embedding <=> $5::vector,id,version LIMIT 12`, [...params, encode(query)]) : [];
      const ranking = new Map<string,{ score:number; document:KnowledgeDocument }>();
      for (const list of [lexical, semantic]) {
        list.forEach(({ id, version, document }, index) => {
          const key = `${id}:${version}`;
          ranking.set(key, {document, score:(ranking.get(key)?.score ?? 0) + 1 / (60 + index + 1)});
        });
      }
      return [...ranking.values()].sort((a,b)=>b.score-a.score).slice(0,12).map(result=>result.document);
    }
  };
}
