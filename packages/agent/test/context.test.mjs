import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextQuestions, evolveContext, nextContextQuestion, recordQuestion, createKnowledgePipeline } from '../dist/index.js';

test('cancellation asks at most two optional questions, with different follow-ups for a fault',()=>{
  let context=evolveContext('Quiero cancelar mi internet');
  for (const [id,reply] of [['motivo','Se cae mucho'],['frecuencia','A diario']]) {
    const selected=nextContextQuestion(context);
    assert.equal(selected.id,id);
    recordQuestion(context,selected);
    context=evolveContext(reply,context);
  }
  assert.equal(context.intent,'cancelacion');
  assert.equal(context.facts.motivo,'Fallas del servicio');
  assert.deepEqual(context.asked,['motivo','frecuencia']);
  assert.equal(nextContextQuestion(context),undefined);
});

test('known price, move, and an explicit opt-out make the context questions unnecessary',()=>{
  for (const text of ['Me mudé a una zona sin cobertura y quiero cancelar','Quiero cancelar. Otro operador cobra menos.']) {
    assert.equal(nextContextQuestion(evolveContext(text)),undefined);
  }
  const context=evolveContext('Quiero cancelar');
  recordQuestion(context,nextContextQuestion(context));
  assert.equal(nextContextQuestion(evolveContext('Prefiero no decirlo',context)),undefined);
  const billing=evolveContext('Ahora quiero consultar mi factura',context);
  assert.equal(billing.intent,'facturacion');
  assert.equal(billing.pending,undefined);
});

test('TRX-0001 preserves the short answer when the active task is slow internet',()=>{
  let context=evolveContext('Por el celular me da 270 megas y contraté 900.');
  const question=nextContextQuestion(context);
  assert.ok(contextQuestions.find(entry=>entry.id===question.id).transcripts.includes('TRX-0001'));
  recordQuestion(context,question);
  context=evolveContext('por cable',context);
  assert.equal(context.facts.medio,'Cable');
  assert.equal(nextContextQuestion(context),undefined);
});

test('a retention eligibility query is scoped on both retrieval attempts',async()=>{
  const policy={id:'retencion-003',title:'Política de retención · Criterios de elegibilidad',version:'POL-RET-2026 v3.1',
    excerpt:'El cliente no debe tener mora mayor a 30 días.',scope:'advisor',effective_from:'2026-11-18',
    metadata:{source:'retencion',section:'Criterios de elegibilidad',tags:['retencion','elegibilidad'],context:'Política interna'}};
  const unrelated={...policy,id:'manual-001',scope:'public',metadata:{...policy.metadata,source:'deco'}};
  for (const audience of ['cliente','asesor']) {
    const observed=[];
    const pipe=createKnowledgePipeline({knowledge:{search:async(query,context)=>{
      observed.push([query,context.filters]);
      return observed.length===1 ? [unrelated] : [unrelated,policy];
    }}});
    const result=await pipe.retrieve({text:'Requisitos para retención',audience,channel:'web',business_date:'2026-11-18',run_id:'test'},'economico',{});
    assert.equal(result.search.attempts,2);
    assert.ok(observed.every(([,filters])=>filters.source==='retencion'&&filters.tags.includes('elegibilidad')));
    assert.deepEqual(result.candidates.map(doc=>doc.id),audience==='asesor'?[policy.id]:[]);
  }
});

test('public answers derived from TRX-0012 fit chat and voice and omit irrelevant catalogue rows',async()=>{
  const base={id:'catalogo-v1-004',title:'Catálogo · Telefonía móvil',version:'CAT-2026 v1.0',scope:'public',type:'catalogo',
    effective_from:'2026-11-01',excerpt:'Claro Max 25 GB 25 GB $49.900 Minutos y SMS ilimitados nacionales.\nClaro Max 60 GB 60 GB $69.900 Todo lo anterior + Claro Video.\nClaro Max Ilimitado Ilimitados* $99.900 Todo lo anterior + Claro Música + 10 GB de\nroaming en las Américas.\n* Plan Ilimitado: después de consumir 150 GB en el ciclo de facturación, la velocidad de navegación se\nreduce a 1 Mbps hasta el siguiente ciclo.'};
  const faq={...base,id:'faq-007',title:'FAQ · ¿Puedo cambiar mi plan móvil?',type:'soporte',excerpt:'## ¿Puedo cambiar mi plan móvil?\nSí, en cualquier momento y sin costo. El nuevo plan aplica desde el siguiente ciclo de facturación.'};
  const pipeline=createKnowledgePipeline({documents:[base,faq]});
  const turn={run_id:'trx-0012',text:'Quiero saber qué incluye el plan Ilimitado.',audience:'cliente',channel:'voice',business_date:'2026-11-18'};
  const first=await pipeline.retrieve(turn,'economico',{});
  const plan=await pipeline.answer(turn,'economico','',first.candidates);
  assert.equal(plan.used[0].id,base.id);
  assert.ok(plan.answer.length<=235);
  for(const text of ['99.900','Claro Video','Claro Música','150 GB','1 Mbps']) assert.ok(plan.answer.includes(text));
  assert.doesNotMatch(plan.answer,/49\.900|69\.900|25 GB|60 GB/);
  const followUp={...turn,text:'¿Puedo cambiar mi plan móvil?'};
  const next=await pipeline.retrieve(followUp,'economico',{});
  assert.deepEqual(next.candidates.map(item=>item.id),[faq.id]);
  const change=await pipeline.answer(followUp,'economico','',next.candidates);
  assert.match(change.answer,/sin costo.*siguiente ciclo/);
});

test('a long public table is cited apart rather than reproduced in the message',async()=>{
  const doc={id:'faq-123',title:'Costos de instalación',excerpt:'Instalación | Precio\n'.repeat(18),version:'test',scope:'public',effective_from:'2026-11-18'};
  const turn={run_id:'no-dump',audience:'cliente',channel:'whatsapp',business_date:'2026-11-18',text:'¿Qué costos tiene la instalación?'};
  const reply=await createKnowledgePipeline({documents:[doc]}).answer(turn,'economico','',[doc]);
  assert.equal(reply.used[0].id,doc.id);
  assert.ok(reply.answer.length<120);
  assert.doesNotMatch(reply.answer,/Instalación \| Precio/);
});
