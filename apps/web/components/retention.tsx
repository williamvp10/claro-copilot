'use client';

import { useEffect, useRef, useState } from 'react';
import type { CaseDiscount, CaseSnapshot, CrmView } from '@claro/contracts';
import { api, key, type RetentionState } from '@/lib/api';
import { Button } from './ui/button';

const money=(amount:number)=>new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(amount);
const statusLabel={
  requested:'En revisión de Administración',authorized:'Autorizado · Falta aceptación',
  accepted:'Aceptado · Pendiente en CRM',crm_confirmed:'Confirmado en CRM · Pendiente en Facturación',
  scheduled:'Programado en Facturación'
} as const;
const errorText=(error:unknown)=>error instanceof Error ? error.message : 'Intenta de nuevo en unos segundos.';

export function RetentionStateDetails({discount}:{discount:CaseDiscount}) {
  const {terms,schedule}=discount;
  const amount=Math.round(terms.base*terms.percentage/100);
  return <div className="retention-terms">
    <p role="status"><strong>{schedule?.last_invoice?'Aplicado en factura':statusLabel[discount.status]}</strong>
      {schedule?.last_invoice&&` · ${schedule.last_invoice}`}</p>
    <strong>{terms.percentage} % sobre el cargo fijo de {terms.plan}</strong>
    <dl className="integration-details">
      <div><dt>Cargo fijo</dt><dd>{money(terms.base)}</dd></div>
      <div><dt>Descuento</dt><dd>{money(amount)}</dd></div>
      <div><dt>Cargo fijo neto</dt><dd>{money(terms.base-amount)}</dd></div>
      <div><dt>Duración</dt><dd>{terms.cycles} ciclos</dd></div>
    </dl>
    {schedule&&<p>Vigencia de {schedule.start_period} a {schedule.end_period}</p>}
    {discount.error&&<p className="alert error" role="alert">El proveedor requiere revisión antes de completar el registro.</p>}
  </div>;
}

export function RetentionControls({snapshot,crm,open,onUse,refresh}:{
  snapshot:CaseSnapshot;crm:CrmView;open:boolean;onUse:(text:string)=>void;refresh:()=>Promise<unknown>;
}) {
  const [details,setDetails]=useState<RetentionState>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [amount,setAmount]=useState('');
  const [serviceId,setServiceId]=useState('');
  const [reason,setReason]=useState('');
  const [editing,setEditing]=useState(false);
  const [attempt,setAttempt]=useState(0);
  const submission=useRef<{fingerprint:string;id:string}|undefined>(undefined);
  const discount=snapshot.retention_discount ?? details?.discount;
  const {id,revision}=snapshot;
  useEffect(()=>{
    let active=true;
    api.retention(id).then(data=>{if(active)setDetails(data);},error=>{if(active)setError(errorText(error));});
    return ()=>{active=false;};
  },[id,revision,attempt]);

  async function update(input:Record<string,unknown>) {
    const body={...input,case_revision:revision};
    const fingerprint=JSON.stringify(body);
    if (submission.current?.fingerprint!==fingerprint) submission.current={fingerprint,id:key()};
    setBusy(true);setError('');
    try {
      await api.updateRetention(id,{...body,idempotency_key:submission.current.id});
      setEditing(false);setReason('');setAmount('');
      await refresh();
    } catch (error) {setError(errorText(error));}
    finally {setBusy(false);}
  }

  const services=crm.customer.servicios.filter(item=>item.estado==='activo' && item.valor_mensual>0);
  const service=services.find(item=>item.servicio_id===serviceId);
  const standard=details?.standard;
  const available=Boolean(open && standard && (!discount || discount.status==='scheduled' && details?.can_authorize));
  const percent=amount ? Number(amount) : standard?.percentage ?? 0;
  const needsReview=!details?.can_authorize && percent>(standard?.percentage ?? 0);
  const lastCustomer=snapshot.messages.filter(item=>item.actor==='cliente' && !item.verification_input).at(-1);
  if (!details && !discount && !error) return <p role="status">Revisando opciones de descuento…</p>;
  if (!discount && !available && !error) return null;
  return <section className="retention-controls" aria-label="Descuento de retención">
    {discount&&<RetentionStateDetails discount={discount}/>}
    {discount&&open&&discount.status==='requested'&&(details?.can_authorize ?
      <Button className="button default" onClick={()=>void update({action:'authorize'})} disabled={busy}>Autorizar excepción</Button> :
      <p>Solicita un escalamiento a Comercial y portabilidad para que Administración revise la excepción.</p>)}
    {discount&&open&&discount.status==='authorized'&&<div className="retention-actions">
      <Button className="button outline" variant="outline" onClick={()=>onUse(`Puedo ofrecerte un ${discount.terms.percentage} % de descuento sobre el cargo fijo de ${discount.terms.plan} durante ${discount.terms.cycles} ciclos de facturación. ¿Aceptas estas condiciones?`)}>Usar términos en respuesta</Button>
      {lastCustomer && lastCustomer.turn_seq>(discount.authorized_turn ?? 0)&&<>
        <blockquote>{lastCustomer.text}</blockquote>
        <Button className="button default" disabled={busy} onClick={()=>void update({action:'accept',message_id:lastCustomer.id})}>Confirmar aceptación</Button>
      </>}
    </div>}
    {discount&&open&&discount.error&&['accepted','crm_confirmed'].includes(discount.status)&&
      <Button className="button outline" variant="outline" disabled={busy} onClick={()=>void update({action:'retry'})}>Reintentar sincronización</Button>}
    {available&&!editing&&<Button className="button outline" variant="outline" onClick={()=>{
      setServiceId(discount?.terms.service_id ?? (services.length===1 ? services[0].servicio_id : ''));
      setAmount(String(snapshot.card?.requested_discount && snapshot.card.requested_discount<=(details?.maximum ?? 0) ?
        Math.max(snapshot.card.requested_discount,standard!.percentage) : standard!.percentage));
      setEditing(true);
    }}>{details?.amendment?'Revisar oferta vigente':'Preparar descuento'}</Button>}
    {available&&editing&&standard&&<form className="integration-form" onSubmit={event=>{
      event.preventDefault();void update({action:'prepare',service_id:serviceId,percentage:percent,reason:reason.trim()});
    }}>
      <label>Servicio<select required value={serviceId} disabled={!!discount?.crm_ref} onChange={event=>setServiceId(event.target.value)}>
        <option value="">Selecciona el servicio</option>
        {services.map(item=><option key={item.servicio_id} value={item.servicio_id}>{item.plan}</option>)}
      </select></label>
      <label>Porcentaje de descuento<input type="number" required min={standard.percentage} max={details?.maximum} step={1}
        value={amount} onChange={event=>setAmount(event.target.value)}/></label>
      <p>Política vigente durante {standard.cycles} ciclos · Hasta {details?.maximum} % con autorización.</p>
      {service&&<p>Cargo fijo de {money(service.valor_mensual)}. Con el beneficio quedaría en {money(service.valor_mensual-Math.round(service.valor_mensual*percent/100))}.</p>}
      <label>Motivo<textarea required minLength={3} maxLength={240} rows={2} value={reason} onChange={event=>setReason(event.target.value)}/></label>
      <div className="retention-actions">
        <Button className="button default" disabled={busy}>{busy?'Guardando…':needsReview?'Solicitar revisión':details?.amendment?'Autorizar enmienda':'Confirmar términos'}</Button>
        <Button className="button outline" type="button" variant="outline" onClick={()=>setEditing(false)} disabled={busy}>Cancelar</Button>
      </div>
    </form>}
    {error&&<p className="alert error" role="alert">{error}
      {!details&&<Button className="button outline" variant="outline" onClick={()=>{setError('');setAttempt(value=>value+1);}}>Reintentar</Button>}
    </p>}
  </section>;
}

export function RetentionBilling({snapshot,canIssue,updated}:{
  snapshot:CaseSnapshot;canIssue:boolean;updated:(invoiceId:string)=>Promise<unknown>;
}) {
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const discount=snapshot.retention_discount;
  if (!discount) return null;
  const schedule=discount.schedule;
  async function issue() {
    if (!schedule) return;
    setBusy(true);setError('');
    try {
      const invoice=await api.issueRetentionInvoice(snapshot.id,schedule.next_period);
      await updated(invoice.factura_id);
    } catch(error) {setError(errorText(error));}
    finally {setBusy(false);}
  }

  return <section className="retention-controls" aria-label="Beneficio en Facturación">
    <h3>Beneficio de retención</h3>
    <RetentionStateDetails discount={discount}/>
    {canIssue&&schedule&&<Button className="button outline" variant="outline" disabled={busy} onClick={()=>void issue()}>
      {busy?'Emitiendo…':`Emitir factura de prueba · ${schedule.next_period}`}
    </Button>}
    {error&&<p className="alert error" role="alert">{error}</p>}
  </section>;
}
