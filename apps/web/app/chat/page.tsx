'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, FileText, MessageCircle, UserRound } from 'lucide-react';
import type { WebChatEvent, WebChatSnapshot } from '@claro/contracts';
import { Button } from '../../components/ui/button';
import styles from './chat.module.css';

const route = '/api/v1/web-chat';
const suggestions = ['¿Qué incluye el plan Fibra 500?', 'Mi decodificador muestra el error E-202', 'Quiero consultar mi factura'];

async function load(path: string, body?: object): Promise<WebChatSnapshot> {
  const response = await fetch(route + path, {
    cache: 'no-store', signal: AbortSignal.timeout(9000),
    ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
  }).catch(() => { throw new Error('No pudimos conectar con el chat. Vuelve a intentarlo.'); });
  if (response.status === 429) throw new Error('Se alcanzó el límite del chat. Intenta en un minuto.');
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.message === 'string' ? body.message : 'No pudimos conectar con el chat. Vuelve a intentarlo.');
  }
  return response.json();
}

export default function CustomerChat() {
  const [snapshot, setSnapshot] = useState<WebChatSnapshot>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [delayedTurn, setDelayedTurn] = useState<string>();
  const end = useRef<HTMLDivElement>(null);
  const retry = useRef<{ text: string; key: string } | null>(null);
  const apply = useCallback((incoming: WebChatSnapshot) =>
    setSnapshot(current => !current || incoming.conversation_id !== current.conversation_id || incoming.cursor >= current.cursor ? incoming : current), []);
  const connect = useCallback(async () => {
    setConnecting(true);
    setError('');
    try { apply(await load('/session', {})); }
    catch (failure) { setError((failure as Error).message); }
    finally { setConnecting(false); }
  }, [apply]);

  useEffect(() => { void connect(); }, [connect]);
  const id = snapshot?.conversation_id;
  const cursor = useRef(0);
  cursor.current = snapshot?.cursor ?? 0;
  useEffect(() => {
    if (!id) return;
    const stream = new EventSource(`${route}/events?cursor=${cursor.current}`);
    let active = true;
    let syncing = false;
    async function syncHistory() {
      if (!active || syncing) return;
      syncing = true;
      try {
        const history = await load('/history');
        if (active && history.conversation_id === id) apply(history);
      } catch { /* A subsequent refresh can recover a temporary transport failure. */ }
      finally { syncing = false; }
    }
    function update(event: Event) {
      const result: WebChatEvent = JSON.parse((event as MessageEvent).data);
      if (result.snapshot.conversation_id === id) apply(result.snapshot);
    }
    stream.addEventListener('conversation.updated', update);
    stream.addEventListener('error', syncHistory);
    const timer = window.setInterval(syncHistory, 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
      stream.close();
    };
  }, [apply, id]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [snapshot?.messages.length]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || !snapshot || sending || snapshot.status === 'closed') return;
    const request = retry.current?.text === content ? retry.current : { text: content, key: crypto.randomUUID() };
    retry.current = request;
    setSending(true);
    setError('');
    setDraft(content);
    try {
      apply(await load('/messages', { text: content, idempotency_key: request.key }));
      retry.current = null;
      setDraft('');
    } catch (failure) { setError((failure as Error).message); }
    finally { setSending(false); }
  }

  const messages = snapshot?.messages ?? [];
  const assisted = snapshot?.attention_mode === 'asistido';
  const closed = snapshot?.status === 'closed';
  const verification = snapshot?.verification;
  const verifying = !closed && (verification?.stage === 'required' || verification?.stage === 'code_sent');
  const last = messages.at(-1);
  const pending = !closed && !verifying && !assisted && !snapshot?.awaiting_advisor && last?.actor === 'cliente' ? last : undefined;
  const pendingId = pending?.id;
  const pendingSince = pending?.created_at;
  useEffect(() => {
    if (!pendingId || !pendingSince) return;
    const timer = window.setTimeout(() => setDelayedTurn(pendingId), Math.max(0, Date.parse(pendingSince) + 15000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pendingId, pendingSince]);
  function submit(event: FormEvent) { event.preventDefault(); void send(draft); }

  return <main className={styles.page}>
    <header className={styles.header}>
      <div className="brand" aria-label="Claro Copiloto">
        <span className="brand-mark">claro</span><span className="brand-divider" /><span className="brand-name">copiloto</span>
      </div>
      <a href="/">Ingresar como asesor</a>
    </header>
    <section className={styles.chat} aria-labelledby="customer-chat-title">
      <div className={styles.title}>
        <span className={styles.avatar}><MessageCircle size={22} /></span>
        <div><h1 id="customer-chat-title">Chat de atención</h1><p>{closed ? 'Conversación cerrada' : assisted ? 'Atención con un asesor' : snapshot?.awaiting_advisor ? 'En espera de un asesor' : 'Asistente de Claro'}</p></div>
      </div>
      <div className={styles.history} role="log" aria-label="Mensajes" aria-live="polite">
        {!messages.length && <div className={styles.welcome}>
          <h2>Hola, ¿en qué puedo ayudarte?</h2>
          <p>Consulta un plan, solicita soporte o habla con un asesor.</p>
          <div className={styles.suggestions}>{suggestions.map(text => <button key={text} type="button" onClick={() => void send(text)} disabled={!snapshot || sending}>{text}</button>)}</div>
        </div>}
        {messages.map(message => <article key={message.id} className={message.actor === 'cliente' ? styles.customer : styles.agent}>
          <span className={styles.author}>{message.actor === 'cliente' ? 'Tú' : message.actor === 'asesor' ? 'Asesor Claro' : 'Claro Copiloto'}</span>
          <p>{message.text}</p>
          {message.citations?.map(citation => <details key={citation.id} className={styles.citation}>
            <summary><FileText size={14} />{citation.title} · {citation.version}</summary><p>{citation.excerpt}</p>
          </details>)}
        </article>)}
        {pending && (delayedTurn === pending.id
          ? <div className={styles.status}>La respuesta se está demorando. <button className={styles.textAction} type="button"
            disabled={sending} onClick={() => void send('Quiero hablar con un asesor.')}>Pedir un asesor</button></div>
          : <p className={styles.status}>Claro Copiloto está preparando una respuesta…</p>)}
        <div ref={end} />
      </div>
      <div className={styles.composer}>
        {error && <div role="alert" className={styles.error}>{error} {!snapshot && <button type="button" onClick={() => void connect()}>Reintentar</button>}</div>}
        {snapshot?.awaiting_advisor && <p className={styles.notice}><UserRound size={15} /> Un asesor continuará en este mismo chat.</p>}
        <form onSubmit={submit}>
          <label className="sr-only" htmlFor="customer-message">Mensaje</label>
          <input id="customer-message" maxLength={4096} value={draft} onChange={event => setDraft(event.target.value)} placeholder={connecting ? 'Conectando…' : closed ? 'Conversación cerrada' : verification?.stage === 'code_sent' ? 'Escribe tu código de prueba' : verification?.stage === 'required' ? 'Escribe tu correo o teléfono de prueba' : 'Escribe tu mensaje'} disabled={!snapshot || closed} />
          <Button type="submit" aria-label="Enviar mensaje" disabled={!draft.trim() || !snapshot || closed || sending} size="icon"><ArrowUp size={19} /></Button>
        </form>
        {verification?.stage === 'required' && !closed && <p className={styles.synthetic}>Contactos de prueba disponibles 11111, 22222 y 33333.</p>}
        <p className={styles.synthetic}>Demo con datos sintéticos. Evita compartir datos personales.</p>
      </div>
    </section>
  </main>;
}
