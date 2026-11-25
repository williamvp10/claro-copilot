import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Inject,
  NotFoundException, Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { DataSource, EntityManager } from 'typeorm';
import { BillingPeriod, demoDiscountLimit, Id, OperationKey, RETENTION_POLICY_VERSION, type CaseDiscount,
  type DiscountTerms, type Message, type Viewer } from '@claro/contracts';
import { z } from 'zod';
import { AUTH, canManageAdministration, getViewer, type createAuth } from './auth.js';
import { checkCase, clearPersonalData, customerReference, isEscalationWaiting, loadCase, queueRun, saveCase } from './cases.js';
import { audit, DATABASE, enqueue, type CaseRow } from './database.js';
import { readInvoice } from './integration-operations.js';
import { SimulatorFailure, simulators } from './simulator-client.js';

const command = z.object({case_revision:z.number().int().positive(),idempotency_key:OperationKey});
const discountCommand=z.discriminatedUnion('action',[
  command.extend({action:z.literal('prepare'),service_id:Id,percentage:z.number().int().min(1).max(100),
    reason:z.string().trim().min(3).max(240)}).strict(),
  command.extend({action:z.literal('authorize')}).strict(),
  command.extend({action:z.literal('accept'),message_id:Id}).strict(),
  command.extend({action:z.literal('retry')}).strict()
]);

function parse<T>(schema:z.ZodType<T>, body:unknown):T {
  const result=schema.safeParse(body);
  if (!result.success) throw new BadRequestException('Revisa los datos de la oferta');
  return result.data;
}

function limit() {return demoDiscountLimit(process.env.DEMO_RETENTION_MAX_PERCENT);}

function authorizedAccount(viewer:Viewer,row:CaseRow) {
  checkCase(viewer,row,true);
  const ref=customerReference(row);
  if (!ref || row.snapshot.attention_mode!=='asistido') throw new ForbiddenException('Se requiere titularidad y atención asignada');
  return ref;
}

const normalize=(text:string)=>text.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().trim();
const units=['','un','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','diez','once','doce'];
const statedCycles=new RegExp(`\\b(\\d+|${units.slice(1).join('|')})\\s+(?:ciclos?|mes(?:es)?)\\b`,'g');
function offersTerms(text:string,terms:DiscountTerms) {
  const value=normalize(text);
  const percentages=[...value.matchAll(/(\d+)\s*(?:%|por ciento)/g)].map(match=>Number(match[1]));
  const duration=new RegExp(`\\b(?:${terms.cycles}|${units[terms.cycles]})\\s+(?:ciclos|meses)\\b`);
  return percentages.length>0 && percentages.every(x=>x===terms.percentage) && duration.test(value) &&
    value.includes(normalize(terms.plan)) && /\bcargo fijo\b/.test(value) &&
    !/\b(?:no puedo|no podemos|no te ofrezco|solicitar|a revision|sujeto a aprobacion)\b/.test(value);
}

export function discountAcceptance(messages:Message[],discount:CaseDiscount,messageId:string) {
  const conversation=messages.filter(message=>!message.attention_notice && !message.verification_input);
  const accepted=conversation.findLast(message=>message.actor==='cliente');
  const authorizedTurn=discount.authorized_turn ?? 0;
  if (!accepted || accepted.id!==messageId || accepted.turn_seq<=authorizedTurn) return null;
  const text=normalize(accepted.text);
  const affirmative=/^[¡!]*(?:si|claro que si|de acuerdo)[.!\s]*$/.test(text) ||
    /^[¡!]*(?:(?:si|listo)[,.!\s]+)?(?:acepto|lo tomo|estoy de acuerdo|me quedo con (?:el descuento|la oferta|el beneficio|es[eo]|esa))\b/.test(text);
  if (!affirmative || /\b(?:no|pero|aunque|otr[oa]|quisiera|prefiero|si me|acepto si|solo si|siempre que)\b|[¿?]/.test(text)) return null;
  const percentages=[...text.matchAll(/(\d+)\s*(?:%|por ciento)/g)].map(match=>Number(match[1]));
  const cycles=[...text.matchAll(statedCycles)].map(([,count])=>units.includes(count) ? units.indexOf(count) : Number(count));
  if (percentages.some(value=>value!==discount.terms.percentage) || cycles.some(value=>value!==discount.terms.cycles)) return null;
  if (/\b(?:mejora|cancelar el servicio|dar de baja)\b/.test(text)) return null;
  const reference=`politica de retencion y descuentos · ${normalize(discount.terms.policy_version)}`;
  const prior=conversation.findLast(message=>message.actor!=='cliente' && message.turn_seq<accepted.turn_seq &&
    normalize(message.text).replace(/^fuente:\s*/,'').replace(/\.$/,'')!==reference);
  return prior?.actor==='asesor' && prior.turn_seq>authorizedTurn && offersTerms(prior.text,discount.terms) ? accepted : null;
}

async function external<T>(action:()=>Promise<T>) {
  try {return await action();}
  catch (error) {
    if (!(error instanceof SimulatorFailure)) throw error;
    if (error.status===404) throw new NotFoundException('El proveedor no tiene el registro requerido');
    if (error.status===409) throw new ConflictException('Cambió el servicio, el ciclo o la elegibilidad. Actualiza la ficha.');
    throw new ServiceUnavailableException('El proveedor está temporalmente indisponible. Puedes reintentar.');
  }
}

async function latestStandardOffer(tx:EntityManager,row:CaseRow) {
  if (row.snapshot.retention_discount?.crm_ref) return row.snapshot.retention_discount.crm_ref;
  const [prior]=await tx.query(`SELECT reference FROM integration_operation WHERE case_id=$1 AND status='confirmed'
    AND action->>'kind'='offer' AND action->>'codigo'='RET-A' ORDER BY created_at DESC LIMIT 1`,[row.id]);
  return prior?.reference as string|undefined;
}

function expandable(discount?:CaseDiscount) {
  return !discount || ['requested','authorized','scheduled'].includes(discount.status);
}

@Controller('api/v1/cases/:caseId/retention-discount')
export class RetentionDiscountController {
  constructor(@Inject(DATABASE) private readonly db:DataSource,
    @Inject(AUTH) private readonly auth:ReturnType<typeof createAuth>['auth']) {}

  private async viewer(req:Request) {
    if (process.env.DEMO_MODE!=='true') throw new ForbiddenException();
    if (req.method==='POST' && req.get('Origin')!==new URL(process.env.BETTER_AUTH_URL!).origin) {
      throw new ForbiddenException('Origen inválido');
    }
    return getViewer(req,this.auth,this.db);
  }

  @Get()
  @Header('Cache-Control','private, no-store')
  async status(@Req() req:Request,@Param('caseId') id:string) {
    const viewer=await this.viewer(req);
    const row=await loadCase(this.db.manager,parse(Id,id));
    const ref=authorizedAccount(viewer,row);
    const discount=row.snapshot.retention_discount;
    const previous=await latestStandardOffer(this.db.manager,row);
    const [schedule,eligibility]=await Promise.all([
      discount?.status==='scheduled' && discount.crm_ref ? simulators.discountStatus(ref,discount.crm_ref).catch(()=>null) : null,
      expandable(discount) && (!previous || canManageAdministration(viewer))
        ? simulators.eligibility(ref,previous).catch(()=>null) : null
    ]);
    return {discount, schedule, standard:eligibility?.options.find(option=>option.codigo==='RET-A')?.discount ?? null,
      maximum:limit(), amendment:!!previous, can_authorize:canManageAdministration(viewer)};
  }

  @Post()
  async update(@Req() req:Request,@Param('caseId') id:string,@Body() raw:unknown) {
    const viewer=await this.viewer(req), input=parse(discountCommand,raw);
    const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.db.transaction(async tx=>{
      const row=await loadCase(tx,parse(Id,id),true);
      const ref=authorizedAccount(viewer,row);
      const scope=`retention-discount:${id}:${viewer.id}`;
      const [replay]=await tx.query('SELECT fingerprint FROM idempotency WHERE scope=$1 AND key=$2',[scope,input.idempotency_key]);
      if (replay) {
        if (replay.fingerprint!==fingerprint) throw new ConflictException('Clave reutilizada');
        return row.snapshot.retention_discount;
      }
      if (row.snapshot.status!=='open' || row.snapshot.revision!==input.case_revision || await isEscalationWaiting(tx,id)) {
        throw new ConflictException('Actualiza el caso antes de continuar');
      }
      const admin=canManageAdministration(viewer);
      const turn=row.snapshot.messages.at(-1)?.turn_seq ?? 0;
      let discount=row.snapshot.retention_discount;
      if (input.action==='prepare') {
        if (!expandable(discount)) throw new ConflictException('El beneficio está en sincronización');
        const previous=await latestStandardOffer(tx,row);
        if (previous && !admin) throw new ForbiddenException('Administración debe revisar la oferta anterior');
        if (previous && discount?.crm_ref && discount.terms.service_id!==input.service_id) {
          throw new ConflictException('La enmienda debe conservar el servicio de la oferta');
        }
        const [eligible,services]=await external(()=>Promise.all([simulators.eligibility(ref,previous),simulators.services(ref)]));
        const standard=eligible.options.find(option=>option.codigo==='RET-A')?.discount;
        const service=services.find(item=>item.servicio_id===input.service_id && item.estado==='activo');
        if (!standard || !service || service.valor_mensual<=0 || input.percentage<standard.percentage || input.percentage>limit()) {
          throw new ConflictException('La oferta excede la elegibilidad vigente o el tope de política');
        }
        const authorized=admin || input.percentage===standard.percentage;
        discount={id:randomUUID(),terms:{service_id:service.servicio_id,plan:service.plan,base:service.valor_mensual,
          percentage:input.percentage,cycles:standard.cycles,policy_version:RETENTION_POLICY_VERSION},
          requested_by:viewer.id,status:authorized?'authorized':'requested',previous_offer:previous,
          ...(authorized ? {authorized_turn:turn,approval_id:viewer.id} : {})};
        await audit(tx,id,'retention_discount_prepared',{operator_id:viewer.id,offer_id:discount.id,
          status:discount.status,terms:discount.terms,reason:clearPersonalData(input.reason)});
      } else {
        if (!discount) throw new NotFoundException('Prepara primero el beneficio');
        if (input.action==='authorize') {
          if (!admin) throw new ForbiddenException('La excepción requiere Administración');
          if (discount.status!=='requested' || discount.terms.percentage>limit()) throw new ConflictException('La solicitud cambió');
          const [eligibility,services]=await external(()=>Promise.all([simulators.eligibility(ref,discount?.previous_offer),simulators.services(ref)]));
          const standard=eligibility.options.find(option=>option.codigo==='RET-A')?.discount;
          const service=services.find(item=>item.servicio_id===discount!.terms.service_id && item.estado==='activo');
          if (!standard || standard.cycles!==discount.terms.cycles || discount.terms.percentage<standard.percentage ||
              service?.plan!==discount.terms.plan || service.valor_mensual!==discount.terms.base) {
            throw new ConflictException('Cambió la elegibilidad o el cargo del servicio');
          }
          discount={...discount,status:'authorized',authorized_turn:turn,approval_id:viewer.id};
          await audit(tx,id,'retention_discount_authorized',{operator_id:viewer.id,offer_id:discount.id});
        } else if (input.action==='accept') {
          if (discount.status!=='authorized' || !discountAcceptance(row.snapshot.messages,discount,input.message_id)) {
            throw new ConflictException('Confirma un sí del cliente a la oferta vigente enviada en el chat');
          }
          discount={...discount,status:'accepted',accepted_message_id:input.message_id};
          await audit(tx,id,'retention_discount_accepted',{operator_id:viewer.id,offer_id:discount.id,message_id:input.message_id});
          await enqueue(tx,`retention:${discount.id}`,id,'retention',{discount_id:discount.id});
        } else {
          if (!['accepted','crm_confirmed'].includes(discount.status)) throw new ConflictException('La oferta no requiere sincronización');
          await tx.query(`UPDATE outbox SET status='queued',available_at=now(),attempts=0,error_code=NULL
            WHERE id=$1 AND (status IN ('done','failed','queued') OR lease_until<=now())`,[`retention:${discount.id}`]);
          discount={...discount,error:null};
        }
      }
      row.snapshot.retention_discount=discount;
      row.snapshot.revision++;
      await tx.query('INSERT INTO idempotency VALUES ($1,$2,$3,$4)',[scope,input.idempotency_key,fingerprint,id]);
      await queueRun(tx,row);
      await saveCase(tx,row);
      return discount;
    });
  }

  @Post('issue')
  async issue(@Req() req:Request,@Param('caseId') id:string,@Body() raw:unknown) {
    const viewer=await this.viewer(req);
    if (!canManageAdministration(viewer)) throw new ForbiddenException();
    const {period}=parse(z.object({period:BillingPeriod}).strict(),raw);
    return this.db.transaction(async tx=>{
      const row=await loadCase(tx,parse(Id,id),true);
      const ref=authorizedAccount(viewer,row);
      const discount=row.snapshot.retention_discount;
      if (discount?.status!=='scheduled' || !discount.crm_ref || await isEscalationWaiting(tx,id)) {
        throw new ConflictException('Primero confirma la programación del descuento');
      }
      if (!discount.schedule || period<discount.schedule.start_period) {
        throw new ConflictException('El ciclo precede a la programación');
      }
      const result=await external(()=>simulators.issueCycle(ref,period,`cycle:${ref}:${period}`));
      const invoice=await readInvoice(ref,result.factura_id,'Factura no encontrada');
      const [event]=await tx.query("SELECT id FROM attention_event WHERE case_id=$1 AND kind='retention_invoice_issued' AND metadata->>'invoice'=$2",[id,result.factura_id]);
      if (!event) {
        await audit(tx,id,'retention_invoice_issued',{operator_id:viewer.id,invoice:result.factura_id,period});
        row.snapshot.retention_discount={...discount,schedule:await external(()=>simulators.discountStatus(ref,discount.crm_ref!))};
        row.snapshot.revision++;
        if (row.snapshot.status==='open') await queueRun(tx,row);
        await saveCase(tx,row);
      }
      return invoice;
    });
  }
}

export async function synchronizeDiscount(db:DataSource,id:string,discountId:string) {
  for (const step of ['accepted','crm_confirmed'] as const) {
    const retry=await db.transaction(async tx=>{
      const row=await loadCase(tx,id,true);
      const discount=row.snapshot.retention_discount;
      const ref=customerReference(row);
      if (!ref || discount?.id!==discountId || discount.status!==step) return null;
      try {
        if (step==='accepted') {
          const receipt=await simulators.confirmDiscount(ref,{terms:discount.terms,
            approval_id:discount.approval_id!,acceptance_id:discount.accepted_message_id!,previous_offer:discount.previous_offer},
          `retention-crm:${discount.id}`);
          row.snapshot.retention_discount={...discount,status:'crm_confirmed',crm_ref:receipt.oferta_id,error:null};
        } else {
          const schedule=await simulators.scheduleDiscount(ref,{terms:discount.terms,offer_ref:discount.crm_ref!},
            `retention-billing:${discount.id}`);
          row.snapshot.retention_discount={...discount,status:'scheduled',schedule,error:null};
        }
      } catch (error) {
        if (!(error instanceof SimulatorFailure)) throw error;
        const terminal=error.status>=400 && error.status<500 && ![408,429].includes(error.status);
        if (discount.error!==error.code) {
          row.snapshot.retention_discount={...discount,error:error.code};
          await saveCase(tx,row);
        }
        return terminal ? null : error;
      }
      await audit(tx,id,step==='accepted'?'retention_discount_crm_confirmed':'retention_discount_scheduled',{offer_id:discount.id});
      row.snapshot.revision++;
      if (row.snapshot.status==='open') await queueRun(tx,row);
      await saveCase(tx,row);
      return null;
    });
    if (retry) throw retry;
  }
}
