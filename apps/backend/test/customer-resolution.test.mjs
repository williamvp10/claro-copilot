import assert from 'node:assert/strict';
import test from 'node:test';
import { resolutionSignals } from '../dist/customer-resolution.js';

test('case resolution requires satisfaction and a separate clear desire to close',()=>{
  assert.deepEqual(resolutionSignals('Sí, quedó resuelto. Puedes cerrar.'),{satisfied:true,close:true});
  assert.deepEqual(resolutionSignals('Ya funciona, muchas gracias.'),{satisfied:true,close:false});
  assert.deepEqual(resolutionSignals('Quiero cerrar la conversación.'),{satisfied:false,close:true});
  assert.deepEqual(resolutionSignals('Todavía no quedó resuelto. Puedes cerrar.'),{satisfied:false,close:false});
  assert.deepEqual(resolutionSignals('Ya quedó resuelto, pero tengo otra pregunta.'),{satisfied:false,close:false});
  assert.deepEqual(resolutionSignals('Gracias.'),{satisfied:false,close:false});
});
