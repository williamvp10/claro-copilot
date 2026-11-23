'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { Citation, KnowledgeInventory, KnowledgeLabQuery, KnowledgeLabResult, KnowledgePassage } from '@claro/contracts';
import { api } from '@/lib/api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

const errorText=(error:unknown)=>error instanceof Error?error.message:'No se pudo completar la consulta.';
const reasonCopy={no_evidence:'No encontré evidencia vigente suficiente para esta consulta.',
  retrieval_unavailable:'El servicio de recuperación no está disponible.',generation_disabled:'OpenAI no está habilitado para esta prueba.',
  generation_fallback:'Se utilizó una respuesta extractiva con la evidencia disponible.'};

function Passages({items}:{items:Citation[]}) {
  return <ol className="knowledge-passages">{items.map(item=><li key={`${item.id}:${item.version}`}>
    <strong>{item.title}</strong><small>{item.version} · {item.id}</small><p>{item.excerpt}</p>
  </li>)}</ol>;
}

export function AdminKnowledge() {
  const [tab,setTab]=useState<'sources'|'lab'>('sources');
  const [inventory,setInventory]=useState<KnowledgeInventory>();
  const [error,setError]=useState('');
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{
    let active=true;
    api.knowledgeInventory().then(value=>{if(active)setInventory(value);},failure=>{if(active)setError(errorText(failure));});
    return ()=>{active=false;};
  },[refresh]);

  return <div className="admin-page evo-page knowledge-page">
    <header className="ops-header"><div><h1>Conocimiento RAG</h1>{inventory&&<p>{inventory.indexed_count} pasajes listos en el índice</p>}</div></header>
    {error ? <div role="alert" className="alert error">{error} <Button variant="outline" onClick={()=>{setError('');setRefresh(n=>n+1);}}>Reintentar</Button></div>
      : !inventory ? <p role="status">Consultando publicaciones…</p>
      : <>
        <nav className="evo-tabs" aria-label="Conocimiento RAG">
          <button type="button" aria-current={tab==='sources'?'page':undefined} onClick={()=>setTab('sources')}>Fuentes</button>
          <button type="button" aria-current={tab==='lab'?'page':undefined} onClick={()=>setTab('lab')}>Chat de prueba</button>
        </nav>
        <div hidden={tab!=='sources'}><KnowledgeSources inventory={inventory}/></div>
        <div hidden={tab!=='lab'}><KnowledgeLab inventory={inventory}/></div>
      </>}
  </div>;
}

function KnowledgeSources({inventory}:{inventory:KnowledgeInventory}) {
  const [digest,setDigest]=useState(inventory.publications[0]?.sha256??'');
  const [key,setKey]=useState(inventory.publications[0]?.files[0]?.key??'');
  const [passages,setPassages]=useState<KnowledgePassage[]>();
  const [error,setError]=useState('');
  const [downloadError,setDownloadError]=useState('');
  const [downloading,setDownloading]=useState(false);
  const [filter,setFilter]=useState('');
  const publication=inventory.publications.find(item=>item.sha256===digest);
  const source=publication?.files.find(item=>item.key===key);
  useEffect(()=>{
    if (!source?.file_name) return;
    const controller=new AbortController();
    api.knowledgePassages(digest,key,controller.signal)
      .then(value=>{if(!controller.signal.aborted)setPassages(value);},failure=>{if(!controller.signal.aborted)setError(errorText(failure));});
    return ()=>controller.abort();
  },[digest,key,source?.file_name]);

  function select(nextDigest:string,nextKey:string) {
    if (digest===nextDigest && key===nextKey) return;
    setDigest(nextDigest);setKey(nextKey);setPassages(undefined);setError('');setDownloadError('');
  }

  async function download() {
    if (!source?.file_name) return;
    setDownloading(true);setDownloadError('');
    try {
      const blob=await api.knowledgeOriginal(digest,key);
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');
      link.href=url;link.download=source.file_name;link.click();
      window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch (failure) { setDownloadError(errorText(failure)); }
    finally { setDownloading(false); }
  }

  if (!publication) return <p className="ops-empty">Todavía no hay publicaciones registradas. El chat puede consultar los pasajes de arranque que estén listos.</p>;
  const term=filter.trim().toLocaleLowerCase('es-CO');
  const files=publication.files.filter(item=>`${item.file_name??''} ${item.title} ${item.version??''}`.toLocaleLowerCase('es-CO').includes(term));
  return <div className="knowledge-sources">
    <section className="ops-plot knowledge-stack" aria-label="Publicaciones y archivos">
      <label>Publicación<select value={digest} onChange={event=>{
        const next=inventory.publications.find(item=>item.sha256===event.target.value);
        if(next){setFilter('');select(next.sha256,next.files[0]?.key??'');}
      }}>{inventory.publications.map(item=><option key={item.sha256} value={item.sha256}>
        {new Date(item.published_at).toLocaleString('es-CO',{timeZone:'America/Bogota'})} · {item.stage==='initial'?'Inicial':'Actualización'} · {item.count} pasajes
      </option>)}</select></label>
      <p>SHA-256 de la publicación <code>{publication.sha256}</code></p>
      <label>Buscar archivo<input type="search" value={filter} onChange={event=>setFilter(event.target.value)}/></label>
      <div className="evo-list">{files.map(item=><button key={item.key} className="evo-customer" aria-pressed={item.key===key}
        onClick={()=>select(digest,item.key)}><strong>{item.title}</strong><span>{item.file_name??item.key}</span></button>)}</div>
      {!files.length&&<p>Sin coincidencias en esta publicación.</p>}
    </section>
    {source&&<section className="ops-plot knowledge-stack" aria-label="Ficha de la fuente">
      <header><h2>{source.title}</h2><p>{source.file_name??'Publicación sin ficha detallada del archivo'}</p></header>
      <dl className="knowledge-meta">
        <div><dt>Versión</dt><dd>{source.version??'—'}</dd></div>
        <div><dt>Audiencia</dt><dd>{source.scope==='advisor'?'Asesor':source.scope==='public'?'Pública':'—'}</dd></div>
        <div><dt>Vigencia</dt><dd>{source.effective_from ? `${source.effective_from} · ${source.effective_to?`hasta ${source.effective_to} (excluida)`:'sin fecha final'}` : '—'}</dd></div>
        <div><dt>Pasajes registrados</dt><dd>{source.passage_count??'—'}</dd></div>
        <div><dt>SHA-256 del original</dt><dd><code>{source.sha256}</code></dd></div>
      </dl>
      <div>{source.original==='available'
        ? <Button variant="outline" disabled={downloading} onClick={()=>void download()}>{downloading?'Verificando…':'Verificar y descargar original'}</Button>
        : <p>{source.original==='mismatch'?'El original difiere del archivo publicado.':'Original no disponible.'}</p>}
        {downloadError&&<p role="alert" className="alert error">{downloadError}</p>}
      </div>
      {error?<p className="alert error" role="alert">{error}</p>:source.file_name&&(!passages?<p role="status">Consultando pasajes…</p>:<>
        <h3>Pasajes indexados</h3>
        <Passages items={passages.flatMap(item=>item.citation?[item.citation]:[])}/>
        {passages.some(item=>!item.citation)&&<p>Algunos pasajes de esta publicación ya no coinciden con el índice actual.</p>}
      </>)}
    </section>}
  </div>;
}

function KnowledgeLab({inventory}:{inventory:KnowledgeInventory}) {
  const [question,setQuestion]=useState('');
  const [audience,setAudience]=useState<KnowledgeLabQuery['audience']>('cliente');
  const [channel,setChannel]=useState<KnowledgeLabQuery['channel']>('web');
  const [date,setDate]=useState(inventory.business_date);
  const [mode,setMode]=useState<KnowledgeLabQuery['mode']>('extractive');
  const [working,setWorking]=useState(false);
  const [error,setError]=useState('');
  const [turns,setTurns]=useState<{input:KnowledgeLabQuery;result:KnowledgeLabResult}[]>([]);
  async function submit(event:FormEvent) {
    event.preventDefault();
    setWorking(true);setError('');
    const input={question:question.trim(),audience,channel,business_date:date,mode};
    try {
      const result=await api.knowledgeQuery(input);
      setTurns(previous=>[{input,result},...previous].slice(0,20));
      setQuestion('');
    } catch (failure) { setError(errorText(failure)); }
    finally { setWorking(false); }
  }
  return <div className="knowledge-stack">
    <form className="ops-plot knowledge-stack" onSubmit={submit}>
      <div className="evo-filters">
        <label>Audiencia<select value={audience} disabled={working} onChange={event=>{
          const next=event.target.value as KnowledgeLabQuery['audience'];setAudience(next);if(next==='asesor')setMode('extractive');
        }}><option value="cliente">Cliente</option><option value="asesor">Asesor</option></select></label>
        <label>Canal<select value={channel} disabled={working} onChange={event=>setChannel(event.target.value as KnowledgeLabQuery['channel'])}>
          <option value="web">Web</option><option value="telegram">Telegram</option></select></label>
        <label>Fecha de consulta<input type="date" required value={date} disabled={working} onChange={event=>setDate(event.target.value)}/></label>
        <label>Respuesta<select value={mode} disabled={working} onChange={event=>setMode(event.target.value as KnowledgeLabQuery['mode'])}>
          <option value="extractive">Extractiva</option><option value="openai" disabled={!inventory.live_available||audience==='asesor'}>OpenAI</option>
        </select></label>
      </div>
      {mode==='openai'&&<p>OpenAI procesa el tema saneado y los extractos públicos aprobados.</p>}
      <label>Pregunta<textarea value={question} onChange={event=>setQuestion(event.target.value)} required minLength={3} maxLength={1024}
        disabled={working} rows={2} placeholder="¿Cuánto cuesta Fibra 500?"/></label>
      <div><Button type="submit" disabled={working||!date||question.trim().length<3}>{working?'Consultando fuentes…':'Probar pregunta'}</Button></div>
      {error&&<p role="alert" className="alert error">{error}</p>}
    </form>
    <div className="knowledge-stack" aria-live="polite">
      {turns.map(({input,result})=><article key={result.run_id} className="ops-plot knowledge-stack">
        <header><h3>{input.question}</h3><p>{input.audience==='cliente'?'Cliente':'Asesor'} · {input.channel} · {input.business_date}</p></header>
        <div className="knowledge-tags"><Badge variant="secondary">{result.mode==='openai'?'OpenAI':result.mode==='extractive'?'Extractiva':'Abstención'}</Badge>
          <Badge variant="outline">{result.transport==='mcp'?'MCP Conocimiento':'PostgreSQL'}</Badge>
          <Badge variant="outline">{result.pgvector?'pgvector local habilitado':'Índice local textual'}</Badge></div>
        {result.answer&&<p className="knowledge-answer">{result.answer}</p>}
        {result.reason&&<p>{reasonCopy[result.reason]}</p>}
        {result.citations.length>0&&<><h3>Fuentes de la respuesta</h3><Passages items={result.citations}/></>}
        {result.retrieved.length>0&&<details><summary>{result.retrieved.length} primeros pasajes recuperados</summary><Passages items={result.retrieved}/></details>}
        <p>Revisión {result.revision??'sin publicar'} · {result.latency_ms} ms total · {result.retrieval_ms} ms de recuperación · <code>{result.run_id}</code></p>
      </article>)}
    </div>
  </div>;
}
