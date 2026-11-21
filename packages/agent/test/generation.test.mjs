import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIPublicWriter, validateDraft } from '../dist/index.js';

const evidence = [{ id:'catalog',title:'Planes vigentes',version:'2026',excerpt:'Fibra 500 cuesta $109.900 e incluye WiFi 6.' }];

test('redacción pública rechaza citas, enlaces y cifras sin respaldo', () => {
  assert.equal(validateDraft({answer:'Cuesta $100.000',citation_ids:['catalog']},evidence),null);
  assert.equal(validateDraft({answer:'300 Mbps',citation_ids:['catalog']},evidence),null);
  assert.equal(validateDraft({answer:'Fibra 500',citation_ids:['other']},evidence),null);
  assert.equal(validateDraft({answer:'Consulta https://example.com',citation_ids:['catalog']},evidence),null);
  assert.ok(validateDraft({answer:'Fibra 500 incluye WiFi 6 por $109.900.',citation_ids:['catalog']},evidence));
});

test('una sola referencia alcanza para redactar, un fallo transitorio activa un respaldo', async () => {
  const requests=[], observations=[];
  const writer=createOpenAIPublicWriter({apiKey:'test',fetch:async (_url, request)=>{
    const body=JSON.parse(request.body);
    requests.push(body);
    if(requests.length===1) return new Response('{}',{status:429});
    return new Response(JSON.stringify({status:'completed',model:body.model,usage:{input_tokens:120,output_tokens:34},output:[
      {type:'message',content:[{type:'output_text',text:JSON.stringify({answer:'Fibra 500 incluye WiFi 6 por $109.900.',citation_ids:['catalog']})}]}
    ]}));
  }});
  const output=await writer.write('plan fibra',evidence,'economico','Escribe en una oración.',x=>observations.push(x));
  assert.equal(output.citations[0].id,'catalog');
  assert.deepEqual(requests.map(x=>[x.model,x.reasoning.effort,x.store]),[['gpt-6-luna','none',false],['gpt-6.1-terra','low',false]]);
  assert.match(requests[0].input,/Escribe en una oración/);
  assert.equal(observations.at(-1).metadata.status,'accepted');
});
