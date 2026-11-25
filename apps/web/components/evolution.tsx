'use client';

import { ArrowUpRight, Sparkles, ChevronDown, ChevronRight, ContactRound, History, Layers, ReceiptText, Search, Smartphone, Tag, Ticket, Wifi, X } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { DirectoryBillingPanel } from './integrations';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { key } from '@/lib/api';
import { escalationDestinations, type CaseMlSignals, type CaseSnapshot, type CrmView, type Intent, type EscalationDestination } from '@claro/contracts';
import styles from './customer-directory.module.css';

const endpoint='/api/v1';
async function request<T>(path:string, init?:RequestInit):Promise<T>{
  const response=await fetch(endpoint+path,{credentials:'same-origin',...init,headers:{'Content-Type':'application/json',...init?.headers}});
  if(!response.ok){let message=`No fue posible completar la solicitud (${response.status}).`;try{const body=await response.json();if(typeof body.message==='string')message=body.message;}catch{}throw new Error(message);}
  return response.json() as Promise<T>;
}
const post=<T,>(path:string,body:unknown)=>request<T>(path,{method:'POST',body:JSON.stringify(body)});
const errorText=(e:unknown)=>e instanceof Error?e.message:'No fue posible completar la solicitud.';
const destinations:Record<string,string>=escalationDestinations;
type Escalation={id:string;case_id:string;destination:EscalationDestination;reason_code:string;status:string;
  requested_by:string;created_at:string;owner_id:string|null;case_revision:number;can_claim:boolean};
type EscalationTracking=NonNullable<CaseSnapshot['tracking']>['escalation'];

export function EscalationRequest({caseId,revision,turnId,active,suggestion,onDone}:{
  caseId:string;revision:number;turnId?:string;active?:EscalationTracking;
  suggestion?:{destination:EscalationDestination;reason_code:string};onDone:()=>Promise<CaseSnapshot>
}) {
  const path=`/cases/${encodeURIComponent(caseId)}/escalations`;
  const [open,setOpen]=useState(false);
  const [destination,setDestination]=useState<EscalationDestination|''>('');
  const [reason,setReason]=useState('');
  const [preview,setPreview]=useState('');
  const [generating,setGenerating]=useState(false);
  const [generationNotice,setGenerationNotice]=useState('');
  const [attempt,setAttempt]=useState(0);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [receipt,setReceipt]=useState<{id:string;destination:EscalationDestination;status:string}>();
  const submission=useRef<{fingerprint:string;key:string}|undefined>(undefined);
  const waiting=active?.status==='en_cola' ? active : receipt?.status==='en_cola' && active?.id!==receipt.id ? receipt : null;
  const forwarding=active?.status==='tomado';

  useEffect(()=>{
    if (!open || !destination) return;
    const controller=new AbortController();
    setGenerating(true);setPreview('');setGenerationNotice('');
    request<{suggestion:{text:string}|null}>(path+'/suggestion',{
      method:'POST',body:JSON.stringify({destination,case_revision:revision}),signal:controller.signal
    }).then(({suggestion:generated})=>{
      if (controller.signal.aborted) return;
      if (generated) setPreview(generated.text);
      else setGenerationNotice('Puedes escribir el motivo o volver a pedir una sugerencia.');
    }).catch(failure=>{if(!controller.signal.aborted)setGenerationNotice(errorText(failure));})
      .finally(()=>{if(!controller.signal.aborted)setGenerating(false);});
    return ()=>controller.abort();
  },[open,destination,revision,turnId,attempt,path]);

  async function submit(e:React.FormEvent) {
    e.preventDefault();
    if (!destination || busy) return;
    setBusy(true);setError('');
    const body={destination,reason_text:reason.trim(),case_revision:revision,
      ...(destination===suggestion?.destination ? {reason_code:suggestion.reason_code} : {})};
    const fingerprint=JSON.stringify(body);
    if (submission.current?.fingerprint!==fingerprint) submission.current={fingerprint,key:key()};
    try {
      const confirmed=await post<NonNullable<typeof receipt>>(path,{...body,idempotency_key:submission.current.key});
      setReceipt(confirmed);setOpen(false);setReason('');
      await onDone().catch(()=>undefined);
    } catch (failure) {
      const current=await onDone().catch(()=>undefined);
      if (current?.tracking?.escalation?.status==='en_cola') {setOpen(false);setReason('');}
      else setError(errorText(failure));
    } finally {setBusy(false);}
  }

  if (waiting) return <p className="assisted-escalation-status" role="status"><ArrowUpRight size={16} aria-hidden="true"/>
    <span><strong>Caso escalado</strong><small>En espera de {destinations[waiting.destination]}</small></span>
  </p>;
  return <div className="assisted-escalation">
    {!open ? <>
      {forwarding&&<p className="assisted-escalation-status" data-stage="taken"><ArrowUpRight size={16} aria-hidden="true"/> Nivel 2 · En atención</p>}
      <Button className="assisted-escalation-button" variant="outline" onClick={()=>{
        setDestination(forwarding ? 'supervision' : suggestion?.destination ?? '');
        setOpen(true);setError('');
      }}><ArrowUpRight size={16} aria-hidden="true"/>{forwarding?'Derivar a Supervisión':'Solicitar escalamiento'}</Button>
    </> : <form onSubmit={submit} className="evo-form">
      <h3>Solicitar escalamiento</h3>
      <p>El cliente podrá seguir escribiendo mientras el equipo lo toma.</p>
      <label>Destino<select value={destination} required onChange={event=>setDestination(event.target.value as EscalationDestination)}>
        <option value="">Elige el equipo</option>
        {Object.entries(destinations).filter(([value])=>!forwarding||value==='supervision').map(([value,label])=>
          <option key={value} value={value}>{label}</option>)}
      </select></label>
      {destination&&<div className="assisted-reason-preview">
        <strong><Sparkles size={15} aria-hidden="true"/> Motivo sugerido por IA</strong>
        {generating ? <p role="status">Preparando una sugerencia…</p> : <>
          {preview ? <><p>{preview}</p><Button type="button" variant="outline" onClick={()=>setReason(preview)}>Usar motivo</Button></>
            : generationNotice&&<p role="status">{generationNotice}</p>}
          <Button type="button" variant="ghost" onClick={()=>setAttempt(value=>value+1)}>Sugerir de nuevo</Button>
        </>}
      </div>}
      <label>Motivo para el equipo receptor<textarea required minLength={3} maxLength={500} value={reason}
        onChange={event=>setReason(event.target.value)} rows={3}/></label>
      {error&&<p className="alert error" role="alert">{error}</p>}
      <div className="ops-actions"><Button disabled={busy||!destination||reason.trim().length<3}>{busy?'Enviando solicitud…':'Confirmar solicitud'}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={()=>setOpen(false)}>Cancelar</Button></div>
    </form>}
  </div>;
}

export function EscalationQueue({openCase,viewerId,canManage=false}:{openCase:(id:string)=>void;viewerId:string;canManage?:boolean}) {
  const [items,setItems]=useState<Escalation[]>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState('');
  const load=useCallback(async()=>{
    try {setItems(await request<Escalation[]>('/escalations'));setError('');}
    catch (failure) {setError(errorText(failure));}
  },[]);
  useEffect(()=>{
    void load();
    const stream=new EventSource('/api/v1/escalations/events');
    stream.addEventListener('escalations.updated',event=>{
      try {setItems(JSON.parse((event as MessageEvent).data));setError('');} catch {void load();}
    });
    stream.onerror=()=>void load();
    return ()=>stream.close();
  },[load]);
  async function transition(row:Escalation,action:'claim'|'cancel'|'resolve') {
    setBusy(row.id);setError('');
    try {
      await post(`/escalations/${encodeURIComponent(row.id)}/${action}`,{case_revision:row.case_revision});
      await load();
      if(action==='claim') openCase(row.case_id);
    } catch (failure) {await load();setError(errorText(failure));}
    finally {setBusy('');}
  }
  return <div className="admin-page evo-page">
    <header className="ops-header"><div><h1>Escalamientos</h1><p>Casos en espera de nivel 2, del más antiguo al más nuevo.</p></div>
      <Button variant="outline" onClick={()=>void load()}>Actualizar</Button></header>
    {error&&<p className="alert error" role="alert">{error}</p>}
    {!items&&!error ? <p role="status">Cargando cola…</p> : items?.length ?
      <div className="evo-list">{items.map(row=><article className="ops-plot" key={row.id}>
        <div className="evo-row"><div><h3>{destinations[row.destination]}</h3>
          <p>{row.case_id.slice(0,8)} · {new Date(row.created_at).toLocaleString('es-CO',{timeZone:'America/Bogota'})}</p></div>
          <span className={`badge ${row.status==='en_cola'?'amber':row.status==='tomado'?'green':'neutral'}`}>
            {row.status==='en_cola' ? 'En espera' : row.status==='tomado' ? row.owner_id===viewerId ? 'Tomado por mí' : 'En seguimiento'
              : row.status.replaceAll('_',' ')}</span></div>
        <div className="ops-actions">
          {row.can_claim&&<Button disabled={!!busy} onClick={()=>void transition(row,'claim')}>{busy===row.id?'Tomando…':'Tomar caso'}</Button>}
          {row.status==='en_cola'&&(row.requested_by===viewerId||canManage)&&<Button variant="outline" disabled={!!busy}
            onClick={()=>void transition(row,'cancel')}>Cancelar solicitud</Button>}
          {canManage&&['en_cola','tomado'].includes(row.status)&&<Reassign row={row} done={()=>void load()}/>}
          {row.status==='tomado'&&row.owner_id===viewerId&&<>
            <Button variant="outline" onClick={()=>openCase(row.case_id)}>Abrir caso</Button>
            <Button disabled={!!busy} onClick={()=>void transition(row,'resolve')}>Marcar resuelto</Button>
          </>}
        </div>
      </article>)}</div> : <div className="ops-empty">No hay escalamientos en esta cola.</div>}
  </div>;
}
function Reassign({row,done}:{row:Escalation;done:()=>void}){const [open,setOpen]=useState(false),[operator,setOperator]=useState(''),[reason,setReason]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);try{await post(`/escalations/${encodeURIComponent(row.id)}/reassign`,{case_revision:row.case_revision,operator_id:operator,reason});setOpen(false);done()}catch(e){setError(errorText(e))}finally{setBusy(false)}}return open?<form className="evo-form" onSubmit={submit}><label>Identificador del operador<input required value={operator} onChange={e=>setOperator(e.target.value)}/></label><label>Motivo<input required minLength={3} value={reason} onChange={e=>setReason(e.target.value)}/></label>{error&&<p className="alert error" role="alert">{error}</p>}<div className="ops-actions"><Button disabled={busy}>Confirmar reasignación</Button><Button type="button" variant="outline" onClick={()=>setOpen(false)}>Cancelar</Button></div></form>:<Button variant="outline" onClick={()=>setOpen(true)}>Reasignar</Button>}
type CustomerCase = { id: string; status: string; updated_at: string; ticket_refs: string[] };
type Customer = CrmView['customer'] & { revision: number; cases: CustomerCase[] };
type CustomerRow = Pick<Customer, 'cliente_id' | 'nombre' | 'estado'>;
type CustomerResponse = {
  customer: Omit<Customer, 'cases'>;
  case_history?: Array<Omit<CustomerCase, 'id'> & { case_id: string }>;
};

const pageSize = 25;
const crmCurrency = new Intl.NumberFormat('es-CO', {style: 'currency', currency: 'COP', maximumFractionDigits: 0});
const crmCalendar = new Intl.DateTimeFormat('es-CO', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'});
const crmDate = (date: string) => crmCalendar.format(new Date(date + 'T00:00:00Z'));
const crmLabel = (value: string) => {
  const text = value.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const ticketCategories = {
  soporte_tecnico: 'Soporte técnico', facturacion: 'Facturación', consulta_planes: 'Consulta de planes',
  cancelacion: 'Cancelación', portabilidad: 'Portabilidad'
};

function CustomerStatus({state}: {state: string}) {
  const tone = ['activo', 'abierto'].includes(state) ? 'active' : state === 'suspendido' ? 'warning' : 'neutral';
  return <span className={styles.status} data-tone={tone}>{crmLabel(state)}</span>;
}

function CustomerDetailTabs({id, canReadBilling, children}: {id: string; canReadBilling: boolean; children: ReactNode}) {
  if (!canReadBilling) return <div className={styles.detailContent}>{children}</div>;
  return <Tabs.Root key={id} defaultValue="crm">
    <Tabs.List className={styles.tabs} aria-label="Ficha del cliente">
      <Tabs.Trigger value="crm"><ContactRound aria-hidden="true"/>CRM</Tabs.Trigger>
      <Tabs.Trigger value="billing"><ReceiptText aria-hidden="true"/>Facturación</Tabs.Trigger>
    </Tabs.List>
    <Tabs.Content value="crm" className={styles.detailContent}>{children}</Tabs.Content>
    <Tabs.Content value="billing" className={`integration-panel ${styles.detailContent} ${styles.billing}`}>
      <DirectoryBillingPanel customerId={id}/>
    </Tabs.Content>
  </Tabs.Root>;
}

function CustomerRecords({customer}: {customer: Customer}) {
  return <>
    <div className={styles.recordGrid}>
      <section aria-labelledby="crm-services">
        <h3 id="crm-services" className={styles.sectionTitle}><Layers aria-hidden="true"/>Servicios</h3>
        {customer.servicios.length ? <ul className={styles.services}>{customer.servicios.map(service => {
          const home = service.tipo === 'hogar';
          const Icon = home ? Wifi : Smartphone;
          return <li key={service.servicio_id} className={styles.service}>
            <div className={styles.serviceTop}>
              <span className={styles.serviceIcon}><Icon aria-hidden="true"/></span>
              <div className={styles.serviceName}><span>{home ? 'Hogar' : 'Móvil'} · {service.servicio_id}</span><h4>{service.plan}</h4></div>
              <CustomerStatus state={service.estado}/>
            </div>
            <dl className={styles.serviceFacts}>
              <div><dt>Mensualidad</dt><dd>{crmCurrency.format(service.valor_mensual)}</dd></div>
              <div><dt>Activación</dt><dd>{crmDate(service.fecha_activacion)}</dd></div>
              {service.permanencia_hasta && <div><dt>Permanencia hasta</dt><dd>{crmDate(service.permanencia_hasta)}</dd></div>}
            </dl>
          </li>;
        })}</ul> : <p className={styles.sectionEmpty}>Esta cuenta no tiene servicios registrados.</p>}
      </section>
      <section aria-labelledby="crm-tickets">
        <h3 id="crm-tickets" className={styles.sectionTitle}><Ticket aria-hidden="true"/>Tickets recientes</h3>
        {customer.tickets_recientes.length ? <ul className={styles.recordList}>{customer.tickets_recientes.map(ticket =>
          <li key={ticket.ticket_id}>
            <div className={styles.recordHeading}>
              <h4>{ticketCategories[ticket.categoria]}</h4>
              <CustomerStatus state={ticket.estado}/>
            </div>
            <p>{ticket.ticket_id} · <time dateTime={ticket.fecha}>{crmDate(ticket.fecha)}</time></p>
            {(ticket.prioridad === 'prioritaria' || ticket.escalar_a) && <p className={styles.ticketNote}>
              {ticket.prioridad === 'prioritaria' && <span>Prioritario</span>}
              {ticket.escalar_a && <span>{ticket.escalar_a === 'nivel2' ? 'Nivel 2' : crmLabel(ticket.escalar_a)}</span>}
            </p>}
          </li>
        )}</ul> : <p className={styles.sectionEmpty}>Esta cuenta no tiene tickets recientes.</p>}
      </section>
    </div>
    {customer.ofertas_retencion_12m.length > 0 && <section aria-labelledby="crm-offers">
      <h3 id="crm-offers" className={styles.sectionTitle}><Tag aria-hidden="true"/>Ofertas de retención</h3>
      <ul className={styles.recordList}>{customer.ofertas_retencion_12m.map((offer, index) => (
        <li key={`${offer.codigo}-${offer.fecha}-${index}`}>
          <div className={styles.recordHeading}>
            <h4>{offer.descripcion}</h4>
            <span className={styles.offerCode}>{offer.codigo}</span>
          </div>
          {offer.fecha && <p><time dateTime={offer.fecha}>{crmDate(offer.fecha)}</time></p>}
        </li>
      ))}</ul>
    </section>}
  </>;
}

type DirectoryProps = {
  openCase: (id: string) => void; openEscalations: () => void; startCase?: (id: string) => void;
  eligibleContacts?: string[]; authorizedCases?: string[]; canManage?: boolean; canReadBilling?: boolean;
};

export function CustomerDirectory({
  openCase, openEscalations, startCase, eligibleContacts = [], authorizedCases = [], canManage = false, canReadBilling = false
}: DirectoryProps) {
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [selected, setSelected] = useState<Customer>();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [requestedId, setRequestedId] = useState('');
  const [escalationError, setEscalationError] = useState('');
  const [customerForm, setCustomerForm] = useState<'new' | 'edit' | null>(null);
  const [reload, setReload] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [escalationsLoading, setEscalationsLoading] = useState(false);
  const detailSequence = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const accountHeading = useRef<HTMLHeadingElement>(null);
  const focusAccount = useRef(false);
  const focusResults = useRef(false);
  const pendingSearch = loading || search.trim() !== query;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setOffset(0);
      setQuery(search.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({offset: String(offset), limit: String(pageSize)});
    if (query) params.set('q', query);
    request<CustomerRow[] | {items: CustomerRow[]}>(`/crm/customers?${params}`, {signal: controller.signal})
      .then(data => {
        if (!controller.signal.aborted) setRows(Array.isArray(data) ? data : data.items);
      })
      .catch(failure => {
        if (!controller.signal.aborted) {
          setRows([]);
          setError(errorText(failure));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [offset, query, reload]);

  useEffect(() => {
    if (!searchOpen || pendingSearch || !focusResults.current) return;
    focusResults.current = false;
    results.current?.querySelector('button')?.focus();
  }, [searchOpen, pendingSearch]);

  async function select(id: string, moveFocus = false) {
    const sequence = ++detailSequence.current;
    focusAccount.current = moveFocus;
    setRequestedId(id);
    setSearchOpen(false);
    setDetailError('');
    setDetailLoading(true);
    setSelected(undefined);
    try {
      const detail = await request<CustomerResponse>(`/crm/customers/${encodeURIComponent(id)}`);
      if (sequence !== detailSequence.current) return;
      setSelected({...detail.customer, cases: (detail.case_history ?? []).map(({case_id, ...row}) => ({...row, id: case_id}))});
    } catch (failure) {
      if (sequence === detailSequence.current) setDetailError(errorText(failure));
    } finally {
      if (sequence === detailSequence.current) setDetailLoading(false);
    }
  }

  useEffect(() => {
    if (!detailLoading && focusAccount.current) {
      const active = document.activeElement;
      if (active === document.body || active === searchInput.current) accountHeading.current?.focus({preventScroll: true});
      focusAccount.current = false;
    }
  }, [detailLoading]);

  useEffect(() => {
    setEscalations([]);
    setEscalationError('');
    setEscalationsLoading(Boolean(selected?.cases.length));
    if (!selected?.cases.length) return;
    const controller = new AbortController();
    request<Escalation[]>('/escalations', {signal: controller.signal})
      .then(items => { if (!controller.signal.aborted) setEscalations(items); })
      .catch(failure => { if (!controller.signal.aborted) setEscalationError(errorText(failure)); })
      .finally(() => { if (!controller.signal.aborted) setEscalationsLoading(false); });
    return () => controller.abort();
  }, [selected]);

  function handleSearchKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && searchOpen) {
      event.preventDefault();
      focusResults.current = false;
      (event.target === searchInput.current ? searchInput.current : searchToggle.current)?.focus();
      setSearchOpen(false);
    }
    if (event.key === 'ArrowDown' && event.target === searchInput.current) {
      event.preventDefault();
      if (searchOpen && !pendingSearch) results.current?.querySelector('button')?.focus();
      else {
        focusResults.current = true;
        setSearchOpen(true);
      }
    }
    if (event.key === 'Enter' && event.target === searchInput.current && searchOpen && !pendingSearch && rows.length === 1) {
      event.preventDefault();
      void select(rows[0].cliente_id, true);
    }
  }

  return <div className={`admin-page evo-page ${styles.page}`}>
    <header className={styles.pageHeader}>
      <h1>Directorio CRM</h1>
      {canManage && <Button onClick={() => setCustomerForm('new')}>Nuevo cliente</Button>}
    </header>
    <div className={styles.searchRegion} role="search" aria-label="Directorio de clientes"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          focusResults.current = false;
          setSearchOpen(false);
        }
      }}
      onKeyDown={handleSearchKeys}>
      <label htmlFor="crm-customer-search">Buscar cliente</label>
      <div className={styles.searchField}>
        <Search aria-hidden="true"/>
        <input ref={searchInput} id="crm-customer-search" type="search" value={search}
          placeholder="Nombre o identificador, p. ej. C-1001" maxLength={100} autoComplete="off"
          onFocus={() => setSearchOpen(true)} onClick={() => setSearchOpen(true)}
          onChange={event => { setSearch(event.target.value); setSearchOpen(true); }}/>
        {search && <button type="button" className={styles.clearSearch} aria-label="Limpiar búsqueda"
          onClick={() => { setSearch(''); searchInput.current?.focus(); setSearchOpen(true); }}>
          <X aria-hidden="true"/>
        </button>}
        <button ref={searchToggle} type="button" className={styles.toggleSearch}
          aria-label="Ver clientes" aria-expanded={searchOpen} aria-controls="crm-search-results"
          onClick={() => setSearchOpen(open => !open)}>
          <span>Ver clientes</span><ChevronDown aria-hidden="true"/>
        </button>
      </div>
      <div id="crm-search-results" className={styles.searchResults} hidden={!searchOpen} aria-busy={pendingSearch}>
        {pendingSearch ? <p className={styles.searchFeedback} role="status">Consultando CRM…</p>
          : error ? <div className={styles.searchFeedback}>
            <p role="alert">{error}</p>
            <Button variant="outline" onClick={() => setReload(value => value + 1)}>Reintentar búsqueda</Button>
          </div>
          : rows.length ? <>
            <ul className={styles.searchOptions} ref={results} aria-label="Resultados de clientes">
              {rows.map(row => <li key={row.cliente_id}>
                <button type="button" className={styles.searchOption} aria-current={selected?.cliente_id === row.cliente_id || undefined}
                  onClick={() => void select(row.cliente_id, true)}>
                  <span><strong>{row.nombre}</strong><small>{row.cliente_id}</small></span>
                  <CustomerStatus state={row.estado}/>
                  <ChevronRight aria-hidden="true"/>
                </button>
              </li>)}
            </ul>
            {(offset > 0 || rows.length === pageSize) && <div className={styles.searchPagination}>
              <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(value => value - pageSize)}>Anterior</Button>
              <span role="status">Registros {offset + 1}–{offset + rows.length}</span>
              <Button size="sm" variant="outline" disabled={rows.length < pageSize} onClick={() => setOffset(value => value + pageSize)}>Siguiente</Button>
            </div>}
          </> : <div className={styles.searchFeedback}>
            <p role="status">{query ? 'No hay coincidencias. Prueba con otro nombre o identificador.' : 'No hay clientes disponibles en esta página.'}</p>
            {offset > 0 && <Button variant="outline" onClick={() => setOffset(value => value - pageSize)}>Anterior</Button>}
          </div>}
      </div>
    </div>
    <section className={styles.workspace} aria-label="Ficha del cliente" aria-busy={detailLoading}>
      {detailLoading ? <div className={styles.empty} role="status"><div className={styles.emptyIcon}><ContactRound aria-hidden="true"/></div><p>Consultando ficha…</p></div>
        : detailError ? <div className={styles.empty}>
          <h2 ref={accountHeading} tabIndex={-1}>La ficha no está disponible</h2>
          <p role="alert">{detailError}</p>
          <Button variant="outline" onClick={() => void select(requestedId, true)}>Reintentar ficha</Button>
        </div>
        : selected ? <>
          <header className={styles.accountHeader}>
            <div className={styles.accountIdentity}>
              <span className={styles.accountIcon}><ContactRound aria-hidden="true"/></span>
              <div>
                <h2 ref={accountHeading} tabIndex={-1}>{selected.nombre}</h2>
                <p><span className={styles.accountRef}>{selected.cliente_id}</span><span>{selected.ciudad}</span><CustomerStatus state={selected.estado}/></p>
              </div>
            </div>
            <div className={styles.accountActions}>
              {canManage && <Button variant="outline" onClick={() => setCustomerForm('edit')}>Gestionar cliente</Button>}
              {startCase && eligibleContacts.includes(selected.cliente_id) && <Button variant="outline" onClick={() => startCase(selected.cliente_id)}>Iniciar caso</Button>}
            </div>
          </header>
          <CustomerDetailTabs id={selected.cliente_id} canReadBilling={canReadBilling}>
            <CustomerRecords customer={selected}/>
            <section aria-labelledby="crm-case-history">
              <h3 id="crm-case-history" className={styles.sectionTitle}><History aria-hidden="true"/>Historial de casos</h3>
              {escalationsLoading && <p className={styles.sectionEmpty} role="status">Consultando escalamientos…</p>}
              {escalationError && <p className="alert error" role="alert">No se pudo consultar el seguimiento de escalamientos. {escalationError}</p>}
              {selected.cases.length ? <ul className={styles.recordList}>{selected.cases.map(item => {
                const matching = escalations.filter(row => row.case_id === item.id);
                return <li key={item.id}>
                  <h4>{item.id}</h4>
                  <p>{item.status === 'open' ? 'Abierto' : item.status === 'closed' ? 'Cerrado' : crmLabel(item.status)}
                    {item.updated_at && <> · Actualizado {new Date(item.updated_at).toLocaleString('es-CO', {timeZone: 'America/Bogota'})}</>}
                  </p>
                  <p>{item.ticket_refs.length ? `Tickets vinculados · ${item.ticket_refs.join(', ')}` : 'Sin tickets vinculados.'}</p>
                  {matching.map(row => <p key={row.id}>
                    {destinations[row.destination] ?? row.destination} · {crmLabel(row.status)} · {crmLabel(row.reason_code)}
                  </p>)}
                  <div className={styles.caseActions}>
                    {authorizedCases.includes(item.id) ? <Button variant="outline" onClick={() => openCase(item.id)}>Abrir caso {item.id}</Button>
                      : <span>La conversación requiere acceso al caso.</span>}
                    {matching.length > 0 && <Button variant="outline" onClick={openEscalations}>Ver cola de escalamientos</Button>}
                  </div>
                </li>;
              })}</ul> : <p className={styles.sectionEmpty}>Sin casos en el historial autorizado.</p>}
            </section>
          </CustomerDetailTabs>
        </> : <div className={styles.empty}>
          <div className={styles.emptyIcon}><ContactRound aria-hidden="true"/></div>
          <h2>Selecciona un cliente</h2>
          <p>Busca por nombre o identificador para abrir su ficha.</p>
        </div>}
    </section>
    {customerForm && <CustomerForm customer={customerForm === 'edit' ? selected : undefined}
      close={() => setCustomerForm(null)} done={() => {
        setCustomerForm(null);
        setReload(value => value + 1);
        if (selected) void select(selected.cliente_id);
      }}/>}
  </div>;
}

type Identity = {tipo_documento:string;numero_documento:string};
type NewCustomer = Identity & {cliente_id:string;nombre:string;celular:string;email:string;motivo:string;idempotency_key:string};

export function CaseCustomerRegistration({snapshot,updated}:{snapshot:CaseSnapshot;updated:()=>Promise<unknown>}) {
  const path=`/cases/${encodeURIComponent(snapshot.id)}/customer-registration`;
  const [identity,setIdentity]=useState<Identity>({tipo_documento:'CC',numero_documento:''});
  const [lookup,setLookup]=useState<'existing'|'missing'>();
  const [adding,setAdding]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [confirmed,setConfirmed]=useState<CaseSnapshot['customer_registration']>();
  const linkKey=useRef(key());
  const registration=snapshot.customer_registration ?? confirmed;
  if (registration) return <div className="assisted-registration">
    <h3>Cliente vinculado</h3><p>Recibo CRM · {registration.customer_ref} · revisión {registration.revision}</p>
    <strong>Titularidad pendiente</strong><p>El cliente puede verificar su cuenta desde el mismo chat.</p>
  </div>;

  async function check() {
    setBusy(true);setError('');setLookup(undefined);
    try {
      const result=await post<{status:'existing'|'missing'}>(path,{...identity,action:'lookup',case_revision:snapshot.revision});
      setLookup(result.status);
    } catch (failure) {setError(errorText(failure));}
    finally {setBusy(false);}
  }
  async function link() {
    setBusy(true);setError('');
    try {
      const result=await post<{registration:NonNullable<CaseSnapshot['customer_registration']>}>(path,
        {...identity,action:'link',case_revision:snapshot.revision,idempotency_key:linkKey.current});
      setConfirmed(result.registration);
      void updated().catch(()=>undefined);
    } catch (failure) {setError(errorText(failure));}
    finally {setBusy(false);}
  }
  return <section className="assisted-registration" aria-label="Vincular cliente al caso">
    <h3>Cliente sin vincular</h3><p>Busca por documento en el CRM de prueba.</p>
    <form className="evo-form" onSubmit={event=>{event.preventDefault();void check();}}>
      <label>Tipo de documento<select value={identity.tipo_documento} disabled={busy} onChange={event=>{
        setIdentity({...identity,tipo_documento:event.target.value});setLookup(undefined);linkKey.current=key();
      }}>{['CC','CE','NIT','PAS'].map(type=><option key={type}>{type}</option>)}</select></label>
      <label>Número de documento<input required maxLength={64} disabled={busy} value={identity.numero_documento} onChange={event=>{
        setIdentity({...identity,numero_documento:event.target.value});setLookup(undefined);linkKey.current=key();
      }}/></label>
      <Button variant="outline" disabled={busy}>{busy?'Consultando…':'Buscar cliente'}</Button>
    </form>
    {error&&<p className="alert error" role="alert">{error}</p>}
    {lookup==='existing'&&<><p role="status">CRM encontró un registro.</p>
      <Button disabled={busy} onClick={()=>void link()}>Vincular cliente</Button></>}
    {lookup==='missing'&&<><p role="status">CRM confirmó que no existe un registro para ese documento.</p>
      <Button onClick={()=>setAdding(true)}>Crear cliente</Button></>}
    {adding&&<CustomerForm identity={identity} close={()=>setAdding(false)} done={()=>{setAdding(false);void updated().catch(()=>undefined);}}
      register={async input=>{
        const result=await post<{registration:NonNullable<CaseSnapshot['customer_registration']>}>(path,
          {...input,action:'create',case_revision:snapshot.revision});
        return {cliente_id:result.registration.customer_ref,revision:result.registration.revision};
      }}/>}
  </section>;
}

function CustomerForm({customer,identity,register,close,done}:{customer?:Customer;identity?:Identity;
  register?:(input:NewCustomer)=>Promise<{cliente_id:string;revision:number}>;close:()=>void;done:()=>void}) {
  const [id,setId]=useState(customer?.cliente_id ?? '');
  const [name,setName]=useState(customer?.nombre??'');
  const [type,setType]=useState(identity?.tipo_documento ?? 'CC');
  const [document,setDocument]=useState(identity?.numero_documento ?? '');
  const [phone,setPhone]=useState('');
  const [email,setEmail]=useState('');
  const [state,setState]=useState<string>(customer?.estado??'activo');
  const [reason,setReason]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [receipt,setReceipt]=useState('');
  const submission=useRef<{fingerprint:string;key:string}|undefined>(undefined);
  const title=customer?'Gestionar cliente':register?'Crear cliente':'Nuevo cliente';
  async function submit(event:React.FormEvent) {
    event.preventDefault();
    if (!register && !window.confirm('¿Confirmas esta operación sobre el cliente?')) return;
    setBusy(true);setError('');
    const creation={cliente_id:id,nombre:name,tipo_documento:type,numero_documento:document,celular:phone,email,motivo:reason};
    const body=customer ? {revision:customer.revision,motivo:reason,nombre:name,...(phone?{celular:phone}:{}),
      ...(email?{email}:{}),estado:state} : creation;
    const fingerprint=JSON.stringify(body);
    if (submission.current?.fingerprint!==fingerprint) submission.current={fingerprint,key:key()};
    try {
      const idempotency_key=submission.current.key;
      const result=register ? await register({...creation,idempotency_key}) :
        await request<{cliente_id:string;revision:number}>(customer?`/admin/customers/${encodeURIComponent(id)}`:'/admin/customers',
          {method:customer?'PATCH':'POST',body:JSON.stringify({...body,idempotency_key})});
      setReceipt(`${result.cliente_id} · revisión ${result.revision}`);
    } catch (failure) {setError(errorText(failure));}
    finally {setBusy(false);}
  }
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)(receipt?done:close)()}}>
    <DialogContent className="ops-plot evo-modal" aria-describedby={undefined}>
      <DialogTitle>{receipt?'Cliente registrado':title}</DialogTitle>
      {receipt ? <><p role="status">Recibo CRM · {receipt}</p><Button onClick={done}>Cerrar</Button></>
        : <form className="evo-form" onSubmit={submit}>
          {error&&<p className="alert error" role="alert">{error}</p>}
          <label>Identificador<input value={id} onChange={event=>setId(event.target.value)} disabled={!!customer}
            placeholder="C-0000" pattern="C-[0-9]{4}" required/></label>
          <label>Nombre<input value={name} onChange={event=>setName(event.target.value)} maxLength={100} required/></label>
          {!customer&&<><label>Tipo de documento<select value={type} disabled={!!identity} onChange={event=>setType(event.target.value)}>
            {['CC','CE','NIT','PAS'].map(value=><option key={value}>{value}</option>)}</select></label>
            <label>Número de documento<input value={document} readOnly={!!identity} maxLength={64} onChange={event=>setDocument(event.target.value)} required/></label></>}
          <label>Celular sintético<input value={phone} onChange={event=>setPhone(event.target.value)} required={!customer}/></label>
          <label>Correo sintético<input type="email" value={email} onChange={event=>setEmail(event.target.value)} required={!customer}/></label>
          {customer&&<label>Estado<select value={state} onChange={event=>setState(event.target.value)}>
            {['activo','suspendido','retirado'].map(value=><option key={value}>{value}</option>)}</select></label>}
          <label>Motivo<textarea required minLength={3} maxLength={120} value={reason} onChange={event=>setReason(event.target.value)}/></label>
          <div className="ops-actions"><Button disabled={busy}>{busy?'Registrando…':'Confirmar y registrar'}</Button>
            <Button type="button" variant="outline" onClick={close} disabled={busy}>Cancelar</Button></div>
        </form>}
    </DialogContent>
  </Dialog>;
}

type Metric={id:string;label:string;value:number|null;unit:string;sample:number|null;denominator:number|null;target:string|null;observed_at:string|null;source:string;status:'measured'|'no_sample'|'pending_instrumentation'|'target_only'|'unavailable';series?:{date:string;value:number;sample?:number}[];evidence?:{label:string;url:string}};
type MetricsResponse={group:string;filters:{days:string;channel?:string;category?:string;revision?:string;digest?:string;timezone:string};metrics:Metric[];supporting?:Record<string,unknown>};
const groups=[['negocio','Negocio'],['calidad-llm','Calidad del LLM'],['tecnica','Técnica'],['agentes','Agentes'],['machine-learning','Machine learning'],['devops','DevOps']] as const;
const statuses:Record<Metric['status'],string>={measured:'Medida',no_sample:'Sin muestra',pending_instrumentation:'Instrumentación pendiente',target_only:'Solo meta',unavailable:'Fuente no disponible'};
const formatNumber=new Intl.NumberFormat('es-CO',{maximumFractionDigits:2});
const formatModelScore=new Intl.NumberFormat('es-CO',{maximumFractionDigits:3});
type MetricPreferences=Record<string,{cards:Record<string,boolean>;series:Record<string,boolean>}>;
export function MetricsBoard({operatorId}:{operatorId:string}){
 const [group,setGroup]=useState('negocio'),[days,setDays]=useState('7'),[channel,setChannel]=useState(''),[category,setCategory]=useState(''),[revision,setRevision]=useState(''),[digest,setDigest]=useState(''),[data,setData]=useState<MetricsResponse>(),[error,setError]=useState(''),[loading,setLoading]=useState(true),[preferences,setPreferences]=useState<MetricPreferences>({}),[initialized,setInitialized]=useState(false),[reload,setReload]=useState(0);
 const [pickerOpen,setPickerOpen]=useState(false);
 const preferenceKey=`claro:metrics:${operatorId}`;
 useEffect(()=>{try{const parsed=JSON.parse(localStorage.getItem(preferenceKey)??'{}');setPreferences(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{})}catch{setPreferences({})}},[preferenceKey]);
 const groupPreferences=preferences[group];
 const isVisible=(kind:'cards'|'series',id:string)=>groupPreferences?.[kind]?.[id]!==false;
 function setVisible(kind:'cards'|'series',id:string,show:boolean){setPreferences(current=>{const existing=current[group]??{cards:{},series:{}};const next={...current,[group]:{cards:existing.cards??{},series:existing.series??{},[kind]:{...existing[kind],[id]:show}}};try{localStorage.setItem(preferenceKey,JSON.stringify(next))}catch{}return next})}
 function resetVisible(){setPreferences(current=>{const next={...current};delete next[group];try{localStorage.setItem(preferenceKey,JSON.stringify(next))}catch{}return next})}
 useEffect(()=>{const params=new URLSearchParams(window.location.search);const next=params.get('group');if(groups.some(([id])=>id===next))setGroup(next!);setDays(params.get('days')==='30'?'30':'7');setChannel(params.get('channel')??'');setCategory(params.get('category')??'');setRevision(params.get('revision')??'');setDigest(params.get('digest')??'');setInitialized(true)},[]);
 useEffect(()=>{if(!initialized)return;const params=new URLSearchParams({view:'metrics',group,days});if(channel)params.set('channel',channel);if(category)params.set('category',category);if(revision&&group==='calidad-llm')params.set('revision',revision);if(digest&&group==='devops')params.set('digest',digest);window.history.replaceState(null,'',`?${params.toString()}`);let live=true;setLoading(true);setError('');request<MetricsResponse>(`/admin/metrics/${group}?${params}`).then(value=>{if(live){setData(value)}}).catch(e=>{if(live){setData(undefined);setError(errorText(e))}}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[group,days,channel,category,revision,digest,reload,initialized]);
 return <div className="admin-page evo-page"><header className="ops-header"><div><span className="eyebrow">MEDICIÓN DEL MVP</span><h1>Tableros</h1><p>Indicadores, fuentes y estado de medición · hora de Bogotá</p></div></header><nav className="evo-tabs" aria-label="Categorías de tableros">{groups.map(([id,label])=><button key={id} aria-current={group===id?'page':undefined} onClick={()=>setGroup(id)}>{label}</button>)}</nav><div className="evo-filters"><label>Período<select value={days} onChange={e=>setDays(e.target.value)}><option value="7">Últimos 7 días</option><option value="30">Últimos 30 días</option></select></label><label>Canal<select value={channel} onChange={e=>setChannel(e.target.value)}><option value="">Todos</option><option value="web">Web</option><option value="telegram">Telegram</option></select></label><label>Categoría<select value={category} onChange={e=>setCategory(e.target.value)}><option value="">Todas</option>{['soporte_tecnico','facturacion','consulta_planes','cancelacion','portabilidad'].map(x=><option key={x} value={x}>{x.replaceAll('_',' ')}</option>)}</select></label>{group==='calidad-llm'&&<label>Revisión<input value={revision} onChange={e=>setRevision(e.target.value)} placeholder="Todas"/></label>}{group==='devops'&&<label>Digest<input value={digest} onChange={e=>setDigest(e.target.value)} placeholder="Último corte"/></label>}</div>{error&&<p className="alert error" role="alert">{error}</p>}{loading?<p role="status">Actualizando métricas…</p>:data&&<><p className="evo-applied">Filtros aplicados: {data.filters.days} días · {data.filters.channel||'todos los canales'} · {data.filters.category||'todas las categorías'} · {data.filters.timezone}</p>{data.metrics.length?<><details className="evo-picker" open={pickerOpen} onToggle={event=>setPickerOpen(event.currentTarget.open)}><summary>Elegir indicadores</summary><p>Preferencias guardadas para esta categoría y operador.</p><div className="evo-picker-grid">{data.metrics.map(metric=><div className="evo-picker-row" key={metric.id}><span>{metric.label}</span><label><input type="checkbox" aria-label={`Mostrar tarjeta ${metric.label}`} checked={isVisible('cards',metric.id)} onChange={e=>setVisible('cards',metric.id,e.target.checked)}/> Tarjeta</label><label><input type="checkbox" aria-label={`Mostrar serie ${metric.label}`} checked={isVisible('series',metric.id)} disabled={!metric.series?.length} onChange={e=>setVisible('series',metric.id,e.target.checked)}/> Serie{!metric.series?.length&&' · sin datos'}</label></div>)}</div><Button type="button" variant="outline" onClick={resetVisible}>Restaurar predeterminadas</Button></details><div className="evo-metrics">{data.metrics.filter(metric=>isVisible('cards',metric.id)).map(metric=><article className="ops-plot evo-metric" key={metric.id}><div className="evo-row"><h3>{metric.label}</h3><span className={`evo-status ${metric.status}`}>{statuses[metric.status]}</span></div><div className="evo-value">{metric.value===null?'—':(metric.unit==='F1'||metric.unit==='AUC'?formatModelScore:formatNumber).format(metric.value)} <small>{metric.unit}</small></div><p>{metric.denominator!==null?`Denominador: ${formatNumber.format(metric.denominator)}`:'Sin denominador'}{metric.sample!==null?` · Muestra: ${formatNumber.format(metric.sample)}`:''}</p><p>Meta: {metric.target??'No definida'} · Fuente: {metric.source}</p>{metric.observed_at&&<p>Observado: {new Date(metric.observed_at).toLocaleString('es-CO',{timeZone:'America/Bogota'})}</p>}{metric.evidence&&<a href={metric.evidence.url} target="_blank" rel="noreferrer">{metric.evidence.label} ↗</a>}{!!metric.series?.length&&<><label className="evo-toggle"><input type="checkbox" aria-label={`Mostrar serie ${metric.label}`} checked={isVisible('series',metric.id)} onChange={e=>setVisible('series',metric.id,e.target.checked)}/> Mostrar serie</label>{isVisible('series',metric.id)&&<MetricSeries metric={metric}/>}</>}</article>)}{data.metrics.every(metric=>!isVisible('cards',metric.id))&&<div className="ops-empty">Todas las tarjetas están ocultas. Usa «Elegir indicadores» para mostrarlas.</div>}</div></>:<div className="ops-empty">No hay indicadores para estos filtros.</div>}{data.supporting&&<MetricSupporting data={data.supporting}/>}</>}{group==='devops'&&<ReleaseImport done={()=>setReload(x=>x+1)}/>}</div>;
}
function MetricSupporting({data}:{data:Record<string,unknown>}){const titles:Record<string,string>={comparison:'Comparación A/B',traces:'Trazas autorizadas',categories:'Resultados por categoría',integrations:'Dependencias',deployment:'Despliegue de intención',churn:'Cohorte y evaluación de churn',drift:'Monitoreo de drift',classes:'Clases de intención',releases:'Cortes de CI y smoke'};return <section className="ops-plot evo-catalog"><h3>Detalle y evidencia</h3>{Object.entries(data).map(([name,value])=><details key={name} className="evo-support"><summary>{titles[name]??name.replaceAll('_',' ')}</summary><SupportValue value={value}/></details>)}</section>}
function SupportValue({value}:{value:unknown}):React.ReactNode{if(value===null||value===undefined)return <p>Sin evidencia disponible.</p>;if(Array.isArray(value))return value.length?<div className="evo-support-list">{value.map((item,index)=><div key={index}><SupportValue value={item}/></div>)}</div>:<p>Sin registros en este período.</p>;if(typeof value==='object')return <dl className="evo-support-data">{Object.entries(value as Record<string,unknown>).map(([key,item])=><div key={key}><dt>{key.replaceAll('_',' ')}</dt><dd>{key==='url'&&typeof item==='string'&&/^(https?:|\/)/.test(item)?<a href={item}>{item}</a>:<SupportValue value={item}/>}</dd></div>)}</dl>;return <span>{String(value)}</span>}
function ReleaseImport({done}:{done:()=>void}){const [json,setJson]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');setNotice('');try{let body:unknown;try{body=JSON.parse(json)}catch{throw new Error('El archivo no contiene JSON válido.')}await post('/admin/releases/evidence',body);setNotice('Evidencia registrada y tablero actualizado.');done()}catch(e){setError(errorText(e))}finally{setBusy(false)}}return <form className="ops-plot evo-form evo-catalog" onSubmit={submit}><h3>Importar evidencia de CI y smoke</h3><p>Adjunta el JSON del corte, con SHA, digest, ejecución de GitHub Actions y resultados de escaneo y smoke.</p><label>Archivo JSON<input type="file" accept="application/json,.json" onChange={e=>{const file=e.target.files?.[0];if(file)void file.text().then(setJson)}}/></label><label>Contenido JSON<textarea rows={5} value={json} onChange={e=>setJson(e.target.value)} placeholder="Pega aquí la evidencia del corte"/></label>{error&&<p className="alert error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}<div><Button disabled={busy||!json}>{busy?'Registrando…':'Registrar evidencia'}</Button></div></form>}
function MetricSeries({metric}:{metric:Metric}){const points=metric.series??[];const max=Math.max(...points.map(p=>p.value),1);return <><div className="evo-chart" aria-hidden="true">{points.map((point,i)=><div key={i} title={`${point.date}: ${point.value} ${metric.unit}`} style={{height:`${Math.max(point.value/max*100,2)}%`}}/>)}</div><details className="ops-data"><summary>Datos de la serie</summary><table><thead><tr><th>Fecha</th><th>Valor ({metric.unit})</th><th>Muestra</th></tr></thead><tbody>{points.map((point,i)=><tr key={i}><td>{point.date}</td><td>{formatNumber.format(point.value)}</td><td>{point.sample??'—'}</td></tr>)}</tbody></table></details></>}

type Operator={id:string;name:string;email:string;capabilities:string[];specialties:string[];enabled:boolean;available:boolean};
const capabilityOptions=['n1','n2','supervisor','admin','superadmin'];
const specialtyOptions=['soporte_tecnico','facturacion','comercial_portabilidad'];
export function Operators(){
 const [audit,setAudit]=useState<Array<{id:string;case_id:string|null;kind:string;created_at:string;metadata:Record<string,unknown>}>>(),[auditError,setAuditError]=useState('');
 const [rows,setRows]=useState<Operator[]>(),[edit,setEdit]=useState<Operator|null>(null),[creating,setCreating]=useState(false),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=useCallback(()=>request<Operator[]>('/admin/operators').then(setRows).catch(e=>setError(errorText(e))),[]);useEffect(()=>{void load()},[load]);
 async function save(e:React.FormEvent){e.preventDefault();if(!edit)return;setBusy(true);setError('');try{const {id,name,email,capabilities,specialties,enabled,available}=edit;const body=creating?{name,email,password,capabilities,specialties,enabled,available}:{capabilities,specialties,enabled,available};await request(creating?'/admin/operators':`/admin/operators/${encodeURIComponent(id)}`,{method:creating?'POST':'PATCH',body:JSON.stringify(body)});setEdit(null);setCreating(false);setPassword('');await load()}catch(e){setError(errorText(e))}finally{setBusy(false)}}
 function toggle(field:'capabilities'|'specialties',value:string){setEdit(current=>current?{...current,[field]:current[field].includes(value)?current[field].filter(x=>x!==value):[...current[field],value]}:current)}
 return <div className="admin-page evo-page"><header className="ops-header"><div><span className="eyebrow">SUPERADMINISTRACIÓN</span><h1>Operadores</h1><p>Capacidades, especialidades y disponibilidad del equipo.</p></div><Button onClick={()=>{setCreating(true);setEdit({id:'',name:'',email:'',capabilities:['n1'],specialties:[],enabled:true,available:true})}}>Nuevo operador</Button></header>{error&&<p className="alert error" role="alert">{error}</p>}<div className="evo-split"><section className="ops-plot">{!rows&&!error?<p role="status">Cargando operadores…</p>:rows?.length?rows.map(row=><div className="revision" key={row.id}><div><strong>{row.name}</strong><span>{row.email} · {row.capabilities.join(', ')}</span><span className="badge">{row.enabled?(row.available?'Disponible':'No disponible'):'Deshabilitado'}</span></div><Button variant="outline" onClick={()=>{setCreating(false);setEdit(row)}}>Gestionar</Button></div>):<p>Sin operadores para mostrar.</p>}</section>{edit&&<form className="ops-plot evo-form" onSubmit={save}><h3>{creating?'Nuevo operador':`Gestionar ${edit.name}`}</h3>{creating&&<><label>Nombre<input required value={edit.name} onChange={e=>setEdit({...edit,name:e.target.value})}/></label><label>Correo<input required type="email" value={edit.email} onChange={e=>setEdit({...edit,email:e.target.value})}/></label><label>Contraseña inicial<input required type="password" value={password} onChange={e=>setPassword(e.target.value)}/></label></>}<fieldset><legend>Capacidades</legend>{capabilityOptions.map(value=><label className="evo-check" key={value}><input type="checkbox" checked={edit.capabilities.includes(value)} onChange={()=>toggle('capabilities',value)}/>{value}</label>)}</fieldset><fieldset><legend>Especialidades</legend>{specialtyOptions.map(value=><label className="evo-check" key={value}><input type="checkbox" checked={edit.specialties.includes(value)} onChange={()=>toggle('specialties',value)}/>{destinations[value]}</label>)}</fieldset><label className="evo-check"><input type="checkbox" checked={edit.enabled} onChange={e=>setEdit({...edit,enabled:e.target.checked})}/> Cuenta habilitada</label><label className="evo-check"><input type="checkbox" checked={edit.available} onChange={e=>setEdit({...edit,available:e.target.checked})}/> Disponible para atención</label><div className="ops-actions"><Button disabled={busy}>{busy?'Guardando…':'Guardar cambios'}</Button><Button type="button" variant="outline" onClick={()=>setEdit(null)}>Cancelar</Button></div></form>}</div><section className="ops-plot evo-catalog"><div className="evo-row"><div><h3>Bitácora operativa</h3><p>Altas, cambios y reasignaciones auditadas.</p></div><Button variant="outline" onClick={()=>{setAuditError('');request<typeof audit>('/admin/audit').then(setAudit).catch(e=>setAuditError(errorText(e)))}}>Consultar bitácora</Button></div>{auditError&&<p className="alert error" role="alert">{auditError}</p>}{audit&&<div className="ops-table"><table><thead><tr><th>Fecha</th><th>Evento</th><th>Caso</th><th>Detalle</th></tr></thead><tbody>{audit.map(row=><tr key={row.id}><td>{new Date(row.created_at).toLocaleString('es-CO',{timeZone:'America/Bogota'})}</td><td>{row.kind}</td><td>{row.case_id??'—'}</td><td>{Object.entries(row.metadata??{}).map(([k,v])=>`${k}: ${String(v)}`).join(' · ')}</td></tr>)}</tbody></table>{!audit.length&&<p>Sin eventos disponibles.</p>}</div>}</section></div>;
}

const intentNames:Record<Intent,string> = {
  soporte_tecnico:'Soporte técnico', facturacion:'Facturación', consulta_planes:'Consulta de planes',
  cancelacion:'Cancelación', portabilidad:'Portabilidad'
};
const churnActions = {
  review_retention_followup:'Revisa fallas o compromisos pendientes. Acuerda el próximo contacto si hace falta.',
  check_unresolved_issues:'Comprueba si hay pendientes y confirma el próximo paso.',
  standard_followup:'Sigue el cierre habitual y verifica si queda algún pendiente.'
};

export function CaseMl({caseId,signals,revision,verified,closing=false}:{
  caseId:string;signals:CaseMlSignals;revision:number;verified:boolean;closing?:boolean
}){
  const [selection,setSelection]=useState<{predictionId:string;label:Intent}>();
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  const [due,setDue]=useState('');
  const operation=useRef<{scope:string;id:string}>(null);
  const intent=closing?null:signals.intent;
  const {churn,follow_up:followUp}=signals;
  const label=selection?.predictionId===intent?.prediction_id ? selection?.label : intent?.label;

  async function send(path:string,body:Record<string,unknown>,success:string) {
    const scope=JSON.stringify({path,body});
    if (operation.current?.scope!==scope) operation.current={scope,id:key()};
    setBusy(true);setError('');setNotice('');
    try {
      await post(`/cases/${encodeURIComponent(caseId)}/ml/${path}`,{...body,event_id:operation.current.id});
      setNotice(success);
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }

  if (!intent && !verified) return null;
  return <section className="evo-ml" aria-label={closing?'Seguimiento al cierre':'Señales de ML'}>
    {!closing&&<div className="divider"/>}
    {intent&&<div className="suggestion">
      <strong>Intención sugerida · {intentNames[intent.label]}</strong>
      <p>{intent.recommendation==='confirm_cancellation_intent'
        ? 'Confirma con el cliente si desea cancelar antes de continuar.'
        : intent.recommendation==='clarify_intent'
          ? 'Aclara el motivo con el cliente antes de registrarlo.'
          : 'Revisa el motivo sugerido y confírmalo o corrígelo.'}</p>
      {intent.feedback ? <p>
        {intent.feedback.label===intent.label?'Intención confirmada':'Intención corregida'} · {intentNames[intent.feedback.label]}
        {!intent.feedback.synchronized&&' · Pendiente de sincronización'}
      </p> : <>
        <label>Motivo confirmado por el asesor<select value={label}
          onChange={event=>setSelection({predictionId:intent.prediction_id,label:event.target.value as Intent})}>
          {Object.entries(intentNames).map(([value,name])=><option key={value} value={value}>{name}</option>)}
        </select></label>
        <Button variant="outline" disabled={busy||!label} onClick={()=>void send('intent-label',{
          prediction_id:intent.prediction_id,label
        },'Intención registrada.')}>{label===intent.label?'Confirmar intención':'Registrar corrección'}</Button>
      </>}
    </div>}
    {verified&&<div className="suggestion">
      <strong>Seguimiento a 90 días{churn.status==='available'&&` · Prioridad ${churn.priority}`}</strong>
      {churn.status==='available'?<>
        <p>{churnActions[churn.recommendation]}</p>
        <small>Corte {churn.fecha_corte} · {churn.model_version}{churn.synthetic&&' · Datos de prueba'}</small>
      </>:<p>Sin datos disponibles para orientar el seguimiento.</p>}
      {followUp ? <>
        <p>{followUp.status==='completed'?'Seguimiento completado':'Seguimiento acordado'} · {followUp.due_date} · {followUp.responsible_name}</p>
        {followUp.status==='agreed'&&<Button variant="outline" disabled={busy} onClick={()=>void send('follow-up',{
          status:'completed',case_revision:revision
        },'Seguimiento completado.')}>Marcar completado</Button>}
      </> : churn.status==='available'&&<>
        <label>Fecha acordada<input type="date" value={due} onChange={event=>setDue(event.target.value)}/></label>
        <Button variant="outline" disabled={busy||!due} onClick={()=>void send('follow-up',{
          status:'agreed',due_date:due,case_revision:revision
        },'Seguimiento acordado.')}>Acordar seguimiento</Button>
      </>}
    </div>}
    {error&&<p className="alert error" role="alert">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}

const trackingEvents:Record<string,string> = {
  escalation_requested:'Escalamiento solicitado', escalation_claim:'Caso tomado',
  escalation_cancel:'Solicitud cancelada', escalation_resolve:'Escalamiento resuelto',
  escalation_reassign:'Caso reasignado', escalation_forwarded:'Derivado a supervisión',
  handoff_taken:'Atención iniciada', holder_verified:'Titularidad verificada', closed:'Caso cerrado'
};
export function CaseTracking({tracking}:{tracking?:CaseSnapshot['tracking']}) {
  if (!tracking) return null;
  const level = tracking.level==='n1' ? 'Nivel 1' : tracking.level==='n2' ? 'Nivel 2' : tracking.level==='supervisor' ? 'Supervisión' : 'Sin asignación';
  const escalation = tracking.escalation;
  return <details className="evo-support case-tracking"><summary>Seguimiento del caso · {level}</summary>
    <p>{tracking.owner_name ?? 'En espera de asesor'}</p>
    {escalation&&<p>{destinations[escalation.destination]} · {escalation.status.replaceAll('_',' ')} · {Math.round(escalation.queued_seconds/60)} min en cola<br/>{escalation.reason_code.replaceAll('_',' ')}</p>}
    {!!tracking.events.length&&<ul className="evo-records">{tracking.events.map((event,index)=><li key={event.at+index}><span>{trackingEvents[event.kind]??event.kind}</span><time>{new Date(event.at).toLocaleString('es-CO',{timeZone:'America/Bogota'})}</time></li>)}</ul>}
    {!!tracking.receipts.length&&<div><strong>Recibos confirmados</strong><ul className="evo-records">{tracking.receipts.map(receipt=><li key={receipt.reference}>{receipt.reference}</li>)}</ul></div>}
  </details>;
}
