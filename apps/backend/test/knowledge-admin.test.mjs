import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgePipeline } from '@claro/agent';
import { indexedOriginal } from '../dist/knowledge-admin.js';
import { KnowledgeManifest, knowledgeHash, validatePublicationFiles } from '../dist/knowledge-publication.js';

const excerpt='Fibra 500 ofrece 500 Mbps por $109.900.';
const document={id:'catalogo-v1-001',title:'Catálogo Fibra 500',excerpt,version:'CAT v1',type:'catalogo',scope:'public',effective_from:'2026-11-01',effective_to:'2026-12-01',status:'ready'};
const original=Buffer.from('original');
const sha256=knowledgeHash(original);
const source={sha256,size_bytes:original.length};
const manifest={sha256:'a'.repeat(64),stage:'current',count:1,sources:{'catalogo-v1':sha256},files:{
  'catalogo-v1':{...source,file_name:'catalogo.pdf',title:'Catálogo',type:'catalogo',version:document.version,scope:'public',
    effective_from:'2026-11-01',effective_to:'2026-12-01',passages:[{id:document.id,excerpt_sha256:knowledgeHash(excerpt)}]}
}};

test('publication binds each indexed excerpt to its file, visibility and validity',()=>{
  const parsed=KnowledgeManifest.parse(manifest);
  validatePublicationFiles(parsed,[document]);
  assert.throws(()=>validatePublicationFiles(parsed,[{...document,excerpt:'Otro texto'}]),/does not match/);
  assert.throws(()=>validatePublicationFiles(parsed,[{...document,scope:'advisor'}]),/does not match/);
  assert.throws(()=>validatePublicationFiles(parsed,[document,{...document,id:'catalogo-v1-002'}]),/omits/);
  assert.equal(KnowledgeManifest.safeParse({...manifest,files:{'catalogo-v1':{...manifest.files['catalogo-v1'],file_name:'../escape.pdf'}}}).success,false);
});

test('only the bytes with the published digest may be downloaded',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'claro-original-test-'));
  const path=join(dir,sha256);
  try {
    assert.equal((await indexedOriginal(dir,source,true)).status,'missing');
    await writeFile(path,original);
    assert.deepEqual((await indexedOriginal(dir,source,true)).bytes,original);
    await writeFile(path,Buffer.from('tampered'));
    assert.equal((await indexedOriginal(dir,source,true)).status,'mismatch');
    await rm(path);
    await writeFile(join(dir,'target'),original);
    await symlink(join(dir,'target'),path);
    assert.equal((await indexedOriginal(dir,source,true)).status,'mismatch');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('lab and agent share validity and audience filters and fall back when generation fails',async()=>{
  const current={...document,id:'catalogo-v2-001',version:'CAT v2',effective_from:'2026-12-01',effective_to:undefined,
    excerpt:'Fibra 500 ofrece 500 Mbps por $114.900.',provider_approved:true};
  const internal={...current,id:'boletin-001',scope:'advisor',excerpt:'Fibra 500 requiere un procedimiento interno.'};
  const seen=[];
  const pipeline=createKnowledgePipeline({knowledge:{search:async()=>[document,current,internal]},requireApprovedPrompts:true,
    writer:{async write(topic,citations){seen.push({topic,citations});return null;}}});
  const publicTurn={run_id:'test',text:'¿Cuánto cuesta Fibra 500? usuario@ejemplo.test',audience:'cliente',channel:'web',business_date:'2026-11-30'};
  const old=await pipeline.retrieve(publicTurn,'economico',{});
  assert.deepEqual(old.candidates.map(doc=>doc.id),[document.id]);
  const next={...publicTurn,business_date:'2026-12-01'};
  const ranked=await pipeline.retrieve(next,'economico',{});
  assert.deepEqual(ranked.candidates.map(doc=>doc.id),[current.id]);
  const answer=await pipeline.answer(next,'economico','Responder con evidencia',ranked.candidates);
  assert.equal(answer.mode,'extractive');
  assert.equal(answer.answer,current.excerpt);
  assert.equal(seen.length,1);
  assert.deepEqual(seen[0].citations.map(item=>item.id),[current.id]);
  assert.doesNotMatch(seen[0].topic,/ejemplo|usuario@/);
  const advisor={...next,audience:'asesor'};
  const all=await pipeline.retrieve(advisor,'economico',{});
  assert.ok(all.candidates.some(item=>item.id===internal.id));
  await pipeline.answer(advisor,'economico','Responder con evidencia',all.candidates);
  assert.equal(seen.length,1);
  const empty=await createKnowledgePipeline({knowledge:{search:async()=>{throw new Error('Unavailable');}}}).retrieve(next,'economico',{});
  assert.deepEqual(empty,{candidates:[],ranked:[],unavailable:true});
});
