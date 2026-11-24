import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DataSource } from 'typeorm';
import { TransientReadError, type AgentPorts, type Fact } from '@claro/contracts';
import { isTransientMcpRead } from '@claro/agent';
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
  try {
   await client.connect(transport);
   const result=await client.callTool({name:tool,arguments:args},undefined,{timeout:3500});
   const content=result.structuredContent;
   if (!content || typeof content!=='object') throw new Error('MCP read failed');
   if (result.isError && 'code' in content && content.code==='read_temporarily_unavailable') throw new TransientReadError();
   if (result.isError || !('data' in content)) throw new Error('MCP read failed');
   return content.data as T;
  } catch (error) {
   if (isTransientMcpRead(error)) throw new TransientReadError();
   throw error;
  }
  finally { await client.close().catch(()=>undefined); }
 }
 function unavailable(error:unknown,domain:'crm'|'billing'):Fact[] {
  if (error instanceof TransientReadError) throw error;
  return domain==='crm'
   ? [{id:'crm-unavailable',label:'CRM',value:'API temporalmente indisponible'}]
   : [{id:'facturación-unavailable',label:'Facturación',value:'Lectura sin confirmar'}];
 }
 return {...fallback,
  getCustomerContext:(id)=>call<Fact[]>(id,'crm','crm.get_customer_context').catch(error=>unavailable(error,'crm')),
  listServices:(id)=>call<Fact[]>(id,'crm','crm.list_services').catch(error=>unavailable(error,'crm')),
  getBilling:(id)=>call<Fact[]>(id,'billing','billing.get_balance').catch(error=>unavailable(error,'billing')),
  listInvoices:(id)=>call<Fact[]>(id,'billing','billing.list_invoices').catch(error=>unavailable(error,'billing')),
  getInvoiceDetail:(id,invoiceId)=>call<Fact[]>(id,'billing','billing.get_invoice_detail',{invoice_id:invoiceId}).catch(error=>unavailable(error,'billing')),
  getTickets:(id)=>call<Fact[]>(id,'crm','crm.list_recent_tickets').catch(error=>unavailable(error,'crm')),
  evaluateRetention:(id)=>call<Awaited<ReturnType<AgentPorts['evaluateRetention']>>>(id,'crm','crm.evaluate_retention').catch(error=>({eligible:false,reason:'CRM temporalmente indisponible. Verifica la elegibilidad antes de ofrecer beneficios.',facts:unavailable(error,'crm'),policy:{id:'retention-unavailable',title:'Fuente pendiente',version:'pendiente',excerpt:'Verificar la política y elegibilidad antes de ofrecer beneficios.'},options:[]}))
 };
}
