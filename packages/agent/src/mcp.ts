import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { CatalogPlan, Citation, KnowledgeSearchFilters, KnowledgeTags, TransientReadError } from '@claro/contracts';
import type { KnowledgeAdapter, KnowledgeDocument } from './index.js';

export type KnowledgeMcpOptions = {url:string; token?:string; trustedLocal?:boolean; timeoutMs?:number; fetch?:typeof globalThis.fetch; revision?:string};

export function isTransientMcpRead(error: unknown): boolean {
 if (error instanceof McpError) return error.code===ErrorCode.RequestTimeout;
 if (error instanceof StreamableHTTPError) return error.code===408 || (error.code ?? 0)>=500;
 if (error instanceof Error && error.name==='TimeoutError') return true;
 const cause=error instanceof TypeError ? error.cause : undefined;
 return typeof cause==='object' && cause!==null && 'code' in cause &&
  ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(String(cause.code));
}
// Closed vocabulary prevents arbitrary names, addresses and account numbers being transmitted.
const vocabulary = new Set((
  'internet fibra hogar plan planes triple play max movil moviles pospago precio cuanto cuanta incluye bono ' +
  'instalacion reconecta reconexion permanencia penalidad clausula regulacion prorrateo costo cargo compensacion ' +
  'ajuste tarifa pqr plazo pin nip deuda deudas requisitos usuario clave contrasena recargo suspender restablezco ' +
  'restablecer reinicio fabrica control parental antiguedad nuevo actuales cambiar cobertura incluye trae elegir quedo contratar descargar resuelto cerrar celular hogar pagar vence pospago prepago primero segundo tercero mismo ese esa antes ahora prioritaria velocidad promocion ' +
  'descuento factura pago financiado financiacion soporte modem wifi decodificador television televisor tv senal error refrescar reiniciar ' +
  'pantalla canal canales azul negro rojo luz luces intermitente parpadea sin con no funciona repetidor ilimitado ' +
  'datos minutos mensajes red portabilidad cancelar cancelacion politica retencion elegibilidad requisitos mora visita ticket esim roaming compatibilidad apple watch intermitencia videollamada videollamadas recurrencia recurrentes fallas prioritaria'
).split(' '));
export function safeKnowledgeQuery(query:string):string {
 const normalized=query.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 const terms=(normalized.match(/[a-z]+/g) ?? []).filter(word=>vocabulary.has(word)).slice(0,32);
 if (/\be[\s-]?202\b/i.test(normalized)) terms.push('E-202');
 if (/\bztx[\s-]?f680\b/i.test(normalized)) terms.push('ZTX-F680');
 if (/\bdecobox\s*4k\b/i.test(normalized)) terms.push('DecoBox 4K');
 if (/\bluz\s+los\b/i.test(normalized)) terms.push('luz LOS');
 for (const identifier of normalized.matchAll(/\b(?:fibra|triple play|max)\s+(100|150|200|250|300|400|500|600|900|1000|60|80)(?=\b)/g)) terms.push(identifier[0]);
 return [...new Set(terms)].join(' ') || 'informacion';
}
function documents(value:unknown):KnowledgeDocument[] {
 if (!value || typeof value!=='object' || !Array.isArray((value as {documents?:unknown}).documents)) throw new Error('Invalid knowledge response');
 const result=(value as {documents:unknown[]}).documents;
 if (result.length>100) throw new Error('Too many knowledge documents');
 return result.map(item=>{
  if (!item || typeof item!=='object') throw new Error('Invalid knowledge document');
  const x=item as Record<string,unknown>;
  for (const key of ['id','title','excerpt','version','effective_from']) if (typeof x[key]!=='string' || !(x[key] as string).trim() || (x[key] as string).length>4096) throw new Error('Invalid knowledge document');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x.effective_from as string) || !['public','advisor'].includes(x.scope as string)) throw new Error('Invalid knowledge metadata');
  if (x.effective_to !== undefined && (typeof x.effective_to!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.effective_to))) throw new Error('Invalid knowledge date');
  if (x.status !== undefined && !['ready','draft'].includes(x.status as string)) throw new Error('Invalid knowledge status');
  if (x.channels !== undefined && (!Array.isArray(x.channels) || x.channels.some(a=>typeof a!=='string'))) throw new Error('Invalid knowledge channels');
  if (x.provider_approved !== undefined && x.provider_approved !== true) throw new Error('Invalid provider approval');
  if (x.url !== undefined && typeof x.url!=='string') throw new Error('Invalid knowledge URL');
  if (x.metadata !== undefined) KnowledgeTags.parse(x.metadata);
  if (x.source !== undefined) Citation.shape.source.parse(x.source);
  return x as unknown as KnowledgeDocument;
 });
}
/** A fresh MCP client per query; only a single read-only tool can be called. */
export function createKnowledgeMcpAdapter(options:KnowledgeMcpOptions):KnowledgeAdapter {
 const url=new URL(options.url);
 if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid knowledge MCP URL');
 if (options.token && url.protocol!=='https:' && !['localhost','127.0.0.1','[::1]','knowledge-mcp'].includes(url.hostname)) throw new Error('Bearer credentials require HTTPS or the private knowledge service');
 const internal = options.trustedLocal === true && url.origin === 'http://knowledge-mcp:3030' && url.pathname === '/mcp' && Boolean(options.token);
 async function call(name:'search_knowledge'|'list_catalog_plans', args:Record<string,unknown>) {
  const timeout=options.timeoutMs ?? 3000;
  const transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:options.token?{Authorization:`Bearer ${options.token}`}:{},signal:AbortSignal.timeout(timeout)},...(options.fetch?{fetch:options.fetch}:{})});
  const client=new Client({name:'claro-knowledge-reader',version:'1.0.0'});
  try {
   await client.connect(transport);
   const result=await client.callTool({name,arguments:{...args,...(options.revision && options.revision!=='legacy' ? {revision:options.revision} : {})}},undefined,{timeout});
   if (result.isError) throw new Error('Knowledge tool failed');
   return result.structuredContent;
  } catch (error) {
   if (isTransientMcpRead(error)) throw new TransientReadError();
   throw error;
  } finally { await client.close().catch(()=>undefined); }
 }
 return {
  revision:options.revision,
  async search(query,context) {
   const filters=context.filters ? KnowledgeSearchFilters.parse(context.filters) : undefined;
   return documents(await call('search_knowledge',{
    query:internal ? query.slice(0,1024) : safeKnowledgeQuery(query),business_date:context.business_date,
    audience:context.audience,channel:context.channel,...(filters && (filters.tags.length || filters.source) ? {filters} : {})
   }));
  },
  async catalog(context) {
   const result=await call('list_catalog_plans',{business_date:context.business_date,channel:context.channel});
   return CatalogPlan.array().max(100).parse((result as {plans?:unknown}|undefined)?.plans);
  }
 };
}
