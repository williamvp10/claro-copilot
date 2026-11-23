'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { EvalStatus, PromptRevision } from '@claro/contracts';
import { api } from '@/lib/api';
import { Button } from './ui/button';

type ManifestEntry={name:string;version:number|null;sha256:string;source:string;owner:string;variables:string[];output_contract:string;data_scope:string};
type CatalogRevision=PromptRevision & {manifest?:Record<string,ManifestEntry>;changed_keys?:string[];base_revision?:string;created_at?:string;approved_at?:string|null};
const statusText:Record<string,string>={active:'Activa',candidate:'Candidata',passed:'Aprobada',failed:'Fallida',queued:'En cola',running:'En ejecución',completed:'Completada',review_required:'Revisión pendiente',verified_exact:'Coincide',platform_replay_required:'Requiere replay',review:'Revisión',review_required_semantic:'Revisión semántica'};

export function AdminEvaluations() {
  const [revisions,setRevisions]=useState<CatalogRevision[]>([]);
  const [selected,setSelected]=useState('');
  const [prompt,setPrompt]=useState('');
  const [promptKey,setPromptKey]=useState('public_answer');
  const [importVersion,setImportVersion]=useState('');
  const [reviewJson,setReviewJson]=useState(''),[reviewMessage,setReviewMessage]=useState('');
  const [status,setStatus]=useState<EvalStatus>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const active=revisions.find(row=>row.status==='active');
  const choice=revisions.find(row=>row.revision===selected);
  const running=status?.job?.status==='running'||status?.job?.status==='queued';

  useEffect(()=>{
    let current=true;
    api.prompts().then(rows=>{
      if(!current)return;
      setRevisions(rows);
      setPrompt(currentValue=>currentValue || (rows.find(row=>row.status==='active')?.prompts.public_answer??''));
      const linked=new URLSearchParams(window.location.search).get('revision');setSelected(rows.some(row=>row.revision===linked)?linked!:rows.find(row=>row.status!=='active')?.revision??'');
    },e=>{if(current)setError(e.message);}).finally(()=>{if(current)setLoading(false);});
    return()=>{current=false;};
  },[]);

  useEffect(()=>{
    if(!selected)return;
    let current=true;
    let timer:ReturnType<typeof setTimeout>;
    let failures=0;
    async function poll(){
      if(!current)return;
      try{
        const next=await api.evalStatus(selected);
        if(!current)return;
        setStatus(next);
        if(next.job?.status==='running'||next.job?.status==='queued') timer=setTimeout(poll,1600);
        else if(next.report?.gate==='passed') setRevisions(rows=>rows.map(row=>row.revision===selected&&row.status!=='active'?{...row,status:'passed'}:row));
      }catch(e){
        if(!current)return;
        if(++failures<=3) timer=setTimeout(poll,1800);
        else setError(e instanceof Error?e.message:'No se pudo leer la evaluación.');
      }
    }
    void poll();
    return()=>{current=false;clearTimeout(timer);};
  },[selected,running]);

  async function action(fn:()=>Promise<void>){
    setBusy(true);setError('');
    try{await fn();}
    catch(e){setError(e instanceof Error?e.message:'No se pudo completar la operación.');}
    finally{setBusy(false);}
  }
  function save(event:FormEvent){
    event.preventDefault();
    void action(async()=>{
      const row=await api.savePrompts({[promptKey]:prompt.trim()});
      setRevisions(rows=>[row,...rows]);setStatus(undefined);setSelected(row.revision);
    });
  }
  return <div className="admin-page ops-dashboard">
    <header className="ops-header"><div><h1>Prompts y evaluaciones</h1><p>Revisión activa · {active?.revision??'—'}</p></div></header>
    {error&&<p className="alert error" role="alert">{error}</p>}
    <div className="ops-grid">
      <form className="ops-plot ops-prompt" onSubmit={save}>
        <h3>Editar plantilla</h3>
        <label>Plantilla<select value={promptKey} onChange={event=>{const name=event.target.value;setPromptKey(name);setPrompt(active?.prompts[name]??'');}}>{Object.keys(active?.prompts??{public_answer:''}).map(name=><option key={name} value={name}>{name}</option>)}</select></label>
        <label htmlFor="public-prompt">Contenido efectivo de la plantilla</label>
        <textarea id="public-prompt" disabled={loading} rows={7} maxLength={4096} value={prompt} onChange={event=>setPrompt(event.target.value)}/>
        <Button type="submit" disabled={!prompt.trim()||busy||loading}>Guardar candidata</Button>
      </form>
      <section className="ops-plot">
        <h3>Evaluar una revisión</h3>
        {revisions.some(row=>row.status!=='active') ? <>
          <label className="ops-revision">Revisión candidata<select value={selected} onChange={event=>{setStatus(undefined);setSelected(event.target.value);}}>
            {revisions.filter(row=>row.status!=='active').map(row=><option value={row.revision} key={row.revision}>{row.revision} · {statusText[row.status]}</option>)}
          </select></label>
          <div className="ops-actions">
            <Button type="button" disabled={!choice||busy||running} onClick={()=>void action(async()=>{
              const job=await api.eval(selected);setStatus({job,report:null});
            })}>Ejecutar evals</Button>
            <Button type="button" variant="outline" disabled={busy||running||status?.report?.gate!=='passed'} onClick={()=>void action(async()=>{
              if(!window.confirm(`¿Activar la revisión ${selected}?`))return;
              const next=await api.activate(selected);
              setRevisions(rows=>rows.map(row=>row.revision===next.revision?next:row.status==='active'?{...row,status:'passed'}:row));
              setSelected('');setStatus(undefined);
            })}>Activar revisión</Button>
          </div>
          {status?.job&&<div role="status" className="ops-progress">
            <span>{statusText[status.job.status]} · {status.job.completed_cases}/{status.job.total_cases} verificaciones A/B</span>
            <progress max={status.job.total_cases} value={status.job.completed_cases}/>
            {status.job.status==='failed'&&<p>Falló la ejecución. Comprueba el worker y los archivos de la suite.</p>}
          </div>}
        </>:<p>Guarda una candidata para iniciar la comparación.</p>}
      </section>
    </div>
    <section className="ops-plot evo-catalog"><h3>Catálogo efectivo · {active?.revision??'—'}</h3><p>Versiones, procedencia y contrato de las plantillas activas.</p>
      {active?.manifest&&Object.keys(active.manifest).length ? <div className="ops-table"><table><thead><tr><th>Plantilla</th><th>Versión y origen</th><th>Variables</th><th>Contrato y alcance</th></tr></thead><tbody>{Object.entries(active.manifest).map(([name,item])=><tr key={name}><th scope="row">{name}<small>{item.owner}</small></th><td>{item.version??'Local'} · {item.source}<small>SHA {item.sha256?.slice(0,12)}</small></td><td>{item.variables?.join(', ')||'—'}</td><td>{item.output_contract} · {item.data_scope}</td></tr>)}</tbody></table></div>:<p>El catálogo efectivo no está disponible.</p>}
      <form className="evo-import" onSubmit={event=>{event.preventDefault();void action(async()=>{const row=await api.importPrompt(promptKey,Number(importVersion));setRevisions(rows=>[row,...rows]);setSelected(row.revision);setStatus(undefined);});}}><label>Versión exacta de Langfuse<input type="number" min="1" required value={importVersion} onChange={event=>setImportVersion(event.target.value)}/></label><Button variant="outline" disabled={busy||!importVersion}>Importar {promptKey}</Button></form>
    </section>
    <section className="ops-plot evo-catalog"><h3>Historial de revisiones</h3>{revisions.map(row=><div className="revision" key={row.revision}><div><strong>{row.revision}</strong><span className="badge">{statusText[row.status]??row.status}</span><span>{row.changed_keys?.join(', ')}</span></div>{row.status==='passed'&&row.approved_at&&<Button variant="outline" disabled={busy} onClick={()=>{if(window.confirm(`¿Restaurar la revisión aprobada ${row.revision}?`))void action(async()=>{const next=await api.rollback(row.revision);setRevisions(rows=>rows.map(item=>item.revision===next.revision?next:item.status==='active'?{...item,status:'passed'}:item));});}}>Restaurar</Button>}</div>)}</section>
    {choice&&<section className="ops-plot evo-catalog"><h3>Comparar candidata · {choice.revision}</h3><p>Base: {choice.base_revision??active?.revision??'—'} · cambios: {choice.changed_keys?.join(', ')||'sin diferencias identificadas'}</p>{(choice.changed_keys??[]).map(name=><details className="evo-support" key={name}><summary>{name}</summary><div className="evo-split"><div><strong>Activa</strong><pre className="evo-prompt-text">{active?.prompts[name]??'—'}</pre></div><div><strong>Candidata</strong><pre className="evo-prompt-text">{choice.prompts[name]??'—'}</pre></div></div></details>)}</section>}
    {selected&&<section className="ops-plot evo-catalog"><h3>Adjudicación humana</h3><p>Carga un JSON con las huellas y los casos adjudicados. La revisión de una respuesta y la comprobación de efectos se muestran por separado.</p>{status?.report?.evidence&&<><dl className="evo-support-data">{([['golden_sha256','Suite golden'],['scenarios_sha256','Escenarios'],['corpus_sha256','Corpus']] as const).map(([key,label])=><div key={key}><dt>{label} · SHA-256</dt><dd><code>{status.report?.evidence?.[key]??'No disponible'}</code></dd></div>)}</dl><Button type="button" variant="outline" onClick={()=>setReviewJson(JSON.stringify({evidence:status.report?.evidence,golden:{},critical:{}},null,2))}>Preparar JSON con estas huellas</Button></>}<label className="evo-search">Archivo JSON<input type="file" accept="application/json,.json" onChange={event=>{const file=event.target.files?.[0];if(file)void file.text().then(setReviewJson)}}/></label><label className="evo-search">Contenido JSON<textarea rows={5} value={reviewJson} onChange={event=>setReviewJson(event.target.value)} placeholder={'{"evidence":{"golden_sha256":"…","scenarios_sha256":"…","corpus_sha256":"…"},"golden":{},"critical":{}}'}/></label><Button disabled={busy||!reviewJson} onClick={()=>void action(async()=>{let payload:unknown;try{payload=JSON.parse(reviewJson)}catch{throw new Error('El archivo no contiene JSON válido.')}await api.reviewPrompt(selected,payload);setReviewMessage('Adjudicación registrada. Actualiza la evaluación para consultar el gate.');setStatus(await api.evalStatus(selected));})}>Registrar adjudicación</Button>{reviewMessage&&<p role="status">{reviewMessage}</p>}</section>}
    {status?.report&&<section className="ops-plot ops-eval-results">
      <h3>Resultados por caso</h3>
      <p>{statusText[status.report.gate]??status.report.gate} · {status.report.rubric} · {status.report.date}</p>
      <div className="ops-table"><table><thead><tr><th>Caso</th><th>Base</th><th>Candidata</th><th>Revisión humana</th></tr></thead>
        <tbody>{status.report.cases.map(row=><tr key={row.id}><th scope="row">{row.id}</th><td>{statusText[row.baseline]??row.baseline}</td><td>{statusText[row.candidate]??row.candidate}</td><td>{row.human_review?'Pendiente':'—'}</td></tr>)}</tbody>
      </table></div>
    </section>}
  </div>;
}
