import { AgentModelAdminController } from './agent-model-admin.js';
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpException, Inject, Module, Param, Post, Query,
  Req, Res, ServiceUnavailableException, UnauthorizedException, type DynamicModule
} from '@nestjs/common';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { type DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { CloseCase, DecideProposal, OpenCase, SendMessage, Text, VerifyHolder, WebVerificationStart, WebVerificationConfirm, Id, ConfirmIntegration, InvoiceId, OperationKey, DashboardFilters, type CaseEvent, type WebChatEvent, type Dashboard, type EvalJob, type EvalStatus, type Viewer } from '@claro/contracts';
import { AUTH, canReadMockBilling, getViewer, type createAuth } from './auth.js';
import { Cases, constantEqual } from './cases.js';
import { createDatabase, DATABASE } from './database.js';
import { readDashboard, projectComparison } from './dashboard.js';
import { readLangfuseEvaluations } from './langfuse-evaluations.js';
import { MetricFilters, MetricGroup, ReleaseEvidence, readMetricGroup } from './metrics.js';
import { lockPromptReleases, PromptReleases } from './prompt-releases.js';
import { adjudicatePromptRevision, PromptAdjudication } from './prompt-adjudication.js';
import { PlatformEvolutionController } from './platform-evolution.js';
import { IntegrationOperations } from './integration-operations.js';
import { observeSimulators, simulators } from './simulator-client.js';
import { KnowledgeAdminController, KnowledgeSourceController } from './knowledge-admin.js';

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
const Synthetic = z.object({ contact_ref: Id, text: Text, idempotency_key: Id, channel: z.literal('whatsapp').optional() });
const PromptKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const Prompts = z.object({ prompts: z.record(PromptKey, z.string().min(1).max(4000)) })
  .refine(({ prompts }) => Object.keys(prompts).length > 0 && Object.keys(prompts).length <= 13);
const DraftEvent = z.object({run_id:Id,case_revision:z.number().int().positive(),event_id:Id,
  kind:z.enum(['used','edited','feedback_positive','feedback_negative'])});
const PromptImport = z.object({ key: PromptKey, version: z.number().int().positive().safe() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Solicitud inválida');
  return result.data;
}

async function streamSnapshots<T extends { cursor: number }>(
  req: Request, res: Response, refresh: () => Promise<T>, payload: (snapshot: T) => CaseEvent | WebChatEvent,
  onAccessLost?: () => void
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
      } catch (error) {
        if (error instanceof HttpException && [401,403,404].includes(error.getStatus())) onAccessLost?.();
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
    return this.startSession(req,res);
  }

  @Post('session/new')
  async startNew(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.startSession(req,res,true);
  }

  private async startSession(req: Request,res: Response,fresh = false) {
    this.origin(req);
    res.setHeader('Cache-Control', 'no-store');
    const { token, snapshot } = await this.cases.startWeb(chatToken(req),fresh);
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

  @Post('verification/start')
  startVerification(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() data: unknown) {
    this.origin(req);
    res.setHeader('Cache-Control', 'no-store');
    return this.cases.startWebVerification(chatToken(req), parse(WebVerificationStart, data).identifier);
  }

  @Post('verification/confirm')
  confirmVerification(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() data: unknown) {
    this.origin(req);
    res.setHeader('Cache-Control', 'no-store');
    const { challenge_id } = parse(WebVerificationConfirm, data);
    // The six-digit shape is the only code check in the synthetic demo.
    return this.cases.confirmWebVerification(chatToken(req), challenge_id);
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
  constructor(private readonly cases: Cases, private readonly integrations: IntegrationOperations, private readonly promptReleases: PromptReleases, @Inject(DATABASE) private readonly db: DataSource, @Inject(AUTH) private readonly auth: Auth) {}

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
  async me(@Req() req: Request): Promise<Viewer> {
    const viewer = await this.viewer(req);
    return { ...viewer, can_read_mock_billing: canReadMockBilling(viewer),
      can_register_case_customer:process.env.DEMO_MODE==='true' && !!viewer.capabilities?.some(value=>['n1','n2','supervisor'].includes(value)) };
  }

  @Get('contacts')
  async contacts(@Req() req: Request) { return this.cases.contacts(await this.viewer(req)); }

  @Get('cases')
  async list(@Req() req: Request,@Query('view') view?:string) {
    const viewer=await this.viewer(req);
    return view==='inbox' ? this.cases.inbox(viewer) : this.cases.list(viewer);
  }

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
    return this.cases.close(await this.viewer(req), parse(Id, id), parse(CloseCase, data));
  }

  @Get('cases/:id/integrations/crm')
  async crm(@Req() req: Request,@Param('id') id: string) {
    return this.integrations.crm(await this.viewer(req),parse(Id,id));
  }

  @Get('cases/:id/integrations/billing')
  async billing(@Req() req: Request,@Param('id') id: string) {
    return this.integrations.billing(await this.viewer(req),parse(Id,id));
  }

  @Get('cases/:id/integrations/billing/invoices/:ref')
  async invoice(@Req() req: Request,@Param('id') id: string,@Param('ref') ref: string) {
    return this.integrations.invoice(await this.viewer(req),parse(Id,id),parse(InvoiceId,ref));
  }

  @Get('cases/:id/integrations/operations')
  async operations(@Req() req: Request,@Param('id') id: string) {
    return this.integrations.list(await this.viewer(req),parse(Id,id));
  }

  @Post('cases/:id/integrations/operations')
  async integrationOperation(@Req() req: Request,@Param('id') id: string,@Body() body: unknown) {
    return this.integrations.confirm(await this.viewer(req),parse(Id,id),parse(ConfirmIntegration,body));
  }

  @Get('admin/integrations')
  async integrationHealth(@Req() req: Request) {
    await this.admin(req);
    return simulators.health(this.db);
  }

  @Get('admin/integrations/approvals')
  async integrationApprovals(@Req() req: Request) {
    return this.integrations.approvals(await this.viewer(req));
  }

  @Post('admin/integrations/approvals/:id')
  async integrationApproval(@Req() req: Request,@Param('id') id: string,@Body() body: unknown) {
    return this.integrations.decision(await this.viewer(req),parse(OperationKey,id),parse(z.object({approved:z.boolean()}),body).approved);
  }

  @Post('proposals/:id/decision')
  async decide(@Req() req: Request, @Param('id') id: string, @Body() data: unknown) {
    return this.cases.decide(await this.viewer(req), parse(Id, id), parse(DecideProposal, data));
  }

  @Get('cases/:id/events')
  async events(@Req() req: Request, @Res() res: Response, @Param('id') rawId: string) {
    const id = parse(Id, rawId);
    return streamSnapshots(req, res, () => this.viewer(req).then(viewer => this.cases.get(viewer, id)),
      next => ({ type: 'case.updated', cursor: next.cursor, snapshot: next }),
      () => res.write('event: case.access_lost\ndata: {}\n\n'));
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
    const { contact_ref, text, idempotency_key, channel } = parse(Synthetic, body);
    await this.cases.receiveSynthetic(contact_ref, text, idempotency_key, channel);
    return { ok: true };
  }

  @Get('admin/dashboard')
  async dashboard(@Req() req: Request,@Query() query: unknown): Promise<Dashboard> {
    await this.admin(req);
    return readDashboard(this.db,parse(DashboardFilters,query));
  }

  @Get('admin/metrics/:group')
  async metricGroup(@Req() req: Request, @Param('group') group: string, @Query() query: unknown) {
    await this.admin(req);
    return readMetricGroup(this.db, parse(MetricGroup, group), parse(MetricFilters, query));
  }

  @Get('admin/evaluations/langfuse')
  async langfuseEvaluations(@Req() req: Request, @Query('experiment') experiment?: string) {
    await this.admin(req);
    if (experiment !== undefined) parse(z.uuid(), experiment);
    try {
      return await readLangfuseEvaluations(experiment);
    } catch {
      throw new ServiceUnavailableException('No se pudieron consultar las evaluaciones en Langfuse.');
    }
  }

  @Post('admin/releases/evidence')
  async releaseEvidence(@Req() req: Request, @Body() body: unknown) {
    const viewer = await this.admin(req);
    const evidence = parse(ReleaseEvidence, body);
    const [saved] = await this.db.query(`INSERT INTO release_metric(digest,component,sha,evidence,operator_id)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(digest,component,sha) DO UPDATE SET
        evidence=excluded.evidence,operator_id=excluded.operator_id,observed_at=now()
      RETURNING observed_at`, [evidence.digest,evidence.component,evidence.sha,evidence,viewer.id]);
    return {accepted:true, observed_at:saved.observed_at};
  }

  @Post('cases/:id/draft-events')
  async draftEvent(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.cases.recordDraftEvent(await this.viewer(req),parse(Id,id),parse(DraftEvent,body));
  }

  @Get('admin/prompts')
  async prompts(@Req() req: Request) {
    await this.admin(req);
    return this.promptReleases.list();
  }

  @Post('admin/prompts')
  async candidate(@Req() req: Request, @Body() body: unknown) {
    const viewer = await this.admin(req);
    return this.promptReleases.edit(viewer.id, parse(Prompts, body).prompts);
  }

  @Post('admin/prompts/import')
  async importPrompt(@Req() req: Request, @Body() body: unknown) {
    const viewer = await this.admin(req);
    const { key, version } = parse(PromptImport, body);
    return this.promptReleases.import(viewer.id, key, version);
  }

  @Post('admin/prompts/:revision/eval')
  async evaluate(@Req() req: Request,@Param('revision') revision: string): Promise<EvalJob> {
    await this.admin(req);
    if (process.env.PROMPT_EVAL_ENABLED !== 'true') {
      throw new ServiceUnavailableException('El worker de evaluaciones está deshabilitado para este entorno');
    }
    return this.db.transaction(async db => {
      const id = parse(Id,revision);
      await lockPromptReleases(db);
      const [active] = await db.query('SELECT revision FROM prompt_revision WHERE activated FOR SHARE');
      const [candidate] = await db.query('SELECT revision,base_revision,activated FROM prompt_revision WHERE revision=$1 FOR UPDATE',[id]);
      if (!candidate || candidate.activated || candidate.base_revision !== active?.revision) {
        throw new BadRequestException('La candidata debe provenir de la revisión activa');
      }
      const [pending] = await db.query(`SELECT id,revision,status,completed_cases,total_cases FROM prompt_eval_job
        WHERE revision=$1 AND status IN ('queued','running')`,[id]);
      if (pending) return pending;
      const [job] = await db.query(`INSERT INTO prompt_eval_job(id,revision,status) VALUES ($1,$2,'queued')
        RETURNING id,revision,status,completed_cases,total_cases`,[randomUUID(),id]);
      await db.query("UPDATE prompt_revision SET status='candidate' WHERE revision=$1",[id]);
      return job;
    });
  }

  @Get('admin/prompts/:revision/eval')
  async evaluation(@Req() req: Request,@Param('revision') revision: string): Promise<EvalStatus> {
    await this.admin(req);
    const id = parse(Id,revision);
    const [[job],[report]] = await Promise.all([
      this.db.query(`SELECT id,revision,status,completed_cases,total_cases,failure_code FROM prompt_eval_job
        WHERE revision=$1 ORDER BY created_at DESC LIMIT 1`,[id]),
      this.db.query('SELECT report FROM prompt_evaluation WHERE candidate_revision=$1',[id])
    ]);
    return {job:job ?? null,report:job && job.status!=='completed' ? null : projectComparison(report?.report)};
  }

  @Post('admin/prompts/:revision/review')
  async review(@Req() req: Request, @Param('revision') revision: string, @Body() body: unknown) {
    const viewer = await this.admin(req);
    return adjudicatePromptRevision(this.db,parse(Id,revision),parse(PromptAdjudication,body),viewer.id);
  }

  @Post('admin/prompts/:revision/activate')
  async activate(@Req() req: Request, @Param('revision') revision: string) {
    const viewer = await this.admin(req);
    return this.promptReleases.activate(viewer.id, parse(Id, revision));
  }

  @Post('admin/prompts/:revision/rollback')
  async rollback(@Req() req: Request, @Param('revision') revision: string) {
    const viewer = await this.admin(req);
    return this.promptReleases.activate(viewer.id, parse(Id, revision), true);
  }
}

@Module({})
export class ApiModule {
  static create(auth: Auth): DynamicModule {
    return {
      module: ApiModule, controllers: [PlatformController, PlatformEvolutionController, HealthController, WebChatController, KnowledgeAdminController, KnowledgeSourceController, AgentModelAdminController],
      providers: [Cases, IntegrationOperations, PromptReleases, { provide: AUTH, useValue: auth }, {
        provide: DATABASE,
        async useFactory() {
          const db = await createDatabase().initialize();
          observeSimulators(db);
          return db;
        }
      }]
    };
  }
}
