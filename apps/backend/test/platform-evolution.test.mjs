import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueAllowed } from '../dist/platform-evolution.js';
import { checkCase } from '../dist/cases.js';

test('specialists can claim only their explicit queue and supervisor queue is separate', () => {
  const n2={id:'n2',role:'asesor',capabilities:['n2'],specialties:['soporte_tecnico']};
  assert.equal(queueAllowed(n2,'soporte_tecnico'),true);
  assert.equal(queueAllowed(n2,'facturacion'),false);
  assert.equal(queueAllowed(n2,'supervision'),false);
  assert.equal(queueAllowed({...n2,capabilities:['supervisor']},'supervision'),true);
});

test('private case access requires both attention capability and assignment', () => {
  const row={snapshot:{owner_id:'owner'}};
  assert.doesNotThrow(()=>checkCase({id:'owner',role:'asesor',capabilities:['n2']},row,true));
  assert.throws(()=>checkCase({id:'owner',role:'admin',capabilities:['superadmin']},row,true));
  assert.throws(()=>checkCase({id:'other',role:'asesor',capabilities:['n1']},row,true));
});
