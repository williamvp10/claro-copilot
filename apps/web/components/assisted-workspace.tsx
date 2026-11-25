'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, Clock3, Sparkles } from 'lucide-react';
import type { CaseInbox, CaseSnapshot } from '@claro/contracts';
import { api } from '@/lib/api';
import { Button } from './ui/button';
import styles from './assisted-workspace.module.css';

const clock = new Intl.DateTimeFormat('es-CO',{hour:'2-digit',minute:'2-digit',day:'numeric',month:'short',timeZone:'America/Bogota'});
const channels={web:'Web',telegram:'Telegram',whatsapp:'WhatsApp',voice:'Voz'};

export function CasesWorkspace({openCase,taken,followEscalations}:{openCase:(id:string)=>void;taken:(snapshot:CaseSnapshot)=>void;followEscalations:()=>void}) {
  const [inbox,setInbox]=useState<CaseInbox>();
  const [error,setError]=useState('');
  const [pending,setPending]=useState('');
  const refresh=useCallback(async()=>{
    try {setInbox(await api.inbox());setError('');}
    catch {setError('No pudimos cargar los casos. Puedes volver a intentarlo.');}
  },[]);
  useEffect(()=>{
    void refresh();
    const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},5000);
    return ()=>window.clearInterval(timer);
  },[refresh]);
  async function take(id:string) {
    setPending(id);
    try {taken(await api.take(id));}
    catch (failure) {
      await refresh();
      setError(failure instanceof Error && /no disponible|no está en espera/i.test(failure.message)
        ? 'Otro asesor tomó este caso o ya salió de la cola.' : failure instanceof Error ? failure.message : 'No pudimos tomar el caso.');
    } finally {setPending('');}
  }
  return <section className={styles.cases} aria-labelledby="case-workspace-title">
    <header className={styles.casesHead}><h1 id="case-workspace-title">Casos</h1>
      <Button variant="outline" onClick={followEscalations}>Ver escalamientos <ArrowUpRight aria-hidden="true"/></Button></header>
    {error&&<div className={styles.caseError} role="alert">{error} <Button variant="outline" onClick={()=>void refresh()}>Actualizar</Button></div>}
    {!inbox&&!error&&<p role="status">Cargando casos…</p>}
    {inbox&&<>
      <section aria-labelledby="intake-title">
        <div className={styles.queueHead}><div><h2 id="intake-title">Disponibles para tomar <span>{inbox.available.length}</span></h2>
          <p>Más antiguo primero</p></div><Button variant="ghost" onClick={()=>void refresh()}>Actualizar</Button></div>
        {inbox.available.length===0 ? <p className={styles.empty}>No hay casos disponibles en tu cola.</p> : <ol className={styles.queue}>
          {inbox.available.map(item=><li key={item.id}>
            <div><strong>{item.display_name}</strong><small>{channels[item.channel]} · {item.id.slice(0,8)}</small></div>
            <div className={styles.wait}><Clock3 size={16} aria-hidden="true"/><div>
              <time dateTime={item.queued_at}>{clock.format(new Date(item.queued_at))}</time>
              <small>En espera · {Math.max(0,Math.floor((Date.now()-Date.parse(item.queued_at))/60000))} min</small></div></div>
            <Button disabled={!inbox.can_take || !!pending} onClick={()=>void take(item.id)}>{pending===item.id?'Tomando…':'Tomar caso'}</Button>
          </li>)}
        </ol>}
        {!inbox.can_take&&inbox.available.length>0&&<p>Activa tu disponibilidad para tomar un caso.</p>}
      </section>
      <section aria-labelledby="assigned-title">
        <div className={styles.queueHead}><h2 id="assigned-title">Mis casos <span>{inbox.assigned.length}</span></h2></div>
        {inbox.assigned.length===0 ? <p className={styles.empty}>Los casos que tomes aparecerán aquí.</p> : <ul className={styles.queue}>
          {inbox.assigned.map(item=><li key={item.id}>
            <div><strong>{item.display_name}</strong><small>{channels[item.channel]} · {item.id.slice(0,8)}</small></div>
            <span>{item.status==='open'?'Abierto':'Cerrado'}</span>
            <Button variant="outline" onClick={()=>openCase(item.id)}>Abrir caso</Button>
          </li>)}
        </ul>}
      </section>
    </>}
  </section>;
}

export function AdvisorSuggestion({card,children}:{card:CaseSnapshot['card'];children:ReactNode}) {
  if (!card?.advisor_draft) return <p className={styles.suggestionWait} role="status">
    {card?.advisor_draft_status==='stale' ? 'Actualizando la respuesta sugerida…' : 'La respuesta sugerida aparecerá aquí cuando esté lista.'}
  </p>;
  return <section className={styles.suggestion} key={card.advisor_draft_run_id} aria-label="Respuesta sugerida por IA">
    <details open><summary><Sparkles size={17} aria-hidden="true"/> Respuesta sugerida por IA</summary>
      <p>{card.advisor_draft}</p>
      {card.citations.length>0&&<ul>{card.citations.map(source=><li key={source.id}>
        {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title} · {source.version}</a> : `${source.title} · ${source.version}`}
      </li>)}</ul>}
    </details>
    {children}
  </section>;
}
