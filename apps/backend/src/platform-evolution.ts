import { Body, ConflictException, Controller, ForbiddenException, Get, Header, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res, UnauthorizedException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import type { DataSource, EntityManager } from 'typeorm';
import { assistedHistory, assistedWriting, requestedAdvisor, TurnModels, type AgentObservation } from '@claro/agent';
import { CustomerId, EscalationDestination, escalationDestinations, InvoiceId, type Viewer } from '@claro/contracts';
import { AUTH, canReadMockBilling, getViewer, type createAuth } from './auth.js';
import { audit, DATABASE, enqueue, type CaseRow } from './database.js';
import { attentionNotice, checkCase, clearPersonalData, customerReference, isEscalationWaiting, loadCase, queueRun, saveCase } from './cases.js';
import { readBilling, readInvoice } from './integration-operations.js';
import { privateSignals, queueChurn } from './ml-advisory.js';
import { SimulatorFailure, simulators } from './simulator-client.js';
import { activeAgentModels, loadAgentModelPolicy } from './agent-model-storage.js';
import { agentProviders } from './agent-providers.js';
import { readRunPromptConfig, runPromptDigest } from './prompt-catalog.js';
import { exportAgentSpan } from './telemetry.js';

type Auth = ReturnType<typeof createAuth>['auth'];
const id = z.string().trim().min(1).max(128);
const operationKey = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);
const reason = z.string().trim().min(3).max(120).regex(/^[\p{L}\p{N}_ .-]+$/u);
const destination = EscalationDestination;
const requestEscalation = z.object({destination,reason_code:reason.optional(),reason_text:z.string().trim().min(3).max(500).optional(),
  case_revision:z.number().int().positive(),idempotency_key:id}).refine(input=>!!(input.reason_text || input.reason_code));
const transition = z.object({case_revision:z.number().int().positive()});
const reassignment = transition.extend({operator_id:id,reason});
const customerIdentity=z.object({tipo_documento:z.enum(['CC','CE','NIT','PAS']),numero_documento:z.string().trim().min(1).max(64)});
const customerDetails=customerIdentity.extend({cliente_id:CustomerId,nombre:z.string().trim().min(1).max(100),
  celular:z.string().trim().min(3).max(32),email:z.email().max(254),motivo:reason,idempotency_key:operationKey});
const caseRegistration=z.discriminatedUnion('action',[
  transition.extend({action:z.literal('lookup'),...customerIdentity.shape}),
  transition.extend({action:z.literal('link'),...customerIdentity.shape,idempotency_key:operationKey}),
  transition.extend({action:z.literal('create'),...customerDetails.shape})
]);
const capabilities = z.array(z.enum(['n1','n2','supervisor','admin','superadmin'])).max(5);
const specialties = z.array(destination.exclude(['supervision'])).max(3);
const operatorFields = z.object({capabilities,specialties,enabled:z.boolean(),available:z.boolean()});
const operatorCreate = operatorFields.extend({name:z.string().trim().min(1).max(100),email:z.email().max(254),password:z.string().min(12).max(128)});
async function provider<T>(operation:()=>Promise<T>):Promise<T> { try { return await operation(); } catch (error) { if (!(error instanceof SimulatorFailure)) throw error; if (error.status===404) throw new NotFoundException(); if (error.status===409) throw new ConflictException('El registro cambió o la clave ya se utilizó'); throw new ServiceUnavailableException('CRM mock no disponible'); } }
const parse = <T>(schema:z.ZodType<T>, input:unknown):T => { const value=schema.safeParse(input); if (!value.success) throw new BadRequestException('Solicitud inválida'); return value.data; };
const has = (viewer:Viewer, capability:string) => viewer.capabilities?.includes(capability) ?? false;
const demoReceiver = (viewer:Viewer) => process.env.DEMO_MODE==='true' && has(viewer,'admin') && has(viewer,'supervisor');
export const queueAllowed = (viewer:Viewer, dest:string) => demoReceiver(viewer) ||
  (dest==='supervision' ? has(viewer,'supervisor') : has(viewer,'n2') && !!viewer.specialties?.includes(dest));

@Controller('api/v1')
export class PlatformEvolutionController {
  constructor(@Inject(DATABASE) private readonly db:DataSource, @Inject(AUTH) private readonly auth:Auth) {}
  private async viewer(req:Request) {
    if (!['GET','HEAD'].includes(req.method) && req.get('Origin') !== new URL(process.env.BETTER_AUTH_URL!).origin) throw new ForbiddenException('Origen inválido');
    return getViewer(req,this.auth,this.db);
  }
  private async superadmin(req:Request) { const v=await this.viewer(req); if (!has(v,'superadmin')) throw new ForbiddenException(); return v; }

  private async confirmCaseOperator(tx:EntityManager,v:Viewer,caseId:string) {
    const row=await loadCase(tx,caseId,true);
    checkCase(v,row,true);
    const [operator]=await tx.query('SELECT enabled,capabilities FROM operator_role WHERE user_id=$1 FOR SHARE',[v.id]);
    if (!operator?.enabled || !(operator.capabilities as string[]).some(value=>['n1','n2','supervisor'].includes(value))) {
      throw new ForbiddenException('Se requiere una asignación de atención vigente');
    }
    return row;
  }

  @Post('cases/:caseId/customer-registration')
  async caseCustomer(@Req() req:Request,@Param('caseId') caseId:string,@Body() raw:unknown) {
    const v=await this.viewer(req), input=parse(caseRegistration,raw);
    if (process.env.DEMO_MODE!=='true') throw new ForbiddenException();
    return this.db.transaction(async tx=>{
      const row=await this.confirmCaseOperator(tx,v,parse(id,caseId));
      const scope=`case-customer:${caseId}:${v.id}`;
      const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
      if (input.action!=='lookup') {
        const [prior]=await tx.query('SELECT fingerprint FROM idempotency WHERE scope=$1 AND key=$2',[scope,input.idempotency_key]);
        if (prior) {
          if (prior.fingerprint!==fingerprint) throw new ConflictException('Clave reutilizada');
          return {status:'registered',registration:row.snapshot.customer_registration};
        }
      }
      if (row.snapshot.status!=='open' || row.snapshot.revision!==input.case_revision || row.snapshot.verified ||
          row.snapshot.customer_registration || row.account_ref) throw new ConflictException('El caso cambió o ya tiene un cliente vinculado');
      const match=await provider(async()=>{
        try { return await simulators.identity(input.tipo_documento,input.numero_documento); }
        catch (error) { if (error instanceof SimulatorFailure && error.status===404) return null; throw error; }
      });
      if (input.action==='lookup') return {status:match ? 'existing' : 'missing'};
      if (input.action==='link' && !match) throw new NotFoundException('El registro ya no está disponible');
      if (input.action==='create' && match && match.cliente_id!==input.cliente_id) {
        throw new ConflictException('El cliente ya existe. Busca su documento para vincularlo.');
      }
      let registration;
      if (input.action==='create') {
        const {action:_action,case_revision:_revision,idempotency_key,...body}=input;
        const key=`case-customer:${createHash('sha256').update(`${scope}:${idempotency_key}`).digest('hex')}`;
        const result=await provider(()=>simulators.customerCommand(null,body,key));
        registration={customer_ref:result.cliente_id,revision:result.revision};
      } else {
        const result=await provider(()=>simulators.directoryCustomer(match!.cliente_id));
        registration={customer_ref:match!.cliente_id,revision:result.revision};
      }
      row.snapshot.customer_registration=registration;
      row.snapshot.revision++;
      await tx.query('INSERT INTO idempotency VALUES ($1,$2,$3,$4)',[scope,input.idempotency_key,fingerprint,caseId]);
      await audit(tx,caseId,input.action==='create' ? 'customer_created' : 'customer_linked',
        {operator_id:v.id,customer_ref:registration.customer_ref,verification:'pending'});
      if (!await isEscalationWaiting(tx,caseId)) await queueRun(tx,row);
      await saveCase(tx,row);
      return {status:'registered',registration};
    });
  }

  @Get('escalations')
  async escalations(@Req() req:Request) {
    const v=await this.viewer(req);
    const destinations=destination.options.filter(dest=>queueAllowed(v,dest));
    const rows:({case_open:boolean;status:string;destination:string}&Record<string,unknown>)[]=await this.db.query(`SELECT e.id,e.case_id,e.destination,e.reason_code,e.status,e.requested_by,e.owner_id,e.created_at,e.updated_at,
      (c.snapshot->>'revision')::int AS case_revision, c.snapshot->>'status'='open' AS case_open FROM escalation e JOIN attention_case c ON c.id=e.case_id
      WHERE e.requested_by=$1 OR e.owner_id=$1 OR (e.status='en_cola' AND e.destination=ANY($3))
      OR ($4 AND e.status='en_cola')
      OR ($2 AND e.status='en_cola' AND NOT EXISTS (SELECT 1 FROM operator_role o WHERE o.enabled AND o.available AND 'n2'=ANY(o.capabilities) AND e.destination=ANY(o.specialties)))
      ORDER BY CASE WHEN e.status='en_cola' THEN 0 WHEN e.status='tomado' THEN 1 ELSE 2 END,e.created_at,e.id LIMIT 100`,
      [v.id,has(v,'supervisor'),destinations,has(v,'superadmin')]);
    return rows.map(({case_open,...row})=>({...row,can_claim:case_open && row.status==='en_cola' && !!v.available && queueAllowed(v,row.destination)}));
  }
  @Post('cases/:caseId/escalations/suggestion')
  async suggestEscalation(@Req() req:Request,@Param('caseId') caseId:string,@Body() raw:unknown) {
    const viewer=await this.viewer(req), input=parse(transition.extend({destination}),raw);
    const read=async()=>this.db.transaction(async tx=>{
      const row=await this.confirmCaseOperator(tx,viewer,parse(id,caseId));
      if (row.snapshot.status!=='open' || row.snapshot.revision!==input.case_revision || await isEscalationWaiting(tx,caseId)) {
        throw new ConflictException('El caso cambió. Revisa su estado.');
      }
      return row;
    });
    const row=await read();
    const history=assistedHistory(row.snapshot.messages).map(message=>({...message,text:clearPersonalData(message.text)}));
    const [revision]=await this.db.query('SELECT revision FROM prompt_revision WHERE activated');
    const [model,prompts]=await Promise.all([activeAgentModels(this.db),readRunPromptConfig(this.db,revision.revision,false,true)]);
    const policy=await loadAgentModelPolicy(this.db,model.revision,model.digest);
    const observations:AgentObservation[]=[];
    const started=Date.now(),run_id=randomUUID();
    const models=new TurnModels(policy,agentProviders().modelCredentials ?? {},model.revision,started+4500,span=>observations.push(span));
    const suggested=await assistedWriting(models,'escalation_reason',prompts.prompts.escalation_reason ?? '',
      row.snapshot.verified ? 'intermedio' : 'economico',history,{
        destination:escalationDestinations[input.destination],
        summary:clearPersonalData(row.snapshot.card?.summary ?? ''),pending:row.snapshot.card?.pending.map(clearPersonalData)
      });
    const latest=await read();
    const stale=latest.snapshot.messages.at(-1)?.id!==row.snapshot.messages.at(-1)?.id;
    const customerReports=history.filter(message=>message.actor==='cliente' && !requestedAdvisor(message.text));
    const evidence=customerReports.slice(-2);
    const fromHistory=evidence.length ? {
      text:`El cliente informó ${evidence.map(item=>`«${item.text.slice(0,165)}»`).join(' y ')}. Se solicita a ${escalationDestinations[input.destination]} revisar el caso.`,
      references:evidence.map(item=>item.id)
    } : null;
    const draft=suggested ?? fromHistory;
    const source=suggested ? 'ia' : fromHistory ? 'historial' : undefined;
    const status=stale ? 'stale' : draft ? 'suggested' : 'unavailable';
    observations.push({name:'advisor.escalation_reason',started,ended:Date.now(),metadata:{step_id:'draft_escalation_reason',
      agent_id:'copiloto',prompt_ref:'escalation_reason',status,source:source ?? 'none'}});
    await exportAgentSpan({run_id,conversation_id:row.snapshot.conversation_id,channel:row.snapshot.channel,audience:'asesor',
      config_revision:revision.revision, model_config_revision:model.revision,model_config_digest:model.digest,
      prompt_manifest_digest:runPromptDigest(prompts)},started,'escalation_reason',status,observations,prompts.prompt_metadata,
      row.web_visitor_ref ?? row.contact_ref);
    if (stale) throw new ConflictException('Llegó un mensaje nuevo. Puedes volver a sugerir el motivo.');
    return {status,suggestion:draft,source,destination:input.destination,case_revision:input.case_revision};
  }
  @Post('cases/:caseId/escalations')
  async request(@Req() req:Request,@Param('caseId') caseId:string,@Body() raw:unknown) {
    const v=await this.viewer(req), input=parse(requestEscalation,raw); parse(id,caseId);
    const reasonCode=input.reason_code ?? 'manual';
    return this.db.transaction(async tx=>{
      const row=await loadCase(tx,caseId,true); checkCase(v,row,true);
      const [prior]=await tx.query('SELECT * FROM escalation WHERE requested_by=$1 AND idempotency_key=$2',[v.id,input.idempotency_key]);
      if (prior) {
        if (prior.case_id!==caseId || prior.destination!==input.destination || prior.reason_code!==reasonCode ||
            prior.reason_text!==(input.reason_text ?? null) || prior.request_revision!==input.case_revision) throw new ConflictException('Clave reutilizada');
        return {id:prior.id,destination:prior.destination,status:prior.status,case_revision:row.snapshot.revision};
      }
      if (row.snapshot.status!=='open' || row.snapshot.revision!==input.case_revision) throw new ConflictException('El caso cambió');
      const [active]=await tx.query("SELECT id,status FROM escalation WHERE case_id=$1 AND status IN ('en_cola','tomado') FOR UPDATE",[caseId]);
      if (active && active.status==='tomado' && input.destination==='supervision') {
        await tx.query("UPDATE escalation SET status='resuelto',updated_at=now() WHERE id=$1",[active.id]);
        await audit(tx,caseId,'escalation_forwarded',{operator_id:v.id});
      } else if (active) throw new ConflictException('Ya hay un escalamiento activo');
      const [created]=await tx.query(`INSERT INTO escalation(id,case_id,destination,reason_code,status,requested_by,idempotency_key,request_revision,reason_text)
        VALUES($1,$2,$3,$4,'en_cola',$5,$6,$7,$8) RETURNING id,case_id,destination,reason_code,status,requested_by,owner_id,created_at,updated_at`,
        [randomUUID(),caseId,input.destination,reasonCode,v.id,input.idempotency_key,input.case_revision,input.reason_text ?? null]);
      row.snapshot.revision++;
      await audit(tx,caseId,'escalation_requested',{escalation_id:created.id,destination:input.destination,reason_code:clearPersonalData(reasonCode),operator_id:v.id});
      await attentionNotice(tx,row,'escalated',created.id,{destination:input.destination});
      await saveCase(tx,row);
      return {...created,case_revision:row.snapshot.revision};
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
        row.snapshot.owner_id=v.id;
      } else if (action==='cancel') {
        if (esc.status!=='en_cola' || (esc.requested_by!==v.id && !has(v,'supervisor'))) throw new ForbiddenException();
      } else if (action==='resolve') {
        if (esc.status!=='tomado' || row.snapshot.owner_id!==v.id) throw new ForbiddenException();
      } else {
        if (!has(v,'supervisor') && !has(v,'superadmin')) throw new ForbiddenException();
        if (!['en_cola','tomado'].includes(esc.status)) throw new ConflictException();
        const [target]=await tx.query('SELECT * FROM operator_role WHERE user_id=$1',[input.operator_id]);
        if (!target?.enabled || !target.available || !target.capabilities.some((c:string)=>['n1','n2','supervisor'].includes(c))) throw new ConflictException('Operador no disponible');
        row.snapshot.owner_id=input.operator_id!;
      }
      const status=action==='cancel'?'cancelado':action==='resolve'?'resuelto':'tomado';
      const [updated]=await tx.query(`UPDATE escalation SET status=$2,owner_id=$3,updated_at=now() WHERE id=$1
        RETURNING id,case_id,destination,reason_code,status,requested_by,owner_id,created_at,updated_at`,[escId,status,action==='claim'?v.id:action==='reassign'?input.operator_id:esc.owner_id]);
      const [{id:eventId}]=await tx.query(`INSERT INTO attention_event(case_id,kind,metadata) VALUES ($1,$2,$3) RETURNING id`,
        [row.id,`escalation_${action}`,{escalation_id:escId,operator_id:v.id,destination:esc.destination,
          ...(input.reason ? {reason:clearPersonalData(input.reason)}:{}),...(input.operator_id ? {target_id:input.operator_id}:{})}]);
      row.snapshot.revision++;
      if (action==='cancel' || action==='claim' || action==='reassign') {
        const [owner]=await tx.query('SELECT name FROM "user" WHERE id=$1',[row.snapshot.owner_id]);
        const event=action==='cancel' ? 'escalation_cancelled' : 'escalation_taken';
        await attentionNotice(tx,row,event,action==='reassign' ? `${escId}:${eventId}` : escId,{advisor:owner?.name});
        if (action!=='cancel') await queueChurn(tx,row);
        await queueRun(tx,row);
      }
      await saveCase(tx,row);
      return {...updated,case_revision:row.snapshot.revision};
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
    if (has(v,'superadmin') || canReadMockBilling(v)) return provider(()=>simulators.directory(offset,limit,q));
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
    if (!admin && !canReadMockBilling(v) && !history.length) throw new NotFoundException();
    const customer=await provider(()=>simulators.directoryCustomer(ref));
    const mask=(value:string)=>value.length<4?'***':'***'+value.slice(-3);
    return {customer:{...customer,email:mask(customer.email),celular:mask(customer.celular)},eligibility:await provider(()=>simulators.eligibility(ref)),case_history:history};
  }
  private async authorizeBilling(req: Request) {
    if (!canReadMockBilling(await this.viewer(req))) throw new ForbiddenException();
  }

  @Get('crm/customers/:id/billing')
  @Header('Cache-Control', 'private, no-store')
  async customerBilling(@Req() req: Request, @Param('id') ref: string) {
    await this.authorizeBilling(req);
    return readBilling(parse(CustomerId, ref), 'Esta cuenta aún no tiene registro en Facturación.');
  }

  @Get('crm/customers/:id/billing/invoices/:ref')
  @Header('Cache-Control', 'private, no-store')
  async customerInvoice(@Req() req: Request, @Param('id') customer: string, @Param('ref') ref: string) {
    await this.authorizeBilling(req);
    const invoice = await readInvoice(parse(CustomerId, customer), parse(InvoiceId, ref), 'Factura no encontrada');
    return {
      ...invoice,
      ajustes: invoice.ajustes.map(({ ajuste_id, fecha, motivo, valor }) => ({ ajuste_id, fecha, motivo, valor }))
    };
  }

  @Post('admin/customers')
  async createCustomer(@Req() req:Request,@Body() raw:unknown) {
    const v=await this.superadmin(req);
    const input=parse(customerDetails,raw);
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
