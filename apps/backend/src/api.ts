import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpException, Inject, Module, Param, Post,
  Req, Res, ServiceUnavailableException, UnauthorizedException, type DynamicModule
} from '@nestjs/common';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { type DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { CloseCase, DecideProposal, OpenCase, SendMessage, Text, VerifyHolder, Id, type CaseEvent, type WebChatEvent, type Dashboard, type Viewer } from '@claro/contracts';
import { AUTH, getViewer, type createAuth } from './auth.js';
import { Cases, constantEqual } from './cases.js';
import { createDatabase, DATABASE } from './database.js';
import { readModelMetrics } from './telemetry.js';

const Webhook = z.object({
  update_id: z.number().int().nonnegative(),
  message: z.object({
    chat: z.object({ id: z.number().int().safe(), type: z.string() }),
    text: Text.optional()
  }).optional(),
  callback_query: z.object({
    id: Id, data: z.string().max(64).optional(),
    message: z.object({chat:z.object({id:z.number().int().safe(),type:z.string()})}).optional()
  }).optional()
});
const Synthetic = z.object({ contact_ref: Id, text: Text, idempotency_key: Id });
const Prompts = z.object({ prompts: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), Text) })
  .refine(({ prompts }) => Object.keys(prompts).length <= 15);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Solicitud inválida');
  return result.data;
}

async function streamSnapshots<T extends { cursor: number }>(
  req: Request, res: Response, refresh: () => Promise<T>, payload: (snapshot: T) => CaseEvent | WebChatEvent
) {
    const snapshot = await refresh();
    const rawCursor = req.get('Last-Event-ID') ?? String(req.query.cursor ?? 0);
    const cursorValue = /^\d+$/.test(rawCursor) ? Number(rawCursor) : 0;
    let cursor = Number.isSafeInteger(cursorValue) ? Math.min(cursorValue, snapshot.cursor) : 0;
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive'
    });
    res.flushHeaders();
    res.write(': ready\n\n');
    const write = (next: typeof snapshot) => {
      if (next.cursor <= cursor) return;
      const event = payload(next);
      cursor = next.cursor;
      if (!res.write(`id: ${cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) res.end();
    };
    write(snapshot);
    let active = true;
    let timer: NodeJS.Timeout;
    let beats = 0;
    const poll = async () => {
      try {
        if (!active || res.writableEnded) return;
        write(await refresh());
        if (++beats % 15 === 0) res.write(': heartbeat\n\n');
        if (active && !res.writableEnded) timer = setTimeout(() => void poll(), 1000);
      } catch {
        res.end();
      }
    };
    res.once('close', () => { active = false; clearTimeout(timer); });
    timer = setTimeout(() => void poll(), 1000);
}

const CHAT_COOKIE = 'claro_web_chat';

function chatToken(req: Request) {
  return req.headers.cookie?.split(';').map(pair => pair.trim()).find(pair => pair.startsWith(`${CHAT_COOKIE}=`))?.slice(CHAT_COOKIE.length + 1);
}

@Controller('api/v1/web-chat')
class WebChatController {
  private readonly streams = new Map<string, number>();
  constructor(private readonly cases: Cases) {}

  private origin(req: Request) {
    if (req.get('Origin') !== new URL(process.env.BETTER_AUTH_URL!).origin) throw new ForbiddenException('Origen inválido');
  }

  @Post('session')
  async start(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.origin(req);
    res.setHeader('Cache-Control', 'no-store');
    const { token, snapshot } = await this.cases.startWeb(chatToken(req));
    if (token) res.cookie(CHAT_COOKIE, token, {
      httpOnly: true, sameSite: 'strict', secure: process.env.BETTER_AUTH_URL?.startsWith('https:'),
      path: '/api/v1/web-chat', maxAge: 24 * 60 * 60 * 1000
    });
    return snapshot;
  }

  @Get('history')
  history(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.cases.viewWeb(chatToken(req));
  }

  @Post('messages')
  async message(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() data: unknown) {
    this.origin(req);
    res.setHeader('Cache-Control', 'no-store');
    return this.cases.sendWeb(chatToken(req), parse(SendMessage, data));
  }

  @Get('events')
  async events(@Req() req: Request, @Res() res: Response) {
    const token = chatToken(req);
    await this.cases.viewWeb(token);
    const key = token!;
    const count = this.streams.get(key) ?? 0;
    if (count >= 2) throw new HttpException('Ya hay dos ventanas del chat abiertas', 429);
    this.streams.set(key, count + 1);
    const release = () => {
      const remaining = (this.streams.get(key) ?? 1) - 1;
      if (remaining) this.streams.set(key, remaining);
      else this.streams.delete(key);
    };
    res.once('close', release);
    try {
      await streamSnapshots(req, res, () => this.cases.viewWeb(token),
        next => ({ type: 'conversation.updated', snapshot: next }));
    } catch (error) {
      res.off('close', release);
      release();
      throw error;
    }
  }
}

type Auth = ReturnType<typeof createAuth>['auth'];

@Controller()
class HealthController {
  constructor(@Inject(DATABASE) private readonly db: DataSource) {}

  @Get('healthz')
  live() { return { status: 'ok' }; }

  @Get('metrics')
  async metrics(@Res() res: Response) {
    const events = ['opened','closed','handoff','agent_completed','agent_stale','job_failed','ml_predicted','ml_unavailable','retention_confirmed','support_ticket_confirmed','telegram_failed'] as const;
    const totals: {kind:string; n:string}[] = await this.db.query('SELECT kind,count(*) AS n FROM attention_event WHERE kind=ANY($1) GROUP BY kind', [events]);
    const values = new Map(totals.map(row => [row.kind,row.n]));
    const lines = events.map(kind => `claro_event_total{kind="${kind}"} ${values.get(kind) ?? 0}`);
    res.type('text/plain; version=0.0.4').send(['# TYPE claro_event_total counter', ...lines, ''].join('\n'));
  }

  @Get('readyz')
  async ready() {
    try {
      await this.db.query('SELECT revision FROM prompt_revision WHERE activated');
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}

@Controller('api/v1')
class PlatformController {
  constructor(private readonly cases: Cases, @Inject(DATABASE) private readonly db: DataSource, @Inject(AUTH) private readonly auth: Auth) {}

  private async viewer(req: Request) {
    if (!['GET', 'HEAD'].includes(req.method) && req.get('Origin') !== new URL(process.env.BETTER_AUTH_URL!).origin) {
      throw new ForbiddenException('Origen inválido');
    }
    return getViewer(req, this.auth, this.db);
  }

  private async admin(req: Request): Promise<Viewer> {
    const viewer = await this.viewer(req);
    if (viewer.role !== 'admin') throw new ForbiddenException();
    return viewer;
  }

  @Get('me')
  me(@Req() req: Request) { return this.viewer(req); }

  @Get('contacts')
  async contacts(@Req() req: Request) { return this.cases.contacts(await this.viewer(req)); }

  @Get('cases')
  async list(@Req() req: Request) { return this.cases.list(await this.viewer(req)); }

  @Post('cases')
  async open(@Req() req: Request, @Body() data: unknown) {
    return this.cases.open(await this.viewer(req), parse(OpenCase, data));
  }

  @Get('cases/:id')
  async read(@Req() req: Request, @Param('id') id: string) {
    return this.cases.get(await this.viewer(req), parse(Id, id));
  }

  @Post('cases/:id/take')
  async take(@Req() req: Request, @Param('id') id: string) {
    return this.cases.take(await this.viewer(req), parse(Id, id));
  }

  @Post('cases/:id/verify-holder')
  async verify(@Req() req: Request, @Param('id') id: string, @Body() data: unknown) {
    return this.cases.verify(await this.viewer(req), parse(Id, id), parse(VerifyHolder, data).verification_code);
  }

  @Post('cases/:id/messages')
  async send(@Req() req: Request, @Param('id') id: string, @Body() data: unknown) {
    return this.cases.send(await this.viewer(req), parse(Id, id), parse(SendMessage, data));
  }

  @Post('cases/:id/close')
  async close(@Req() req: Request, @Param('id') id: string, @Body() data: unknown) {
    return this.cases.close(await this.viewer(req), parse(Id, id), parse(CloseCase, data).resolved);
  }

  @Post('proposals/:id/decision')
  async decide(@Req() req: Request, @Param('id') id: string, @Body() data: unknown) {
    return this.cases.decide(await this.viewer(req), parse(Id, id), parse(DecideProposal, data));
  }

  @Get('cases/:id/events')
  async events(@Req() req: Request, @Res() res: Response, @Param('id') rawId: string) {
    const id = parse(Id, rawId);
    return streamSnapshots(req, res, () => this.viewer(req).then(viewer => this.cases.get(viewer, id)),
      next => ({ type: 'case.updated', cursor: next.cursor, snapshot: next }));
  }

  @Post('webhooks/telegram')
  async webhook(@Req() req: Request, @Body() body: unknown) {
    const configured = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!configured || !constantEqual(req.get('X-Telegram-Bot-Api-Secret-Token') ?? '', configured)) throw new UnauthorizedException();
    const { update_id, message, callback_query } = parse(Webhook, body);
    if (message?.chat.type === 'private' && message.text && !message.text.startsWith('/')) {
      await this.cases.receiveTelegram({ update_id, chat_id: String(message.chat.id), text: message.text });
    }
    const rating = /^csat:([a-f0-9-]{36}):([1-5])$/.exec(callback_query?.data ?? '');
    if (rating && callback_query?.message?.chat.type === 'private') {
      await this.cases.recordFeedback(rating[1], String(callback_query.message.chat.id), Number(rating[2]));
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (token) {
        await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({callback_query_id:callback_query.id}), signal:AbortSignal.timeout(750)
        }).catch(() => undefined);
      }
    }
    return { ok: true };
  }

  @Post('demo/incoming')
  async synthetic(@Req() req: Request, @Body() body: unknown) {
    const key = process.env.DEMO_INGRESS_TOKEN;
    if (!key || !constantEqual(req.get('Authorization') ?? '', `Bearer ${key}`)) throw new UnauthorizedException();
    const { contact_ref, text, idempotency_key } = parse(Synthetic, body);
    await this.cases.receiveSynthetic(contact_ref, text, idempotency_key);
    return { ok: true };
  }

  @Get('admin/dashboard')
  async dashboard(@Req() req: Request): Promise<Dashboard> {
    await this.admin(req);
    const [ml, [{ p95 }]] = await Promise.all([readModelMetrics(), this.db.query(`SELECT
      percentile_cont(.95) WITHIN GROUP (ORDER BY (metadata->>'ms')::numeric)::float AS p95 FROM attention_event
      WHERE kind='agent_latency' AND created_at > now()-interval '7 days'`)]);
    const [{ revision }] = await this.db.query('SELECT revision FROM prompt_revision WHERE activated');
    const [{ total, resolved, aht }] = await this.db.query(`SELECT count(*)::integer AS total,
      count(*) FILTER(WHERE resolved)::integer AS resolved,
      avg(extract(epoch FROM ((snapshot->>'updated_at')::timestamptz-created_at))) FILTER(WHERE resolved IS NOT NULL) AS aht
      FROM attention_case WHERE created_at > now() - interval '7 days'`);
    const [{ surveys, satisfied }] = await this.db.query(`SELECT count(*)::integer AS surveys,
      count(*) FILTER(WHERE score>=4)::integer AS satisfied
      FROM case_feedback WHERE created_at > now()-interval '7 days'`);
    const [{ attempts, generation_cost }] = await this.db.query(`SELECT count(*)::integer AS attempts,
      sum((metadata->>'cost_usd')::double precision) AS generation_cost FROM attention_event
      WHERE kind='generation.openai' AND metadata ? 'cost_usd' AND created_at > now()-interval '7 days'`);
    const [quality] = await this.db.query(`SELECT report->'review'->'metrics' AS metrics FROM prompt_evaluation
      WHERE candidate_revision=$1 AND report->>'gate'='passed'`, [revision]);
    const events: { kind: string; count: number }[] = await this.db.query(`SELECT kind,count(*)::integer FROM attention_event
      WHERE created_at > now() - interval '7 days' GROUP BY kind`);
    const counts = new Map(events.map(({ kind, count }) => [kind, count]));
    const count = (kind: string) => counts.get(kind) ?? 0;
    return {
      window_days: 7, sample: process.env.DEMO_MODE === 'true' ? 'synthetic' : 'pilot', revision,
      providers: [
        { name: 'Worker', status: count('agent_completed') > 0 ? 'observed' : 'waiting' },
        { name: 'Telegram', status: process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'simulation' },
        { name: 'Langfuse', status: count('langfuse_exported') ? 'observed' : process.env.LANGFUSE_PUBLIC_KEY ? 'configured' : 'unconfigured' },
        { name: 'ML en sombra', status: ml?.groups.length ? ml.groups.map(group => `${group.model_version} · ${group.drift?.status ?? 'sin referencia'}`).join(', ') : count('ml_predicted') > 0 ? 'observed' : 'waiting' }
      ],
      metrics: [
        { id: 'cases', label: 'Conversaciones', value: total, unit: 'casos' },
        { id: 'aht', label: 'Duración media de atención', value: aht === null ? null : Number(aht), unit: 's' },
        { id: 'resolved', label: 'Resolución reportada', value: total ? resolved * 100 / total : null, unit: '%', denominator: total },
        { id: 'handoff', label: 'Derivaciones', value: count('handoff'), unit: 'casos' },
        { id: 'retention', label: 'Ofertas confirmadas', value: count('retention_confirmed'), unit: 'ofertas' },
        { id: 'agent', label: 'Ejecuciones completadas', value: count('agent_completed'), unit: 'turnos' },
        { id: 'discarded', label: 'Salidas obsoletas descartadas', value: count('agent_stale'), unit: 'turnos' },
        { id: 'agent_errors', label: 'Errores de ejecución', value: count('job_failed'), unit: 'eventos' },
        { id: 'ml', label: 'Predicciones en sombra', value: count('ml_predicted'), unit: 'turnos' },
        { id: 'agent_p95', label: 'Latencia del worker p95', value: p95, unit: 'ms' },
        { id: 'ml_f1', label: 'F1 macro agrupado de ML', value: ml?.offline?.metrics.macro_f1 ?? null, unit: 'F1' },
        { id: 'ml_recall', label: 'Recall de cancelación de ML', value: ml?.offline?.metrics.cancelacion_recall ?? null, unit: 'recall' },
        { id: 'ml_labels', label: 'Etiquetas supervisadas', value: ml ? ml.groups.reduce((n, group) => n + group.labels_count, 0) : null, unit: 'casos' },
        { id: 'ml_errors', label: 'Fallos de inferencia en sombra', value: count('ml_unavailable'), unit: 'turnos' },
        { id: 'csat', label: 'CSAT (4 o 5)', value: surveys ? satisfied * 100 / surveys : null, unit: '%', denominator: surveys },
        { id: 'generation_cost', label: 'Costo medido de generación pública', value: generation_cost, unit: 'USD', denominator: attempts },
        { id: 'groundedness', label: 'Groundedness de la revisión activa', value: quality?.metrics?.groundedness ?? null, unit: 'proporción' },
        { id: 'recall', label: 'Recall@5 de la revisión activa', value: quality?.metrics?.recall_at_5 ?? null, unit: 'proporción' }
      ]
    };
  }

  @Get('admin/prompts')
  async prompts(@Req() req: Request) {
    await this.admin(req);
    return this.db.query('SELECT revision,status,prompts FROM prompt_revision ORDER BY created_at DESC LIMIT 50');
  }

  @Post('admin/prompts')
  async candidate(@Req() req: Request, @Body() body: unknown) {
    await this.admin(req);
    const { prompts } = parse(Prompts, body);
    const [candidate] = await this.db.query(`INSERT INTO prompt_revision(revision,base_revision,prompts,status)
      SELECT $1,revision,$2,'candidate' FROM prompt_revision WHERE activated RETURNING revision,status,prompts`, [randomUUID(), prompts]);
    return candidate;
  }

  @Post('admin/prompts/:revision/eval')
  async evaluate(@Req() req: Request, @Param('revision') revision: string) {
    await this.admin(req);
    const [[candidate]] = await this.db.query(`UPDATE prompt_revision AS p SET status=CASE
      WHEN EXISTS (SELECT 1 FROM prompt_evaluation e WHERE e.candidate_revision=p.revision
        AND e.base_revision=p.base_revision AND e.report->>'gate'='passed') THEN 'passed' ELSE 'failed' END
      WHERE p.revision=$1 AND NOT p.activated AND p.status IN ('candidate','failed','passed')
      RETURNING p.revision,p.status,p.prompts`, [parse(Id, revision)]);
    if (!candidate) throw new BadRequestException('Revisión candidata no disponible');
    return { ...candidate, reason: candidate.status === 'passed' ? 'Evidencia de evaluación aprobada' : 'Evidencia de evaluación semántica independiente requerida' };
  }

  @Post('admin/prompts/:revision/activate')
  async activate(@Req() req: Request, @Param('revision') revision: string) {
    await this.admin(req);
    return this.db.transaction(async (db) => {
      const [active] = await db.query('SELECT revision FROM prompt_revision WHERE activated FOR UPDATE');
      const [target] = await db.query(`SELECT revision FROM prompt_revision
        WHERE revision=$1 AND status='passed' AND base_revision=$2 FOR UPDATE`, [parse(Id, revision), active?.revision]);
      const [evidence] = target ? await db.query(`SELECT candidate_revision FROM prompt_evaluation
        WHERE candidate_revision=$1 AND base_revision=$2 AND report->>'gate'='passed' FOR UPDATE`, [target.revision, active.revision]) : [];
      if (!evidence) throw new ForbiddenException('Se requiere evaluación aprobada para la revisión activa');
      await db.query("UPDATE prompt_revision SET activated=false,status='passed' WHERE activated");
      const [[updated]] = await db.query(`UPDATE prompt_revision SET activated=true,status='active' WHERE revision=$1 RETURNING revision,status,prompts`, [target.revision]);
      return updated;
    });
  }
}

@Module({})
export class ApiModule {
  static create(auth: Auth): DynamicModule {
    return {
      module: ApiModule, controllers: [PlatformController, HealthController, WebChatController],
      providers: [Cases, { provide: AUTH, useValue: auth }, { provide: DATABASE, useFactory: () => createDatabase().initialize() }]
    };
  }
}
