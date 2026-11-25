'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ExternalLink, KeyRound, Link2, Pencil, RefreshCw, Send } from 'lucide-react';
import type { TelegramAdminContact, TelegramAdminSettings, TelegramConnectionCheck } from '@claro/contracts';
import { api } from '@/lib/api';
import { Button } from './ui/button';
import styles from './admin-telegram.module.css';

const webhookLabels = { expected:'Registrado en este entorno', other:'Registrado en otro destino', none:'Sin webhook' };
const errorText = (error:unknown) => error instanceof Error ? error.message : 'No se pudo completar la operación.';
const dateTime = new Intl.DateTimeFormat('es-CO',{ dateStyle:'short', timeStyle:'short', timeZone:'America/Bogota' });

export function AdminTelegram() {
  const [settings,setSettings] = useState<TelegramAdminSettings>();
  const [connection,setConnection] = useState<TelegramConnectionCheck>();
  const [token,setToken] = useState('');
  const [tokenOpen,setTokenOpen] = useState(false);
  const [contact,setContact] = useState<TelegramAdminContact>();
  const [busy,setBusy] = useState<string | null>('load');
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  useEffect(()=>{
    let active = true;
    api.telegramSettings().then(value=>{if (active) setSettings(value);})
      .catch(failure=>{if (active) setError(errorText(failure));})
      .finally(()=>{if (active) setBusy(null);});
    return ()=>{active=false;};
  },[]);

  async function run(action:string, work:()=>Promise<void>) {
    setBusy(action);
    setError('');
    setNotice('');
    try { await work(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(null); }
  }

  function saveToken(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = token.trim();
    setToken('');
    void run('token',async()=>{
      setSettings(await api.saveTelegramToken(value));
      setConnection(undefined);
      setTokenOpen(false);
      setNotice('Token validado y guardado.');
    });
  }

  function saveContact(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!contact) return;
    void run('contact',async()=>{
      setSettings(await api.saveTelegramContact(contact.ref,{chat_id:contact.chat_id?.trim() || null,enabled:contact.enabled}));
      setContact(undefined);
      setNotice('Contacto actualizado.');
    });
  }

  const configured = settings?.token_configured;
  const status = settings?.credentials_unreadable ? 'Credenciales no disponibles'
    : connection ? webhookLabels[connection.webhook]
    : settings?.registered ? 'Webhook configurado'
    : configured ? 'Token configurado' : 'Sin configurar';

  return <section className={`admin-page ${styles.page}`}>
    <header className="ops-header">
      <div><h1>Telegram</h1><p>Conecta el bot y elige qué chats privados pueden usar el canal.</p></div>
    </header>
    <div aria-live="polite">
      {notice && <p className={styles.notice}>{notice}</p>}
      {busy==='load' && <p className="ops-loading">Cargando configuración…</p>}
    </div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!settings && !busy && <Button variant="outline" onClick={()=>run('load',async()=>setSettings(await api.telegramSettings()))}>Reintentar carga</Button>}
    {settings && <>
      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="telegram-bot">
          <div className={styles.cardHeading}>
            <KeyRound size={19} aria-hidden="true"/>
            <h2 id="telegram-bot">Bot de atención</h2>
          </div>
          <p>Crea un bot con <code>/newbot</code> en BotFather y pega el token aquí.</p>
          <a className={styles.link} href="https://t.me/BotFather" target="_blank" rel="noreferrer">
            Abrir BotFather <ExternalLink size={14} aria-hidden="true"/>
          </a>
          <dl className={styles.details}>
            <div><dt>Bot</dt><dd>{connection?.username || settings.username ? `@${connection?.username ?? settings.username}` : 'Pendiente de confirmar'}</dd></div>
            <div><dt>Origen de la configuración</dt><dd>{{ none:'Sin configurar', admin:'Administración', environment:'Variables del servidor' }[settings.source]}</dd></div>
          </dl>
          {(!configured || tokenOpen) ? <form onSubmit={saveToken} className={styles.form}>
            <label htmlFor="telegram-token">Token de BotFather</label>
            <input id="telegram-token" type="password" autoComplete="off" spellCheck={false} required
              maxLength={120} value={token} aria-describedby="telegram-token-help" onChange={event=>setToken(event.target.value)}/>
            <small id="telegram-token-help">{configured ? 'Si cambias de bot, registra su webhook para activar el canal.' : 'El token se verifica y se guarda cifrado.'}</small>
            <div className={styles.actions}>
              <Button type="submit" disabled={!!busy || !token.trim()}>{busy==='token'?'Validando…':'Validar y guardar'}</Button>
              {configured && <Button variant="outline" type="button" disabled={!!busy} onClick={()=>{setTokenOpen(false);setToken('');}}>Cancelar</Button>}
            </div>
          </form> : <Button variant="outline" disabled={!!busy} onClick={()=>setTokenOpen(true)}><Pencil size={16}/> Cambiar token</Button>}
        </section>
        <section className={styles.card} aria-labelledby="telegram-webhook">
          <div className={styles.cardHeading}>
            <Link2 size={19} aria-hidden="true"/>
            <h2 id="telegram-webhook">Webhook</h2>
          </div>
          <p>Registra la dirección que Telegram usará para entregar mensajes y calificaciones.</p>
          <div className={styles.status}>
            <span className={connection?.webhook==='expected'||(!connection&&settings.registered)?styles.live:styles.neutral}>{status}</span>
          </div>
          {settings.webhook_url ? <div className={styles.endpoint}>
            <span>URL de este entorno</span><code>{settings.webhook_url}</code>
          </div> : <p className={styles.endpoint}>El registro requiere una dirección pública HTTPS.</p>}
          {connection && <dl className={styles.details}>
            <div><dt>Actualizaciones pendientes</dt><dd>{connection.pending_updates}</dd></div>
            {connection.last_error_at && <div><dt>Último error reportado</dt><dd>{dateTime.format(new Date(connection.last_error_at))}</dd></div>}
          </dl>}
          <div className={styles.actions}>
            <Button type="button" disabled={!!busy || !configured || !settings.webhook_url} onClick={()=>run('webhook',async()=>{
              setSettings(await api.registerTelegramWebhook());
              setConnection(undefined);
              setNotice('Telegram confirmó el registro del webhook.');
            })}>
              <Link2 size={16}/>{busy==='webhook'?'Registrando…':'Registrar webhook'}
            </Button>
            <Button type="button" variant="outline" disabled={!!busy || !configured} onClick={()=>run('check',async()=>{
              setConnection(undefined);
              setConnection(await api.checkTelegram());
              setNotice('Estado consultado en Telegram.');
            })}>
              <RefreshCw size={16}/>{busy==='check'?'Comprobando…':'Comprobar conexión'}
            </Button>
          </div>
        </section>
      </div>
      <section className={styles.card} aria-labelledby="telegram-contacts">
        <div className={styles.cardHeading}>
          <Send size={19} aria-hidden="true"/>
          <h2 id="telegram-contacts">Chats autorizados</h2>
        </div>
        <p>Asigna el ID de un chat privado a un contacto de prueba y habilita su acceso.</p>
        {settings.contacts.length ? <ul className={styles.contacts}>
          {settings.contacts.map(item=><li key={item.ref}>
            <div className={styles.contactRow}>
              <div><strong>{item.display_name}</strong><small>{item.chat_id ? `Chat ID ${item.chat_id}` : 'Sin chat ID'}</small></div>
              <span className={item.enabled&&item.chat_id ? styles.live : styles.neutral}>
                {item.enabled ? item.chat_id ? 'Habilitado' : 'Pendiente de asociar' : 'Deshabilitado'}
              </span>
              <Button type="button" variant="outline" disabled={!!busy} aria-expanded={contact?.ref===item.ref}
                aria-label={`Editar ${item.display_name}`} onClick={()=>setContact(contact?.ref===item.ref?undefined:{...item})}>
                <Pencil size={15}/> Editar
              </Button>
            </div>
            {contact?.ref===item.ref && <form onSubmit={saveContact} className={`${styles.form} ${styles.contactForm}`}>
              <label htmlFor="telegram-chat-id">Chat ID</label>
              <input id="telegram-chat-id" inputMode="numeric" autoComplete="off" pattern="[1-9][0-9]{0,15}"
                maxLength={16} value={contact.chat_id ?? ''} onChange={event=>setContact({...contact,chat_id:event.target.value})}/>
              <label className={styles.checkbox}><input type="checkbox" checked={contact.enabled}
                onChange={event=>setContact({...contact,enabled:event.target.checked})}/> Habilitar contacto</label>
              <div className={styles.actions}>
                <Button type="submit" disabled={!!busy}>{busy==='contact'?'Guardando…':'Guardar contacto'}</Button>
                <Button type="button" variant="outline" disabled={!!busy} onClick={()=>setContact(undefined)}>Cancelar</Button>
              </div>
            </form>}
          </li>)}
        </ul> : <p>Los contactos aparecen cuando se cargan los datos de prueba.</p>}
      </section>
    </>}
  </section>;
}
