import { Body, Controller, ForbiddenException, Get, Header, Inject, NotFoundException, Param, Post, Req, Res, BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createKnowledgePipeline, createOpenAIPublicWriter, createOpenAIEvidenceSelector } from '@claro/agent';
import { Citation, KnowledgeDigest, KnowledgeLabQuery, KnowledgeSourceKey, type KnowledgeInventory, type KnowledgeLabResult, type KnowledgePassage, type KnowledgeSourceSummary } from '@claro/contracts';
import type { Request, Response } from 'express';
import type { DataSource } from 'typeorm';
import type { ZodType } from 'zod';
import { AUTH, getViewer, type createAuth } from './auth.js';
import { clearPersonalData } from './cases.js';
import { DATABASE, audit } from './database.js';
import { configuredKnowledge, hasKnowledgeEmbedding } from './knowledge.js';
import { KnowledgeManifest, knowledgeHash, type KnowledgeSourceFile } from './knowledge-publication.js';
import { readRunPromptConfig } from './prompt-catalog.js';

type PublicationRow = { sha256:string; manifest:unknown; published_at:Date };

function parse<T>(schema:ZodType<T>, value:unknown):T {
  const result=schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Solicitud de conocimiento inválida');
  return result.data;
}

export async function indexedOriginal(directory:string|undefined, source:Pick<KnowledgeSourceFile,'sha256'|'size_bytes'>, verify:boolean) {
  if (!directory) return {status:'missing' as const};
  try {
    const file=await open(join(directory,KnowledgeDigest.parse(source.sha256)),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat=await file.stat();
      if (!stat.isFile() || stat.size!==source.size_bytes) return {status:'mismatch' as const};
      if (!verify) return {status:'available' as const};
      // A bounded read serves the same bytes that are checked, even if the path is replaced.
      const buffer=Buffer.alloc(source.size_bytes+1);
      let offset=0;
      while (offset<buffer.length) {
        const {bytesRead}=await file.read(buffer,offset,buffer.length-offset,offset);
        if (bytesRead===0) break;
        offset+=bytesRead;
      }
      const bytes=buffer.subarray(0,offset);
      return offset===source.size_bytes && knowledgeHash(bytes)===source.sha256
        ? {status:'available' as const,bytes} : {status:'mismatch' as const};
    } finally { await file.close(); }
  } catch (error) {
    return {status:(error as NodeJS.ErrnoException).code==='ELOOP' ? 'mismatch' as const : 'missing' as const};
  }
}

function businessDate() {
  if (process.env.DEMO_MODE==='true') return process.env.DEMO_BUSINESS_DATE || '2026-11-18';
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}

@Controller('api/v1/admin/knowledge')
export class KnowledgeAdminController {
  constructor(@Inject(DATABASE) private readonly db:DataSource, @Inject(AUTH) private readonly auth:ReturnType<typeof createAuth>['auth']) {}

  private async authorize(req:Request) {
    if (req.method==='POST' && req.get('Origin')!==new URL(process.env.BETTER_AUTH_URL!).origin) throw new ForbiddenException('Origen inválido');
    const viewer=await getViewer(req,this.auth,this.db);
    if (viewer.role!=='admin') throw new ForbiddenException();
    return viewer;
  }

  private async source(digest:string,key:string) {
    const [row]:PublicationRow[]=await this.db.query('SELECT sha256,manifest,published_at FROM knowledge_publication WHERE sha256=$1',[parse(KnowledgeDigest,digest)]);
    const files=row && KnowledgeManifest.parse(row.manifest).files;
    const source=parse(KnowledgeSourceKey,key);
    if (!files || !Object.hasOwn(files,source)) throw new NotFoundException('La publicación no tiene una ficha para esta fuente');
    return files[source];
  }

  @Get('publications')
  @Header('Cache-Control','no-store')
  async publications(@Req() req:Request):Promise<KnowledgeInventory> {
    await this.authorize(req);
    const [rows,[index]]:[PublicationRow[],{count:number}[]]=await Promise.all([
      this.db.query('SELECT sha256,manifest,published_at FROM knowledge_publication ORDER BY published_at DESC,sha256 LIMIT 30'),
      this.db.query("SELECT count(*)::int AS count FROM knowledge_document WHERE document->>'status'='ready'")
    ]);
    const root=process.env.KNOWLEDGE_ORIGINALS_DIR;
    const publications=[];
    for (const row of rows) {
      const manifest=KnowledgeManifest.parse(row.manifest);
      const files:KnowledgeSourceSummary[]=[];
      for (const [key,sha256] of Object.entries(manifest.sources)) {
        const file=manifest.files?.[key];
        files.push({key,sha256,title:file?.title??key,file_name:file?.file_name??null,version:file?.version??null,
          scope:file?.scope??null,type:file?.type??null,effective_from:file?.effective_from??null,effective_to:file?.effective_to??null,
          passage_count:file?.passages.length??null,original:file?(await indexedOriginal(root,file,false)).status:'missing'});
      }
      publications.push({sha256:row.sha256,stage:manifest.stage,published_at:row.published_at.toISOString(),count:manifest.count,files});
    }
    return {publications,business_date:businessDate(),live_available:process.env.RAG_LAB_LIVE_ENABLED==='true' && Boolean(process.env.OPENAI_API_KEY),indexed_count:index.count};
  }

  @Get('publications/:digest/sources/:key/passages')
  @Header('Cache-Control','no-store')
  async passages(@Req() req:Request,@Param('digest') digest:string,@Param('key') key:string):Promise<KnowledgePassage[]> {
    await this.authorize(req);
    const source=await this.source(digest,key);
    const rows:{id:string;document:unknown}[]=await this.db.query('SELECT id,document FROM knowledge_document WHERE version=$1 AND id=ANY($2::text[])',
      [source.version,source.passages.map(item=>item.id)]);
    const documents=new Map(rows.map(row=>[row.id,Citation.safeParse(row.document)]));
    return source.passages.map(passage=>{
      const citation=documents.get(passage.id);
      return {...passage,version:source.version,citation:citation?.success && knowledgeHash(citation.data.excerpt)===passage.excerpt_sha256 ? citation.data : null};
    });
  }

  @Get('publications/:digest/sources/:key/original')
  async original(@Req() req:Request,@Res() res:Response,@Param('digest') digest:string,@Param('key') key:string) {
    const viewer=await this.authorize(req);
    const source=await this.source(digest,key);
    const original=await indexedOriginal(process.env.KNOWLEDGE_ORIGINALS_DIR,source,true);
    if (original.status==='mismatch') throw new ConflictException('El original difiere del SHA-256 publicado');
    if (!original.bytes) throw new NotFoundException('El original no está disponible');
    await audit(this.db.manager,null,'knowledge_original_downloaded',{operator_id:viewer.id,publication:digest,source:key});
    res.attachment(source.file_name).type('application/octet-stream').set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).send(original.bytes);
  }

  @Post('lab/query')
  @Header('Cache-Control','no-store')
  async query(@Req() req:Request,@Body() raw:unknown):Promise<KnowledgeLabResult> {
    await this.authorize(req);
    const {question,mode,...context}=parse(KnowledgeLabQuery,raw);
    const started=Date.now();
    const run_id=randomUUID();
    const turn={...context,text:clearPersonalData(question),run_id};
    const [active]=await this.db.query('SELECT revision FROM prompt_revision WHERE activated');
    const config=active ? await readRunPromptConfig(this.db,active.revision) : undefined;
    const {adapter,transport}=configuredKnowledge(this.db);
    const key=mode==='openai' && context.audience==='cliente' && process.env.RAG_LAB_LIVE_ENABLED==='true' ? process.env.OPENAI_API_KEY : undefined;
    const pipeline=createKnowledgePipeline({knowledge:adapter,requireApprovedPrompts:true,
      ...(key?{writer:createOpenAIPublicWriter({apiKey:key}),evidenceSelector:createOpenAIEvidenceSelector({apiKey:key,models:{economico:'gpt-6-luna'}})}:{})});
    const retrievalStarted=Date.now();
    const [evidence,pgvector]=await Promise.all([pipeline.retrieve(turn,'economico',config?.prompts??{}),hasKnowledgeEmbedding(this.db)]);
    const retrieval_ms=Date.now()-retrievalStarted;
    const reply=await pipeline.answer(turn,'economico',config?.prompts.public_answer??'',evidence.candidates);
    const reason=evidence.unavailable?'retrieval_unavailable':!reply?'no_evidence':mode==='openai' && reply.mode==='extractive'
      ? key?'generation_fallback':'generation_disabled' : null;
    return {run_id,revision:config?.revision??null,transport,pgvector,retrieval_ms,latency_ms:Date.now()-started,
      mode:reply?.mode??null,reason,answer:reply?.answer??null,citations:reply?.used??[],
      retrieved:evidence.ranked.slice(0,5).map(doc=>Citation.parse(doc))};
  }
}
