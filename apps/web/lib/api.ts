import type { AgentModelActivation, AgentModelCatalog, AgentModelPolicy, AgentModelRevision, AgentModelRevisions, ModelValidation } from '@claro/contracts';
import type { CaseEvent, CaseSnapshot, CaseSummary, Contact, Dashboard, DashboardFilters, EvalJob, EvalStatus, PromptRevision, Viewer, BillingView, CrmView, InvoiceDetail, ManualAction, IntegrationHealth, IntegrationOperation, KnowledgeInventory, KnowledgeLabQuery, KnowledgeLabResult, KnowledgePassage } from '@claro/contracts';
import type { LangfuseEvaluations } from '@claro/contracts';

const fixtures = process.env.NEXT_PUBLIC_FIXTURES === 'true';
const now = () => new Date().toISOString();
const key = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export { key };
const policy = { id: 'policy', title: 'Política de retención', excerpt: 'Elegibilidad sujeta a mora máxima de 30 días y condiciones vigentes.', version: 'v1' };
const catalog = { id: 'catalog', title: 'Catálogo Fibra 500', excerpt: 'Conoce las condiciones del plan Hogar Fibra 500.', version: 'v1' };
const seed: CaseSnapshot[] = [
 { id:'C-1001', conversation_id:'conv-1001', display_name:'María Rodríguez', channel:'telegram', attention_mode:'autoservicio', owner_id:null, verified:false, status:'open', revision:1, updated_at:now(), last_message:'¿Y cuánto debo en mi factura?', cursor:1, messages:[{id:'m1',turn_seq:1,actor:'cliente',text:'Hola, quiero saber sobre Fibra 500.',created_at:now()},{id:'m2',turn_seq:2,actor:'agente',text:'Claro, Fibra 500 te ofrece conexión para tu hogar. Puedes consultar sus condiciones en el catálogo.',created_at:now(),citations:[catalog]},{id:'m3',turn_seq:3,actor:'cliente',text:'¿Y cuánto debo en mi factura?',created_at:now()}], card:{intent:'facturacion',summary:'María consultó por Fibra 500 y ahora necesita conocer el valor de su factura.',facts:[],citations:[catalog],pending:['Validar titularidad para consultar la cuenta'],next_action:'Toma el caso y valida al titular para consultar la factura.',reason_codes:['consulta_cuenta']} },
 { id:'C-1007', conversation_id:'conv-1007', display_name:'Andrés Gómez', channel:'telegram', attention_mode:'asistido', owner_id:'advisor-demo', verified:false, status:'open', revision:1, updated_at:now(), last_message:'Quiero cancelar. ¿Me pueden dar un descuento?', cursor:1, messages:[{id:'m7',turn_seq:1,actor:'cliente',text:'Quiero cancelar. ¿Me pueden dar un descuento?',created_at:now()}], card:{intent:'cancelacion',summary:'El cliente solicita cancelar y pregunta por un descuento.',facts:[],citations:[],pending:['Validar titularidad para evaluar elegibilidad'],next_action:'Valida al titular para revisar la política de retención.',reason_codes:['retencion']} }
];
let cases = structuredClone(seed);
let revisions: PromptRevision[] = [{revision:'rev-1',status:'active',prompts:{atencion:'Responde con claridad, respalda tus afirmaciones y protege los datos del cliente.',retencion:'Evalúa la elegibilidad y presenta opciones respaldadas por la política vigente.'}}];
const contacts: Contact[] = [{ref:'C-1004',display_name:'Laura Martínez · C-1004',enabled:true},{ref:'C-1001',display_name:'María Rodríguez · C-1001',enabled:true},{ref:'C-1007',display_name:'Andrés Gómez · C-1007',enabled:true}];
const dashboard: Dashboard = {sample:'synthetic',window_days:30,revision:'rev-1',metrics:[{id:'cases',label:'Casos atendidos',value:128,unit:'casos',denominator:128},{id:'fcr',label:'Resolución al primer contacto',value:78,unit:'%',denominator:128},{id:'aht',label:'Tiempo medio de atención',value:8.4,unit:'min',denominator:128},{id:'quality',label:'Respuestas con respaldo',value:92,unit:'%',denominator:75}],providers:[{name:'Plataforma',status:'operativo'},{name:'Agente',status:'operativo'},{name:'ML · modo sombra',status:'operativo'}]};
class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(path:string, init?:RequestInit):Promise<T> { const response = await fetch(path,{...init,credentials:'same-origin',headers:{'Content-Type':'application/json',...init?.headers}}); if(!response.ok){let message = `No fue posible completar la solicitud (${response.status}).`; try {const data=await response.json(); if(typeof data.message==='string') message=data.message;}catch{} throw new ApiError(message,response.status);} return response.json() as Promise<T>; }
const post = <T>(path:string, body:unknown={}) => request<T>(path,{method:'POST',body:JSON.stringify(body)});
const knowledgePath='/api/v1/admin/knowledge';
const knowledgeSource=(digest:string,source:string)=>`${knowledgePath}/publications/${encodeURIComponent(digest)}/sources/${encodeURIComponent(source)}`;
const copy = <T,>(value:T):T => structuredClone(value);
function getCase(id:string){const c=cases.find(x=>x.id===id); if(!c) throw new Error('No se encontró el caso.'); return c;}
function update(id:string, fn:(c:CaseSnapshot)=>void){const c=getCase(id);fn(c);c.revision++;c.cursor++;c.updated_at=now();return copy(c);}
function verifiedCard(c:CaseSnapshot){ if(c.id==='C-1001') {c.card={intent:'facturacion',summary:'Consulta de factura pendiente después de conocer Fibra 500.',facts:[{id:'p1',label:'Hogar',value:'Fibra 500 · $109.900'},{id:'p2',label:'Móvil',value:'Claro Max 60 GB · $59.415'},{id:'p3',label:'Factura noviembre',value:'$169.315 · vence el 25 de noviembre'}],citations:[catalog],pending:[],next_action:'Comparte el valor y vencimiento con el cliente.',reason_codes:[]};} else if(c.id==='C-1007'){c.card={intent:'cancelacion',summary:'Solicita cancelar y pregunta por un descuento.',facts:[{id:'f1',label:'Mora',value:'45 días'},{id:'f2',label:'Límite de política',value:'30 días'}],citations:[policy],pending:['Continuar trámite de cancelación'],next_action:'Explica la condición y continúa con la solicitud de cancelación.',reason_codes:['no_elegible']};} else {c.card={intent:'cancelacion',summary:'Cliente interesado en cancelar. Es elegible para alternativas de retención.',facts:[{id:'f1',label:'Antigüedad',value:'30 meses'},{id:'f2',label:'Mora',value:'0 días'},{id:'f3',label:'Ofertas últimos 12 meses',value:'0'}],citations:[policy],pending:['Confirmar aceptación del cliente'],next_action:'Presenta las alternativas y confirma la elección del cliente.',reason_codes:['elegible'],proposal:{id:'proposal-1004',revision:1,title:'30 % de descuento por seis meses',detail:'Sobre $89.900 durante seis meses. Alternativa: mejora a Fibra 500 sin costo por seis meses.',status:'pending_approval'}};} }
const caseIntegration = (id: string) => `/api/v1/cases/${encodeURIComponent(id)}/integrations`;
const adminIntegration = '/api/v1/admin/integrations';
const directoryBilling = (id: string) => `/api/v1/crm/customers/${encodeURIComponent(id)}/billing`;

export const integrations = {
 crm: (id: string) => request<CrmView>(caseIntegration(id)+'/crm'),
 billing: (id: string) => request<BillingView>(caseIntegration(id)+'/billing'),
 invoice: (id: string, ref: string) => request<InvoiceDetail>(caseIntegration(id)+'/billing/invoices/'+encodeURIComponent(ref)),
 directoryBilling: async (id: string): Promise<BillingView | null> => {
   try {
     return await request<BillingView>(directoryBilling(id));
   } catch (error) {
     if (error instanceof ApiError && error.status === 404) return null;
     throw error;
   }
 },
 directoryInvoice: (id: string, ref: string) => request<InvoiceDetail>(directoryBilling(id)+'/invoices/'+encodeURIComponent(ref)),
 operations: (id: string) => request<IntegrationOperation[]>(caseIntegration(id)+'/operations'),
 confirm: (id: string, action: ManualAction, idempotency_key: string) =>
   post<IntegrationOperation>(caseIntegration(id)+'/operations',{idempotency_key,action}),
 health: () => request<IntegrationHealth[]>(adminIntegration),
 approvals: () => request<IntegrationOperation[]>(adminIntegration+'/approvals'),
 approve: (id: string, approved: boolean) => post<IntegrationOperation>(adminIntegration+'/approvals/'+encodeURIComponent(id),{approved})
};
export const api = {
  agentModelCatalog:()=>request<AgentModelCatalog>('/api/v1/admin/agent-models/catalog'),
  agentModelRevisions:()=>request<AgentModelRevisions>('/api/v1/admin/agent-models/revisions'),
  saveAgentModelRevision:(input:{base_revision:string;reason:string;policy:AgentModelPolicy})=>request<AgentModelRevision>(
    '/api/v1/admin/agent-models/revisions',{method:'POST',body:JSON.stringify(input)}),
  validateAgentModelRevision:(revision:string)=>request<ModelValidation>(
    `/api/v1/admin/agent-models/revisions/${encodeURIComponent(revision)}/validate`,{method:'POST',body:'{}'}),
  applyAgentModelRevision:(revision:string,action:'activate'|'restore',input:{expected_revision:string;reason:string;evidence:string})=>request<AgentModelActivation>(
    `/api/v1/admin/agent-models/revisions/${encodeURIComponent(revision)}/${action}`,{method:'POST',body:JSON.stringify(input)}),
 fixtures,
 me:()=>fixtures?Promise.resolve<Viewer>({id:'advisor-demo',name:'Valentina Torres',role:'admin',capabilities:['admin','n1'],specialties:[],available:true}):request<Viewer>('/api/v1/me'),
 login:(email:string,password:string)=>fixtures?Promise.resolve({}):post('/api/auth/sign-in/email',{email,password}),
 logout:()=>fixtures?Promise.resolve({}):post('/api/auth/sign-out'),
 contacts:()=>fixtures?Promise.resolve(copy(contacts)):request<Contact[]>('/api/v1/contacts'),
 cases:()=>fixtures?Promise.resolve(copy(cases as CaseSummary[])):request<CaseSummary[]>('/api/v1/cases'),
 case:(id:string)=>fixtures?Promise.resolve(copy(getCase(id))):request<CaseSnapshot>(`/api/v1/cases/${encodeURIComponent(id)}`),
 open:(contact_ref:string,text:string)=>{if(!fixtures)return post<CaseSnapshot>('/api/v1/cases',{contact_ref,text,idempotency_key:key()}); const c:CaseSnapshot={id:contact_ref,conversation_id:`conv-${contact_ref}`,display_name:'Laura Martínez',channel:'telegram',attention_mode:'asistido',owner_id:'advisor-demo',verified:false,status:'open',revision:1,updated_at:now(),last_message:text,cursor:1,messages:[{id:key(),turn_seq:1,actor:'asesor',text,created_at:now()}],card:{intent:null,summary:'Contacto iniciado por el asesor.',facts:[],citations:[],pending:['Esperar respuesta del cliente'],next_action:'Continúa la conversación y valida al titular cuando sea necesario.',reason_codes:[]}}; cases=[c,...cases.filter(x=>x.id!==contact_ref)];return Promise.resolve(copy(c));},
 take:(id:string)=>fixtures?Promise.resolve(update(id,c=>{c.attention_mode='asistido';c.owner_id='advisor-demo';})):post<CaseSnapshot>(`/api/v1/cases/${encodeURIComponent(id)}/take`),
 send:(id:string,text:string,draft?:{run_id:string;case_revision:number})=>fixtures?Promise.resolve(update(id,c=>{c.messages.push({id:key(),turn_seq:c.messages.length+1,actor:'asesor',text,created_at:now()});c.last_message=text;if(c.id==='C-1004'&&c.verified&&c.card)c.card.pending=['Esperar confirmación del cliente'];})):post<CaseSnapshot>(`/api/v1/cases/${encodeURIComponent(id)}/messages`,{text,idempotency_key:key(),...(draft?{draft}:{})}),
 close:(id:string,resolved:boolean,retention_outcome?:'permanencia'|'baja'|'pendiente')=>fixtures?Promise.resolve(update(id,c=>{c.status='closed';})):post<CaseSnapshot>(`/api/v1/cases/${encodeURIComponent(id)}/close`,{resolved,...(retention_outcome?{retention_outcome}:{})}),
 decision:(id:string,proposalId:string,revision:number,decision:'approved'|'rejected')=>fixtures?Promise.resolve(update(id,c=>{if(c.card?.proposal){c.card.proposal.status=decision==='approved'?'confirmed':'rejected';if(decision==='approved')c.card.proposal.effect_ref='CRM-OFERTA-1004';}})):post<CaseSnapshot>(`/api/v1/proposals/${encodeURIComponent(proposalId)}/decision`,{decision,revision,idempotency_key:key()}),
 draftEvent:(id:string,run_id:string,case_revision:number,kind:'used'|'edited'|'feedback_positive'|'feedback_negative')=>post(`/api/v1/cases/${encodeURIComponent(id)}/draft-events`,{run_id,case_revision,event_id:key(),kind}),
 dashboard:(filters: DashboardFilters)=>fixtures?Promise.resolve(copy(dashboard)):request<Dashboard>('/api/v1/admin/dashboard?'+new URLSearchParams(filters)),
  langfuseEvaluations: (experiment?: string) => fixtures
    ? Promise.resolve<LangfuseEvaluations>({ dataset_url: null, evaluator_url: null, runs: [], selected_id: null, cases: [] })
    : request<LangfuseEvaluations>('/api/v1/admin/evaluations/langfuse' + (experiment ? '?' + new URLSearchParams({ experiment }) : '')),
 knowledgeInventory:()=>request<KnowledgeInventory>(`${knowledgePath}/publications`),
 knowledgePassages:(digest:string,source:string,signal?:AbortSignal)=>request<KnowledgePassage[]>(`${knowledgeSource(digest,source)}/passages`,{signal}),
 knowledgeQuery:(input:KnowledgeLabQuery)=>post<KnowledgeLabResult>(`${knowledgePath}/lab/query`,input),
 knowledgeOriginal:async(digest:string,source:string)=>{
   const response=await fetch(`${knowledgeSource(digest,source)}/original`,{credentials:'same-origin'});
   if (!response.ok) {
     const error=await response.json().catch(()=>null) as {message?:string}|null;
     throw new Error(error?.message??'No se pudo descargar el original.');
   }
   return response.blob();
 },
 prompts:()=>fixtures?Promise.resolve(copy(revisions)):request<PromptRevision[]>('/api/v1/admin/prompts'),
 savePrompts:(prompts:Record<string,string>)=>{if(!fixtures)return post<PromptRevision>('/api/v1/admin/prompts',{prompts});const r:PromptRevision={revision:`rev-${revisions.length+1}`,status:'candidate',prompts};revisions=[r,...revisions];return Promise.resolve(copy(r));},
 reviewPrompt:(revision:string,evidence:unknown)=>post(`/api/v1/admin/prompts/${encodeURIComponent(revision)}/review`,evidence),
 importPrompt:(keyName:string,version:number)=>post<PromptRevision>('/api/v1/admin/prompts/import',{key:keyName,version}),
 rollback:(revision:string)=>post<PromptRevision>(`/api/v1/admin/prompts/${encodeURIComponent(revision)}/rollback`),
 eval:(revision:string)=>post<EvalJob>(`/api/v1/admin/prompts/${encodeURIComponent(revision)}/eval`),
 evalStatus:(revision:string)=>fixtures?Promise.resolve<EvalStatus>({job:null,report:null}):request<EvalStatus>(`/api/v1/admin/prompts/${encodeURIComponent(revision)}/eval`),
 activate:(revision:string)=>{if(!fixtures)return post<PromptRevision>(`/api/v1/admin/prompts/${encodeURIComponent(revision)}/activate`);revisions.forEach(r=>{if(r.status==='active')r.status='passed';if(r.revision===revision)r.status='active';});return Promise.resolve(copy(revisions.find(x=>x.revision===revision)!));},
 subscribe:(id:string,cursor:number,onEvent:(event:CaseEvent)=>void,onError:()=>void)=>{if(fixtures)return ()=>{};const stream=new EventSource(`/api/v1/cases/${encodeURIComponent(id)}/events?cursor=${cursor}`);stream.addEventListener('case.updated',event=>{try{onEvent(JSON.parse((event as MessageEvent).data) as CaseEvent);}catch{onError();}});stream.onerror=onError;return ()=>stream.close();}
};
