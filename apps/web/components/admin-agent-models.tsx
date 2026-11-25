'use client';

import { useEffect, useState } from 'react';
import { initialAgentModelPolicy, modelStepLabels, ModelProfile, ModelStep,
  type AgentModelCatalog, type AgentModelPolicy, type AgentModelRevisions, type ModelAssignment } from '@claro/contracts';
import { api } from '@/lib/api';
import { Button } from './ui/button';

const profiles={economico:'Económico',intermedio:'Intermedio',complejo:'Complejo'};
const dollars=new Intl.NumberFormat('es-CO',{style:'currency',currency:'USD',maximumFractionDigits:4});

export function AdminAgentModels() {
  const [catalog,setCatalog]=useState<AgentModelCatalog>();
  const [history,setHistory]=useState<AgentModelRevisions>();
  const [revision,setRevision]=useState('');
  const [policy,setPolicy]=useState<AgentModelPolicy>();
  const [step,setStep]=useState<ModelStep>('extract_turn');
  const [reason,setReason]=useState('');
  const [evidence,setEvidence]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const selected=history?.revisions.find(item=>item.revision===revision);
  const changed=!!policy && !!selected && JSON.stringify(policy)!==JSON.stringify(selected.policy);
  const rule=policy?.steps[step];

  function showRevision(value:AgentModelRevisions,id=value.active) {
    const item=value.revisions.find(item=>item.revision===id);
    setHistory(value);
    setRevision(id);
    setPolicy(item?.policy);
  }

  async function action(work:()=>Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try { await work(); }
    catch(failure) { setError(failure instanceof Error?failure.message:'No se pudo completar la operación.'); }
    finally { setBusy(false); }
  }

  useEffect(()=>{
    let active=true;
    Promise.all([api.agentModelCatalog(),api.agentModelRevisions()]).then(([models,revisions])=>{
      if (!active) return;
      setCatalog(models);
      showRevision(revisions);
    },failure=>{
      if (active) setError(failure instanceof Error ? failure.message : 'No se pudo cargar la configuración.');
    });
    return ()=>{active=false;};
  },[]);

  function setRule(next:ModelAssignment) {
    setPolicy(current=>current && ({...current,steps:{...current.steps,[step]:next}}));
  }

  function options() {
    return catalog?.models.map(model=><option key={model.id} value={model.id}>
      {model.label} · {model.provider==='openai'?'OpenAI directo':'OpenRouter'}{model.available?'':' · Sin confirmar'}
    </option>);
  }

  const validated=selected?.validation?.digest===selected?.digest && selected?.validation?.issues.length===0;
  const canApply=!changed && validated && revision!==history?.active && reason.trim().length>=5 && evidence.trim().length>=3;
  return <div className="admin-page evo-page knowledge-page">
    <header className="ops-header"><div><h1>Modelos del agente</h1>
      {history&&<p>Revisión activa <code>{history.active}</code></p>}</div></header>
    {error&&<div className="alert error" role="alert">{error}</div>}
    {notice&&<div className="alert" role="status">{notice}</div>}
    {!history || !catalog || !rule || !policy ? (error ? <Button variant="outline" onClick={()=>void action(async()=>{
      const [models,revisions]=await Promise.all([api.agentModelCatalog(),api.agentModelRevisions()]);
      setCatalog(models);
      showRevision(revisions);
    })}>Reintentar</Button> : <p role="status">Cargando políticas de modelos…</p>) : <>
      <section className="agent-model-panel">
        <h2>Política por llamada</h2>
        <div className="agent-model-fields">
          <label>Revisión<select value={revision} disabled={busy} onChange={event=>showRevision(history,event.target.value)}>
            {history.revisions.map(item=><option key={item.revision} value={item.revision}>{item.reason}{item.revision===history.active?' · Activa':''}</option>)}
          </select></label>
          <label>Componente y llamada<select value={step} onChange={event=>setStep(ModelStep.parse(event.target.value))}>
            {ModelStep.options.map(item=><option key={item} value={item}>{modelStepLabels[item]}</option>)}
          </select></label>
          <label>Estrategia<select value={rule.mode} onChange={event=>setRule(event.target.value==='fixed'
            ? {mode:'fixed',model:rule.mode==='auto'?rule.profiles.economico:'gpt-6-luna',fallback:rule.fallback}
            : {...initialAgentModelPolicy.steps[step],fallback:rule.fallback})}>
            <option value="auto">Automática por perfil y costo</option>
            <option value="fixed">Modelo fijo</option>
          </select></label>
          {rule.mode==='fixed' ? <label>Modelo<select value={rule.model} onChange={event=>setRule({...rule,model:event.target.value})}>{options()}</select></label>
            : ModelProfile.options.map(profile=><label key={profile}>{profiles[profile]}<select value={rule.profiles[profile]}
                onChange={event=>setRule({...rule,profiles:{...rule.profiles,[profile]:event.target.value}})}>{options()}</select></label>)}
          <label>Respaldo<select value={rule.fallback ?? ''} onChange={event=>setRule({...rule,fallback:event.target.value || undefined})}>
            <option value="">Sin respaldo</option>{options()}
          </select></label>
          <label>Tope por turno en USD<input type="number" min="0.0001" max="1" step="0.0001" value={policy.max_cost_usd}
            onChange={event=>setPolicy({...policy,max_cost_usd:Number(event.target.value)})}/></label>
          <label>Tiempo por llamada en ms<input type="number" min={350} max={10000} value={policy.max_call_ms}
            onChange={event=>setPolicy({...policy,max_call_ms:Number(event.target.value)})}/></label>
        </div>
        {rule.mode==='auto'&&<fieldset className="agent-model-alternatives"><legend>Alternativas explícitas para esta llamada</legend>
          {catalog.models.filter(model=>model.provider==='openrouter').map(model=><label key={model.id}><input type="checkbox"
            checked={rule.alternatives.includes(model.id)} onChange={event=>setRule({...rule,alternatives:event.target.checked
              ? [...rule.alternatives,model.id] : rule.alternatives.filter(id=>id!==model.id)})}/>{model.label}</label>)}
        </fieldset>}
        <div className="agent-model-fields">
          <label>Motivo<input maxLength={300} value={reason} onChange={event=>setReason(event.target.value)}/></label>
          <label>Referencia de prueba<input maxLength={240} value={evidence} onChange={event=>setEvidence(event.target.value)}/></label>
        </div>
        <div className="ops-actions">
          <Button disabled={busy || !changed || reason.trim().length<5} onClick={()=>void action(async()=>{
            const saved=await api.saveAgentModelRevision({base_revision:history.active,reason,policy});
            showRevision(await api.agentModelRevisions(),saved.revision);
            setNotice('Borrador guardado.');
          })}>Guardar borrador</Button>
          <Button variant="outline" disabled={busy || changed} onClick={()=>void action(async()=>{
            const report=await api.validateAgentModelRevision(revision);
            showRevision(await api.agentModelRevisions(),revision);
            setNotice(report.issues.length?'La revisión tiene hallazgos de validación.':'La revisión pasó la validación con proveedores.');
          })}>Validar revisión</Button>
          {(['activate','restore'] as const).map(operation=><Button key={operation} variant="outline" disabled={busy || !canApply}
            onClick={()=>void action(async()=>{
              await api.applyAgentModelRevision(revision,operation,{expected_revision:history.active,reason,evidence});
              showRevision(await api.agentModelRevisions());
              setNotice('La revisión está activa para turnos nuevos.');
            })}>{operation==='activate'?'Activar':'Restaurar'}</Button>)}
        </div>
        {selected?.validation&&<div>
          <p>Validación del {new Date(selected.validation.checked_at).toLocaleString('es-CO')}</p>
          {!!selected.validation.issues.length&&<ul>{selected.validation.issues.map(issue=><li key={`${issue.step}:${issue.model}`}>
            {modelStepLabels[issue.step]} · {issue.model} · {issue.reason.replaceAll('_',' ')}
          </li>)}</ul>}
        </div>}
      </section>
      <section className="agent-model-panel">
        <h2>Catálogo permitido</h2>
        <p>OpenAI directo {catalog.providers.openai?'configurado':'sin credencial'} · OpenRouter {catalog.providers.openrouter?'configurado':'sin credencial'}</p>
        <div className="agent-model-table"><table>
          <thead><tr><th>Modelo</th><th>Familia</th><th>Perfil</th><th>USD por millón de tokens<br/>Entrada / salida</th><th>Disponibilidad</th></tr></thead>
          <tbody>{catalog.models.map(model=><tr key={model.id}><th scope="row">{model.label}<small>{model.id}</small></th>
            <td>{model.family}</td><td>{profiles[model.profile]}</td>
            <td>{dollars.format(model.input_usd_per_million)} / {dollars.format(model.output_usd_per_million)}</td>
            <td>{model.available ? model.structured_outputs===false?'Salida incompatible':'Disponible para validar' : 'Sin confirmar'}</td>
          </tr>)}</tbody>
        </table></div>
      </section>
    </>}
  </div>;
}
