import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from 'pg';
import { signCapability } from '../dist/mcp-capability.js';

const billing = process.env.BILLING_MCP_URL;
const crm = process.env.CRM_MCP_URL;
const token = process.env.INTEGRATION_MCP_TOKEN;
const key = process.env.INTEGRATION_MCP_SIGNING_KEY;
if (process.env.DEMO_MODE !== 'true' || !process.env.DATABASE_URL || !billing || !crm || !token || !key) {
  throw new Error('Use the seeded platform integration environment with both private MCP endpoints');
}
const db = new Client({connectionString:process.env.DATABASE_URL});
await db.connect();

function credentials(scope) {
  return {Authorization:'Bearer '+token,'X-Case-Capability':signCapability(scope,key)};
}

async function rejected(url, headers, status) {
  const response = await fetch(url,{
    method:'POST',
    headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',
      capabilities:{},clientInfo:{name:'claro-contract-test',version:'1.0.0'}}}),
    signal:AbortSignal.timeout(4000)
  });
  assert.equal(response.status,status);
  await response.body?.cancel();
}

async function tools(url, scope, use) {
  const client=new McpClient({name:'claro-contract-test',version:'1.0.0'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url),{
      requestInit:{headers:credentials(scope),signal:AbortSignal.timeout(5000)}
    }));
    const {tools}=await client.listTools();
    assert.deepEqual(tools.map(tool=>tool.name),scope.actions);
    await use(client);
  } finally {
    await client.close();
  }
}

try {
  const result=await db.query(`SELECT r.id, r.case_id, (r.turn->>'case_revision')::integer AS case_revision
    FROM attention_case c
    JOIN agent_run r ON r.case_id=c.id AND r.turn->>'case_revision'=c.snapshot->>'revision'
    JOIN LATERAL (
      SELECT message->>'turn_seq' AS seq
      FROM jsonb_array_elements(c.snapshot->'messages') AS message
      WHERE message->>'actor'<>'agente' AND COALESCE(message->>'verification_input','false')='false'
      ORDER BY (message->>'turn_seq')::integer DESC LIMIT 1
    ) latest ON r.turn->>'turn_seq'=latest.seq
    WHERE c.account_ref='C-1001' AND c.snapshot->>'channel'='web'
      AND c.snapshot->>'status'='open' AND c.snapshot->>'verified'='true' AND r.turn->>'audience'='asesor'
    ORDER BY c.created_at DESC,r.id LIMIT 1`);
  const run=result.rows[0];
  assert.ok(run,'Run the platform integration suite first to create a current verified C-1001 turn');
  const scope={run_id:run.id,case_id:run.case_id,case_revision:run.case_revision,
    aud:'billing',exp:Date.now()+30_000,actions:['billing.get_balance']};
  await rejected(billing,{},401);
  await rejected(billing,credentials({...scope,exp:Date.now()-1_000}),403);
  await rejected(billing,credentials({...scope,case_revision:scope.case_revision+1}),403);
  await rejected(billing,credentials({...scope,case_id:'unrelated-fixture-case'}),403);
  await rejected(crm,credentials(scope),403);
  await tools(billing,scope,async client=>{
    const response=await client.callTool({name:'billing.get_balance',arguments:{}});
    assert.equal(response.isError,undefined);
    assert.ok(response.structuredContent?.data.some(fact=>fact.id==='invoice-balance'));
  });
  await tools(billing,{...scope,actions:['billing.get_invoice_detail']},async client=>{
    const foreign=await client.callTool({name:'billing.get_invoice_detail',arguments:{invoice_id:'F-5019'}});
    assert.equal(foreign.isError,true);
    assert.equal(foreign.structuredContent,undefined);
    assert.doesNotMatch(JSON.stringify(foreign),/5019|cliente_id/);
  });
  console.log('Private MCP contract verified: case, revision, audience, expiry, tool allowlist and invoice ownership.');
} finally {
  await db.end();
}
