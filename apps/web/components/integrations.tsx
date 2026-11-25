'use client';

import { Tabs } from 'radix-ui';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BillingView, CaseSnapshot, CrmView, IntegrationOperation, InvoiceDetail, ManualAction } from '@claro/contracts';
import { ADVISOR_ADJUSTMENT_LIMIT } from '@claro/contracts';
import { integrations, key } from '@/lib/api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './ui/dialog';
import { RetentionBilling, RetentionControls } from './retention';

const currency = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0});
const money = (value: number) => currency.format(value);
const message = (error: unknown) => error instanceof Error ? error.message : 'Intenta de nuevo en unos segundos.';
const categories = {
  soporte_tecnico:'Soporte técnico',facturacion:'Facturación',consulta_planes:'Consulta de planes',
  cancelacion:'Cancelación',portabilidad:'Portabilidad'
};
const invoiceStates={pendiente:'Pendiente',vencida:'Vencida',pagada:'Pagada'};
const operationStatus = {
  queued:'En cola',pending_supervisor:'Pendiente de aprobación',pending_verification:'Pendiente de verificación',
  confirmed:'Confirmada',rejected:'Rechazada',expired:'Vencida'
};
const operationName = { ticket:'Ticket',offer:'Oferta',adjustment:'Ajuste' };
const rejectedReason: Record<string,string> = {
  AJUSTE_SUPERA_SALDO:'El importe supera el saldo disponible.',
  NO_ELEGIBLE:'El cliente dejó de cumplir la política de retención.',
  FACTURA_NO_ENCONTRADA:'La factura no está disponible para esta cuenta.'
};

function useProvider<T>(read: () => Promise<T>, revision = 0, enabled = true) {
  const [result,setResult] = useState<{data?: T; error?: string}>({});
  const [retry,setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setResult({});
    read().then(data => { if (active) setResult({data}); }, error => { if (active) setResult({error:message(error)}); });
    return () => { active = false; };
  },[read,retry,revision,enabled]);
  return {...result,retry:() => setRetry(n => n+1)};
}

function IntegrationLoading({name,error,retry}:{name:string;error?:string;retry:()=>void}) {
  return error ? <div className="alert error" role="alert"><p>{error}</p><Button size="sm" variant="outline" onClick={retry}>Reintentar {name}</Button></div>
    : <p role="status">Consultando {name}…</p>;
}

type Draft = { kind:'ticket' } | { kind:'offer'; option: CrmView['eligibility']['options'][number] } | { kind:'adjustment'; invoice: InvoiceDetail };

function ActionDialog({draft,confirm,close}:{draft:Draft;confirm:(action:ManualAction)=>Promise<void>;close:()=>void}) {
  const [category,setCategory] = useState<Extract<ManualAction,{kind:'ticket'}>['ticket']['categoria']>('soporte_tecnico');
  const [description,setDescription] = useState('');
  const [value,setValue] = useState('');
  const [accepted,setAccepted] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const adjustment = draft.kind === 'adjustment' ? draft.invoice : null;
  const approval = adjustment && adjustment.total_ajustado + Number(value) > ADVISOR_ADJUSTMENT_LIMIT;
  const title = draft.kind === 'ticket' ? 'Registrar ticket en CRM' : draft.kind === 'offer' ? 'Registrar oferta en CRM' : 'Solicitar ajuste de factura';
  async function submit() {
    let action: ManualAction;
    if (draft.kind === 'ticket') action = {kind:'ticket',ticket:{categoria:category,descripcion:description.trim(),prioridad:'estandar'}};
    else if (draft.kind === 'offer') action = {kind:'offer',codigo:draft.option.codigo,customer_accepted:true};
    else action = {kind:'adjustment',invoice_id:draft.invoice.factura_id,adjustment:{valor:Number(value),motivo:description.trim()}};
    setBusy(true);
    setError('');
    try {
      await confirm(action);
    } catch (error) {
      setError(message(error));
      setBusy(false);
    }
  }
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)close();}}>
    <DialogContent className="modal" showCloseButton={false}>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{draft.kind === 'offer' ? draft.option.detail : adjustment ? `${adjustment.factura_id} · saldo disponible ${money(adjustment.saldo_abierto)}` : 'La solicitud quedará registrada en el historial del cliente.'}</DialogDescription>
      <form className="integration-form" onSubmit={event=>{event.preventDefault();void submit();}}>
        {draft.kind === 'ticket' && <label>Categoría<select value={category} onChange={event=>setCategory(event.target.value as typeof category)}>
          {Object.entries(categories).map(([id,label])=><option key={id} value={id}>{label}</option>)}
        </select></label>}
        {draft.kind === 'offer' ? <label className="integration-check">
          <input type="checkbox" checked={accepted} onChange={event=>setAccepted(event.target.checked)} required/>
          <span>Confirmo que el cliente aceptó {draft.option.title.toLowerCase()}.</span>
        </label> : <>
          {adjustment && <label>Importe del ajuste en COP<input type="number" min="1" max={adjustment.saldo_abierto} step="1" required value={value} onChange={event=>setValue(event.target.value)}/></label>}
          <label>{adjustment?'Motivo del ajuste':'Descripción del ticket'}<textarea rows={3} maxLength={1000} required value={description} onChange={event=>setDescription(event.target.value)}/></label>
          {approval && <p role="status">El acumulado requiere aprobación de un administrador.</p>}
        </>}
        {error && <p className="alert error" role="alert">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={close}>Cancelar</Button>
          <Button type="submit" disabled={busy||(draft.kind==='offer'?!accepted:!description.trim())}>
            {busy?'Enviando…':approval?'Solicitar aprobación':'Confirmar registro'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

type RetentionUi={snapshot:CaseSnapshot;canIssue:boolean;onUse:(text:string)=>void;refresh:()=>Promise<unknown>};
function CrmPanel({caseId,open,revision,prepare,retention}:{caseId:string;open:boolean;revision:number;
  prepare:(draft:Draft)=>void;retention?:RetentionUi}) {
  const read = useCallback(()=>integrations.crm(caseId),[caseId]);
  const result = useProvider(read,revision);
  if (!result.data) return <IntegrationLoading name="CRM" {...result}/>;
  const {customer,eligibility} = result.data;
  return <>
    <dl className="integration-details">
      <div><dt>Cliente</dt><dd>{customer.cliente_id} · {customer.ciudad}</dd></div>
      <div><dt>Estado</dt><dd>{customer.estado}</dd></div>
      <div><dt>Mora registrada</dt><dd>{customer.dias_mora} días</dd></div>
    </dl>
    <h3>Servicios activos</h3>
    <ul>{customer.servicios.filter(service=>service.estado==='activo').map(service=><li key={service.servicio_id}><strong>{service.plan}</strong><span>{money(service.valor_mensual)} / mes</span></li>)}</ul>
    <h3>Tickets de los últimos 90 días</h3>
    {customer.tickets_recientes.length ? <ul>{customer.tickets_recientes.map(ticket=><li key={ticket.ticket_id}>
      <strong>{categories[ticket.categoria]}</strong><span className="integration-ref">{ticket.ticket_id} · {ticket.estado} · {ticket.fecha}</span>
    </li>)}</ul> : <p>Sin tickets en este período.</p>}
    {open&&<Button size="sm" variant="outline" onClick={()=>prepare({kind:'ticket'})}>Registrar ticket</Button>}
    <h3>Retención</h3>
    <p>{eligibility.reason}</p>
    {eligibility.options.map(option=><div className="integration-choice" key={option.codigo}>
      <strong>{option.title}</strong><p>{option.detail}</p>
      {open&&!(retention?.snapshot.channel==='web'&&option.discount)&&<Button size="sm" variant="outline" onClick={()=>prepare({kind:'offer',option})}>Registrar {option.codigo}</Button>}
    </div>)}
    {retention&&<RetentionControls {...retention} crm={result.data} open={open}/>}
    {customer.ofertas_retencion_12m.length>0&&<ul>{customer.ofertas_retencion_12m.map((offer,index)=><li key={offer.codigo+index}>
      <strong>{offer.codigo} · {offer.fecha}</strong><span>{offer.descripcion}</span>
    </li>)}</ul>}
  </>;
}

type InvoiceRead = (ref: string) => Promise<InvoiceDetail>;
type PrepareAdjustment = (draft: Extract<Draft, {kind: 'adjustment'}>) => void;

function InvoicePanel({refId, readInvoice, revision, prepare}: {
  refId: string; readInvoice: InvoiceRead; revision: number; prepare?: PrepareAdjustment;
}) {
  const read = useCallback(() => readInvoice(refId), [readInvoice, refId]);
  const result = useProvider(read, revision);
  if (!result.data) return <IntegrationLoading name="factura" {...result}/>;
  const invoice = result.data;
  return <div className="integration-choice">
    <h3>Detalle de {invoice.factura_id}</h3>
    <p>Corte {invoice.fecha_corte} · vence {invoice.fecha_limite_pago}</p>
    <ul>{invoice.detalle.map((line,index)=><li key={line.concepto+index}><span>{line.concepto}</span><strong>{money(line.valor)}</strong></li>)}</ul>
    {!!invoice.descuentos?.length&&<><h3>Descuentos aplicados</h3><ul>{invoice.descuentos.map(item=><li key={item.offer_ref}>
      <strong>{item.plan} · {item.percentage} %</strong>
      <span>Cargo fijo {money(item.base)} · descuento {money(item.amount)} · neto {money(item.net)}</span>
    </li>)}</ul></>}
    <p>Saldo abierto <strong>{money(invoice.saldo_abierto)}</strong></p>
    {invoice.ajustes.length>0&&<><h3>Ajustes aplicados</h3><ul>{invoice.ajustes.map(credit=><li key={credit.ajuste_id}><span>{credit.fecha} · {credit.motivo}</span><strong>−{money(credit.valor)}</strong></li>)}</ul></>}
    {prepare && invoice.saldo_abierto>0 && <Button size="sm" variant="outline" onClick={()=>prepare({kind:'adjustment',invoice})}>Solicitar ajuste</Button>}
  </div>;
}

function BillingPanel({read, readInvoice, revision = 0, prepare, directory = false, recentInvoice}: {
  read: () => Promise<BillingView | null>; readInvoice: InvoiceRead; revision?: number; prepare?: PrepareAdjustment; directory?: boolean;
  recentInvoice?:string;
}) {
  const result = useProvider(read, revision);
  const [selection,setSelection] = useState<{value:string|null;recent?:string}>();
  const selected=selection?.recent===recentInvoice ? selection?.value : recentInvoice;
  if (result.data === null) return <p role="status">Esta cuenta aún no tiene registro en Facturación.</p>;
  if (!result.data) return <IntegrationLoading name="Facturación" {...result}/>;
  const {balance,invoices} = result.data;
  return <>
    <dl className="integration-details">
      <div><dt>Saldo impago</dt><dd>{money(balance.saldo_pendiente)}</dd></div>
      <div><dt>Subtotal vencido</dt><dd>{money(balance.saldo_vencido)}</dd></div>
      <div><dt>Próximo vencimiento</dt><dd>{balance.proxima_fecha_limite ?? 'Sin vencimientos pendientes'}</dd></div>
    </dl>
    <h3>Facturas</h3>
    {invoices.length ? <ul className="integration-invoices">{invoices.map(invoice=><li key={invoice.factura_id}>
      {directory ? <>
        <div><strong>{invoice.periodo}</strong><span className="integration-ref">{invoice.factura_id}</span></div>
        <strong className="integration-invoice-total">{money(invoice.valor_total)}</strong>
      </> : <strong>{invoice.periodo} · {money(invoice.valor_total)}</strong>}
      <span className="integration-invoice-state" data-state={invoice.estado !== 'pagada' && invoice.saldo_abierto===0 ? 'ajuste' : invoice.estado}>
        {invoice.estado !== 'pagada' && invoice.saldo_abierto === 0 ? 'Saldada por ajuste' : invoiceStates[invoice.estado]}
      </span>
      <Button size="sm" variant="outline" aria-expanded={selected===invoice.factura_id}
        onClick={()=>setSelection({value:selected===invoice.factura_id?null:invoice.factura_id,recent:recentInvoice})}>
        Ver factura {invoice.factura_id}
      </Button>
      {selected===invoice.factura_id&&<InvoicePanel refId={invoice.factura_id} readInvoice={readInvoice} revision={revision} prepare={prepare}/>}
    </li>)}</ul> : <p>Sin facturas para esta cuenta.</p>}
  </>;
}

export function DirectoryBillingPanel({customerId}: {customerId: string}) {
  const read = useCallback(() => integrations.directoryBilling(customerId), [customerId]);
  const readInvoice = useCallback((ref: string) => integrations.directoryInvoice(customerId, ref), [customerId]);
  return <BillingPanel key={customerId} read={read} readInvoice={readInvoice} directory/>;
}

export function CaseIntegrationTabs({caseId,enabled,open,customerRegistration,children,retention}:{caseId:string;enabled:boolean;open:boolean;
  customerRegistration?:ReactNode;children:ReactNode;retention?:RetentionUi}) {
  const [draft,setDraft] = useState<Draft|null>(null);
  const readBilling = useCallback(() => integrations.billing(caseId), [caseId]);
  const readInvoice = useCallback((ref: string) => integrations.invoice(caseId, ref), [caseId]);
  const [tab,setTab] = useState('summary');
  const [operations,setOperations] = useState<IntegrationOperation[]>([]);
  const [operationError,setOperationError] = useState('');
  const [revision,setRevision] = useState(0);
  const [recentInvoice,setRecentInvoice]=useState<string>();
  const previousConfirmed = useRef('');
  const submission = useRef<{ fingerprint:string; key:string }|null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await integrations.operations(caseId);
      setOperations(next);
      setOperationError('');
      const confirmed = next.filter(op=>op.status==='confirmed').map(op=>op.id).join(',');
      if (confirmed !== previousConfirmed.current) {
        previousConfirmed.current = confirmed;
        setRevision(n=>n+1);
      }
    } catch (error) {
      setOperationError(message(error));
    }
  },[caseId]);
  useEffect(()=>{
    if (!enabled || tab === 'summary') return;
    void refresh();
    const timer = window.setInterval(()=>{if (document.visibilityState==='visible') void refresh();},3000);
    return ()=>window.clearInterval(timer);
  },[enabled,tab,refresh]);
  async function confirm(action:ManualAction) {
    const fingerprint = JSON.stringify(action);
    if (submission.current?.fingerprint !== fingerprint) submission.current = {fingerprint,key:key()};
    const result = await integrations.confirm(caseId,action,submission.current.key);
    setOperations(current=>[result,...current.filter(item=>item.id!==result.id)]);
    submission.current = null;
    setDraft(null);
    await refresh();
  }
  const history = (target:'crm'|'billing') => {
    const relevant = operations.filter(item=>(target==='billing')===(item.action.kind==='adjustment'));
    return <>
      {operationError && <p role="alert">{operationError} <Button size="sm" variant="outline" onClick={()=>void refresh()}>Reintentar historial</Button></p>}
      {relevant.length>0&&<><h3>Operaciones de este caso</h3><ul aria-live="polite">{relevant.map(item=><li key={item.id}>
        <strong>{operationName[item.action.kind]} · {operationStatus[item.status]}</strong>
        {item.reference && <span className="integration-ref">Recibo {item.reference}</span>}
        {item.status==='rejected' && item.failure_code && <span>{rejectedReason[item.failure_code] ?? 'La API rechazó la operación.'}</span>}
      </li>)}</ul></>}
    </>;
  };
  return <Tabs.Root value={tab} onValueChange={setTab}>
    <Tabs.List className="integration-tabs assisted-primary-tabs" aria-label="Ficha del caso">
      <Tabs.Trigger value="summary">Resumen</Tabs.Trigger><Tabs.Trigger value="customer">Datos del cliente</Tabs.Trigger>
    </Tabs.List>
    <Tabs.Content value="summary">{children}</Tabs.Content>
    <Tabs.Content value="customer">
      <Tabs.Root defaultValue="crm">
        <Tabs.List className="integration-tabs assisted-secondary-tabs" aria-label="Datos del cliente">
          <Tabs.Trigger value="crm">CRM</Tabs.Trigger><Tabs.Trigger value="billing">Facturación</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="crm" className="integration-panel">
          {enabled ? <><Badge variant="secondary">CRM · API mock</Badge>
            <CrmPanel caseId={caseId} open={open} revision={revision} prepare={setDraft} retention={retention}/>{history('crm')}</>
            : customerRegistration ?? <p>El cliente debe verificar su titularidad para consultar CRM.</p>}
        </Tabs.Content>
        <Tabs.Content value="billing" className="integration-panel">
          {enabled ? <><Badge variant="secondary">Facturación · API mock</Badge>
            {retention&&<RetentionBilling snapshot={retention.snapshot} canIssue={retention.canIssue} updated={async invoice=>{
              setRecentInvoice(invoice);setRevision(value=>value+1);await retention.refresh();
            }}/>}
            <BillingPanel key={caseId} read={readBilling} readInvoice={readInvoice} revision={revision} recentInvoice={recentInvoice}
              prepare={open ? setDraft : undefined}/>
            {history('billing')}</> : <p>El cliente debe verificar su titularidad para consultar Facturación.</p>}
        </Tabs.Content>
      </Tabs.Root>
    </Tabs.Content>
    {draft && <ActionDialog draft={draft} confirm={confirm} close={()=>setDraft(null)}/>}
  </Tabs.Root>;
}

export function AdminIntegrations() {
  const health = useProvider(integrations.health);
  const queue = useProvider(integrations.approvals);
  const [selected,setSelected] = useState<{item:IntegrationOperation;approved:boolean}|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  async function decide() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await integrations.approve(selected.item.id,selected.approved);
      setSelected(null);
      queue.retry();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return <>
    <section className="admin-card integration-panel">
      <h2>Integraciones mock</h2>
      {health.data?<><p>Latencia de la verificación actual y errores de las últimas 24 horas.</p>
        {health.data.map(item=><div className="provider" key={item.service}>
          <span><strong>{item.service==='crm'?'CRM':'Facturación'}</strong><small className="integration-admin-meta">{item.latency_ms} ms · {item.errors} errores / {item.requests} solicitudes</small></span>
          <Badge variant={item.available?'secondary':'destructive'}>{item.available?'Disponible':'Indisponible'}</Badge>
        </div>)}
        <Button variant="outline" size="sm" onClick={health.retry}>Actualizar estado</Button></>
        : <IntegrationLoading name="integraciones" {...health}/>}
    </section>
    <section className="admin-card integration-panel">
      <h2>Aprobaciones de facturación</h2>
      {queue.data?<>{queue.data.length? <ul>{queue.data.map(item=>item.action.kind==='adjustment'&&<li key={item.id}>
        <strong>{item.action.invoice_id} · {money(item.action.adjustment.valor)}</strong>
        <span>{item.action.adjustment.motivo}</span>
        <div className="integration-buttons">
          <Button size="sm" onClick={()=>setSelected({item,approved:true})}>Aprobar ajuste</Button>
          <Button size="sm" variant="outline" onClick={()=>setSelected({item,approved:false})}>Rechazar</Button>
        </div>
      </li>)}</ul>:<p>Sin ajustes pendientes de aprobación.</p>}
      <Button variant="outline" size="sm" onClick={queue.retry}>Actualizar solicitudes</Button></>
      : <IntegrationLoading name="aprobaciones" {...queue}/>}
    </section>
    {selected&&<Dialog open onOpenChange={open=>{if(!open&&!busy){setSelected(null);setError('');}}}>
      <DialogContent className="modal" showCloseButton={false}>
        <DialogTitle>{selected.approved?'Aprobar ajuste':'Rechazar ajuste'}</DialogTitle>
        <DialogDescription>{selected.item.action.kind==='adjustment'? `${selected.item.action.invoice_id} · ${money(selected.item.action.adjustment.valor)}`:''}</DialogDescription>
        {error&&<p className="alert error" role="alert">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={()=>{setSelected(null);setError('');}}>Volver</Button>
          <Button disabled={busy} onClick={()=>void decide()}>{selected.approved?'Confirmar aprobación':'Confirmar rechazo'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>}
  </>;
}
