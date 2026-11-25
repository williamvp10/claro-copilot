'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { escalationDestinations, Text, type CaseSnapshot, type CaseSummary, type Contact, type Viewer } from '@claro/contracts';
import { Sparkles } from 'lucide-react';
import { AdvisorSuggestion, CasesWorkspace } from '@/components/assisted-workspace';
import { MessageText } from '@/components/message-text';
import { api } from '../lib/api';
import { advisorCitationHref, publicCitationHref } from '@/lib/citations';
import { CaseIntegrationTabs } from '@/components/integrations';
import { CaseCloseForm, FollowUpsAgenda } from '@/components/follow-ups';
import { RetentionStateDetails } from '@/components/retention';
import { Button as ShadButton } from '@/components/ui/button';
import { Badge as ShadBadge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

import { AdminAgentModels } from '@/components/admin-agent-models';
import { AdminDashboard } from '@/components/admin-dashboard';
import { AdminEvaluations } from '@/components/admin-evaluations';
import { AdminKnowledge } from '@/components/admin-knowledge';
import { CaseCustomerRegistration, CaseMl, CaseTracking, CustomerDirectory, EscalationQueue, EscalationRequest, MetricsBoard, Operators } from '@/components/evolution';

type View = 'inbox'|'cases'|'dashboard'|'prompts'|'metrics'|'crm'|'queue'|'operators'|'knowledge'|'models'|'follow-ups';
const canAttendViewer=(user:Viewer)=>user.capabilities === undefined ? user.role==='asesor' : user.capabilities.some(x=>['n1','n2','supervisor'].includes(x));
const canAdminViewer=(user:Viewer)=>user.role==='admin';
const labels:Record<string,string>={autoservicio:'Autoservicio',asistido:'Atención asistida',telegram:'Telegram',web:'Web',whatsapp:'WhatsApp',voice:'Voz',pending_approval:'Pendiente de aprobación',pending_verification:'Pendiente de verificación',approved:'Aprobada',confirmed:'Confirmada',rejected:'Rechazada',expired:'Expirada',candidate:'Candidata',passed:'Evaluación aprobada',failed:'Evaluación fallida',active:'Activa'};
const fmt = (value:string) => new Intl.DateTimeFormat('es-CO',{hour:'2-digit',minute:'2-digit'}).format(new Date(value));
function Icon({name,size=18}:{name:string;size?:number}) { const paths:Record<string,ReactNode>={inbox:<><path d="M4 4h16l2 10v6H2v-6L4 4Z"/><path d="M2 14h5l2 3h6l2-3h5"/></>,chart:<><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,spark:<><path d="m12 2 1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></>,search:<><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,plus:<path d="M12 5v14M5 12h14"/>,send:<><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,check:<path d="m5 12 4 4L19 6"/>,shield:<><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></>,clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,arrow:<path d="m9 18 6-6-6-6"/>,logout:<><path d="M10 17v3H4V4h6v3M14 8l4 4-4 4M8 12h10"/></>,file:<><path d="M6 2h8l4 4v16H6zM14 2v5h5M9 12h6M9 16h6"/></>,users:<><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,close:<path d="m6 6 12 12M18 6 6 18"/>};return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg> }
function Button({children,variant='default',className='',...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'default'|'outline'|'ghost'|'dark'}){return <ShadButton variant={variant === 'dark' ? 'secondary' : variant} className={`button ${variant} ${className}`} {...props}>{children}</ShadButton>}
function Badge({children,tone='neutral'}:{children:ReactNode;tone?:string}){return <ShadBadge variant="secondary" className={`badge ${tone}`}>{children}</ShadBadge>}
function Modal({title,children,onClose}:{title:string;children:ReactNode;onClose:()=>void}){return <Dialog open onOpenChange={open=>{if(!open)onClose()}}><DialogContent className="modal" showCloseButton={false} aria-describedby={undefined}><div className="modal-head"><DialogTitle>{title}</DialogTitle><button className="icon-button" onClick={onClose} aria-label="Cerrar"><Icon name="close"/></button></div>{children}</DialogContent></Dialog>}
export default function Home(){
 const [viewer,setViewer]=useState<Viewer|null>(null),[loading,setLoading]=useState(true),[view,setView]=useState<View>('inbox');
 const [cases,setCases]=useState<CaseSummary[]>([]),[contacts,setContacts]=useState<Contact[]>([]),[selected,setSelected]=useState<CaseSnapshot|null>(null),[search,setSearch]=useState(''),[filter,setFilter]=useState('open');
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[draft,setDraft]=useState(''),[modal,setModal]=useState<'new'|'close'|'approve'|null>(null),[contact,setContact]=useState(''),[opening,setOpening]=useState(''),[resolved,setResolved]=useState(true),[showCard,setShowCard]=useState(false);
 const mobileFicha=useRef<HTMLButtonElement>(null);
 const mobileFichaClose=useRef<HTMLButtonElement>(null);
 const [menuOpen,setMenuOpen]=useState(true),[mobileMenu,setMobileMenu]=useState(false),[isMobile,setIsMobile]=useState(false);
 useEffect(()=>{const media=window.matchMedia('(max-width:700px)');const sync=()=>setIsMobile(media.matches);sync();media.addEventListener('change',sync);return()=>media.removeEventListener('change',sync)},[]);
 const menuButton=useRef<HTMLButtonElement>(null);
 useEffect(()=>{if(viewer)setMenuOpen(localStorage.getItem(`claro-menu:${viewer.id}`)!=='collapsed')},[viewer]);
 useEffect(()=>{if(!mobileMenu)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){setMobileMenu(false);menuButton.current?.focus()}};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close)},[mobileMenu]);
 const [superMenuOpen,setSuperMenuOpen]=useState(true);
 const [suggestionChoice,setSuggestionChoice]=useState(false);
 const [includeLinksForCase,setIncludeLinksForCase]=useState<string|null>(null);
 useEffect(()=>{if(showCard)mobileFichaClose.current?.focus();},[showCard]);
 const [usedSuggestion,setUsedSuggestion]=useState<{caseId:string;runId:string;revision:number;text:string}|null>(null);
 function trackDraft(kind:'used'|'edited'|'feedback_positive'|'feedback_negative',snapshot:CaseSnapshot){const runId=(snapshot.card as (typeof snapshot.card & {advisor_draft_run_id?:string}))?.advisor_draft_run_id;if(!runId||api.fixtures)return Promise.resolve();return api.draftEvent(snapshot.id,runId,snapshot.revision,kind).then(()=>{}).catch(()=>{setNotice('No se pudo registrar la señal del borrador.')});}
 function useSuggestion(snapshot:CaseSnapshot,mode:'insert'|'replace'){
   const card=snapshot.card;
   if(!card?.advisor_draft)return;
   const existing=mode==='insert' ? draft : '';
   const links=new Map<string,string>();
   if(includeLinksForCase===snapshot.id){
     const usedLines=new Set([existing,card.advisor_draft].join('\n').split(/\r?\n/).map(line=>line.trim()));
     for(const citation of card.citations){
       const href=publicCitationHref(citation);
       if(!href)continue;
       const url=new URL(href,window.location.origin).href;
       if(!links.has(url)&&!usedLines.has(url))links.set(url,citation.title);
     }
   }
   const suggestion=[card.advisor_draft,...Array.from(links,([url,title])=>`Fuente · ${title}\n${url}`)].join('\n\n');
   const nextDraft=[existing,suggestion].filter(Boolean).join('\n\n');
   if(links.size&&!Text.safeParse(nextDraft).success){
     setError('El mensaje con los enlaces supera el máximo de 4096 caracteres. Acorta el texto o desmarca la opción de incluir enlaces.');
     return;
   }
   setError('');
   setDraft(nextDraft);
   setUsedSuggestion(card.advisor_draft_run_id
     ? {caseId:snapshot.id,runId:card.advisor_draft_run_id,revision:snapshot.revision,text:suggestion}
     : null);
   void trackDraft('used',snapshot);
   setSuggestionChoice(false);
   requestAnimationFrame(()=>document.getElementById('message')?.focus());
 }
 const [retentionOutcome,setRetentionOutcome]=useState<'permanencia'|'baja'|'pendiente'>('pendiente');
 const [email,setEmail]=useState(''),[password,setPassword]=useState('');
 const selectionRequest=useRef(0), inboxVersion=useRef(0);
 const refresh=useCallback(async()=>{const [list,people]=await Promise.all([api.cases(),api.contacts()]);setCases(list);setContacts(people);},[]);
 async function enter(user: Viewer) {
   const caps=(user as Viewer & {capabilities?:string[]}).capabilities??[];
   const attend=canAttendViewer(user), admin=canAdminViewer(user);
   if (attend) await refresh();
   const params=new URLSearchParams(window.location.search);
   const manage=user.can_manage_administration;
   const requested=params.get('view');
   setView(requested==='models' && manage ? 'models' : requested==='operators' && manage ? 'operators' :
     requested==='follow-ups' && user.demo_features && (attend||manage) ? 'follow-ups' : attend && requested==='cases' ? 'cases' : (attend||caps.includes('superadmin')) && params.get('view')==='escalations' ? 'queue' : admin && params.get('view')==='knowledge' ? 'knowledge' : admin && params.get('view')==='evaluations' ? 'prompts' : admin && params.has('group') ? 'metrics' : admin ? 'dashboard' : attend ? 'inbox' : caps.includes('superadmin') ? 'models' : 'crm');
   setViewer(user);
 }
 useEffect(()=>{api.me().then(enter).catch(()=>setViewer(null)).finally(()=>setLoading(false))},[refresh]);
 useEffect(()=>{if(!viewer||!canAttendViewer(viewer)||view!=='inbox')return;let active=true;let pending=false;const poll=async()=>{if(pending||document.visibilityState!=='visible')return;pending=true;const version=inboxVersion.current;try{const list=await api.cases();if(active&&version===inboxVersion.current){setCases(old=>list.map(item=>{const previous=old.find(c=>c.id===item.id);return previous&&previous.revision>item.revision?previous:item}));setSelected(current=>current&&!list.some(item=>item.id===current.id)?null:current);}}catch{if(active)setNotice('No se pudo actualizar la bandeja. Se intentará de nuevo.');}finally{pending=false}};const timer=window.setInterval(poll,10000);const onVisible=()=>{if(document.visibilityState==='visible')void poll()};document.addEventListener('visibilitychange',onVisible);return()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',onVisible)}},[viewer,view]);
 useEffect(()=>{if(!selected?.id)return; const id=selected.id; return api.subscribe(id,selected.cursor,event=>{inboxVersion.current++;setSelected(current=>current?.id===id&&event.cursor>current.cursor?event.snapshot:current);setCases(current=>current.map(c=>c.id===id&&event.snapshot.revision>=c.revision?event.snapshot:c));},()=>setNotice('Reconectando actualizaciones en vivo…'),()=>{
   selectionRequest.current++;
   setSelected(current=>current?.id===id?null:current);
   setCases(current=>current.filter(item=>item.id!==id));
   setDraft('');setUsedSuggestion(null);setShowCard(false);
   setNotice('El caso cambió de asignación. Consulta su estado en Escalamientos.');
 });},[selected?.id]);
 async function run<T>(fn:()=>Promise<T>,success?:(result:T)=>void){setBusy(true);setError('');setNotice('');try{const value=await fn();success?.(value)}catch(e){setError(e instanceof Error?e.message:'Ocurrió un error. Intenta de nuevo.')}finally{setBusy(false)}}
 function apply(c:CaseSnapshot){inboxVersion.current++;setSelected(current=>current?.id===c.id&&current.cursor>c.cursor?current:c);setCases(old=>{const previous=old.find(item=>item.id===c.id);return [previous&&previous.revision>c.revision?previous:c,...old.filter(item=>item.id!==c.id)]});setModal(null)}
 function submitReply(event:FormEvent<HTMLFormElement>){
   event.preventDefault();
   const text=draft.trim();
   if(!selected||!text)return;
   void run(async()=>{
     const used=usedSuggestion?.caseId===selected.id ? usedSuggestion : null;
     const current=used?.revision===selected.revision&&used.runId===selected.card?.advisor_draft_run_id ? used : null;
     if(current&&text!==current.text.trim())await trackDraft('edited',selected);
     if(used&&!current)setNotice('La ficha cambió: el mensaje se envió sin asociarlo al borrador anterior.');
     return api.send(selected.id,text,current ? {run_id:current.runId,case_revision:current.revision} : undefined);
   },snapshot=>{
     apply(snapshot);
     setDraft('');
     setUsedSuggestion(null);
     setIncludeLinksForCase(value=>value===snapshot.id ? null : value);
   });
 }
 const selectCase=(id:string)=>{const request=++selectionRequest.current;void run(()=>api.case(id),c=>{if(request!==selectionRequest.current)return;setSelected(current=>current?.id===c.id&&current.cursor>c.cursor?current:c);setDraft('');setUsedSuggestion(null);setShowCard(false)})};
 async function login(e:FormEvent){e.preventDefault();await run(async()=>{await api.login(email,password);await enter(await api.me())})}
 if(loading)return <div className="center-screen"><div className="loader"/> Cargando consola…</div>;
 if(!viewer)return <div className="login-page"><div className="login-brand"><Brand/><div className="login-intro"><span className="eyebrow light">ATENCIÓN MÁS HUMANA</span><h1>La información correcta,<br/>en el momento justo.</h1><p>Una experiencia conectada para acompañar cada conversación.</p></div><span className="login-foot">CLARO COPILOTO · CONSOLA DE ATENCIÓN</span></div><div className="login-side"><form className="login-form" onSubmit={login}><span className="eyebrow">BIENVENIDO DE NUEVO</span><h2>Inicia sesión</h2><p>Ingresa tus credenciales para acceder a la consola.</p>{error&&<div className="alert error" role="alert">{error}</div>}<label>Correo electrónico<input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="nombre@claro.com" required/></label><label>Contraseña<input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Tu contraseña" required/></label><Button disabled={busy}>{busy?'Ingresando…':'Ingresar a la consola'} <Icon name="arrow"/></Button><small>Acceso exclusivo para personal autorizado.</small></form></div></div>;
 const capabilities=(viewer as Viewer & {capabilities?:string[]}).capabilities??[];
 const canAttend=canAttendViewer(viewer);
 const canAdmin=canAdminViewer(viewer);
 const manage=!!viewer.can_manage_administration;
 const agenda=viewer.demo_features && (canAttend||manage);
 const go=(next:View)=>{
   setView(next);setMobileMenu(false);
   if(next==='cases')window.history.replaceState(null,'','/?view=cases');
   else if(next==='queue')window.history.replaceState(null,'','/?view=escalations');
   else if(next==='models'||next==='follow-ups'||next==='operators')window.history.replaceState(null,'','/?view='+next);
   else if(next==='knowledge')window.history.replaceState(null,'','/?view=knowledge');
   else if(next==='prompts')window.history.replaceState(null,'','/?view=evaluations');
   else if(next!=='metrics'&&(window.location.search.includes('view=')||window.location.search.includes('group=')))window.history.replaceState(null,'','/');
 };
 const owner=selected?.owner_id===viewer.id;
 const escalation=selected?.tracking?.escalation;
 const waiting=escalation?.status==='en_cola';
 const composerLocked=waiting && viewer.can_register_case_customer===true;
 const refreshSelected=async()=>{
   if(!selected) throw new Error('Selecciona un caso.');
   const fresh=await api.case(selected.id);
   apply(fresh);
   return fresh;
 };
 const closeFicha=()=>{setShowCard(false);requestAnimationFrame(()=>mobileFicha.current?.focus());};
 const retentionEligible=!!selected?.verified && selected.card?.intent==='cancelacion' && (selected.card.reason_codes.includes('retention_eligible') || selected.card.proposal?.kind==='retention_offer');
 const filtered=cases.filter(c=>(filter==='all'||c.status===filter)&&`${c.display_name} ${c.id} ${c.last_message??''}`.toLowerCase().includes(search.toLowerCase()));
 return <div className={`app-shell ${menuOpen?'':'menu-collapsed'} ${mobileMenu?'mobile-menu-open':''}`}><aside className="sidebar" id="workspace-navigation"><Brand/><div className="side-label">ESPACIO DE TRABAJO</div><nav aria-label="Navegación principal">{canAttend&&<><button title="Bandeja" className={view==='inbox'?'nav-item active':'nav-item'} onClick={()=>go('inbox')}><Icon name="inbox"/><span>Bandeja</span><span className="nav-count">{cases.filter(c=>c.status==='open').length}</span></button><button title="Casos" className={view==='cases'?'nav-item active':'nav-item'} onClick={()=>go('cases')}><Icon name="file"/><span>Casos</span></button></>}{(canAttend||capabilities.includes('superadmin'))&&<><button title="Escalamientos" className={view==='queue'?'nav-item active':'nav-item'} onClick={()=>go('queue')}><Icon name="arrow"/><span>Escalamientos</span></button></>}<button title="Directorio CRM" className={view==='crm'?'nav-item active':'nav-item'} onClick={()=>go('crm')}><Icon name="users"/><span>Directorio CRM</span></button>{agenda&&<button title="Seguimientos programados" className={view==='follow-ups'?'nav-item active':'nav-item'} onClick={()=>go('follow-ups')}><Icon name="clock"/><span>Seguimientos programados</span></button>}{canAdmin&&<><div className="side-label admin-label">ADMINISTRACIÓN</div><button title="Panel general" className={view==='dashboard'?'nav-item active':'nav-item'} onClick={()=>go('dashboard')}><Icon name="chart"/><span>Panel general</span></button><button title="Tableros" className={view==='metrics'?'nav-item active':'nav-item'} onClick={()=>go('metrics')}><Icon name="chart"/><span>Tableros</span></button><button title="Prompts y evaluaciones" className={view==='prompts'?'nav-item active':'nav-item'} onClick={()=>go('prompts')}><Icon name="spark"/><span>Prompts y evals</span></button><button title="Conocimiento RAG" className={view==='knowledge'?'nav-item active':'nav-item'} onClick={()=>go('knowledge')}><Icon name="file"/><span>Conocimiento RAG</span></button>{manage&&viewer.demo_features&&<>
        <button title="Modelos del agente" className={view==='models'?'nav-item active':'nav-item'} onClick={()=>go('models')}><Icon name="spark"/><span>Modelos del agente</span></button>
        <button title="Operadores" className={view==='operators'?'nav-item active':'nav-item'} onClick={()=>go('operators')}><Icon name="users"/><span>Operadores</span></button>
      </>}</>}{manage&&!viewer.demo_features&&<div className="superadmin-nav">
        <button type="button" className="nav-item superadmin-toggle" title="Superadministración"
          aria-expanded={superMenuOpen} aria-controls="superadmin-links" onClick={()=>setSuperMenuOpen(open=>!open)}>
          <Icon name="shield"/><span>Superadministración</span><Icon name="arrow" size={14}/>
        </button>
        <div id="superadmin-links" className="superadmin-links" hidden={!superMenuOpen}>
          <button type="button" title="Modelos del agente" aria-label="Modelos del agente" aria-current={view==='models'?'page':undefined}
            className={view==='models'?'nav-item active':'nav-item'} onClick={()=>go('models')}><Icon name="spark"/><span>Modelos del agente</span></button>
          <button type="button" title="Operadores" aria-label="Operadores" aria-current={view==='operators'?'page':undefined}
            className={view==='operators'?'nav-item active':'nav-item'} onClick={()=>go('operators')}><Icon name="users"/><span>Operadores</span></button>
        </div>
      </div>}</nav><div className="sidebar-bottom"><div className="online"><span/> Sistema disponible</div><div className="profile"><div className="avatar dark-avatar">{viewer.name.split(' ').map(x=>x[0]).slice(0,2).join('')}</div><div><strong>{viewer.name}</strong><small>{capabilities.includes('superadmin')?'Superadministrador':viewer.role==='admin'?'Administrador':'Asesor'}</small></div><button className="icon-button" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={()=>run(()=>api.logout(),()=>{setViewer(null);setSelected(null)})}><Icon name="logout"/></button></div></div></aside>{mobileMenu&&<button className="menu-scrim" aria-label="Cerrar menú" onClick={()=>{setMobileMenu(false);menuButton.current?.focus()}}/>}<main className="main-area"><header className="topbar"><button ref={menuButton} className="menu-toggle icon-button" aria-controls="workspace-navigation" aria-expanded={isMobile ? mobileMenu : menuOpen} aria-label={mobileMenu?"Cerrar menú":"Alternar menú"} onClick={()=>{if(isMobile)setMobileMenu(v=>!v);else setMenuOpen(v=>{localStorage.setItem(`claro-menu:${viewer.id}`,v?"collapsed":"expanded");return !v})}}>☰</button><div className="breadcrumb">Espacio de trabajo <Icon name="arrow" size={14}/> <strong>{{inbox:'Bandeja',cases:'Casos',dashboard:'Panel general',prompts:'Prompts y evals',metrics:'Tableros',crm:'Directorio CRM',queue:'Escalamientos',operators:'Operadores',knowledge:'Conocimiento RAG',models:'Modelos del agente','follow-ups':'Seguimientos programados'}[view]}</strong></div><div className="top-right"><span className="live-dot"/> {api.fixtures?'Datos de demostración':'Consola en línea'} <div className="avatar small-avatar">{viewer.name[0]}</div></div></header>{error&&<div className="global-alert alert error" role="alert">{error}<button onClick={()=>setError('')} aria-label="Cerrar error">×</button></div>}{notice&&<div className="global-alert alert" role="status">{notice}</div>}
 {view==='inbox'?<div className="workspace"><section className={`inbox-panel ${selected?'has-selection':''}`}><div className="inbox-head"><div><span className="eyebrow">TU ESPACIO DE ATENCIÓN</span><h1>Bandeja <span>{cases.filter(c=>c.status==='open').length}</span></h1><p>Gestiona tus conversaciones en un solo lugar.</p></div><Button className="new-button" onClick={()=>setModal('new')}><Icon name="plus"/> Nuevo caso</Button></div><div className="search"><Icon name="search"/><input aria-label="Buscar conversación" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar por nombre o caso"/></div><div className="filter-row"><button className={filter==='open'?'selected':''} onClick={()=>setFilter('open')}>Abiertos <span>{cases.filter(c=>c.status==='open').length}</span></button><button className={filter==='closed'?'selected':''} onClick={()=>setFilter('closed')}>Cerrados</button><button className={filter==='all'?'selected':''} onClick={()=>setFilter('all')}>Todos</button></div><div className="list-caption">CONVERSACIONES <span>{filtered.length}</span></div><div className="case-list">{filtered.map(c=><button key={c.id} className={`case-row ${selected?.id===c.id?'selected':''}`} onClick={()=>selectCase(c.id)}><div className="avatar">{c.display_name.split(' ').map(x=>x[0]).slice(0,2).join('')}</div><div className="case-copy"><div className="case-line"><strong>{c.display_name}</strong><time>{fmt(c.updated_at)}</time></div><div className="case-line"><span className="case-id">{c.id} · {labels[c.channel]}</span>{c.attention_mode==='autoservicio'&&<span className="unread-dot"/>}</div><p>{c.last_message||'Sin mensajes todavía'}</p><Badge tone={c.status==='closed'?'neutral':c.attention_mode==='autoservicio'?'amber':'green'}>{c.status==='closed'?'Cerrado':labels[c.attention_mode]}</Badge></div></button>)}{!filtered.length&&<div className="empty-list">No hay conversaciones para mostrar.</div>}</div></section>
 {selected?<><section className="conversation"><div className="conversation-head"><button className="mobile-back icon-button" onClick={()=>setSelected(null)} aria-label="Volver a la bandeja">‹</button><div className="avatar">{selected.display_name.split(' ').map(x=>x[0]).slice(0,2).join('')}</div><div className="conversation-title"><h2>{selected.display_name}</h2><p>{selected.id} <span>•</span> {labels[selected.channel]} <span>•</span> {selected.status==='open'?'Caso abierto':'Caso cerrado'}</p></div><ShadButton variant="outline" className="button outline mobile-card-button" ref={mobileFicha} onClick={()=>setShowCard(true)}><Icon name="spark"/> Ficha</ShadButton>{selected.status==='open'&&owner&&!composerLocked&&<Button variant="outline" onClick={()=>{setRetentionOutcome('pendiente');setModal('close')}}>Cerrar caso</Button>}</div><div className="thread"><div className="day-marker"><span/> Conversación <span/></div>{selected.messages.map(m=><div className={`message-row ${m.actor==='asesor'?'outgoing':''}`} key={m.id}><div className={`message-avatar ${m.actor}`}>{m.attention_notice?<Icon name="check" size={14}/>:m.actor==='cliente'?selected.display_name[0]:m.actor==='agente'?<Icon name="spark" size={14}/>:<Icon name="users" size={14}/>}</div><div className="message-content"><div className="message-meta"><strong>{m.attention_notice?'Estado del caso':m.actor==='cliente'?selected.display_name:m.actor==='agente'?'Copiloto':'Asesor'}</strong><time>{fmt(m.created_at)}</time></div><div className="bubble"><span className="message-text"><MessageText text={m.text}/></span>{m.citations?.map(c=><div className="message-citation" key={c.id}><Icon name="file" size={14}/> {c.title} · {c.version}</div>)}</div></div></div>)}<div aria-live="polite" className="sr-only">{notice}</div></div>{selected.status==='open'?(selected.attention_mode==='autoservicio'?<div className="takeover"><div><strong>Esta conversación está en autoservicio</strong><p>Toma el caso para responder directamente al cliente.</p></div><Button disabled={busy} onClick={()=>run(()=>api.take(selected.id),snapshot=>{apply(snapshot);setNotice('Caso tomado.');})}>Tomar caso <Icon name="arrow"/></Button></div>:composerLocked?<div className="assisted-composer-lock" role="status">
  <strong>Caso escalado · En espera de {escalationDestinations[escalation.destination]}</strong>
  <p>El cliente puede seguir escribiendo. El envío se reanuda para el asesor asignado si cancelas la solicitud.</p>
  <Button variant="outline" onClick={()=>go('queue')}>Ver escalamiento</Button>
 </div>:<form className="composer" onSubmit={submitReply}><AdvisorSuggestion card={selected.card}>
   {selected.card?.citations.some(publicCitationHref)&&<label className="assisted-draft-links">
     <input type="checkbox" checked={includeLinksForCase===selected.id}
       onChange={event=>setIncludeLinksForCase(event.currentTarget.checked ? selected.id : null)}/>
     Incluir enlaces públicos en el mensaje
   </label>}
   <div className="assisted-draft-actions">
     {suggestionChoice ? <>
       <Button type="button" variant="outline" onClick={()=>useSuggestion(selected,'insert')}>Insertar</Button>
       <Button type="button" variant="outline" onClick={()=>useSuggestion(selected,'replace')}>Reemplazar</Button>
       <Button type="button" variant="ghost" onClick={()=>setSuggestionChoice(false)}>Cancelar</Button>
     </> : <Button type="button" variant="outline" onClick={()=>{if(draft.trim())setSuggestionChoice(true);else useSuggestion(selected,'replace');}}>Usar en respuesta</Button>}
     <div><Button type="button" variant="ghost" onClick={()=>void trackDraft('feedback_positive',selected)}>Útil</Button>
       <Button type="button" variant="ghost" onClick={()=>void trackDraft('feedback_negative',selected)}>No útil</Button></div>
   </div>
 </AdvisorSuggestion>
 {usedSuggestion?.caseId===selected.id&&(usedSuggestion.revision!==selected.revision||usedSuggestion.runId!==selected.card?.advisor_draft_run_id)&&<p className="alert" role="status">La ficha cambió. Revisa tu mensaje: ya no está asociado al borrador anterior.</p>}<label className="sr-only" htmlFor="message">Mensaje al cliente</label><textarea id="message" value={draft} onChange={e=>setDraft(e.target.value)} placeholder="Escribe un mensaje al cliente..." rows={2}/><div className="composer-footer"><span>El cliente recibirá este mensaje en {labels[selected.channel]}.</span><Button disabled={busy||!draft.trim()}>Enviar mensaje <Icon name="send" size={16}/></Button></div></form>):<div className="closed-message"><Icon name="check"/> Este caso está cerrado.</div>}</section><aside className={`insight-panel assisted-insight ${showCard?'show':''}`} aria-label="Asistencia en tiempo real" onKeyDown={event=>{
   if (showCard&&event.key==='Escape') closeFicha();
 }}>
  <div className="insight-head"><div className="insight-icon"><Sparkles aria-hidden="true"/></div>
    <div><h2>Copiloto</h2><p>Asistencia en tiempo real</p></div>
    <button className="mobile-card-button icon-button" ref={mobileFichaClose} onClick={closeFicha} aria-label="Cerrar ficha"><Icon name="close"/></button>
  </div>
  <div className="private-note"><Icon name="shield" size={15}/> Solo visible para el asesor</div>
  <div className="insight-scroll">
   {selected.status==='open'&&owner&&<EscalationRequest key={selected.id} caseId={selected.id} revision={selected.revision}
     active={escalation} suggestion={selected.retention_discount?.status==='requested'
       ? {destination:'comercial_portabilidad',reason_code:'revision_descuento_retencion'} : selected.card?.suggested_escalation}
     turnId={selected.messages.filter(message=>!message.attention_notice).at(-1)?.id}
     onDone={refreshSelected}/>}
   <CaseIntegrationTabs key={selected.id} caseId={selected.id} enabled={selected.verified&&owner&&!api.fixtures}
    open={selected.status==='open'&&!composerLocked}
    retention={viewer.demo_features&&owner&&selected.verified&&(selected.card?.intent==='cancelacion'||selected.retention_discount) ? {
      snapshot:selected,canIssue:manage&&!composerLocked,refresh:refreshSelected,onUse:text=>{
        setDraft(current=>[current,text].filter(Boolean).join('\n\n'));closeFicha();
        requestAnimationFrame(()=>document.getElementById('message')?.focus());
      }
    } : undefined} customerRegistration={owner&&!selected.verified&&selected.status==='open'&&!composerLocked&&viewer.can_register_case_customer
      ? <CaseCustomerRegistration snapshot={selected} updated={refreshSelected}/> : undefined}>
    <div className="assisted-summary">
     <section className="assisted-summary-lead" aria-label="Resumen del caso">
      <div className="assisted-summary-heading"><h3>Resumen del caso</h3>
       {selected.card?.summary_update?.origin==='ia'&&<span><Sparkles size={14} aria-hidden="true"/> Generado con IA</span>}</div>
      <p>{selected.card?.closure_summary || selected.card?.summary || (owner ? 'El Copiloto está preparando el resumen.' : 'Toma el caso para consultar su historial y resumen.')}</p>
      {selected.card?.summary_update&&<small>{selected.card.summary_update.stale ? 'Actualización pendiente · ' : 'Actualizado · '}{fmt(selected.card.summary_update.at)}</small>}
     </section>
     {(escalation||selected.handoff_reason||selected.card?.handoff_summary)&&<section aria-label={escalation?'Motivo del escalamiento':'Motivo del traspaso'}>
       <h3>{escalation?'Motivo del escalamiento':'Motivo del traspaso'}</h3>
       {escalation&&<small>{escalationDestinations[escalation.destination]} · Confirmado por el asesor</small>}
       <p>{escalation?.reason_text || escalation?.reason_code.replaceAll('_',' ') || selected.handoff_reason || selected.card?.handoff_summary}</p>
     </section>}
     {selected.card&&<>
      <section aria-label="Recomendaciones y pendientes">
       <h3>Recomendaciones y pendientes</h3>
       <p className="assisted-recommendation"><Sparkles size={16} aria-hidden="true"/>{selected.card.next_action}</p>
       {selected.card.requested_discount&&<p>El cliente solicitó {selected.card.requested_discount} % de descuento.</p>}
       {selected.retention_discount&&<RetentionStateDetails discount={selected.retention_discount}/>}
       {selected.card.retention_options&&<>
         <h4>Alternativas elegibles</h4>
         <ul className="retention-options">{selected.card.retention_options.map(option=><li key={option.id}>
           <strong>{option.title}</strong><span>{option.detail}</span>
         </li>)}</ul>
       </>}
       {selected.card.pending.length>0&&<ul>{selected.card.pending.map(item=><li key={item}>{item}</li>)}</ul>}
       {selected.card.context_question&&<div className="assisted-question">
         <strong>Pregunta sugerida</strong><p>{selected.card.context_question.text}</p>
         <Button variant="outline" disabled={selected.status!=='open'||composerLocked||!owner} onClick={()=>{
           const question=selected.card?.context_question;
           if (question) {setDraft(current=>[current,question.text].filter(Boolean).join('\n\n'));closeFicha();}
         }}>Añadir al mensaje</Button>
       </div>}
      </section>
      <section aria-label="Intención sugerida"><h3>Intención sugerida</h3>
       <p className="assisted-intent">{selected.card.objectives?.map(item=>item.replaceAll('_',' ')).join(' · ') ||
         selected.card.intent?.replaceAll('_',' ') || 'Por identificar'}</p>
       {selected.ml&&<CaseMl key={selected.id} caseId={selected.id} signals={selected.ml} revision={selected.revision} verified={selected.verified} demo={viewer.demo_features}/>}
      </section>
      <section aria-label="Hechos y fuentes"><h3>Hechos y fuentes</h3>
       {selected.intake&&Object.keys(selected.intake.facts).length>0&&<><strong>Declarado por el cliente</strong>
        <ul>{Object.entries(selected.intake.facts).map(([field,value])=><li key={field}>{value}</li>)}</ul></>}
       {selected.card.facts.length>0&&<><strong>Evidencia del caso</strong><dl className="assisted-facts">
        {selected.card.facts.map(fact=><div key={fact.id}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
       </dl></>}
       {selected.card.citations.map(source=>{
         const href=advisorCitationHref(source);
         return <details className="source" key={source.id}>
           <summary><Icon name="file" size={16}/><span>{source.title}<small>Versión {source.version}</small></span></summary>
           <p>{source.excerpt}</p>{href&&<a href={href} target="_blank" rel="noreferrer">Abrir fuente</a>}
         </details>;
       })}
       {!selected.card.citations.length&&!selected.card.facts.length&&!Object.keys(selected.intake?.facts??{}).length&&<p>Aún no hay evidencia en la ficha.</p>}
      </section>
      {selected.card.proposal&&<section className="proposal">
        <div className="section-title"><h3>Propuesta</h3><Badge tone="amber">{labels[selected.card.proposal.status]}</Badge></div>
        <strong>{selected.card.proposal.title}</strong><p>{selected.card.proposal.detail}</p>
        {selected.card.proposal.effect_ref&&<small>Referencia {selected.card.proposal.effect_ref}</small>}
        {selected.card.proposal.status==='pending_approval'&&!composerLocked&&owner&&<div className="proposal-actions">
         <Button disabled={busy} onClick={()=>setModal('approve')}>Revisar propuesta</Button>
         <Button variant="ghost" disabled={busy} onClick={()=>run(()=>api.decision(selected.id,selected.card!.proposal!.id,selected.card!.proposal!.revision,'rejected'),apply)}>Rechazar</Button>
        </div>}
      </section>}
     </>}
     {selected.closure&&<section aria-label="Resultado del cierre"><h3>{selected.closure.outcome==='resolved'?'Cerrado como resuelto':'Cerrado con pendientes'}</h3>
       <p>{selected.closure.reason || (selected.closure.evidence==='cliente'?'Confirmación del cliente registrada.':null)}</p>
     </section>}
     <CaseTracking tracking={selected.tracking}/>
    </div>
   </CaseIntegrationTabs>
  </div>
 </aside></>:<div className="empty-conversation"><div className="empty-icon"><Icon name="inbox" size={28}/></div><h2>Tu próxima conversación comienza aquí</h2><p>Selecciona un caso de la bandeja para ver el historial y la asistencia del copiloto.</p></div>}</div>:view==='cases'&&canAttend?<CasesWorkspace openCase={id=>{go('inbox');selectCase(id);}}
  taken={snapshot=>{go('inbox');setDraft('');setUsedSuggestion(null);apply(snapshot);setNotice('Caso tomado.');}}
  followEscalations={()=>go('queue')}/>:view==='dashboard'?<AdminDashboard/>:view==='metrics'?<MetricsBoard operatorId={viewer.id}/>:view==='crm'?<CustomerDirectory openEscalations={()=>go('queue')} authorizedCases={canAttend?cases.filter(c=>c.owner_id===viewer.id).map(c=>c.id):[]} canManage={manage} canReadBilling={viewer.can_read_mock_billing} eligibleContacts={contacts.filter(c=>c.enabled).map(c=>c.ref)} startCase={canAttend?id=>{setContact(id);go('inbox');setModal('new')}:undefined} openCase={id=>{go('inbox');selectCase(id)}}/>:view==='queue'?<EscalationQueue viewerId={viewer.id} canManage={capabilities.some(x=>['supervisor','superadmin'].includes(x))} openCase={id=>{go('inbox');selectCase(id)}}/>:view==='follow-ups'&&agenda?<FollowUpsAgenda openCase={id=>{go('inbox');selectCase(id)}}/>:view==='operators'&&manage?<Operators demo={viewer.demo_features}/>:view==='models'?(manage?<AdminAgentModels/>:
 <section className="admin-page"><header className="ops-header"><div><h1>Modelos del agente</h1>
 <p>Para abrir esta sección, inicia sesión con una cuenta administrativa.</p></div></header></section>):view==='knowledge'&&canAdmin?<AdminKnowledge/>:<AdminEvaluations/>}
 </main>
 {modal==='new'&&<Modal title="Iniciar conversación" onClose={()=>setModal(null)}><p>Selecciona un contacto habilitado y envía el primer mensaje.</p><label>Contacto<select value={contact} onChange={e=>setContact(e.target.value)}><option value="">Selecciona un contacto</option>{contacts.filter(c=>c.enabled).map(c=><option value={c.ref} key={c.ref}>{c.display_name}</option>)}</select></label><label>Mensaje inicial<textarea rows={4} value={opening} onChange={e=>setOpening(e.target.value)} placeholder="Hola, te contactamos de Claro..."/></label><div className="modal-actions"><Button variant="outline" onClick={()=>setModal(null)}>Cancelar</Button><Button disabled={busy||!contact||!opening.trim()} onClick={()=>run(()=>api.open(contact,opening.trim()),c=>{apply(c);setOpening('');setContact('')})}>Iniciar conversación</Button></div></Modal>}
 {modal==='close'&&selected&&viewer.demo_features&&<Modal title="Cerrar caso" onClose={()=>setModal(null)}>
   <CaseCloseForm snapshot={selected} close={()=>setModal(null)} confirmed={apply} eligible={Boolean(retentionEligible)}/>
 </Modal>}
 {modal==='close'&&selected&&!viewer.demo_features&&<Modal title="Cerrar caso" onClose={()=>setModal(null)}><p>Se cerrará la conversación con {selected.display_name}. Indica si la solicitud quedó resuelta.</p>{selected.verified&&selected.ml&&<CaseMl caseId={selected.id} signals={selected.ml} revision={selected.revision} verified closing/>}<label className="checkbox"><input type="checkbox" checked={resolved} onChange={e=>setResolved(e.target.checked)}/> La solicitud quedó resuelta</label>{retentionEligible&&<label>Resultado de retención<select value={retentionOutcome} onChange={e=>setRetentionOutcome(e.target.value as typeof retentionOutcome)}><option value="pendiente">Pendiente</option><option value="permanencia">Permanencia confirmada</option><option value="baja">Baja confirmada</option></select></label>}<div className="modal-actions"><Button variant="outline" onClick={()=>setModal(null)}>Cancelar</Button><Button disabled={busy} onClick={()=>run(()=>api.close(selected.id,resolved,retentionEligible?retentionOutcome:undefined),apply)}>Confirmar cierre</Button></div></Modal>}
 {modal==='approve'&&selected?.card?.proposal&&<Modal title="Confirmar propuesta" onClose={()=>setModal(null)}><p>{selected.card.proposal.kind === 'support_ticket' ? 'Confirma el registro del ticket prioritario. La franja se coordina después.' : 'Confirma que el cliente aceptó esta alternativa antes de registrarla.'}</p><div className="confirm-detail"><strong>{selected.card.proposal.title}</strong><p>{selected.card.proposal.detail}</p><small>Cliente: {selected.display_name} · {selected.id}</small></div><div className="modal-actions"><Button variant="outline" onClick={()=>setModal(null)}>Volver</Button><Button disabled={busy} onClick={()=>run(()=>api.decision(selected.id,selected.card!.proposal!.id,selected.card!.proposal!.revision,'approved'),apply)}>Confirmar y registrar</Button></div></Modal>}
 </div>
}
function Brand(){return <div className="brand"><div className="brand-mark">claro<span>✳</span></div><div className="brand-divider"/><div className="brand-name">copiloto<small>CONSOLA DE ATENCIÓN</small></div></div>}
