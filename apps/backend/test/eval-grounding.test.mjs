import assert from 'node:assert/strict';
import { test } from 'node:test';
import { citationKey, publishedCitations, verifyPublishedAnswer } from '../scripts/eval-grounding.mjs';

const passage=(id,type,excerpt,fields={})=>({id,title:id,version:'v1',type,excerpt,scope:'public',
  status:'ready',effective_from:'2026-09-01',...fields});
const confirm=(answer,sources,question='')=>verifyPublishedAnswer({question,answer,sources});

test('citation provenance binds the exact text, source version, date, audience and channel',()=>{
  const source=passage('ref-001','soporte','Guarda el cambio.',{channels:['telegram'],effective_to:'2026-12-01'});
  const clone={id:source.id,title:source.title,version:source.version,excerpt:source.excerpt};
  const context={audience:'cliente',channel:'telegram',businessDate:'2026-11-18'};
  const docs=new Map([[citationKey(source),source]]);
  assert.deepEqual(publishedCitations([clone],docs,context),[source]);
  assert.deepEqual(publishedCitations([{...clone,excerpt:'El cambio quedó guardado.'}],docs,context),[]);
  assert.deepEqual(publishedCitations([{...clone,version:'otros datos'}],docs,context),[]);
  assert.deepEqual(publishedCitations([clone],docs,{...context,businessDate:'2026-12-01'}),[]);
  assert.deepEqual(publishedCitations([clone],docs,{...context,channel:'web'}),[]);
  docs.set(citationKey(source),{...source,scope:'advisor'});
  assert.deepEqual(publishedCitations([clone],docs,context),[]);
  assert.equal(publishedCitations([clone],docs,{...context,audience:'asesor'}).length,1);
});

test('a product claim requires its own catalogue price and complete benefits',()=>{
  const catalogue=passage('table-001','catalogo','Plan Velocidad Precio\nmensual\nIncluye\n'+
    'Hogar Fibra 400 400 Mbps $89.800 Módem WiFi 6\nHogar Fibra 700 700 Mbps $119.800 Módem WiFi 6 + 2 repetidores WiFi');
  const answer='Hogar Fibra 700 cuesta $119.800 al mes e incluye 700 Mbps, Módem WiFi 6, 2 repetidores WiFi.';
  assert.equal(confirm(answer,[catalogue]),'catalogue_bundle');
  assert.equal(confirm(answer.replace('$119.800','$89.800'),[catalogue]),null);
  assert.equal(confirm(answer.replace('2 repetidores','3 repetidores'),[catalogue]),null);
  assert.equal(confirm(answer+' Ya se activó el servicio.',[catalogue]),null);
  const conflicting={...catalogue,excerpt:catalogue.excerpt.replace('$119.800','$120.000')};
  assert.equal(confirm(answer,[catalogue,conflicting]),null);
});

test('the cited tenure row supports both conditional retention alternatives',()=>{
  const matrix=passage('policy-001','politica',
    'Más de 24 meses | 35 % por 5 meses | TV sin costo por 5 meses\nEntre 12 y 24 meses | 20 % por 3 meses | Datos sin costo por 3 meses',
    {version:'POL-RET-2026 v5',scope:'advisor'});
  const answer='Si CRM confirma la elegibilidad, la política para ese tramo indica estas opciones. Opción A: 35 % por 5 meses. Opción B: TV sin costo por 5 meses.';
  assert.equal(confirm(answer,[matrix],'Una consulta de retención por 29 meses de antigüedad.'),'retention_policy_matrix');
  assert.equal(confirm(answer,[matrix],'Una consulta de retención por 24 meses de antigüedad.'),null);
  assert.equal(confirm(answer.replace('TV','Datos'),[matrix],'Una consulta por 29 meses de antigüedad.'),null);
  assert.equal(confirm(answer.replace('Si CRM confirma la elegibilidad, la','La'),[matrix],'Una consulta por 29 meses de antigüedad.'),null);
});

test('Wi-Fi instructions require the cited menu, password rules and consecutive excerpts from the same manual',()=>{
  const manual=[
    passage('manual-003','soporte','2. Abra un navegador e ingrese a http://192.168.10.1.'),
    passage('manual-004','soporte','3. Usuario: gestor. Contraseña: la indicada en la etiqueta.'),
    passage('manual-005','soporte','4. Vaya a Configuración > WLAN > SSID, cambie la contraseña (mínimo 12 caracteres) y guarde.')
  ];
  const answer='Abre 192.168.10.1 en el navegador. Entra con el usuario gestor y la clave de la etiqueta. Ve a Configuración, WLAN y SSID. Cambia la contraseña (mínimo 12 caracteres) y guarda.';
  assert.equal(confirm(answer,manual),'wifi_manual_steps');
  assert.equal(confirm(answer.replace('Configuración','Red'),manual),null);
  assert.equal(confirm(answer.replace('12 caracteres','8 caracteres'),manual),null);
  assert.equal(confirm(answer,manual.map(source=>source.id==='manual-004'?{...source,id:'otro-004'}:source)),null);
});

test('signal refresh links the wait and the powered-on condition to the cited procedure',()=>{
  const source=passage('deco-101','soporte',
    'E-202: Entre a Mi Claro (Mi TV > Refrescar señal). Espere hasta 7 minutos con el equipo encendido.');
  const answer='Abre Mi Claro, entra en Mi TV y elige «Refrescar señal». Deja el decodificador encendido y espera hasta 7 minutos.';
  assert.equal(confirm(answer,[source]),'signal_refresh_manual');
  assert.equal(confirm(answer+'\n\nCuando termine la espera, cuéntame: ¿volvió la imagen?',[source]),'signal_refresh_manual');
  assert.equal(confirm(answer.replace('7 minutos','10 minutos'),[source]),null);
  assert.equal(confirm(answer+' Tu señal ya se refrescó.',[source]),null);
  assert.equal(confirm(answer,[{...source,excerpt:source.excerpt.replace('encendido','apagado')}]),null);
});
