import 'reflect-metadata';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createDatabase } from './database.js';
import { assertActiveCaseOperator, businessPorts, runContext } from './business.js';
import { constantEqual, stillCurrent } from './cases.js';
import { verifyCapability } from './mcp-capability.js';
import { observeSimulators } from './simulator-client.js';

const domain = process.env.MCP_DOMAIN;
if (domain !== 'crm' && domain !== 'billing') throw new Error('MCP_DOMAIN must be crm or billing');
const serviceToken = process.env.INTEGRATION_MCP_TOKEN;
const signingKey = process.env.INTEGRATION_MCP_SIGNING_KEY;
if (!serviceToken || serviceToken.length < 24 || !signingKey || signingKey.length < 32) throw new Error('Configure private MCP credentials');
const db = await createDatabase().initialize();
observeSimulators(db);
const ports = businessPorts(db);
const app = express(); app.disable('x-powered-by'); app.use(express.json({limit:'32kb'}));
app.get('/healthz', (_req,res) => res.json({status:'ok'}));
app.post('/mcp', async (req,res) => {
  if (req.get('Origin') || !constantEqual(req.get('Authorization') ?? '', `Bearer ${serviceToken}`)) { res.sendStatus(401); return; }
  try {
    const cap = verifyCapability(req.get('X-Case-Capability') ?? '',signingKey,domain);
    const {row,turn} = await runContext(db.manager,cap.run_id,false);
    if (row.id !== cap.case_id || turn.case_revision !== cap.case_revision || !stillCurrent(row,turn) || !row.snapshot.verified || !row.snapshot.owner_id || turn.audience !== 'asesor') throw new Error('scope denied');
    await assertActiveCaseOperator(db.manager,row);
    const server = new McpServer({name:`claro-${domain}`,version:'1.0.0'});
    const register = (name:string, read:(arg?:string)=>Promise<unknown>, selector = false) => {
      if (!cap.actions.includes(name)) return;
      server.registerTool(name, {description:'Authorized case-scoped read.',inputSchema: {invoice_id:z.string().min(1).max(100).optional()}, annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}, async (args) => {
        // Revalidate after connection and before each read, including ownership changes.
        const current = await runContext(db.manager,cap.run_id,false);
        if (!stillCurrent(current.row,current.turn) || !current.row.snapshot.verified || !current.row.snapshot.owner_id || current.turn.audience !== 'asesor' || cap.exp <= Date.now()) throw new Error('scope denied');
        await assertActiveCaseOperator(db.manager,current.row);
        const data = await read(selector ? args.invoice_id : undefined);
        return {structuredContent:{data},content:[{type:'text' as const,text:JSON.stringify({data})}]};
      });
    };
    if (domain === 'crm') {
      register('crm.get_customer_context',()=>ports.getCustomerContext(cap.run_id));
      register('crm.list_services',()=>ports.listServices!(cap.run_id));
      register('crm.list_recent_tickets',()=>ports.getTickets(cap.run_id));
      register('crm.evaluate_retention',()=>ports.evaluateRetention(cap.run_id));
    } else {
      register('billing.get_balance',()=>ports.getBilling(cap.run_id));
      register('billing.list_invoices',()=>ports.listInvoices!(cap.run_id));
      register('billing.get_invoice_detail',async(id)=>{if (!id) throw new Error('scope denied'); return ports.getInvoiceDetail!(cap.run_id,id);},true);
    }
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.once('close',()=>{void transport.close();}); await server.connect(transport); await transport.handleRequest(req,res,req.body);
  } catch { if (!res.headersSent) res.sendStatus(403); }
});
app.all('/mcp',(_req,res)=>res.sendStatus(405));
const http=app.listen(Number(process.env.MCP_PORT ?? 3031),process.env.HOST ?? '127.0.0.1');
for (const signal of ['SIGTERM','SIGINT'] as const) process.once(signal,()=>http.close(()=>void db.destroy()));
