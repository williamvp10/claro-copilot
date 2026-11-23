import { Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res, UnauthorizedException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import type { DataSource } from 'typeorm';
import type { Viewer } from '@claro/contracts';
import { AUTH, getViewer, type createAuth } from './auth.js';
import { audit, DATABASE, enqueue, type CaseRow } from './database.js';
import { checkCase, clearPersonalData, customerReference, loadCase, saveCase } from './cases.js';
import { privateSignals, queueChurn } from './ml-advisory.js';
import { SimulatorFailure, simulators } from './simulator-client.js';

type Auth = ReturnType<typeof createAuth>['auth'];
const id = z.string().trim().min(1).max(128);
const operationKey = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);
const reason = z.string().trim().min(3).max(120).regex(/^[\p{L}\p{N}_ .-]+$/u);
const destination = z.enum(['soporte_tecnico','facturacion','comercial_portabilidad','supervision']);
const requestEscalation = z.object({destination,reason_code:reason,case_revision:z.number().int().positive(),idempotency_key:id});
const transition = z.object({case_revision:z.number().int().positive()});
const reassignment = transition.extend({operator_id:id,reason});
const capabilities = z.array(z.enum(['n1','n2','supervisor','admin','superadmin'])).max(5);
const specialties = z.array(destination.exclude(['supervision'])).max(3);
const operatorFields = z.object({capabilities,specialties,enabled:z.boolean(),available:z.boolean()});
const operatorCreate = operatorFields.extend({name:z.string().trim().min(1).max(100),email:z.email().max(254),password:z.string().min(12).max(128)});
async function provider<T>(operation:()=>Promise<T>):Promise<T> { try { return await operation(); } catch (error) { if (!(error instanceof SimulatorFailure)) throw error; if (error.status===404) throw new NotFoundException(); if (error.status===409) throw new ConflictException('El registro cambió o la clave ya se utilizó'); throw new ServiceUnavailableException('CRM mock no disponible'); } }
const parse = <T>(schema:z.ZodType<T>, input:unknown):T => { const value=schema.safeParse(input); if (!value.success) throw new BadRequestException('Solicitud inválida'); return value.data; };
const has = (viewer:Viewer, capability:string) => viewer.capabilities?.includes(capability) ?? false;
export const queueAllowed = (viewer:Viewer, dest:string) => dest === 'supervision' ? has(viewer,'supervisor') : has(viewer,'n2') && !!viewer.specialties?.includes(dest);

@Controller('api/v1')
export class PlatformEvolutionController {
  constructor(@Inject(DATABASE) private readonly db:DataSource, @Inject(AUTH) private readonly auth:Auth) {}
  private async viewer(req:Request) {
    if (!['GET','HEAD'].includes(req.method) && req.get('Origin') !== new URL(process.env.BETTER_AUTH_URL!).origin) throw new ForbiddenException('Origen inválido');
    return getViewer(req,this.auth,this.db);
  }
  private async superadmin(req:Request) { const v=await this.viewer(req); if (!has(v,'superadmin')) throw new ForbiddenException(); return v; }

  @Get('escalations')
  async escalations(@Req() req:Request) {
    const v=await this.viewer(req);
    return this.db.query(`SELECT e.id,e.case_id,e.destination,e.reason_code,e.status,e.requested_by,e.owner_id,e.created_at,e.updated_at,(c.snapshot->>'revision')::int AS case_revision FROM escalation e JOIN attention_case c ON c.id=e.case_id
      WHERE e.requested_by=$1 OR e.owner_id=$1 OR (e.status='en_cola' AND (($2 AND e.destination='supervision') OR ($3 AND e.destination=ANY($4))))
      OR ($5 AND e.status='en_cola')
      OR ($2 AND e.status='en_cola' AND NOT EXISTS (SELECT 1 FROM operator_role o WHERE o.enabled AND o.available AND 'n2'=ANY(o.capabilities) AND e.destination=ANY(o.specialties)))
      ORDER BY e.created_at DESC LIMIT 100`,[v.id,has(v,'supervisor'),has(v,'n2'),v.specialties ?? [],has(v,'superadmin')]);
  }
  @Post('cases/:caseId/escalations')
  async request(@Req() req:Request,@Param('caseId') caseId:string,@Body() raw:unknown) {
    const v=await this.viewer(req), input=parse(requestEscalation,raw); parse(id,caseId);
    return this.db.transaction(async tx=>{
      const row=await loadCase(tx,caseId,true); checkCase(v,row,true);
      const [prior]=await tx.query('SELECT * FROM escalation WHERE requested_by=$1 AND idempotency_key=$2',[v.id,input.idempotency_key]);
      if (prior) { if (prior.case_id!==caseId || prior.destination!==input.destination || prior.reason_code!==input.reason_code || prior.request_revision!==input.case_revision) throw new ConflictException('Clave reutilizada'); return prior; }
      if (row.snapshot.status!=='open' || row.snapshot.revision!==input.case_revision) throw new ConflictException('El caso cambió');
      const [active]=await tx.query("SELECT id,status FROM escalation WHERE case_id=$1 AND status IN ('en_cola','tomado') FOR UPDATE",[caseId]);
      if (active && active.status==='tomado' && input.destination==='supervision') {
        await tx.query("UPDATE escalation SET status='resuelto',updated_at=now() WHERE id=$1",[active.id]);
        await audit(tx,caseId,'escalation_forwarded',{operator_id:v.id});
      } else if (active) throw new ConflictException('Ya hay un escalamiento activo');
      const [created]=await tx.query(`INSERT INTO escalation(id,case_id,destination,reason_code,status,requested_by,idempotency_key,request_revision)
        VALUES($1,$2,$3,$4,'en_cola',$5,$6,$7) RETURNING id,case_id,destination,reason_code,status,requested_by,owner_id,created_at,updated_at`,[randomUUID(),caseId,input.destination,input.reason_code,v.id,input.idempotency_key,input.case_revision]);
      await audit(tx,caseId,'escalation_requested',{destination:input.destination,reason_code:clearPersonalData(input.reason_code),operator_id:v.id});
      await saveCase(tx,row); return created;
    });
  }
  @Post('escalations/:id/claim')
  async claim(@Req() req:Request,@Param('id') escalationId:string,@Body() raw:unknown) { return this.move(req,escalationId,'claim',parse(transition,raw)); }
  @Post('escalations/:id/cancel')
  async cancel(@Req() req:Request,@Param('id') escalationId:string,@Body() raw:unknown) { return this.move(req,escalationId,'cancel',parse(transition,raw)); }
  @Post('escalations/:id/resolve')
  async resolve(@Req() req:Request,@Param('id') escalationId:string,@Body() raw:unknown) { return this.move(req,escalationId,'resolve',parse(transition,raw)); }
  @Post('escalations/:id/reassign')
  async reassign(@Req() req:Request,@Param('id') escalationId:string,@Body() raw:unknown) { return this.move(req,escalationId,'reassign',parse(reassignment,raw)); }
  private async move(req:Request,escId:string,action:'claim'|'cancel'|'resolve'|'reassign',input:{case_revision:number;operator_id?:string;reason?:string}) {
    const v=await this.viewer(req); parse(id,escId);
    return this.db.transaction(async tx=>{
      const [initial]=await tx.query('SELECT case_id FROM escalation WHERE id=$1',[escId]); if (!initial) throw new NotFoundException();
      const row=await loadCase(tx,initial.case_id,true);
      const [esc]=await tx.query('SELECT * FROM escalation WHERE id=$1 FOR UPDATE',[escId]);
      const [operator]=await tx.query('SELECT enabled,available,capabilities,specialties FROM operator_role WHERE user_id=$1 FOR SHARE',[v.id]);
      if (!operator?.enabled) throw new UnauthorizedException();
      v.capabilities=operator.capabilities; v.specialties=operator.specialties; v.available=operator.available;
      if (row.snapshot.status!=='open' || row.snapshot.revision!==input.case_revision) throw new ConflictException('El caso cambió');
      if (action==='claim') {
        if (esc.status!=='en_cola' || !v.available || !queueAllowed(v,esc.destination)) throw new ConflictException('Escalamiento no disponible');
        row.snapshot.owner_id=v.id; row.snapshot.revision++;
      } else if (action==='cancel') {
        if (esc.status!=='en_cola' || (esc.requested_by!==v.id && !has(v,'supervisor'))) throw new ForbiddenException();
      } else if (action==='resolve') {
        if (esc.status!=='tomado' || row.snapshot.owner_id!==v.id) throw new ForbiddenException();
      } else {
        if (!has(v,'supervisor') && !has(v,'superadmin')) throw new ForbiddenException();
        if (!['en_cola','tomado'].includes(esc.status)) throw new ConflictException();
        const [target]=await tx.query('SELECT * FROM operator_role WHERE user_id=$1',[input.operator_id]);
        if (!target?.enabled || !target.available || !target.capabilities.some((c:string)=>['n1','n2','supervisor'].includes(c))) throw new ConflictException('Operador no disponible');
        row.snapshot.owner_id=input.operator_id!; row.snapshot.revision++;
      }
      const status=action==='cancel'?'cancelado':action==='resolve'?'resuelto':'tomado';
      const [updated]=await tx.query(`UPDATE escalation SET status=$2,owner_id=$3,updated_at=now() WHERE id=$1
        RETURNING id,case_id,destination,reason_code,status,requested_by,owner_id,created_at,updated_at`,[escId,status,action==='claim'?v.id:action==='reassign'?input.operator_id:esc.owner_id]);
      await audit(tx,row.id,`escalation_${action}`,{operator_id:v.id,destination:esc.destination,...(input.reason ? {reason:clearPersonalData(input.reason)}:{}),...(input.operator_id ? {target_id:input.operator_id}:{})});
      if (action==='claim' || action==='reassign') await queueChurn(tx,row);
      await saveCase(tx,row); return updated;
    });
  }
  @Post('cases/:id/ml/intent-label')
  async labelIntent(@Req() req:Request,@Param('id') caseId:string,@Body() raw:unknown) {
    const v=await this.viewer(req), input=parse(z.object({prediction_id:id,label:z.enum(['soporte_tecnico','facturacion','consulta_planes','cancelacion','portabilidad']),event_id:operationKey}),raw);
    return this.db.transaction(async tx=>{
      const row=await loadCase(tx,parse(id,caseId),true); checkCase(v,row,true);
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('ml-feedback'),hashtext($1))",[input.event_id]);
      const [prior]=await tx.query('SELECT * FROM ml_feedback WHERE event_id=$1',[input.event_id]);
      if (prior) { if (prior.case_id!==caseId || prior.kind!=='intent' || prior.payload.prediction_id!==input.prediction_id || prior.payload.label!==input.label) throw new ConflictException('Evento reutilizado'); return {status:'queued',event_id:input.event_id}; }
      const signal=await privateSignals(tx,row);
      if (!signal.intent || signal.intent.prediction_id!==input.prediction_id) throw new ConflictException('La predicción ya no está vigente');
      if (signal.intent.feedback) throw new ConflictException('La intención ya fue registrada');
      await tx.query("INSERT INTO ml_feedback(event_id,case_id,kind,payload) VALUES($1,$2,'intent',$3)",[input.event_id,caseId,input]);
      await enqueue(tx,`ml-label:${input.event_id}`,caseId,'ml_label',{...input,advisor_id:v.id,case_revision:row.snapshot.revision,turn_id:signal.intent.turn_id});
      await audit(tx,caseId,'ml_intent_labeled',{prediction_id:input.prediction_id,label:input.label,corrected:input.label!==signal.intent.label,channel:row.snapshot.channel});
      await saveCase(tx,row);
      return {status:'queued',event_id:input.event_id};
    });
  }
  @Post('cases/:id/ml/follow-up')
  async followUp(@Req() req:Request,@Param('id') caseId:string,@Body() raw:unknown) {
    const v=await this.viewer(req);
    const command=z.object({case_revision:z.number().int().positive(),event_id:operationKey});
    const input=parse(z.discriminatedUnion('status',[
      command.extend({status:z.literal('agreed'),due_date:z.iso.date()}).strict(),
      command.extend({status:z.literal('completed')}).strict()
    ]),raw);
    return this.db.transaction(async tx=>{
      const row=await loadCase(tx,parse(id,caseId),true); checkCase(v,row,true);
      const ref=customerReference(row);
      if (!ref) throw new ForbiddenException('Se requiere titularidad verificada');
      const dueDate=input.status==='agreed'?input.due_date:null;
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('ml-feedback'),hashtext($1))",[input.event_id]);
      const [prior]=await tx.query('SELECT * FROM ml_feedback WHERE event_id=$1',[input.event_id]);
      if (prior) {
        if (prior.case_id!==caseId || prior.kind!=='follow_up' || prior.payload.customer_ref!==ref || prior.payload.status!==input.status ||
            prior.payload.due_date!==dueDate || prior.payload.case_revision!==input.case_revision) throw new ConflictException('Evento reutilizado');
        return {status:input.status,event_id:input.event_id};
      }
      if (row.snapshot.revision!==input.case_revision) throw new ConflictException('El caso cambió');
      const signal=await privateSignals(tx,row);
      if (input.status==='agreed') {
        if (signal.follow_up) throw new ConflictException('El seguimiento ya está registrado');
        if (signal.churn.status!=='available') throw new ConflictException('Se requiere una señal de seguimiento para esta cuenta');
        await tx.query(`INSERT INTO case_ml_follow_up(case_id,customer_ref,responsible_id,due_date,model_version,fecha_corte)
          VALUES($1,$2,$3,$4,$5,$6)`,[caseId,ref,v.id,input.due_date,signal.churn.model_version,signal.churn.fecha_corte]);
      } else {
        if (signal.follow_up?.status!=='agreed') throw new ConflictException('Se requiere un seguimiento acordado y pendiente');
        await tx.query('UPDATE case_ml_follow_up SET completed_at=now() WHERE case_id=$1 AND customer_ref=$2',[caseId,ref]);
      }
      await tx.query("INSERT INTO ml_feedback(event_id,case_id,kind,payload) VALUES($1,$2,'follow_up',$3)",
        [input.event_id,caseId,{...input,customer_ref:ref,due_date:dueDate,actor_id:v.id}]);
      await audit(tx,caseId,`ml_follow_up_${input.status}`,{channel:row.snapshot.channel});
      await saveCase(tx,row);
      return {status:input.status,event_id:input.event_id};
    });
  }
  @Post('cases/:id/review')
  async review(@Req() req:Request,@Param('id') caseId:string,@Body() raw:unknown) {
    const v=await this.viewer(req), input=parse(z.object({reason,scope:z.enum(['summary','full'])}),raw);
    if (!has(v,'supervisor')) throw new ForbiddenException();
    return this.db.transaction(async tx=>{
      const [operator]=await tx.query('SELECT enabled,capabilities FROM operator_role WHERE user_id=$1 FOR SHARE',[v.id]);
      if (!operator?.enabled || !operator.capabilities.includes('supervisor')) throw new ForbiddenException();
      const row=await loadCase(tx,parse(id,caseId),true);
      await audit(tx,row.id,'case_reviewed',{operator_id:v.id,reason:clearPersonalData(input.reason),scope:input.scope});
      if (input.scope==='full') return row.snapshot;
      const {messages:_messages,card:_card,last_message:_last,...summary}=row.snapshot;
      return summary;
    });
  }
  @Get('crm/customers')
  async customers(@Req() req:Request,@Query() query:unknown) {
    const v=await this.viewer(req);
    const {offset,limit,q}=parse(z.object({offset:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(100).default(25),q:z.string().trim().max(100).default('')}),query);
    if (has(v,'superadmin')) return provider(()=>simulators.directory(offset,limit,q));
    const rows:CaseRow[]=await this.db.query(`SELECT * FROM attention_case WHERE snapshot->>'owner_id'=$1 AND snapshot->>'verified'='true'`,[v.id]);
    const refs=[...new Set<string>(rows.map(customerReference).filter((ref):ref is string=>!!ref))];
    return refs.length ? provider(()=>simulators.directory(offset,limit,q,refs)) : [];
  }
  @Get('crm/customers/:id')
  async customer(@Req() req:Request,@Param('id') ref:string) {
    const v=await this.viewer(req); parse(z.string().regex(/^C-\d{4}$/),ref);
    const admin=has(v,'superadmin');
    const history=await this.db.query(`SELECT c.id AS case_id,c.snapshot->>'status' AS status,c.snapshot->>'updated_at' AS updated_at,
      COALESCE((SELECT jsonb_agg(o.reference ORDER BY o.created_at) FROM integration_operation o
      WHERE o.case_id=c.id AND o.status='confirmed' AND o.action->>'kind'='ticket' AND o.reference IS NOT NULL),'[]'::jsonb) AS ticket_refs
      FROM attention_case c WHERE c.snapshot->>'verified'='true'
      AND (c.account_ref=$1 OR c.contact_ref=$1 OR ($1='C-1001' AND c.contact_ref LIKE 'web-c1001:%'))
      AND ($2 OR c.snapshot->>'owner_id'=$3) ORDER BY c.created_at DESC LIMIT 100`,[ref,admin,v.id]);
    if (!admin && !history.length) throw new NotFoundException();
    const customer=await provider(()=>simulators.directoryCustomer(ref));
    const mask=(value:string)=>value.length<4?'***':'***'+value.slice(-3);
    return {customer:{...customer,email:mask(customer.email),celular:mask(customer.celular)},eligibility:await provider(()=>simulators.eligibility(ref)),case_history:history};
  }
  @Post('admin/customers')
  async createCustomer(@Req() req:Request,@Body() raw:unknown) {
    const v=await this.superadmin(req);
    const input=parse(z.object({cliente_id:z.string().regex(/^C-\d{4}$/),nombre:id,tipo_documento:z.enum(['CC','CE','NIT','PAS']),numero_documento:id,celular:id,email:z.email(),motivo:reason,idempotency_key:operationKey}),raw);
    const {idempotency_key,...body}=input;
    const receipt=await provider(()=>simulators.customerCommand(null,body,idempotency_key));
    await this.db.transaction(tx=>audit(tx,null,'customer_created',{operator_id:v.id,customer_ref:receipt.cliente_id,reason:clearPersonalData(input.motivo)}));
    return {...receipt,idempotency_key};
  }
  @Patch('admin/customers/:id')
  async updateCustomer(@Req() req:Request,@Param('id') ref:string,@Body() raw:unknown) {
    const v=await this.superadmin(req); parse(z.string().regex(/^C-\d{4}$/),ref);
    const input=parse(z.object({revision:z.number().int().positive(),motivo:reason,idempotency_key:operationKey,nombre:id.optional(),celular:id.optional(),email:z.email().optional(),estado:z.enum(['activo','suspendido','retirado']).optional()}),raw);
    const {idempotency_key,...body}=input;
    const receipt=await provider(()=>simulators.customerCommand(ref,body,idempotency_key));
    await this.db.transaction(tx=>audit(tx,null,'customer_updated',{operator_id:v.id,customer_ref:ref,reason:clearPersonalData(input.motivo)}));
    return {...receipt,idempotency_key};
  }
  @Get('admin/audit')
  async operatorAudit(@Req() req:Request) {
    await this.superadmin(req);
    return this.db.query(`SELECT id,case_id,kind,created_at,metadata FROM attention_event
      WHERE kind LIKE 'operator_%' OR kind LIKE 'customer_%' OR kind LIKE 'escalation_%' ORDER BY id DESC LIMIT 200`);
  }
  @Get('escalations/events')
  async escalationEvents(@Req() req:Request,@Res() res:Response) {
    await this.viewer(req);
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-store, no-transform','X-Accel-Buffering':'no',Connection:'keep-alive'});
    res.flushHeaders();
    let active=true, previous='';
    const send=async()=>{
      try { const rows=await this.escalations(req); const next=JSON.stringify(rows);
        if (next!==previous) { previous=next; res.write(`event: escalations.updated\ndata: ${next}\n\n`); }
      } catch { active=false; res.end(); }
      if (active) timer=setTimeout(()=>void send(),1000);
    };
    let timer:NodeJS.Timeout;
    res.once('close',()=>{active=false; clearTimeout(timer);});
    await send();
  }
  @Get('admin/operators')
  async operators(@Req() req:Request) { await this.superadmin(req); return this.db.query(`SELECT u.id,u.name,u.email,o.capabilities,o.specialties,o.enabled,o.available FROM operator_role o JOIN "user" u ON u.id=o.user_id ORDER BY u.name LIMIT 200`); }
  @Post('admin/operators')
  async createOperator(@Req() req:Request,@Body() raw:unknown) {
    const v=await this.superadmin(req), input=parse(operatorCreate,raw), userId=randomUUID();
    const password=await hashPassword(input.password);
    return this.db.transaction(async tx=>{
      await tx.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())`,[userId,input.name,input.email.toLowerCase()]);
      await tx.query(`INSERT INTO account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES($1,$2,'credential',$2,$3,now(),now())`,[randomUUID(),userId,password]);
      await tx.query(`INSERT INTO operator_role(user_id,role,capabilities,specialties,enabled,available) VALUES($1,$2,$3,$4,$5,$6)`,[userId,input.capabilities.includes('admin')?'admin':'asesor',input.capabilities,input.specialties,input.enabled,input.available]);
      await audit(tx,null,'operator_created',{operator_id:v.id,target_id:userId,capabilities:input.capabilities});
      return {id:userId,name:input.name,email:input.email,capabilities:input.capabilities,specialties:input.specialties,enabled:input.enabled,available:input.available};
    });
  }
  @Patch('admin/operators/:id')
  async updateOperator(@Req() req:Request,@Param('id') operatorId:string,@Body() raw:unknown) {
    const v=await this.superadmin(req), input=parse(operatorFields,raw); parse(id,operatorId);
    return this.db.transaction(async tx=>{
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('superadmin-management'))");
      const [current]=await tx.query('SELECT * FROM operator_role WHERE user_id=$1 FOR UPDATE',[operatorId]); if (!current) throw new NotFoundException();
      if (current.enabled && current.capabilities.includes('superadmin') && (!input.enabled || !input.capabilities.includes('superadmin'))) {
        const [{count}]=await tx.query("SELECT count(*)::int AS count FROM operator_role WHERE enabled AND 'superadmin'=ANY(capabilities)");
        if (count<=1) throw new ConflictException('Se requiere al menos un superadmin activo');
      }
      await tx.query('UPDATE operator_role SET role=$2,capabilities=$3,specialties=$4,enabled=$5,available=$6 WHERE user_id=$1',[operatorId,input.capabilities.includes('admin')?'admin':'asesor',input.capabilities,input.specialties,input.enabled,input.available]);
      await tx.query('DELETE FROM session WHERE "userId"=$1',[operatorId]);
      await audit(tx,null,'operator_updated',{operator_id:v.id,target_id:operatorId,capabilities:input.capabilities,enabled:input.enabled});
      return {id:operatorId,...input};
    });
  }
}
