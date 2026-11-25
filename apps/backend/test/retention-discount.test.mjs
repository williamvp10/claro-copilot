import assert from 'node:assert/strict';
import test from 'node:test';
import { discountAcceptance } from '../dist/retention-discount.js';

const terms={policy_version:'POL-RET-2026 v3.1',plan:'Hogar Fibra 300',percentage:35,cycles:6};
const discount={terms,authorized_turn:18};
const message=(actor,text,turn_seq)=>({id:`m${turn_seq}`,actor,text,turn_seq});
const offer=message('asesor','Puedo ofrecerte un 35 % de descuento sobre el cargo fijo de Hogar Fibra 300 durante 6 ciclos de facturación. ¿Aceptas estas condiciones?',19);
const source=message('asesor','Política de retención y descuentos · POL-RET-2026 v3.1',21);

test('a short yes confirms the sent offer and a standalone policy citation preserves it',()=>{
  for (const text of ['si!', '¡Sí!', 'si acepto', 'Sí, acepto', 'Acepto el 35 %.']) {
    const acceptance=message('cliente',text,22);
    assert.equal(discountAcceptance([offer,acceptance],discount,acceptance.id),acceptance);
    assert.equal(discountAcceptance([offer,source,acceptance],discount,acceptance.id),acceptance);
  }
});

test('confirmation stays bound to the last customer message and the current authorized offer',()=>{
  const yes=message('cliente','Sí.',22);
  for (const history of [
    [source,yes],
    [offer, message('asesor','¿Quieres que revise tu factura?',21), yes],
    [offer, {...source,text:`${source.text}\n¿Quieres que revise tu factura?`}, yes],
    [{...offer,turn_seq:17}, source, yes],
    [{...offer,text:offer.text.replace('35','30')}, source, yes]
  ]) assert.equal(discountAcceptance(history,discount,yes.id),null);
  assert.equal(discountAcceptance([offer,yes],discount,'other-id'),null);
  for (const text of ['Listo, gracias.', 'No acepto.', 'Sí, si me das el 40 %.', 'Acepto si son más ciclos.',
    'Acepto el 30 %.','Acepto el 35 % durante doce meses.','Me quedo con la mejora.','Sí, quiero cancelar el servicio.']) {
    const answer={...yes,text};
    assert.equal(discountAcceptance([offer,source,answer],discount,answer.id),null,text);
  }
});
