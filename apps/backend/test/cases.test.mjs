import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stillCurrent, clearPersonalData } from '../dist/cases.js';

test('stale public and private output fails the publication fence', () => {
  const record = { snapshot: {status:'open', revision:2, attention_mode:'asistido',
    messages:[{actor:'cliente',turn_seq:1}, {actor:'agente',turn_seq:2}, {actor:'asesor',turn_seq:3}] } };
  assert.equal(stillCurrent(record, {case_revision:1, attention_mode:'autoservicio', audience:'cliente', turn_seq:1}), false);
  assert.equal(stillCurrent(record, {case_revision:2, attention_mode:'asistido', audience:'asesor', turn_seq:1}), false);
  assert.equal(stillCurrent(record, {case_revision:2, attention_mode:'asistido', audience:'asesor', turn_seq:3}), true);
});

test('intent input removes common contact identifiers while preserving diagnostics', () => {
  assert.equal(clearPersonalData('Error E-202, llame al +57 300 123 4567 o escriba a cliente@example.com'), 'Error E-202, llame al [número] o escriba a [correo]');
});
