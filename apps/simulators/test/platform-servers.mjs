import express from 'express';
import { createSimulator } from '../server.mjs';
import { database } from '../storage.mjs';

// Test-only facade. Keep fault headers inaccessible from the platform and expose a loopback toggle.
const outage = { crm:false,billing:false };
for (const [service,prefix,port] of [['crm','CRM',8081],['billing','BILLING',8082]]) {
  const url = process.env[prefix+'_DATABASE_URL'];
  const key = process.env[prefix+'_API_KEY'];
  const pool = database(url);
  const facade = express();
  facade.post('/test-outage/:state',(req,res)=>{
    outage[service] = req.params.state === 'on';
    res.json({ok:true});
  });
  facade.use((req,res,next)=>{
    if (outage[service]) return res.status(503).json({codigo:'NO_DISPONIBLE',mensaje:'Fallo de prueba'});
    if (service==='crm' && req.method==='POST' && /^manual:/.test(req.get('Idempotency-Key')??'')) {
      req.headers['x-simulator-fault'] = 'lost-after-commit';
    }
    next();
  });
  facade.use(createSimulator({service,pool,key,date:process.env.DEMO_BUSINESS_DATE||'2026-11-18',faults:'test'}));
  const server = facade.listen(Number(process.env[prefix+'_PORT']||port),'127.0.0.1');
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>server.close(()=>void pool.end()));
}
