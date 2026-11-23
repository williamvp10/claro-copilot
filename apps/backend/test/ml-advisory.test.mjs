import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChurnFeatures, demoChurnFeatures, privateSignals, predictChurn, predictIntent } from '../dist/ml-advisory.js';
const zero={cancelacion:0,consulta_planes:0,facturacion:0,portabilidad:0,soporte_tecnico:0,categoria_no_disponible:0};
const photo={fecha_corte:'2026-10-31',ciudad:'Bogotá',tipo_servicio:'hogar',plan_hogar:'Fibra',plan_movil:null,metodo_pago:'pse',valor_mensual:100000,antiguedad_meses:12,dias_mora:0,tickets_90d:0,tickets_tecnicos_90d:0,caidas_servicio_90d:0,uso_datos_gb_mes:null,nps_ultimo:7,ofertas_retencion_12m:0,historial_30d:zero,historial_90d:zero,dias_desde_ultimo_ticket:null};
test('churn snapshot rejects inconsistent windows and preserves missing values',()=>{
  assert.equal(ChurnFeatures.safeParse(photo).success,true);
  assert.equal(ChurnFeatures.safeParse({...photo,tickets_90d:1}).success,false);
  assert.equal(ChurnFeatures.safeParse({...photo,historial_30d:{...zero,facturacion:1}}).success,false);
});
test('the CRM photo uses whole days and excludes future dates and duplicate tickets',()=>{
  const last={ticket_id:'t1',fecha:'2026-10-20',categoria:'facturacion',estado:'cerrado'};
  const result=demoChurnFeatures({ciudad:'Bogotá',antiguedad_meses:40,dias_mora:45,valor_mensual_total:160000,
    servicios:[{tipo:'hogar',plan:'Fibra',estado:'activo',fecha_activacion:'2023-07-21'},
      {tipo:'movil',plan:'Claro Max',estado:'activo',fecha_activacion:'2023-07-21'}],
    tickets_recientes:[last,last,{ticket_id:'t2',fecha:'2026-08-20',categoria:'desconocida',estado:'cerrado'},
      {ticket_id:'t3',fecha:'2026-11-19',categoria:'soporte_tecnico',estado:'cerrado'},
      {ticket_id:'t4',fecha:'2026-09-28',categoria:'soporte_tecnico',estado:'abierto'}],
    ofertas_retencion_12m:[{fecha:'2026-11-19'}]
  },'2026-11-18');
  assert.equal(result.tipo_servicio,'convergente');
  assert.equal(result.dias_mora,45);
  assert.equal(result.dias_desde_ultimo_ticket,30);
  assert.equal(result.tickets_90d,2);
  assert.equal(result.historial_90d.categoria_no_disponible,1);
  assert.equal(result.historial_30d.facturacion,1);
  assert.equal(result.ofertas_retencion_12m,0);
  assert.equal(result.nps_ultimo,null);
  assert.equal(result.caidas_servicio_90d,null);
});
test('signals exclude stale intent and churn after holder changes',async()=>{
  const signals={intent:{turn_id:'old',case_revision:3},churn_customer_ref:'C-1001',churn:{status:'available',priority:'alta'}};
  const db={query:async()=>[signals]};
  const row={id:'case',contact_ref:'C-1007',snapshot:{channel:'telegram',verified:true,revision:4,messages:[{id:'new',actor:'cliente'}]}};
  assert.deepEqual(await privateSignals(db,row),{intent:null,churn:{status:'unavailable'},follow_up:null});
});
test('an invalid photo retires the previous signal and never sends features to FastAPI',async()=>{
  const row={id:'case',contact_ref:'C-1001',snapshot:{id:'case',conversation_id:'conversation',display_name:'Cliente de prueba',
    channel:'telegram',attention_mode:'asistido',verified:true,owner_id:'advisor',status:'open',revision:4,cursor:1,
    updated_at:'2026-11-22T12:00:00Z',last_message:null,messages:[],card:null}};
  const calls=[];
  const tx={query:async(sql,params)=>{
    calls.push({sql,params});
    if (sql.startsWith('SELECT * FROM attention_case')) return [row];
    if (sql.includes('FROM ml_customer_snapshot')) return [{features:{...photo,tickets_90d:1},date:photo.fecha_corte,synthetic:true}];
    if (sql.includes('INSERT INTO case_ml_signal')) return [{case_id:row.id}];
    return [];
  }};
  const prior=globalThis.fetch;
  let requests=0;
  globalThis.fetch=async()=>{requests++;throw new Error('unexpected inference');};
  try {
    await predictChurn({query:tx.query,manager:tx,transaction:fn=>fn(tx)},row.id,{case_revision:4,customer_ref:'C-1001'});
    assert.equal(requests,0);
    assert.deepEqual(calls.find(call=>call.sql.includes('INSERT INTO case_ml_signal')).params[1],{status:'unavailable'});
    assert.deepEqual(calls.find(call=>call.sql.includes('INSERT INTO attention_event')).params[2],{outcome:'invalid_snapshot',channel:'telegram'});
  } finally {globalThis.fetch=prior;}
});
test('a late intent prediction cannot overwrite a newer case',async()=>{
  const previous={url:process.env.ML_API_URL,token:process.env.ML_SERVICE_TOKEN,fetch:globalThis.fetch};
  process.env.ML_API_URL='http://127.0.0.1:8000'; process.env.ML_SERVICE_TOKEN='test';
  globalThis.fetch=async()=>({ok:true,json:async()=>({prediction_id:'p',label:'facturacion',score:0.5,score_type:'uncalibrated',model_version:'v1',mode:'shadow',recommendation:'clarify_intent',requires_human_confirmation:true})});
  const writes=[]; const row={snapshot:{status:'open',revision:2,attention_mode:'asistido',messages:[{id:'new',actor:'cliente',turn_seq:2}]}};
  const tx={query:async(sql)=>{if (sql.startsWith('SELECT * FROM attention_case')) return [row]; writes.push(sql); return [];}};
  const db={transaction:async fn=>fn(tx),manager:tx};
  try { await predictIntent(db,{case_id:'case',turn_id:'old',turn_seq:1,case_revision:1,attention_mode:'asistido',audience:'asesor',text:'factura',channel:'web',run_id:'run'}); assert.deepEqual(writes,[]); }
  finally {globalThis.fetch=previous.fetch; if(previous.url===undefined) delete process.env.ML_API_URL; else process.env.ML_API_URL=previous.url; if(previous.token===undefined) delete process.env.ML_SERVICE_TOKEN; else process.env.ML_SERVICE_TOKEN=previous.token;}
});
