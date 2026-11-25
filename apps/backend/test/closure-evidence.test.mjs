import assert from 'node:assert/strict';
import test from 'node:test';
import { closureEvidence } from '../dist/closure-evidence.js';

const message=(actor,text,id='m1')=>({id,actor,text});

test('closure evidence uses a linked confirmation or a reported operational result',()=>{
  const confirmed=message('cliente','Sí, ya funciona.');
  const snapshot={messages:[confirmed],customer_resolution:{satisfied_message_id:confirmed.id}};
  assert.match(closureEvidence(snapshot,'cliente',[]),/confirmó.*ya funciona/);
  assert.equal(closureEvidence({messages:[message('cliente','Listo, gracias.')]},'cliente',[]),null);
  const reported=message('asesor','Verifiqué que ya funciona la conexión.');
  assert.match(closureEvidence({messages:[reported]},'operativa',[]),/asesor informó.*ya funciona/);
  assert.equal(closureEvidence({messages:[reported,message('cliente','Sigo sin conexión.','m2')]},'operativa',[]),null);
});

test('a closure draft distinguishes pending, scheduled and applied operations',()=>{
  const snapshot={messages:[],retention_discount:{terms:{percentage:35,plan:'Hogar Fibra 300'},status:'authorized'}};
  assert.equal(closureEvidence(snapshot,'operativa',[]),null);
  assert.equal(closureEvidence({messages:[]},'operativa',[{kind:'ticket',reference:'T-012'}]),null);
  snapshot.retention_discount.status='scheduled';
  snapshot.retention_discount.schedule={start_period:'2026-12'};
  assert.match(closureEvidence(snapshot,'operativa',[]),/programado desde el ciclo 2026-12/);
  snapshot.retention_discount.schedule.last_invoice='F-5310';
  assert.match(closureEvidence(snapshot,'operativa',[]),/se aplicó en la factura F-5310/);
});
