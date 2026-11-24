import 'reflect-metadata';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { CatalogPlan, KnowledgeDigest, KnowledgeSearchFilters } from '@claro/contracts';
import { createDatabase } from './database.js';
import { databaseKnowledge } from './knowledge.js';
import { constantEqual } from './cases.js';

const token = process.env.KNOWLEDGE_SERVICE_TOKEN;
if (!token || token.length < 24) throw new Error('Configure a private KNOWLEDGE_SERVICE_TOKEN (at least 24 characters)');
const db = await createDatabase().initialize();
const knowledge = databaseKnowledge(db);
const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'32kb'}));
app.get('/healthz', (_req,res)=>res.json({status:'ok'}));
app.post('/mcp', async (req, res) => {
  if (!constantEqual(req.get('Authorization') ?? '', `Bearer ${token}`)) {
    res.sendStatus(401);
    return;
  }
  if (req.get('Origin')) {
    res.sendStatus(403);
    return;
  }
  const server = new McpServer({ name:'claro-knowledge', version:'1.0.0' });
  server.registerTool('search_knowledge', {
    description:'Read published passages valid for the trusted worker audience and business date.',
    inputSchema: {
      query:z.string().trim().min(1).max(1024), business_date:z.iso.date(),
      audience:z.enum(['cliente','asesor']), channel:z.enum(['telegram','web','whatsapp','voice']),
      filters:KnowledgeSearchFilters.optional(), revision:KnowledgeDigest.optional()
    },
    outputSchema: {documents:z.array(z.object({}).passthrough())},
    annotations:{readOnlyHint:true, destructiveHint:false, openWorldHint:false}
  }, async ({query,revision,...context}) => {
    if ((revision ?? 'legacy')!==knowledge.revision) throw new Error('Knowledge index differs from the requested revision');
    const documents = await knowledge.search(query, context);
    return {structuredContent:{documents},content:[{type:'text',text:JSON.stringify({documents})}]};
  });
  server.registerTool('list_catalog_plans', {
    description:'Read the published public catalogue for a date and channel.',
    inputSchema: {
      business_date:z.iso.date(), channel:z.enum(['telegram','web','whatsapp','voice']),
      revision:KnowledgeDigest.optional()
    },
    outputSchema: {plans:z.array(CatalogPlan)},
    annotations:{readOnlyHint:true, destructiveHint:false, openWorldHint:false}
  }, async ({revision,...context}) => {
    if ((revision ?? 'legacy')!==knowledge.revision) throw new Error('Knowledge index differs from the requested revision');
    const plans = await knowledge.catalog!(context);
    return {structuredContent:{plans},content:[{type:'text',text:JSON.stringify({plans})}]};
  });
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined, enableJsonResponse:true});
  res.once('close', () => { void transport.close(); });
  await server.connect(transport);
  await transport.handleRequest(req,res,req.body);
});
app.all('/mcp', (_req,res)=>res.sendStatus(405));
const http = app.listen(Number(process.env.MCP_PORT ?? 3030),process.env.HOST ?? '127.0.0.1');
for (const signal of ['SIGTERM','SIGINT'] as const) process.once(signal,()=>http.close(()=>void db.destroy()));
