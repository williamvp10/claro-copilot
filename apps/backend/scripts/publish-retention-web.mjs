import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { publishWebEvaluations } from './publish-web-evaluations.mjs';

const [baseline,candidate,output,baseRuntime,candidateRuntime,business_date]=process.argv.slice(2);
assert.ok(baseline && candidate && output && baseRuntime && candidateRuntime && /^\d{4}-\d{2}-\d{2}$/.test(business_date),
  'Use BASE.json CANDIDATE.json OUTPUT.json BASE_REVISION CANDIDATE_REVISION BUSINESS_DATE');
const corpus=await readFile(new URL('../../../docs/agente/retencion-seguimiento-evals.v1.jsonl',import.meta.url));
const items=corpus.toString('utf8').trim().split('\n').map(JSON.parse);
const result={dataset:'claro-retencion-seguimiento-v1',corpus_sha256:createHash('sha256').update(corpus).digest('hex'),revisions:{}};
function observedTurns(id,output) {
  if (id==='RET-02') return [
    {etapa:'Pedido inicial antes de autorización',mensaje_del_asesor:output.respuesta_a_solicitud},
    ...(output.respuesta_autorizada ? [
      {etapa:'Respuesta después de la autorización',mensaje_del_asesor:output.respuesta_autorizada},
      {etapa:'Estado después de la aceptación, antes de la emisión',registro_de_facturacion:output.antes_de_emitir},
      {etapa:'Resultado medido después de emitir la factura',factura:output.factura_emitida}
    ] : [])
  ];
  if (id==='SEG-01' && output.seguimiento_al_cerrar) return [
    {etapa:'Agradecimiento tras la oferta',aceptacion:false,resolucion:false},
    {etapa:'Afirmación tras la pregunta explícita de resolución',confirmacion_del_cliente:output.confirmacion_despues_de_pregunta},
    {etapa:'Después del comando de cierre del asesor',resultado:output.resultado,
      estado_del_seguimiento:output.seguimiento_al_cerrar==='agreed'?'Programado':output.seguimiento_al_cerrar,
      fecha_acordada:output.fecha_acordada}
  ];
  return output;
}
for (const [label,file,runtime] of [['base',baseline,baseRuntime],['candidate',candidate,candidateRuntime]]) {
  const report=JSON.parse(await readFile(file,'utf8'));
  const cases=items.map(({id})=>{
    assert.ok(report.results[id],`Missing verification evidence for ${id}`);
    return {id,output:observedTurns(id,report.results[id])};
  });
  result.revisions[label]={runtime,business_date,cases};
}
await publishWebEvaluations(result,{environment:'demo-retention',prefix:'retencion-seguimiento'});
await writeFile(output,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
