import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MigrationInterface, QueryRunner, DataSource, EntityManager } from 'typeorm';
import { Citation, KnowledgeDigest, KnowledgeTags } from '@claro/contracts';
import { catalogPlans, createKnowledgeMcpAdapter, retrievalTerms, type KnowledgeAdapter, type KnowledgeDocument } from '@claro/agent';
import { encodeKnowledge } from './knowledge-embeddings.js';
import { KnowledgeManifest, publiclyViewable } from './knowledge-publication.js';

export const Document = Citation.extend({
  url: z.url({protocol:/^https$/}).optional(), excerpt:z.string().trim().min(1).max(8000),
  scope: z.enum(['public', 'advisor']), effective_from: z.iso.date(), effective_to: z.iso.date().optional(),
  status: z.enum(['ready', 'draft']).default('ready'), channels: z.array(z.string()).optional(),
  products: z.array(z.string()).optional(), type: z.string().optional(), provider_approved: z.literal(true).optional(),
  metadata: KnowledgeTags.optional(), source: z.undefined().optional()
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
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const words = normalized.match(/[a-z0-9]{3,}/g) ?? [];
  const diagnostic = /\be[\s-]?202\b/.test(normalized) ? ['e-202'] : [];
  return [...new Set([...diagnostic, ...words.filter(word => !stop.has(word))])].slice(0, 24);
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
  const [{ present }] = await db.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='knowledge_document' AND column_name='embedding') AS present");
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
type Db = Pick<DataSource,'query'>;
export function activeKnowledgeRevision() {
  const pinned=process.env.KNOWLEDGE_INDEX_REVISION;
  return !pinned || pinned==='legacy' ? 'legacy' : KnowledgeDigest.parse(pinned);
}

export function knowledgeCorpus(db:Db, revision=activeKnowledgeRevision()):Promise<SearchRow[]> {
  return revision==='legacy' ? db.query('SELECT id,version,document FROM knowledge_document ORDER BY id,version') :
    db.query('SELECT id,version,document FROM knowledge_contextual_document WHERE revision=$1 ORDER BY id,version',[revision]);
}

export function configuredKnowledge(db: Pick<DataSource,'query'>) {
  const url=process.env.KNOWLEDGE_MCP_URL;
  const token=process.env.KNOWLEDGE_SERVICE_TOKEN;
  return url && token
    ? {adapter:createKnowledgeMcpAdapter({url,token,trustedLocal:true,revision:activeKnowledgeRevision()}),transport:'mcp' as const}
    : {adapter:databaseKnowledge(db),transport:'postgres' as const};
}

export async function hasKnowledgeEmbedding(db: Db,revision=activeKnowledgeRevision()):Promise<boolean> {
  const [{dense}]=await db.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name=$1 AND column_name='embedding') AS dense`,[revision==='legacy'?'knowledge_document':'knowledge_contextual_document']);
  return dense;
}

function fuse(lists:SearchRow[][]) {
  const ranking = new Map<string,{ score:number; document:KnowledgeDocument }>();
  for (const list of lists) list.forEach(({id,version,document},index)=>{
    const key=`${id}:${version}`;
    ranking.set(key,{document,score:(ranking.get(key)?.score ?? 0)+1/(60+index+1)});
  });
  return [...ranking.values()].sort((a,b)=>b.score-a.score).slice(0,40).map(result=>result.document);
}
const accessFilter = `document->>'status'='ready' AND (document->>'scope'='public' OR $2='asesor')
  AND document->>'effective_from'<=$3 AND (document->>'effective_to' IS NULL OR document->>'effective_to'>$3)
  AND (document->'channels' IS NULL OR (document->'channels') ? $4)`;

async function contextualSearch(db:Db,revision:string,query:string,words:string[],context:SearchContext) {
  const filters=context.filters;
  const scope = `${accessFilter} AND revision=$5 AND ($6::text IS NULL OR document#>>'{metadata,source}'=$6)`;
  const params=[words.join(' | '),context.audience,context.business_date,context.channel,revision,filters?.source ?? null,filters?.tags ?? []];
  const [lexical,dense,publication]:[SearchRow[],boolean,{manifest:unknown}[]]=await Promise.all([
    db.query(`SELECT id,version,document FROM knowledge_contextual_document WHERE ${scope}
      AND (lexical @@ to_tsquery('spanish',$1) OR (document#>'{metadata,tags}') ?| $7::text[])
      ORDER BY (SELECT count(*) FROM unnest($7::text[]) AS tags(tag) WHERE (document#>'{metadata,tags}') ? tag) DESC,
        ts_rank_cd(lexical,to_tsquery('spanish',$1),32) DESC,id,version LIMIT 36`,params),
    hasKnowledgeEmbedding(db,revision),
    db.query('SELECT manifest FROM knowledge_publication WHERE sha256=$1',[revision])
  ]);
  if (!publication.length) throw new Error('knowledge_revision_unavailable');
  const manifest=KnowledgeManifest.parse(publication[0].manifest);
  const vectors=dense ? await encodeKnowledge([query.slice(0,1024)],'query') : null;
  const semantic:SearchRow[]=vectors ? await db.query(`SELECT id,version,document FROM knowledge_contextual_document
    WHERE ${scope} AND $1<>'' AND embedding IS NOT NULL AND $7::text[] IS NOT NULL
    ORDER BY embedding <=> $8::vector,id,version LIMIT 20`,[...params,JSON.stringify(vectors[0])]) : [];
  return fuse([lexical,semantic]).map(document=>withSource(document,revision,manifest));
}

function withSource(document:KnowledgeDocument,revision:string,manifest:KnowledgeManifest) {
  const reference=document.metadata;
  const file=reference && manifest.files?.[reference.source];
  return reference && file && publiclyViewable(reference.source,file)
    ? {...document,source:{publication:revision,key:reference.source,page:reference.page}} : document;
}

export function databaseKnowledge(db: Db,revision=activeKnowledgeRevision()): KnowledgeAdapter {
  return {
    revision,
    async catalog(context) {
      const params = [context.business_date,context.channel];
      const filter = `document->>'status'='ready' AND document->>'scope'='public'
        AND document->>'effective_from'<=$1 AND (document->>'effective_to' IS NULL OR document->>'effective_to'>$1)
        AND (document->'channels' IS NULL OR (document->'channels') ? $2)`;
      if (revision==='legacy') {
        const rows:SearchRow[] = await db.query(`SELECT document FROM knowledge_document
          WHERE ${filter} AND document->>'type'='catalogo' ORDER BY id,version`,params);
        return catalogPlans(rows.map(row=>row.document),context);
      }
      const [rows,publication]:[SearchRow[],{manifest:unknown}[]] = await Promise.all([
        db.query(`SELECT document FROM knowledge_contextual_document
          WHERE ${filter} AND revision=$3 AND document#>>'{metadata,source}' ~ '^catalogo-v[0-9]+$'
          ORDER BY id,version`,[...params,revision]),
        db.query('SELECT manifest FROM knowledge_publication WHERE sha256=$1',[revision])
      ]);
      if (!publication.length) throw new Error('knowledge_revision_unavailable');
      const manifest=KnowledgeManifest.parse(publication[0].manifest);
      return catalogPlans(rows.map(row=>withSource(row.document,revision,manifest)).filter(document=>document.source),context);
    },
    async search(query: string, context: SearchContext) {
      const words = retrievalTerms(query);
      if (!words.length) return [];
      if (revision!=='legacy') return contextualSearch(db,revision,query,words,context);
      const filter = accessFilter;
      const params = [words.join(' | '), context.audience, context.business_date, context.channel];
      const [dense, lexical] = await Promise.all([
        hasKnowledgeEmbedding(db),
        db.query(`SELECT id,version,document FROM knowledge_document WHERE ${filter}
          AND lexical @@ to_tsquery('spanish',$1)
          ORDER BY ts_rank_cd(lexical,to_tsquery('spanish',$1), 32) DESC,id,version LIMIT 36`, params) as Promise<SearchRow[]>
      ]);
      const semantic: SearchRow[] = dense ? await db.query(`SELECT id,version,document FROM knowledge_document WHERE ${filter}
        AND $1<>'' AND embedding IS NOT NULL AND (embedding <=> $5::vector)<0.70
        ORDER BY embedding <=> $5::vector,id,version LIMIT 16`, [...params, encode(query)]) : [];
      return fuse([lexical,semantic]);
    }
  };
}

export class ContextualKnowledge1795260000017 implements MigrationInterface {
  async up(db:QueryRunner) {
    await db.query(`CREATE TABLE knowledge_contextual_document (
      revision text NOT NULL REFERENCES knowledge_publication(sha256), id text NOT NULL, version text NOT NULL, document jsonb NOT NULL,
      lexical tsvector GENERATED ALWAYS AS (to_tsvector('spanish'::regconfig,
        coalesce(document#>>'{metadata,context}','') || ' ' || (document->>'excerpt'))) STORED,
      PRIMARY KEY (revision,id,version));
      CREATE INDEX knowledge_contextual_lexical ON knowledge_contextual_document USING GIN (lexical);`);
    const [{available}]=await db.query("SELECT EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='vector') AS available");
    if (available) await db.query('CREATE EXTENSION IF NOT EXISTS vector; ALTER TABLE knowledge_contextual_document ADD COLUMN embedding vector(384)');
  }
  async down(db:QueryRunner) { await db.query('DROP TABLE knowledge_contextual_document'); }
}

export class BoundBootstrapCatalog1795260000003 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`UPDATE knowledge_document SET document=jsonb_set(document,'{effective_to}',to_jsonb('2026-12-01'::text))
      WHERE id='catalogo-2026-fibra500' AND version='CAT-2026 v1.0'`);
  }
  async down(db: QueryRunner) {
    await db.query(`UPDATE knowledge_document SET document=document-'effective_to'
      WHERE id='catalogo-2026-fibra500' AND version='CAT-2026 v1.0'`);
  }
}
