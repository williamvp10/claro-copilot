'use client';

import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { CaseSnapshot, ClosureEvidenceSuggestion, FollowUpEntry } from '@claro/contracts';
import { ApiError, api, key } from '@/lib/api';
import { Button } from './ui/button';

export const priorityNames={habitual:'Habitual',media:'Media',alta:'Alta',sin_prediccion:'Sin predicción'} as const;
export const followUpNames={agreed:'Programado',overdue:'Vencido',completed:'Completado',cancelled:'Cancelado'} as const;
const dateText=(value:string)=>new Intl.DateTimeFormat('es-CO',{dateStyle:'medium',timeZone:'UTC'}).format(new Date(value+'T00:00:00Z'));
const errorText=(error:unknown)=>error instanceof Error ? error.message : 'Intenta de nuevo en unos segundos.';

export function PriorityBadge({priority}:{priority:keyof typeof priorityNames}) {
  return <span className="follow-up-priority" data-priority={priority}>{priorityNames[priority]}</span>;
}

export function FollowUpsAgenda({openCase}:{openCase:(id:string)=>void}) {
  const [data,setData]=useState<Awaited<ReturnType<typeof api.followUps>>>();
  const [priority,setPriority]=useState('');
  const [status,setStatus]=useState('');
  const [offset,setOffset]=useState(0);
  const [refresh,setRefresh]=useState(0);
  const [editing,setEditing]=useState<FollowUpEntry|null>(null);
  const [date,setDate]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const operation=useRef<{fingerprint:string;id:string}|undefined>(undefined);

  useEffect(()=>{
    const pending=new AbortController();
    const search=new URLSearchParams({offset:String(offset)});
    if (priority) search.set('priority',priority);
    if (status) search.set('status',status);
    api.followUps(search,pending.signal).then(result=>{
      if (!pending.signal.aborted) setData(result);
    }).catch(error=>{if (!pending.signal.aborted) setError(errorText(error));});
    return ()=>pending.abort();
  },[priority,status,offset,refresh]);

  function reload() {setError('');setData(undefined);setRefresh(value=>value+1);}
  async function update(item:FollowUpEntry,status:'rescheduled'|'completed'|'cancelled') {
    const body={status,case_revision:item.case_revision,...(status==='rescheduled'?{due_date:date}:{})};
    const fingerprint=JSON.stringify([item.case_id,body]);
    if (operation.current?.fingerprint!==fingerprint) operation.current={fingerprint,id:key()};
    setError('');setNotice('');setBusy(true);
    try {
      await api.followUp(item.case_id,{...body,event_id:operation.current.id});
      setEditing(null);
      setNotice(status==='rescheduled'?'Seguimiento reprogramado.':status==='completed'?'Seguimiento completado.':'Seguimiento cancelado.');
      setRefresh(value=>value+1);
    } catch (error) {
      if (error instanceof ApiError && error.status===409) {
        setEditing(null);setRefresh(value=>value+1);
      }
      setError(errorText(error));
    } finally {setBusy(false);}
  }

  return <section className="admin-page follow-up-page">
    <header className="ops-header"><div><h1>Seguimientos programados</h1>
      <p>Consulta los compromisos de atención y actualiza su estado.</p></div></header>
    <div className="follow-up-filters">
      <label>Prioridad<select value={priority} onChange={event=>{setPriority(event.target.value);setOffset(0);setData(undefined);setError('');}}>
        <option value="">Todas</option>{Object.entries(priorityNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Estado<select value={status} onChange={event=>{setStatus(event.target.value);setOffset(0);setData(undefined);setError('');}}>
        <option value="">Todos</option>{Object.entries(followUpNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>
    </div>
    {notice&&<p role="status">{notice}</p>}
    {error&&<div className="alert error" role="alert"><p>{error}</p><Button className="button outline" variant="outline" onClick={reload}>Actualizar agenda</Button></div>}
    {!data&&!error&&<p role="status">Cargando seguimientos…</p>}
    {data&&data.items.length===0&&<p>Sin seguimientos para los filtros elegidos.</p>}
    {data&&data.items.length>0&&<div className="follow-up-table">
      <table><thead><tr><th scope="col">Cliente y caso</th><th scope="col">Fecha</th><th scope="col">Prioridad</th><th scope="col">Responsable</th><th scope="col">Estado</th><th scope="col">Acciones</th></tr></thead>
      <tbody>{data.items.map(item=>{
        const actionable=item.can_edit && (item.status==='agreed'||item.status==='overdue');
        return <tr key={item.case_id}>
          <th scope="row">{item.display_name}<small>{item.case_id.slice(0,8)}</small></th>
          <td data-label="Fecha"><time dateTime={item.due_date}>{dateText(item.due_date)}</time></td>
          <td data-label="Prioridad"><PriorityBadge priority={item.priority}/></td>
          <td data-label="Responsable">{item.responsible_name}</td>
          <td data-label="Estado"><span className="follow-up-status" data-status={item.status}>{followUpNames[item.status]}</span></td>
          <td className="follow-up-operations">
            {item.can_open&&<Button className="button outline" variant="outline" onClick={()=>openCase(item.case_id)}>Abrir caso</Button>}
            {actionable&&<Button className="button ghost" variant="ghost" onClick={()=>{setEditing(item);setDate(item.due_date);}}>Gestionar</Button>}
            {editing?.case_id===item.case_id&&<form className="integration-form" onSubmit={event=>{event.preventDefault();void update(item,'rescheduled');}}>
              <label>Nueva fecha<input type="date" required value={date} onChange={event=>setDate(event.target.value)}/></label>
              <Button className="button default" disabled={busy}>Confirmar fecha</Button>
              <Button className="button outline" type="button" variant="outline" disabled={busy} onClick={()=>void update(item,'completed')}>Marcar completado</Button>
              <Button className="button ghost" type="button" variant="ghost" disabled={busy} onClick={()=>void update(item,'cancelled')}>Cancelar seguimiento</Button>
              <Button className="button ghost" type="button" variant="ghost" onClick={()=>setEditing(null)} disabled={busy}>Volver</Button>
            </form>}
          </td>
        </tr>;
      })}</tbody></table>
    </div>}
    {data&&(offset>0||data.next_offset!==null)&&<div className="ops-actions">
      <Button className="button outline" variant="outline" disabled={!offset} onClick={()=>{setOffset(Math.max(0,offset-25));setData(undefined);}}>Anterior</Button>
      <Button className="button outline" variant="outline" disabled={data.next_offset===null} onClick={()=>{setOffset(data.next_offset!);setData(undefined);}}>Siguiente</Button>
    </div>}
  </section>;
}

export function CaseCloseForm({snapshot,close,confirmed,eligible}:{
  snapshot:CaseSnapshot;close:()=>void;confirmed:(snapshot:CaseSnapshot)=>void;eligible:boolean;
}) {
  const [evidence,setEvidence]=useState<'cliente'|'operativa'|'pendientes'|''>(
    snapshot.customer_resolution?.satisfied_message_id?'cliente':'');
  const [reason,setReason]=useState('');
  const [schedule,setSchedule]=useState(false);
  const [due,setDue]=useState<string>();
  const [outcome,setOutcome]=useState<'permanencia'|'baja'|'pendiente'>('pendiente');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const operation=useRef<{fingerprint:string;id:string}|undefined>(undefined);
  const [suggestionResult,setSuggestionResult]=useState<{key:string;suggestion:ClosureEvidenceSuggestion;error?:true}>();
  const [usedSuggestion,setUsedSuggestion]=useState('');
  const reasonInput=useRef<HTMLTextAreaElement>(null);
  const {id,revision}=snapshot;
  const lastMessage=snapshot.messages.at(-1)?.id ?? null;
  const confirmedByCustomer=!!snapshot.customer_resolution?.satisfied_message_id;
  const canSuggest=evidence==='operativa' || evidence==='cliente' && confirmedByCustomer;
  const suggestionKey=JSON.stringify([id,revision,lastMessage,evidence]);
  const currentSuggestion=suggestionResult?.key===suggestionKey ? suggestionResult : undefined;
  const stale=!!usedSuggestion && usedSuggestion!==suggestionKey;
  const current=snapshot.ml?.follow_up;
  const existing=current && current.status!=='cancelled';
  const effectiveDate=due ?? snapshot.ml?.recommended_due_date ?? '';
  const canSchedule=snapshot.verified && !existing;

  useEffect(()=>{
    if (!canSuggest) return;
    const pending=new AbortController();
    api.closureSuggestion(id,{case_revision:revision,last_message_id:lastMessage,evidence},pending.signal)
      .then(({suggestion})=>{if(!pending.signal.aborted)setSuggestionResult({key:suggestionKey,suggestion});})
      .catch(()=>{if(!pending.signal.aborted)setSuggestionResult({key:suggestionKey,suggestion:null,error:true});});
    return ()=>pending.abort();
  },[id,revision,lastMessage,evidence,canSuggest,suggestionKey]);

  function selectEvidence(value:typeof evidence) {
    setEvidence(value);setReason('');setUsedSuggestion('');setError('');
  }

  async function submit() {
    if (!evidence || stale || evidence==='cliente' && !confirmedByCustomer) return;
    const completion={case_revision:snapshot.revision,evidence,reason:reason.trim() || undefined,
      last_message_id:lastMessage,
      follow_up_date:schedule ? effectiveDate : undefined};
    const fingerprint=JSON.stringify([completion,outcome]);
    if (operation.current?.fingerprint!==fingerprint) operation.current={fingerprint,id:key()};
    setError('');setBusy(true);
    try {
      confirmed(await api.close(snapshot.id,evidence!=='pendientes',eligible?outcome:undefined,
        {...completion,idempotency_key:operation.current.id}));
    } catch(error) {setError(errorText(error));}
    finally {setBusy(false);}
  }

  return <form className="completion-form" onSubmit={event=>{event.preventDefault();void submit();}}>
    <p>El cierre quedará registrado en el historial de {snapshot.display_name}.</p>
    <label>Resultado del caso<select value={evidence} required onChange={event=>selectEvidence(event.target.value as typeof evidence)}>
      <option value="">Selecciona el resultado</option>
      {confirmedByCustomer&&<option value="cliente">Cerrar como resuelto · Confirmado por el cliente</option>}
      <option value="operativa">Cerrar como resuelto · Con evidencia operativa</option>
      <option value="pendientes">Cerrar con pendientes</option>
    </select></label>
    {canSuggest&&<section className="completion-suggestion" aria-label="Sugerencia de Copiloto" aria-live="polite">
      <strong><Sparkles size={16} aria-hidden="true"/> Sugerencia de Copiloto</strong>
      {!currentSuggestion ? <p role="status">Preparando la evidencia de resolución…</p>
        : currentSuggestion.suggestion ? <>
          <p>{currentSuggestion.suggestion.text}</p>
          <Button className="button outline" variant="outline" type="button" disabled={busy||usedSuggestion===suggestionKey} onClick={()=>{
            setReason(currentSuggestion.suggestion!.text);setUsedSuggestion(suggestionKey);setError('');
            reasonInput.current?.focus();
          }}>{usedSuggestion===suggestionKey?'Sugerencia aplicada':'Usar sugerencia'}</Button>
        </> : <p>{currentSuggestion.error?'No pudimos cargar la sugerencia. Puedes registrar la evidencia en el campo de abajo.'
          :'Puedes registrar la evidencia del resultado en el campo de abajo.'}</p>}
    </section>}
    {evidence&&<label>{evidence==='pendientes'?'Motivo y pendientes':'Evidencia de resolución'}
      <textarea ref={reasonInput} required={evidence!=='cliente'} minLength={3} maxLength={500} rows={3} value={reason}
        onChange={event=>{setReason(event.target.value);setUsedSuggestion('');}}/>
    </label>}
    {stale&&<p role="status">El caso se actualizó. Revisa la evidencia o usa la sugerencia actualizada.</p>}
    {eligible&&<label>Resultado de retención<select value={outcome} onChange={event=>setOutcome(event.target.value as typeof outcome)}>
      <option value="pendiente">Pendiente</option><option value="permanencia">Permanencia confirmada</option><option value="baja">Baja confirmada</option>
    </select></label>}
    {existing&&<p>Seguimiento {followUpNames[current.status].toLowerCase()} · {dateText(current.due_date)} · {current.responsible_name}</p>}
    {canSchedule&&<>
      <label className="checkbox"><input type="checkbox" checked={schedule} onChange={event=>setSchedule(event.target.checked)}/> Acordar seguimiento</label>
      {schedule&&<div className="follow-up-fields">
        <PriorityBadge priority={snapshot.ml?.churn.status==='available'?snapshot.ml.churn.priority:'sin_prediccion'}/>
        <label>Fecha acordada<input type="date" required value={effectiveDate} onChange={event=>setDue(event.target.value)}/></label>
      </div>}
    </>}
    {error&&<p className="alert error" role="alert">{error}</p>}
    <div className="modal-actions">
      <Button className="button outline" type="button" variant="outline" onClick={close} disabled={busy}>Volver</Button>
      <Button className="button default" disabled={busy||!evidence||stale||(evidence==='cliente'&&!confirmedByCustomer)}>{busy?'Cerrando…':'Confirmar cierre'}</Button>
    </div>
  </form>;
}
