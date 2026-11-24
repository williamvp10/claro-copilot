import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run=promisify(execFile);

test('fresh Langfuse import verifies an empty connection acknowledgement and reuses all persisted resources',async t=>{
  let dataset,connection,evaluator;
  let connectionWrites=0,evaluatorWrites=0;
  const items=new Map();
  const server=createServer(async (req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    const endpoint=url.pathname;
    const reply=(body,status=200)=>{
      res.writeHead(status,{'Content-Type':'application/json'});
      res.end(JSON.stringify(body));
    };
    const rpc=body=>reply({result:{data:{json:body}}});
    const read=async ()=>{
      let body='';
      for await(const chunk of req) body+=chunk;
      return JSON.parse(body);
    };
    try{
      if(endpoint==='/api/auth/csrf') return reply({csrfToken:'synthetic'});
      if(endpoint==='/api/auth/callback/credentials') return reply({});
      if(endpoint==='/api/auth/session') return reply({user:{id:'synthetic'}});
      if(endpoint==='/api/public/projects') return reply({data:[{id:'fixture-project'}]});
      if(endpoint==='/api/public/v2/datasets/claro-llamadas-v1') return dataset ? reply(dataset) : reply({},404);
      if(endpoint==='/api/public/v2/datasets' && req.method==='POST'){
        dataset={...await read(),id:'synthetic-dataset'};
        return reply(dataset);
      }
      if(endpoint.startsWith('/api/public/dataset-items/')){
        const item=items.get(decodeURIComponent(endpoint.split('/').at(-1)));
        return item ? reply(item) : reply({},404);
      }
      if(endpoint==='/api/public/dataset-items' && req.method==='POST'){
        const item={...await read(),status:'ACTIVE',datasetId:dataset.id};
        items.set(item.id,item);
        return reply(item);
      }
      if(endpoint==='/api/trpc/llmApiKey.all') return rpc({data:connection?[connection]:[]});
      if(endpoint==='/api/trpc/llmApiKey.create'){
        const {json:{secretKey,projectId,...fields}}=await read();
        assert.equal(projectId,'fixture-project');
        assert.equal(secretKey,'synthetic-provider');
        connection=fields;
        connectionWrites++;
        return rpc(null);
      }
      if(endpoint==='/api/trpc/evalsV2.list'){
        const evaluators=evaluator?[{id:evaluator.id,name:evaluator.name}]:[];
        return rpc({evaluators,totalItems:evaluators.length});
      }
      if(endpoint==='/api/trpc/evalsV2.create'){
        const {json:{evaluatorId,name,description,definition}}=await read();
        const {type,modelConfig,variableMapping,questions}=definition;
        evaluator={id:evaluatorId,name,description,type,versions:[{version:1,...modelConfig,variableMapping,questions}]};
        evaluatorWrites++;
        return rpc({id:evaluator.id,type});
      }
      if(endpoint==='/api/trpc/evalsV2.get') return rpc(evaluator);
      return reply({},404);
    }catch{
      reply({},500);
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const address='http://127.0.0.1:'+server.address().port;
  const script=fileURLToPath(new URL('../../../scripts/bootstrap-langfuse-calls.mjs',import.meta.url));
  const runImport=()=>run(process.execPath,[script,'--manifest-evaluator'],{
    env:{...process.env,LANGFUSE_UI_URL:address,LANGFUSE_PROJECT_ID:'fixture-project',
      LANGFUSE_PUBLIC_KEY:'fixture-public',LANGFUSE_SECRET_KEY:'fixture-secret',
      LANGFUSE_ADMIN_EMAIL:'synthetic@example.test',LANGFUSE_ADMIN_PASSWORD:'synthetic-password',OPENROUTER_API_KEY:'synthetic-provider'},
    timeout:10000
  });
  const first=await runImport();
  assert.match(first.stdout,/15 casos, 15 creados/);
  assert.match(first.stdout,/Jev · Llamadas v1 · Manifiesto.+Creado/);
  const second=await runImport();
  assert.match(second.stdout,/15 casos, 0 creados/);
  assert.match(second.stdout,/Ya configurado/);
  assert.equal(items.size,15);
  assert.equal(connectionWrites,1);
  assert.equal(evaluatorWrites,1);
});
