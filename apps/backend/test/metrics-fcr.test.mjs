import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readMetricGroup } from '../dist/metrics.js';

const connectionString=process.env.FCR_TEST_DATABASE_URL;
test('FCR counts first mature closure and finds account recontacts across channel filters', {skip:!connectionString}, async()=>{
 const client=new pg.Client({connectionString}); await client.connect();
 try {
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE attention_case(id text PRIMARY KEY,contact_ref text NOT NULL,account_ref text,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL,resolved boolean,intent_hint text);
    CREATE TEMP TABLE attention_event(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,case_id text,kind text,created_at timestamptz NOT NULL DEFAULT now(),metadata jsonb NOT NULL DEFAULT '{}');`);
  async function add(id,contact,account,verified,category='soporte_tecnico',channel='web',created='15 days') {
   await client.query(`INSERT INTO attention_case VALUES ($1,$2,$3,$4,now()-$5::interval,true,$6)`,[id,contact,account,{channel,verified},created,category]);
  }
  async function event(id,kind,when,metadata={}) {await client.query(`INSERT INTO attention_event(case_id,kind,created_at,metadata) VALUES ($1,$2,now()-$3::interval,$4)`,[id,kind,when,metadata]);}
  for(const [id,contact,account,verified] of [
   ['cross','w1','C-1001',true],['success','w2','C-1002',true],['unresolved','w3','C-1003',true],
   ['escalated','w4','C-1004',true],['reopened','w5','C-1005',true],['other-motive','w6','C-1006',true],
   ['same-channel','anonymous-a',null,false],['other-channel','anonymous-b',null,false]
  ]) {await add(id,contact,account,verified);await event(id,'closed','12 days',{resolved:id!=='unresolved'});}
  await event('escalated','escalation_requested','13 days');
  await event('reopened','reopened','11 days'); await event('reopened','closed','10 days',{resolved:true});
  await add('cross-followup','C-1001',null,true,'soporte_tecnico','telegram','10 days');
  await add('different-category','C-1006',null,true,'facturacion','telegram','10 days');
  await add('same-channel-followup','anonymous-a',null,false,'soporte_tecnico','web','10 days');
  await add('other-channel-followup','anonymous-b',null,false,'soporte_tecnico','telegram','10 days');
  await add('immature','w9','C-1009',true);await event('immature','closed','3 days',{resolved:true});
  let pending=Promise.resolve();
  const db={query:(sql,args)=>{const operation=pending.then(()=>client.query(sql,args));pending=operation.catch(()=>{});return operation.then(result=>result.rows);}};
  for(const channel of ['all','web']) {
   const result=await readMetricGroup(db,'negocio',{days:30,channel,category:'all'});
   const fcr=result.metrics.find(item=>item.id==='fcr');
   assert.equal(fcr.denominator,8,channel);assert.equal(fcr.sample,3,channel);assert.equal(fcr.value,37.5,channel);
  }
  const onlyBilling=await readMetricGroup(db,'negocio',{days:30,channel:'web',category:'facturacion'});
  assert.equal(onlyBilling.metrics.find(item=>item.id==='fcr').denominator,0);
 } finally { await client.query('ROLLBACK').catch(()=>{}); await client.end(); }
});
