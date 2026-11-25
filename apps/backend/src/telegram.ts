import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { z } from 'zod';

export const TelegramBotToken = z.string().trim().regex(/^\d{1,16}:[A-Za-z0-9_-]{20,100}$/);
export const TelegramSecret = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const Credentials = z.object({ token:TelegramBotToken, secret:TelegramSecret });

type TelegramSettings = {
  credentials: string;
  bot_username: string;
  registered: boolean;
};

function credentialKey() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('Telegram encryption key unavailable');
  return Buffer.from(hkdfSync('sha256',secret,'claro-copiloto','telegram-credentials-v1',32));
}

export function encryptTelegramCredentials(value: z.input<typeof Credentials>) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',credentialKey(),iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(Credentials.parse(value))),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),ciphertext.toString('base64url')].join('.');
}

function decryptTelegramCredentials(value: string) {
  const [version,iv,tag,ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Invalid Telegram credential data');
  const decipher = createDecipheriv('aes-256-gcm',credentialKey(),Buffer.from(iv,'base64url'));
  decipher.setAuthTag(Buffer.from(tag,'base64url'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext,'base64url')),decipher.final()]);
  return Credentials.parse(JSON.parse(plaintext.toString('utf8')));
}

export const telegramBotId = (token: string | undefined) => /^\d+(?=:)/.exec(token ?? '')?.[0];

export async function readTelegramConnection(db: DataSource | EntityManager) {
  const [row]: TelegramSettings[] = await db.query('SELECT credentials,bot_username,registered FROM telegram_settings WHERE singleton');
  if (row) {
    let credentials: z.output<typeof Credentials> | undefined;
    try { credentials = decryptTelegramCredentials(row.credentials); } catch { /* fail closed */ }
    return {
      source:'admin' as const, token:credentials?.token, secret:credentials?.secret,
      username:row.bot_username, registered:row.registered, unreadable:!credentials
    };
  }
  const token = process.env.TELEGRAM_BOT_TOKEN || undefined;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || undefined;
  return {
    source:token || secret ? 'environment' as const : 'none' as const,
    token, secret, username:undefined, registered:!!token, unreadable:false
  };
}

export async function activeTelegramConnection(db: DataSource | EntityManager) {
  const connection = await readTelegramConnection(db);
  return connection.source !== 'admin' || connection.registered ? connection : undefined;
}

export function telegramWebhookTarget() {
  const base = process.env.BETTER_AUTH_URL;
  if (!base) return null;
  const url = new URL('/api/v1/webhooks/telegram',base);
  return url.protocol === 'https:' ? url.href : null;
}

export class TelegramApiError extends Error {
  constructor(readonly rejectedToken: boolean, readonly providerRejected = false) { super('Error de la API de Telegram'); }
}

export async function callTelegram<T>(
  token: string, method: 'getMe'|'getWebhookInfo'|'setWebhook'|'sendMessage'|'answerCallbackQuery',
  body: object = {}, timeout = 4000
): Promise<T> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`,{
      method:'POST', redirect:'error', headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body), signal:AbortSignal.timeout(timeout)
    });
    const result = await response.json() as {ok:boolean;result:T;error_code?:number};
    if (response.ok && result.ok === true) return result.result;
    throw new TelegramApiError([401,404].includes(result.error_code ?? response.status),true);
  } catch (error) {
    if (error instanceof TelegramApiError) throw error;
    throw new TelegramApiError(false);
  }
}
