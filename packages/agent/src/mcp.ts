import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { KnowledgeAdapter, KnowledgeDocument } from './index.js';

export type KnowledgeMcpOptions = {url:string; token?:string; timeoutMs?:number; fetch?:typeof globalThis.fetch};
// Closed vocabulary prevents arbitrary names, addresses and account numbers being transmitted.
const vocabulary = new Set('internet fibra hogar plan precio tarifa velocidad promocion descuento factura pago soporte modem wifi decodificador television televisor tv senal error refrescar reiniciar pantalla canal canales azul negro rojo rojo luz luces intermitente parpadea sin con no funciona instalacion repetidor ilimitado datos minutos mensajes red cobertura portabilidad cancelar mora visita ticket'.split(' '));
export function safeKnowledgeQuery(query:string):string {
 const normalized=query.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 const terms=(normalized.match(/[a-z]+/g) ?? []).filter(word=>vocabulary.has(word)).slice(0,32);
 if (/\be[\s-]?202\b/i.test(normalized)) terms.push('E-202');
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
  return x as unknown as KnowledgeDocument;
 });
}
/** A fresh MCP client per query; only a single read-only tool can be called. */
export function createKnowledgeMcpAdapter(options:KnowledgeMcpOptions):KnowledgeAdapter {
 const url=new URL(options.url);
 if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid knowledge MCP URL');
 if (options.token && url.protocol!=='https:' && !['localhost','127.0.0.1','[::1]','knowledge-mcp'].includes(url.hostname)) throw new Error('Bearer credentials require HTTPS or the private knowledge service');
 return {async search(query,context) {
  const timeout=options.timeoutMs ?? 3000;
  const transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:options.token?{Authorization:`Bearer ${options.token}`}:{},signal:AbortSignal.timeout(timeout)},...(options.fetch?{fetch:options.fetch}:{})});
  const client=new Client({name:'claro-knowledge-reader',version:'1.0.0'});
  try {
   await client.connect(transport);
   const result=await client.callTool({name:'search_knowledge',arguments:{query:safeKnowledgeQuery(query),business_date:context.business_date,audience:context.audience,channel:context.channel}},undefined,{timeout});
   if (result.isError) throw new Error('Knowledge search failed');
   return documents(result.structuredContent);
  } finally { await client.close().catch(()=>undefined); }
 }};
}
