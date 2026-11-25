'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowDownRight, ArrowUpRight, Check, ChevronRight, CircleHelp, FileClock, Network, Pencil, Radio, RefreshCw, Router, SlidersHorizontal } from 'lucide-react';
import {
  AgentModelPolicy, initialAgentModelPolicy, ModelProfile, modelProfileRank,
  type AgentModelCatalog, type AgentModelExecutions, type AgentModelRevision, type AgentModelRevisions,
  type ModelAssignment, type ModelStep
} from '@claro/contracts';
import { api } from '@/lib/api';
import { Button } from './ui/button';
import styles from './admin-agent-models.module.css';

const groups = [
  {name:'Orquestador', description:'Interpreta el contexto, delega y compone la respuesta.', icon:Network,
    steps:['extract_turn','plan_objectives','select_evidence','write_public','write_advisor']},
  {name:'Comercial y Portabilidad', description:'Sintetiza condiciones y evidencia de productos.', icon:Router, steps:['commercial_evidence']},
  {name:'Soporte Técnico', description:'Sintetiza procedimientos y evidencia de diagnóstico.', icon:Radio, steps:['support_evidence']},
  {name:'Facturación', description:'Sintetiza información autorizada de facturación.', icon:FileClock, steps:['billing_evidence']}
] as const satisfies readonly {name:string;description:string;icon:typeof Network;steps:readonly ModelStep[]}[];

const stepLabels:Record<ModelStep,string> = {
  extract_turn:'Extraer contexto', plan_objectives:'Planificar tareas', select_evidence:'Ordenar fuentes',
  write_public:'Redactar respuesta pública', write_advisor:'Redactar sugerencia privada',
  commercial_evidence:'Sintetizar evidencia comercial', support_evidence:'Sintetizar evidencia técnica',
  billing_evidence:'Sintetizar evidencia de facturación'
};
const profiles={economico:'Económico',intermedio:'Intermedio',complejo:'Complejo'};
const providers={openai:'OpenAI directo',openrouter:'OpenRouter'};
const tabs=[['policy','Configuración'],['revisions','Revisiones'],['executions','Trazas']] as const;
type Tab = typeof tabs[number][0];
const dateFormat=new Intl.DateTimeFormat('es-CO',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Bogota'});
const dollars=new Intl.NumberFormat('es-CO',{style:'currency',currency:'USD',maximumFractionDigits:6});
const errorText=(error:unknown)=>error instanceof Error?error.message:'No pudimos completar la operación.';
const shortId=(id:string)=>id.length>18 ? id.slice(0,8) : id;
const groupFor=(step:ModelStep)=>groups.find(group=>(group.steps as readonly ModelStep[]).includes(step)) ?? groups[0];
const statusLabel:Record<string,string>={
  accepted:'Aceptada',invalid:'Salida inválida',budget_exhausted:'Límite del turno',unavailable:'Sin respuesta',
  credencial_ausente:'Falta la credencial del proveedor',modelo_no_aprobado:'Modelo fuera del catálogo',
  modelo_no_disponible:'Modelo sin disponibilidad confirmada',salida_estructurada_incompatible:'Salida estructurada incompatible',
  perfil_incompatible:'Modelo insuficiente para el perfil',presupuesto_insuficiente:'Presupuesto insuficiente',
  proveedor_no_disponible:'Proveedor sin respuesta'
};

function RevisionStatus({item,active}:{item:AgentModelRevision;active:string}) {
  if(item.revision===active) return <span className={styles.live}>Activa</span>;
  if(item.validation?.issues.length) return <span className={styles.warning}>Con hallazgos</span>;
  if(item.was_active) return <span className={styles.muted}>Histórica</span>;
  return <span className={styles.muted}>{item.validation?.digest===item.digest?'Validada':'Borrador'}</span>;
}

function ModelOptionList({catalog,minimum}:{catalog:AgentModelCatalog;minimum?:ModelProfile}) {
  return <>{Object.entries(providers).map(([provider,label])=><optgroup key={provider} label={label}>
    {catalog.models.filter(model=>model.provider===provider).map(model=>{
      const incompatible=minimum && modelProfileRank[model.profile]<modelProfileRank[minimum];
      return <option key={model.id} value={model.id} disabled={Boolean(incompatible)||model.structured_outputs===false}>
        {model.label}{!model.available?' · Por confirmar':''}
      </option>;
    })}
  </optgroup>)}</>;
}

function AssignmentFields({catalog,step,rule,onChange}:{catalog:AgentModelCatalog;step:ModelStep;rule:ModelAssignment;
  onChange:(value:ModelAssignment)=>void}) {
  return <>
    <div className={styles.fields}>
      <label>Estrategia<select value={rule.mode} onChange={event=>{
        if (event.target.value==='fixed' && rule.mode==='auto') onChange({mode:'fixed',model:rule.profiles.economico,fallback:rule.fallback});
        if (event.target.value==='auto' && rule.mode==='fixed') onChange({...initialAgentModelPolicy.steps[step],fallback:rule.fallback});
      }}>
        <option value="auto">Automática por perfil y costo</option><option value="fixed">Modelo fijo</option>
      </select></label>
      <label>Modelo de respaldo<select value={rule.fallback ?? ''} onChange={event=>onChange({...rule,fallback:event.target.value||undefined})}>
        <option value="">Sin respaldo</option><ModelOptionList catalog={catalog}/>
      </select></label>
    </div>
    {rule.mode==='fixed' ?
      <div className={styles.fields}><label>Modelo principal<select value={rule.model} onChange={event=>onChange({...rule,model:event.target.value})}>
        <ModelOptionList catalog={catalog}/>
      </select></label></div>
      : <>
        <div className={styles.fields}>
          {ModelProfile.options.map(profile=><label key={profile}>{profiles[profile]}<select value={rule.profiles[profile]}
            onChange={event=>onChange({...rule,profiles:{...rule.profiles,[profile]:event.target.value}})}>
            <ModelOptionList catalog={catalog} minimum={profile}/>
          </select></label>)}
        </div>
        <fieldset className={styles.alternatives}><legend>Alternativas automáticas de OpenRouter</legend>
          {catalog.models.filter(model=>model.provider==='openrouter').map(model=><label key={model.id}><input type="checkbox"
            checked={rule.alternatives.includes(model.id)} disabled={model.structured_outputs===false} onChange={event=>onChange({
              ...rule,alternatives:event.target.checked ? [...rule.alternatives,model.id] : rule.alternatives.filter(id=>id!==model.id)
            })}/>{model.label}</label>)}
        </fieldset>
      </>}
  </>;
}

function ExecutionView() {
  const [data,setData]=useState<AgentModelExecutions>();
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const [component,setComponent]=useState('');
  const load=useCallback(async()=>{
    setLoading(true);
    setError('');
    try {setData(await api.agentModelExecutions());}
    catch(failure){setError(errorText(failure));}
    finally{setLoading(false);}
  },[]);
  useEffect(()=>{void load();},[load]);
  const items=data?.items.filter(item=>!component||groupFor(item.step).name===component);
  return <section className={styles.surface} aria-labelledby="model-execution-title">
    <div className={styles.sectionHead}>
      <div><h2 id="model-execution-title">Ejecuciones recientes</h2><p>Hasta 40 llamadas a modelos de los últimos 7 días.</p></div>
      <div className={styles.actions}>
        <Button type="button" variant="outline" disabled={loading} onClick={()=>void load()}><RefreshCw aria-hidden="true"/>Actualizar</Button>
        {data?.langfuse_url&&<Button asChild variant="outline"><a href={data.langfuse_url} target="_blank" rel="noreferrer">Abrir Langfuse <ArrowUpRight aria-hidden="true"/></a></Button>}
      </div>
    </div>
    <label className={styles.filter}>Componente<select value={component} onChange={event=>setComponent(event.target.value)}>
      <option value="">Todos los agentes</option>{groups.map(group=><option key={group.name}>{group.name}</option>)}
    </select></label>
    {error&&<p role="alert" className={styles.error}>{error}</p>}
    {loading&&!data&&<p role="status">Cargando ejecuciones…</p>}
    {items?.length===0&&<p className={styles.empty}>No hay llamadas registradas para este filtro. Actualiza después de un turno que use un modelo.</p>}
    {!!items?.length&&<ul className={styles.executionList}>
      {items.map(item=><li key={item.id}>
        <div><strong>{groupFor(item.step).name}</strong><small>{stepLabels[item.step]}</small><small>{dateFormat.format(new Date(item.at))}</small></div>
        <div><strong className={styles.modelId}>{item.effective_model ?? 'Sin modelo efectivo'}</strong>
          <small>{providers[item.provider]} · Revisión <code title={item.revision}>{shortId(item.revision)}</code></small>
          {item.requested_model!==item.effective_model&&<small className={styles.modelId}>Solicitado {item.requested_model}</small>}</div>
        <div><span className={item.status==='accepted'?styles.live:styles.warning}>{statusLabel[item.status] ?? item.status.replaceAll('_',' ')}</span>
          <small>{item.attempt>1?'Respaldo · ':''}{item.latency_ms===null?'':`${item.latency_ms.toLocaleString('es-CO')} ms`}</small>
          {item.cost_usd!==null&&<small>{dollars.format(item.cost_usd)}{item.cost_basis==='rate_estimate'?' estimado':''}</small>}</div>
        {item.trace_url?<a className={styles.link} href={item.trace_url} target="_blank" rel="noreferrer">Ver traza <ArrowUpRight size={15} aria-hidden="true"/></a>
          :<small>{data?.langfuse_url?'Traza sin enlace':'Langfuse sin configurar'}</small>}
      </li>)}
    </ul>}
  </section>;
}

export function AdminAgentModels() {
  const [catalog,setCatalog]=useState<AgentModelCatalog>();
  const [history,setHistory]=useState<AgentModelRevisions>();
  const [tab,setTab]=useState<Tab>('policy');
  const [step,setStep]=useState<ModelStep>('extract_turn');
  const [reviewId,setReviewId]=useState<string>();
  const [inspectId,setInspectId]=useState<string>();
  const [edit,setEdit]=useState<{base:string;policy:AgentModelPolicy}>();
  const [draftReason,setDraftReason]=useState('');
  const [reason,setReason]=useState('');
  const [evidence,setEvidence]=useState('');
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const active=history?.revisions.find(item=>item.revision===history.active);
  const inspected=history?.revisions.find(item=>item.revision===inspectId) ?? active;
  const reviewed=history?.revisions.find(item=>item.revision===reviewId) ?? active;
  const policy=edit?.policy ?? inspected?.policy;
  const rule=policy?.steps[step];
  const group=groupFor(step);
  const changed=!!edit && JSON.stringify(edit.policy)!==JSON.stringify(active?.policy);
  const parsed=edit ? AgentModelPolicy.safeParse(edit.policy) : undefined;

  const load=useCallback(async()=>{
    const [models,revisions]=await Promise.all([api.agentModelCatalog(),api.agentModelRevisions()]);
    setCatalog(models);
    setHistory(revisions);
  },[]);
  useEffect(()=>{void load().catch(failure=>setError(errorText(failure)));},[load]);

  async function action(label:string,work:()=>Promise<void>) {
    setBusy(label);
    setError('');
    setNotice('');
    try{await work();}
    catch(failure){setError(errorText(failure));}
    finally{setBusy('');}
  }

  function updatePolicy(update:(policy:AgentModelPolicy)=>AgentModelPolicy) {
    setEdit(current=>current&&{...current,policy:update(current.policy)});
  }

  function selectTab(next:Tab) {
    setTab(next);
    setError('');
    setNotice('');
  }

  function selectReview(id:string) {
    setReviewId(id);
    setReason('');
    setEvidence('');
    setError('');
    setNotice('');
  }

  function save(event:FormEvent) {
    event.preventDefault();
    if (!edit || !parsed?.success) return;
    void action('Guardando borrador…',async()=>{
      const saved=await api.saveAgentModelRevision({base_revision:edit.base,reason:draftReason,policy:parsed.data});
      setHistory(current=>current&&({...current,revisions:[saved,...current.revisions]}));
      setEdit(undefined);
      setDraftReason('');
      selectReview(saved.revision);
      setTab('revisions');
      setNotice('Borrador guardado. Valídalo para poder activarlo.');
    });
  }

  const ready=reviewed?.validation?.digest===reviewed?.digest && reviewed?.validation?.issues.length===0;
  const operation=reviewed?.was_active?'restore':'activate';
  const canApply=!!reviewed && reviewed.revision!==active?.revision && ready &&
    (reviewed.was_active || reviewed.base_revision===history?.active);
  const modelLabel=(id:string)=>catalog?.models.find(model=>model.id===id)?.label ?? id;

  return <div className={`admin-page ${styles.page}`}>
    <header className={styles.header}>
      <div><h1>Modelos del agente</h1><p>Consulta y configura qué LLM usa cada agente y sus llamadas.</p></div>
      {active&&<div className={styles.activeRevision}><span className={styles.live}>Revisión activa</span><code title={active.revision}>{shortId(active.revision)}</code></div>}
    </header>
    <nav className={styles.tabs} aria-label="Gestión de modelos">
      {tabs.map(([id,label])=><button key={id} type="button" disabled={!!busy} aria-current={tab===id?'page':undefined} onClick={()=>selectTab(id)}>
        {id==='policy'?<SlidersHorizontal/>:id==='revisions'?<FileClock/>:<Radio/>}{label}
      </button>)}
    </nav>
    {(notice||busy)&&<p className={styles.notice} role="status">{busy||notice}</p>}
    {error&&<div className={styles.error} role="alert">{error} <Button type="button" variant="outline" size="sm" onClick={()=>void action('Actualizando datos…',load)}>Actualizar datos</Button></div>}
    {tab==='executions'?<ExecutionView/>:!active||!catalog||!policy||!rule||!inspected||!reviewed?
      !error&&<p role="status" className={styles.empty}>Cargando configuración de modelos…</p>:
      tab==='policy'?<>
        <section className={styles.split} aria-label="Configuración por componente">
          <div className={styles.componentList} aria-label="Agentes disponibles">
            <h2>Agentes</h2>
            {groups.map(item=>{
              const Icon=item.icon;
              const steps:readonly ModelStep[]=item.steps;
              const first=policy.steps[item.steps[0]];
              const mixed=steps.some(itemStep=>JSON.stringify(policy.steps[itemStep])!==JSON.stringify(first));
              return <button type="button" aria-pressed={item.name===group.name} disabled={!!busy} key={item.name} onClick={()=>setStep(item.steps[0])}>
                <Icon size={18} aria-hidden="true"/><span><strong>{item.name}</strong>
                  <small>{mixed?`${steps.length} llamadas con reglas distintas`:first.mode==='fixed'?modelLabel(first.model):'Automático · 3 perfiles'}</small>
                </span><ChevronRight size={16} aria-hidden="true"/>
              </button>;
            })}
          </div>
          <div className={styles.editor}>
            <div className={styles.sectionHead}>
              <div><h2>{group.name}</h2><p>{group.description}</p></div>
              {!edit&&(inspected.revision===active.revision?
                <Button type="button" onClick={()=>{setError('');setNotice('');setEdit({base:active.revision,policy:structuredClone(active.policy)});}}><Pencil/>Editar modelos</Button>
                :<Button type="button" variant="outline" onClick={()=>setInspectId(undefined)}>Volver a la activa</Button>)}
            </div>
            {inspected.revision!==active.revision&&!edit&&<p className={styles.notice}>Consultando revisión <code>{shortId(inspected.revision)}</code></p>}
            {group.steps.length>1&&<label className={styles.filter}>Llamada<select value={step} disabled={!!busy} onChange={event=>setStep(event.target.value as ModelStep)}>
              {group.steps.map(item=><option key={item} value={item}>{stepLabels[item]}</option>)}
            </select></label>}
            {edit?<form onSubmit={save} className={styles.form}>
              <fieldset className={styles.formFields} disabled={!!busy}>
                <AssignmentFields catalog={catalog} step={step} rule={rule} onChange={next=>updatePolicy(current=>({...current,steps:{...current.steps,[step]:next}}))}/>
                {group.steps.length>1&&<Button type="button" variant="outline" className={styles.replicate}
                  onClick={()=>updatePolicy(current=>({...current,steps:{...current.steps,...Object.fromEntries(group.steps.map(key=>[key,rule]))}}))}>
                  <ArrowDownRight/>Aplicar a las {group.steps.length} llamadas del orquestador
                </Button>}
                <details className={styles.disclosure}><summary>Límites de la política</summary>
                  <div className={styles.fields}>
                    <label>Presupuesto por turno en USD<input type="number" step="0.0001" min="0.0001" max="1" value={Number.isNaN(policy.max_cost_usd)?'':policy.max_cost_usd}
                      onChange={event=>{const value=event.target.valueAsNumber;updatePolicy(current=>({...current,max_cost_usd:value}));}} required/></label>
                    <label>Tiempo por llamada en ms<input type="number" min="350" max="10000" value={Number.isNaN(policy.max_call_ms)?'':policy.max_call_ms}
                      onChange={event=>{const value=event.target.valueAsNumber;updatePolicy(current=>({...current,max_call_ms:value}));}} required/></label>
                  </div>
                </details>
                <label>Motivo del cambio<input value={draftReason} minLength={5} maxLength={300} required
                  onChange={event=>setDraftReason(event.target.value)} placeholder="Ej. Ajuste de síntesis comercial"/></label>
              </fieldset>
              <div className={styles.formActions}>
                <Button type="button" variant="outline" disabled={!!busy} onClick={()=>{setEdit(undefined);setDraftReason('');setError('');}}>Descartar edición</Button>
                <Button type="submit" disabled={!!busy||!changed||!parsed?.success||draftReason.trim().length<5}>Guardar borrador</Button>
              </div>
            </form>:<>
              <dl className={styles.assignment}>
                <div><dt>Estrategia</dt><dd>{rule.mode==='auto'?'Automática por perfil y costo':'Modelo fijo'}</dd></div>
                {rule.mode==='fixed'?<div><dt>Modelo principal</dt><dd>{modelLabel(rule.model)}</dd></div>:
                  ModelProfile.options.map(profile=><div key={profile}><dt>{profiles[profile]}</dt><dd>{modelLabel(rule.profiles[profile])}</dd></div>)}
                <div><dt>Respaldo</dt><dd>{rule.fallback?modelLabel(rule.fallback):'Sin respaldo'}</dd></div>
                {rule.mode==='auto'&&rule.alternatives.length>0&&<div><dt>Alternativas</dt><dd>{rule.alternatives.map(modelLabel).join(', ')}</dd></div>}
              </dl>
              <p className={styles.limits}>{dollars.format(policy.max_cost_usd)} por turno <span aria-hidden="true">·</span> {policy.max_call_ms.toLocaleString('es-CO')} ms por llamada</p>
            </>}
          </div>
        </section>
        <details className={`${styles.surface} ${styles.disclosure}`}><summary>Catálogo y tarifas</summary>
          <p>OpenAI directo {catalog.providers.openai?'configurado':'sin credencial'} <span aria-hidden="true">·</span> OpenRouter {catalog.providers.openrouter?'configurado':'sin credencial'}</p>
          <ul className={styles.catalog}>
            {catalog.models.map(model=><li key={model.id}>
              <div><strong>{model.label}</strong><small className={styles.modelId}>{model.id}</small></div>
              <div>{providers[model.provider]}<small>{profiles[model.profile]}</small></div>
              <div>{dollars.format(model.input_usd_per_million)} / {dollars.format(model.output_usd_per_million)}<small>Entrada / salida por millón de tokens</small></div>
              <small>{model.structured_outputs===false?'Salida incompatible':model.available?'Disponible para validar':'Disponibilidad por confirmar'}</small>
            </li>)}
          </ul>
        </details>
      </>:<section className={styles.split} aria-label="Revisiones de modelos">
        <div className={styles.componentList}>
          <h2>Historial</h2>
          {history?.revisions.map(item=><button type="button" key={item.revision} disabled={!!busy}
            aria-pressed={item.revision===reviewed.revision} onClick={()=>selectReview(item.revision)}>
            <FileClock size={18} aria-hidden="true"/>
            <span><strong>{item.reason}</strong><small>{dateFormat.format(new Date(item.created_at))}</small></span>
            <ChevronRight size={16} aria-hidden="true"/>
          </button>)}
        </div>
        <div className={styles.editor}>
          <div className={styles.sectionHead}>
            <div><h2>{reviewed.reason}</h2><p>Revisión <code title={reviewed.revision}>{shortId(reviewed.revision)}</code></p></div>
            <RevisionStatus item={reviewed} active={active.revision}/>
          </div>
          <div className={styles.form}>
            <div className={styles.actions}>
              <Button type="button" variant="outline" disabled={!!busy||!!edit} onClick={()=>{setInspectId(reviewed.revision);selectTab('policy');}}>Consultar configuración</Button>
              <Button type="button" variant={ready?'outline':'default'} disabled={!!busy||!!edit} onClick={()=>void action('Validando con los proveedores…',async()=>{
                const validation=await api.validateAgentModelRevision(reviewed.revision);
                setHistory(current=>current&&({...current,revisions:current.revisions.map(item=>item.revision===reviewed.revision?{...item,validation}:item)}));
                setNotice(validation.issues.length?'La validación encontró hallazgos. Revisa el detalle.':'Validación completada.');
              })}>{reviewed.validation?'Volver a validar':'Validar revisión'}</Button>
            </div>
            {edit&&<p className={styles.limits}>Guarda o descarta la edición para operar sobre el historial.</p>}
            {reviewed.validation?<div className={styles.validation}>
              <strong>{ready?<Check size={16}/>:<CircleHelp size={16}/>} {ready?'Validación aprobada':'Hallazgos de la validación'}</strong>
              <small>{dateFormat.format(new Date(reviewed.validation.checked_at))}</small>
              {reviewed.validation.issues.length>0&&<ul>{reviewed.validation.issues.map(issue=><li key={`${issue.step}:${issue.model}`}>
                {groupFor(issue.step).name} · {stepLabels[issue.step]} · {modelLabel(issue.model)}
                <small>{statusLabel[issue.reason] ?? issue.reason.replaceAll('_',' ')}</small>
              </li>)}</ul>}
            </div>:<p className={styles.limits}>La validación comprueba disponibilidad, presupuesto y salida estructurada.</p>}
            {!reviewed.was_active&&ready&&reviewed.base_revision!==active.revision&&
              <p className={styles.warning}>La revisión base cambió. Crea un borrador desde la política activa.</p>}
            {canApply&&<form className={styles.form} onSubmit={event=>{
              event.preventDefault();
              void action(operation==='restore'?'Restaurando revisión…':'Activando revisión…',async()=>{
                const result=await api.applyAgentModelRevision(reviewed.revision,operation,{expected_revision:active.revision,reason,evidence});
                setHistory(current=>current&&({active:result.active,revisions:current.revisions.map(item=>item.revision===result.active?result.revision:item)}));
                setInspectId(undefined);
                setReason('');
                setEvidence('');
                setNotice('La revisión activa se aplicará a los turnos nuevos.');
              });
            }}>
              <div className={styles.fields}>
                <label>Motivo<input required minLength={5} maxLength={300} value={reason} onChange={event=>setReason(event.target.value)}/></label>
                <label>Referencia de prueba<input required minLength={3} maxLength={240} value={evidence} onChange={event=>setEvidence(event.target.value)}/></label>
              </div>
              <div className={styles.formActions}><Button type="submit" disabled={!!busy||!!edit||reason.trim().length<5||evidence.trim().length<3}>
                {operation==='restore'?'Restaurar revisión':'Activar revisión'}
              </Button></div>
            </form>}
          </div>
        </div>
      </section>}
  </div>;
}
