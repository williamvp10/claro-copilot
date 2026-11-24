'use client';

import { useEffect, useState } from 'react';
import type { LangfuseEvaluations } from '@claro/contracts';
import { api } from '@/lib/api';
import { Button } from './ui/button';

const verdicts = { passed: 'Aprobado', review: 'Revisión', failed: 'Fallido', pending: 'Pendiente' };
const choices: Record<string, string> = {
  completo: 'Completo', parcial: 'Parcial', ausente: 'Ausente',
  limpio: 'Sin infracción', dudoso: 'Dudoso', infraccion: 'Con infracción'
};
const runDate = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bogota'
});

export function LangfuseEvaluationsPanel() {
  const [data, setData] = useState<LangfuseEvaluations>();
  const [selection, setSelection] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    api.langfuseEvaluations(selection).then(result => {
      if (live) setData(result);
    }, reason => {
      if (live) setError(reason instanceof Error ? reason.message : 'No se pudieron consultar los resultados.');
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [selection, refresh]);

  const counts = { passed: 0, review: 0, failed: 0, pending: 0 };
  for (const row of data?.cases ?? []) counts[row.verdict]++;
  const total = data?.runs.find(run => run.id === data.selected_id)?.cases ?? 0;
  const evaluated = counts.passed + counts.review + counts.failed;

  return <section className="ops-plot ops-jev" aria-labelledby="jev-results-title" aria-busy={loading}>
    <h3 id="jev-results-title">Evaluaciones de llamadas con Jev</h3>
    <p>Resultados de Langfuse para el dataset claro-llamadas-v1.</p>
    <div className="ops-actions">
      {!!data?.runs.length && <label className="ops-revision">
        Corrida
        <select value={selection ?? data.selected_id ?? ''} disabled={loading} onChange={event => {
          setError('');
          setLoading(true);
          setSelection(event.target.value);
        }}>
          {data.runs.map(run => <option key={run.id} value={run.id}>
            {runDate.format(new Date(run.started_at))} · {run.name}
          </option>)}
        </select>
      </label>}
      <Button type="button" variant="outline" disabled={loading} onClick={() => {
        setError('');
        setLoading(true);
        setRefresh(value => value + 1);
      }}>Actualizar</Button>
    </div>
    {data?.dataset_url && <a className="ops-link" href={data.dataset_url} target="_blank" rel="noreferrer">Experimentos en Langfuse</a>}
    {data?.evaluator_url && <a className="ops-link" href={data.evaluator_url} target="_blank" rel="noreferrer">Evaluadores en Langfuse</a>}
    {loading && <p role="status">Consultando Langfuse…</p>}
    {error && <p className="alert error" role="alert">{error}</p>}
    {!loading && !error && !total && <div className="ops-empty">Aún no hay corridas nativas de Jev en Langfuse.</div>}
    {!loading && !error && !!total && <>
      <dl className="ops-kpis">
        <div><dt>Evaluados</dt><dd>{evaluated}/{total}</dd></div>
        <div><dt>Aprobados</dt><dd>{counts.passed}</dd></div>
        <div><dt>En revisión</dt><dd>{counts.review}</dd></div>
        <div><dt>Fallidos</dt><dd>{counts.failed}</dd></div>
      </dl>
      <details open>
        <summary>Resultados por caso</summary>
        <div className="ops-table">
          <table aria-label="Resultados de Jev por caso">
            <thead><tr><th scope="col">Caso</th><th scope="col">Resultado</th>
              <th scope="col">Contenido requerido</th><th scope="col">Afirmaciones prohibidas</th></tr></thead>
            <tbody>{data?.cases.map(row => <tr key={row.id}>
              <th scope="row">{row.trace_url
                ? <a href={row.trace_url} className="ops-link" target="_blank" rel="noreferrer">{row.id}</a>
                : row.id}</th>
              <td>{verdicts[row.verdict]}</td>
              <td>{row.required ? choices[row.required] : '—'}</td>
              <td>{row.forbidden ? choices[row.forbidden] : '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>
    </>}
  </section>;
}
