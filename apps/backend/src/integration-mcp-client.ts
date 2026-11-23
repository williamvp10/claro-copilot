import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DataSource } from 'typeorm';
import type { AgentPorts } from '@claro/contracts';
import { runContext } from './business.js';
import { signCapability } from './mcp-capability.js';

/** Issues a single-tool, short-lived capability. Account references never come from the model. */
export function integrationMcpPorts(db:DataSource, fallback:AgentPorts):AgentPorts {
 const token=process.env.INTEGRATION_MCP_TOKEN, key=process.env.INTEGRATION_MCP_SIGNING_KEY;
 async function call<T>(runId:string, domain:'crm'|'billing', tool:string, args:Record<string,string> = {}):Promise<T> {
  const endpoint=process.env[domain === 'crm' ? 'CRM_MCP_URL' : 'BILLING_MCP_URL'];
  if (!endpoint || !token || !key || token.length<24 || key.length<32) throw new Error('integration MCP not configured');
  const url=new URL(endpoint);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['crm-mcp','billing-mcp','localhost','127.0.0.1'].includes(url.hostname))) throw new Error('MCP URL not private');
  const {row,turn}=await runContext(db.manager,runId,false);
  const capability=signCapability({run_id:runId,case_id:row.id,case_revision:turn.case_revision,aud:domain,exp:Date.now()+15000,actions:[tool]},key);
  const transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${token}`,'X-Case-Capability':capability},signal:AbortSignal.timeout(3500)}});
  const client=new Client({name:'claro-agent',version:'1.0.0'});
  try { await client.connect(transport); const result=await client.callTool({name:tool,arguments:args},undefined,{timeout:3500}); if (result.isError || !result.structuredContent || typeof result.structuredContent !== 'object' || !('data' in result.structuredContent)) throw new Error('MCP read failed'); return result.structuredContent.data as T; }
  finally { await client.close().catch(()=>undefined); }
 }
 return {...fallback,
  getCustomerContext:(id)=>call<Awaited<ReturnType<AgentPorts['getCustomerContext']>>>(id,'crm','crm.get_customer_context').catch(()=>[{id:'crm-unavailable',label:'CRM',value:'API temporalmente indisponible'}]),
  listServices:(id)=>call<Awaited<ReturnType<NonNullable<AgentPorts['listServices']>>>>(id,'crm','crm.list_services').catch(()=>[{id:'crm-unavailable',label:'CRM',value:'API temporalmente indisponible'}]),
  getBilling:(id)=>call<Awaited<ReturnType<AgentPorts['getBilling']>>>(id,'billing','billing.get_balance').catch(()=>[{id:'facturación-unavailable',label:'Facturación',value:'API temporalmente indisponible'}]),
  listInvoices:(id)=>call<Awaited<ReturnType<NonNullable<AgentPorts['listInvoices']>>>>(id,'billing','billing.list_invoices').catch(()=>[{id:'facturación-unavailable',label:'Facturación',value:'API temporalmente indisponible'}]),
  getInvoiceDetail:(id,invoiceId)=>call<Awaited<ReturnType<NonNullable<AgentPorts['getInvoiceDetail']>>>>(id,'billing','billing.get_invoice_detail',{invoice_id:invoiceId}).catch(()=>[{id:'facturación-unavailable',label:'Facturación',value:'Detalle no disponible o no autorizado'}]),
  getTickets:(id)=>call<Awaited<ReturnType<AgentPorts['getTickets']>>>(id,'crm','crm.list_recent_tickets').catch(()=>[{id:'crm-unavailable',label:'CRM',value:'API temporalmente indisponible'}]),
  evaluateRetention:(id)=>call<Awaited<ReturnType<AgentPorts['evaluateRetention']>>>(id,'crm','crm.evaluate_retention').catch(()=>({eligible:false,reason:'CRM temporalmente indisponible. Verifica la elegibilidad antes de ofrecer beneficios.',facts:[{id:'crm-unavailable',label:'CRM',value:'API temporalmente indisponible'}],policy:{id:'retention-unavailable',title:'Fuente pendiente',version:'pendiente',excerpt:'Verificar la política y elegibilidad antes de ofrecer beneficios.'},options:[]}))
 };
}
