'use client';

import { useEffect, useState } from 'react';
import type { Dashboard, DashboardDay, DashboardFilters, EvalComparison } from '@claro/contracts';
import { Activity, ArrowUpRight, CircleAlert, Timer, Workflow } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from './ui/button';
import { AdminIntegrations } from './integrations';

const number = new Intl.NumberFormat('es-CO',{maximumFractionDigits:2});
const dateLabel = (date: string) => date.split('-').slice(1).reverse().join('/');
const format = (value: number|null, unit: string) => value===null ? 'Sin muestra' : number.format(value)+(unit ? ' '+unit : '');

function Trend({ title, subtitle, days, value, sample, unit, tone }: {
  title:string;subtitle:string;days:DashboardDay[];value:(day:DashboardDay)=>number|null;
  sample?:(day:DashboardDay)=>number;unit:string;tone?:'red'|'cobalt'
}) {
  const points=days.map(day=>({date:day.date,value:value(day),sample:sample?.(day)}));
  const max=Math.max(...points.map(point=>point.value??0),1);
  const empty=points.every(point=>point.value===null);
  return <section className="ops-plot">
    <h3>{title}</h3><p>{subtitle}</p>
    {empty ? <div className="ops-empty">Sin muestra en este período.</div> : <>
      <div className="ops-chart" aria-hidden="true" data-tone={tone ?? 'red'}>
        <div className="ops-axis"><span>{number.format(max)} {unit}</span><span>{number.format(max/2)}</span><span>0</span></div>
        <div className="ops-chart-body">
          <div className="ops-bars">{points.map(point=><div key={point.date} className="ops-bar-slot"
            title={`${dateLabel(point.date)} · ${format(point.value,unit)}${point.sample===undefined?'':` · n=${point.sample}`}`}>
            {point.value!==null&&<div className="ops-bar" style={{height:`max(2px, ${point.value/max*100}%)`}}/>}
          </div>)}</div>
          <div className="ops-ticks">{[0,Math.floor((days.length-1)/2),days.length-1].filter((index,position,list)=>list.indexOf(index)===position).map(index=><span key={days[index].date}>{dateLabel(days[index].date)}</span>)}</div>
        </div>
      </div>
      <details className="ops-data"><summary>Datos del gráfico</summary>
        <table><thead><tr><th>Fecha</th><th>Valor</th>{sample&&<th>Muestra</th>}</tr></thead>
          <tbody>{points.map(point=><tr key={point.date}><td>{point.date}</td><td>{format(point.value,unit)}</td>{sample&&<td>{point.sample}</td>}</tr>)}</tbody>
        </table>
      </details>
    </>}
  </section>;
}

function Quality({ report }: {report?:EvalComparison|null}) {
  const metrics=[['accuracy','Exactitud',0.8],['groundedness','Fidelidad',0.85],['recall_at_5','Recall@5',0.9]] as const;
  return <section className="ops-plot">
    <h3>Comparación A/B</h3>
    {!report ? <div className="ops-empty">Sin evaluación registrada.</div> : <>
      <p>{report.provider_mode==='live'?'Proveedores conectados':'Corrida local'}{report.date ? ' · '+report.date : ''} · {report.gate==='passed'?'Gate aprobado':'Revisión pendiente'}</p>
      <div className="ops-compare">{metrics.map(([key,label,target])=><div key={key}>
        <strong>{label}</strong><span>Meta {Math.round(target*100)} %</span>
        {(['baseline','candidate'] as const).map(side=>{
          const value=report[side][key];
          return <div className="ops-comparison-row" key={side}>
            <span>{side==='baseline'?'Base':'Candidata'}</span>
            <div className="ops-track" aria-hidden="true">{value!==null&&<i data-side={side} style={{width:`${Math.max(0,Math.min(value,1))*100}%`}}/>}</div>
            <b>{value===null?'Sin muestra':format(value*100,'%')}</b>
          </div>;
        })}
      </div>)}</div>
    </>}
  </section>;
}

function Model({ dash }: {dash:Dashboard}) {
  const classes=dash.prediction_classes??[];
  const predictions=classes.reduce((sum,row)=>sum+row.count,0);
  const version=dash.evidence?.model_version;
  return <section className="ops-plot">
    <h3>Intención en sombra</h3>
    <p>{version ? `Modelo servido ${/^\d+$/.test(version) ? 'v' : ''}${version}` : 'Sin versión observada'} · {predictions} predicciones medidas</p>
    {!predictions ? <div className="ops-empty">Sin predicciones por clase en este período.</div> :
      <div className="ops-compare">{classes.map(row=><div className="ops-comparison-row" key={row.label}>
        <span>{row.label.replaceAll('_',' ')}</span>
        <div className="ops-track" aria-hidden="true"><i data-side="baseline" style={{width:`${row.count/predictions*100}%`}}/></div>
        <b>{row.count}</b>
      </div>)}</div>}
  </section>;
}

type SummaryMetric={id:string;label:string;value:number|null;unit:string;sample:number|null;denominator:number|null;source:string;status:'measured'|'no_sample'|'pending_instrumentation'|'target_only'|'unavailable'};
type SummaryResult={metrics:SummaryMetric[]};
const summaryGroups=[
  {id:'negocio',label:'Negocio',metric:'cases'},
  {id:'calidad-llm',label:'Calidad del LLM',metric:'groundedness'},
  {id:'tecnica',label:'Técnica',metric:'first_content_p95'},
  {id:'agentes',label:'Agentes',metric:'agent_success'},
  {id:'machine-learning',label:'Machine learning',metric:'intent_f1'},
  {id:'devops',label:'DevOps',metric:'coverage'}
] as const;
const metricStatus:Record<SummaryMetric['status'],string>={measured:'Medida',no_sample:'Sin muestra',pending_instrumentation:'Instrumentación pendiente',target_only:'Solo meta',unavailable:'Fuente no disponible'};
function GroupSummary({filters,reload}:{filters:DashboardFilters;reload:number}){
 const [results,setResults]=useState<Record<string,{metric?:SummaryMetric;error?:boolean}>>({});
 const [loading,setLoading]=useState(true);
 useEffect(()=>{let current=true;setLoading(true);setResults({});const params=new URLSearchParams({days:filters.days});if(filters.channel!=='all')params.set('channel',filters.channel);void Promise.all(summaryGroups.map(async group=>{try{const response=await fetch(`/api/v1/admin/metrics/${group.id}?${params}`,{credentials:'same-origin'});if(!response.ok)throw new Error('unavailable');const data=await response.json() as SummaryResult;return [group.id,{metric:data.metrics.find(metric=>metric.id===group.metric)}] as const}catch{return [group.id,{error:true}] as const}})).then(rows=>{if(current){setResults(Object.fromEntries(rows));setLoading(false)}});return()=>{current=false}},[filters.days,filters.channel,reload]);
 const link=(group:string)=>{const params=new URLSearchParams({view:'metrics',group,days:filters.days});if(filters.channel!=='all')params.set('channel',filters.channel);return `/?${params}`};
 return <section className="evo-overview"><div className="evo-overview-head"><div><h2>Resumen por categoría</h2><p>Señales del período seleccionado · hora de Bogotá</p></div></div><div className="evo-overview-grid">{summaryGroups.map(group=>{const result=results[group.id],metric=result?.metric;return <a className="evo-overview-card" key={group.id} href={link(group.id)}><div className="evo-row"><h3>{group.label}</h3><span aria-hidden="true">↗</span></div>{loading?<p role="status">Consultando…</p>:result?.error?<><strong>Fuente no disponible</strong><p>No se pudo consultar este tablero.</p></>:metric?<><span className="evo-overview-label">{metric.label}</span><strong>{metric.value===null?'—':number.format(metric.value)} <small>{metric.unit}</small></strong><span className={`evo-status ${metric.status}`}>{metricStatus[metric.status]}</span><p>{metric.denominator!==null?`Denominador ${number.format(metric.denominator)}`:metric.sample!==null?`Muestra ${number.format(metric.sample)}`:'Sin denominador'} · {metric.source}</p></>:<><strong>Sin indicador</strong><p>No hay señal disponible para esta categoría.</p></>}</a>})}</div>{!loading&&summaryGroups.some(group=>results[group.id]?.error||results[group.id]?.metric?.status==='unavailable')&&<p className="alert" role="status">Hay fuentes no disponibles. Abre la categoría afectada para revisar el detalle.</p>}</section>;
}

const landmarks=[
  ['cases',Workflow],['aht',Timer],['agent_p95',Activity],['agent_errors',CircleAlert]
] as const;

export function AdminDashboard() {
  const [filters,setFilters]=useState<DashboardFilters>({days:'7',channel:'all'});
  const [dash,setDash]=useState<Dashboard>();
  const [pending,setPending]=useState(true);
  const [error,setError]=useState('');
  const [reload,setReload]=useState(0);
  useEffect(()=>{
    let current=true;
    setPending(true);
    setError('');
    api.dashboard(filters).then(result=>{
      if(current) setDash(result);
    },failure=>{
      if(current) {setError(failure.message);setDash(undefined);}
    }).finally(()=>{if(current)setPending(false);});
    return ()=>{current=false;};
  },[filters,reload]);
  const days=dash?.daily??[];
  return <div className="admin-page ops-dashboard">
    <header className="ops-header">
      <div><h1>Operación de atención</h1><p>{dash?.sample==='pilot'?'Datos de piloto':api.fixtures?'Ejemplo de interfaz':'Insumos oficiales de la prueba'} {dash?.timezone&&'· Hora de Bogotá'}</p></div>
      <div className="ops-filters">
        <label><span id="ops-days-label">Período</span><select aria-labelledby="ops-days-label" value={filters.days} onChange={e=>setFilters({...filters,days:e.target.value as DashboardFilters['days']})}>
          <option value="7">Últimos 7 días</option><option value="30">Últimos 30 días</option>
        </select></label>
        <label><span id="ops-channel-label">Canal</span><select aria-labelledby="ops-channel-label" value={filters.channel} onChange={e=>setFilters({...filters,channel:e.target.value as DashboardFilters['channel']})}>
          <option value="all">Todos</option><option value="web">Web</option><option value="telegram">Telegram</option>
        </select></label>
        <Button type="button" variant="outline" onClick={()=>setReload(v=>v+1)}>Actualizar</Button>
      </div>
    </header>
    <GroupSummary filters={filters} reload={reload}/>
    {error&&<p className="alert error" role="alert">{error}</p>}
    {pending&&<p className="ops-loading" role="status">Actualizando métricas…</p>}
    {!pending&&dash&&<>
      <dl className="ops-kpis">{landmarks.map(([id,Icon])=>{
        const m=dash.metrics.find(metric=>metric.id===id);
        return m ? <div key={id}><dt><Icon size={16}/>{m.label}</dt><dd>{format(m.value,m.unit)}</dd>
          {m.denominator!==undefined&&<span>Muestra {m.denominator}</span>}</div>:null;
      })}</dl>
      {days.length>0&&<div className="ops-grid">
        <Trend days={days} title="Volumen de atención" subtitle="Conversaciones abiertas por día" value={d=>d.cases} unit="casos"/>
        <Trend days={days} title="Tiempo de atención" subtitle="Desde la toma o apertura asistida hasta el cierre" value={d=>d.aht} sample={d=>d.aht_sample} unit="s" tone="cobalt"/>
        <Trend days={days} title="Latencia del agente" subtitle="Percentil 95 de ejecuciones del worker" value={d=>d.latency_p95} sample={d=>d.latency_sample} unit="ms" tone="cobalt"/>
        <Trend days={days} title="Errores operativos" subtitle="Trabajos fallidos, Telegram e inferencia" value={d=>d.errors} unit="eventos"/>
      </div>}
      <div className="ops-grid"><Quality report={dash.evaluation}/><Model dash={dash}/></div>
      <div className="ops-grid">
        <section className="ops-plot"><h3>Indicadores del período</h3>
          <div className="ops-table"><table><thead><tr><th>Indicador</th><th>Valor</th><th>Muestra</th></tr></thead>
            <tbody>{dash.metrics.filter(m=>!landmarks.some(([id])=>id===m.id)).map(m=><tr key={m.id}>
              <th scope="row">{m.label}</th><td>{format(m.value,m.unit)}</td><td>{m.denominator??'—'}</td>
            </tr>)}</tbody></table></div>
          <p>Las ofertas confirmadas se miden al registrar el efecto. FCR y variaciones de piloto requieren una línea base.</p>
        </section>
        <section className="ops-plot"><h3>Servicios y evidencia</h3>
          {dash.providers.map(provider=><div className="ops-service" key={provider.name}><strong>{provider.name}</strong><span>{provider.status}</span></div>)}
          {dash.evidence?.langfuse&&<a className="ops-link" target="_blank" rel="noreferrer" href={dash.evidence.langfuse}>Abrir Langfuse <ArrowUpRight size={14}/></a>}
          {dash.evidence?.mlflow&&<a className="ops-link" target="_blank" rel="noreferrer" href={dash.evidence.mlflow}>Abrir {dash.evidence.model_run_id?'ejecución de MLflow':'MLflow'} <ArrowUpRight size={14}/></a>}
          {dash.evidence?.traces.map(trace=><a className="ops-link ops-trace" target="_blank" rel="noreferrer" key={trace.run_id} href={trace.url}>Traza {trace.channel} · {trace.run_id.slice(0,8)} <ArrowUpRight size={14}/></a>)}
        </section>
      </div>
    </>}

    {!api.fixtures&&<div className="ops-grid"><AdminIntegrations/></div>}
  </div>;
}
