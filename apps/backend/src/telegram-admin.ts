import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header,
  Inject, NotFoundException, Param, Post, Req, ServiceUnavailableException
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import type { TelegramAdminSettings } from '@claro/contracts';
import { AUTH, canManageAdministration, getViewer, type createAuth } from './auth.js';
import { audit, DATABASE } from './database.js';
import {
  callTelegram, encryptTelegramCredentials, readTelegramConnection, TelegramApiError,
  telegramBotId, TelegramBotToken, TelegramSecret, telegramWebhookTarget
} from './telegram.js';

const TokenInput = z.object({ token:TelegramBotToken });
const ContactInput = z.object({
  chat_id:z.string().regex(/^[1-9]\d{0,15}$/).refine(value=>Number.isSafeInteger(Number(value))).nullable(),
  enabled:z.boolean()
});
const SettingsLock = 771532019;

function parse<T>(schema: z.ZodType<T>, body: unknown) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException('Datos de Telegram inválidos');
  return parsed.data;
}

async function telegram<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof TelegramApiError && error.rejectedToken) {
      throw new BadRequestException('Telegram rechazó el token. Revisa el token activo en BotFather.');
    }
    throw new ServiceUnavailableException('No se pudo consultar Telegram. Intenta de nuevo.');
  }
}

async function readBot(token: string) {
  const bot = await telegram(() => callTelegram<{is_bot:boolean;id:number;username?:string}>(token,'getMe'));
  if (!bot?.is_bot || String(bot.id) !== telegramBotId(token) || !/^[\w]{5,32}$/.test(bot.username ?? '')) {
    throw new BadRequestException('Telegram no devolvió una identidad de bot válida');
  }
  return bot.username!;
}

async function readWebhook(token: string) {
  return telegram(() => callTelegram<{url:string;pending_update_count:number;last_error_date?:number}>(token,'getWebhookInfo'));
}

@Controller('api/v1/admin/telegram')
export class TelegramAdminController {
  constructor(@Inject(DATABASE) private readonly db: DataSource,
    @Inject(AUTH) private readonly auth: ReturnType<typeof createAuth>['auth']) {}

  private async viewer(req: Request) {
    const viewer = await getViewer(req,this.auth,this.db);
    if (!canManageAdministration(viewer)) throw new ForbiddenException();
    const origin = new URL(process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:0').origin;
    if (req.method === 'POST' && req.get('Origin') !== origin) throw new ForbiddenException('Origen inválido');
    return viewer;
  }

  private async settings(): Promise<TelegramAdminSettings> {
    const connection = await readTelegramConnection(this.db);
    return {
      source:connection.source, token_configured:!!connection.token, credentials_unreadable:connection.unreadable,
      username:connection.username ?? null, webhook_url:telegramWebhookTarget(),
      registered:connection.source === 'admin' && connection.registered && !!connection.token,
      contacts:await this.db.query('SELECT ref,display_name,chat_id,enabled FROM telegram_contact ORDER BY ref')
    };
  }

  @Get()
  @Header('Cache-Control','private, no-store')
  async get(@Req() req: Request) {
    await this.viewer(req);
    return this.settings();
  }

  @Post('token')
  @Header('Cache-Control','private, no-store')
  async saveToken(@Req() req: Request, @Body() body: unknown) {
    const viewer = await this.viewer(req);
    const { token } = parse(TokenInput,body);
    const username = await readBot(token);
    const target = telegramWebhookTarget();
    if (target) {
      const webhook = await readWebhook(token);
      if (webhook.url && webhook.url !== target) {
        throw new ConflictException('El bot tiene un webhook en otro destino. Usa un bot dedicado a este entorno.');
      }
    }
    await this.db.transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock($1)',[SettingsLock]);
      const current = await readTelegramConnection(tx);
      const sameBot = !!current.token && telegramBotId(current.token) === telegramBotId(token);
      const oldSecret = sameBot ? TelegramSecret.safeParse(current.secret) : null;
      const secret = oldSecret?.success ? oldSecret.data : randomBytes(32).toString('base64url');
      const registered = !!oldSecret?.success && (current.source === 'environment' || current.registered);
      const credentials = encryptTelegramCredentials({token,secret});
      await tx.query(`INSERT INTO telegram_settings (singleton,credentials,bot_username,registered)
        VALUES (true,$1,$2,$3) ON CONFLICT (singleton) DO UPDATE SET credentials=EXCLUDED.credentials,
        bot_username=EXCLUDED.bot_username,registered=EXCLUDED.registered`,[credentials,username,registered]);
      await audit(tx,null,'telegram_bot_configured',{operator_id:viewer.id,bot_username:username});
    });
    return this.settings();
  }

  @Post('check')
  @Header('Cache-Control','private, no-store')
  async check(@Req() req: Request) {
    await this.viewer(req);
    const { token } = await readTelegramConnection(this.db);
    if (!token) throw new BadRequestException('Guarda el token del bot para comprobar la conexión');
    const [username,webhook] = await Promise.all([readBot(token),readWebhook(token)]);
    const target = telegramWebhookTarget();
    return {
      username,
      webhook:webhook.url ? webhook.url === target ? 'expected' : 'other' : 'none',
      pending_updates:webhook.pending_update_count,
      last_error_at:webhook.last_error_date ? new Date(webhook.last_error_date*1000).toISOString() : null
    };
  }

  @Post('webhook')
  @Header('Cache-Control','private, no-store')
  async register(@Req() req: Request) {
    const viewer = await this.viewer(req);
    const target = telegramWebhookTarget();
    if (!target) throw new BadRequestException('Telegram requiere una URL pública HTTPS para recibir mensajes');
    await this.db.transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock($1)',[SettingsLock]);
      const { token,secret,source } = await readTelegramConnection(tx);
      if (!token || !TelegramSecret.safeParse(secret).success) {
        throw new BadRequestException('Guarda el token del bot antes de registrar el webhook');
      }
      const webhook = await readWebhook(token);
      if (webhook.url && webhook.url !== target) {
        throw new ConflictException('El bot tiene un webhook en otro destino. Usa un bot dedicado a este entorno.');
      }
      const registered = await telegram(() => callTelegram<boolean>(token,'setWebhook',{
        url:target, secret_token:secret, allowed_updates:['message','callback_query']
      }));
      if (!registered) throw new ServiceUnavailableException('Telegram no confirmó el registro del webhook');
      if (source === 'admin') await tx.query('UPDATE telegram_settings SET registered=true WHERE singleton');
      await audit(tx,null,'telegram_webhook_registered',{operator_id:viewer.id});
    });
    return this.settings();
  }

  @Post('contacts/:ref')
  @Header('Cache-Control','private, no-store')
  async contact(@Req() req: Request, @Param('ref') ref: string, @Body() body: unknown) {
    const viewer = await this.viewer(req);
    const input = parse(ContactInput,body);
    await this.db.transaction(async tx=>{
      const [current] = await tx.query('SELECT chat_id FROM telegram_contact WHERE ref=$1 FOR UPDATE',[ref]);
      if (!current) throw new NotFoundException('Contacto de Telegram desconocido');
      if (current.chat_id !== input.chat_id) {
        const [usage] = await tx.query(`SELECT EXISTS (
          SELECT 1 FROM attention_case c WHERE c.contact_ref=$1 AND c.snapshot->>'channel'='telegram'
            AND (c.snapshot->>'status'='open' OR EXISTS (
              SELECT 1 FROM outbox o WHERE o.case_id=c.id AND o.kind='deliver' AND o.status IN ('queued','processing')
            ))
        ) AS used`,[ref]);
        if (usage.used) throw new ConflictException('Cierra el caso de Telegram y espera los envíos pendientes antes de cambiar el chat ID');
      }
      try {
        await tx.query('UPDATE telegram_contact SET chat_id=$2, enabled=$3, managed_by_admin=true WHERE ref=$1',
          [ref,input.chat_id,input.enabled]);
      } catch (error) {
        if ((error as {code?:string}).code === '23505') throw new ConflictException('Este chat ID ya está asignado');
        throw error;
      }
      await audit(tx,null,'telegram_contact_configured',{operator_id:viewer.id,contact_ref:ref,enabled:input.enabled});
    });
    return this.settings();
  }
}
