import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { CaseMlSignals, Viewer } from '@claro/contracts';
import type { EntityManager } from 'typeorm';
import { canManageAdministration } from './auth.js';
import { customerReference } from './cases.js';
import { audit, type CaseRow } from './database.js';
import { privateSignals } from './ml-advisory.js';

export function bogotaDate(now=new Date()) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}

export function recommendedFollowUp(signal:CaseMlSignals['churn'], today=bogotaDate()) {
  if (signal.status!=='available') return null;
  const days={alta:1,media:3,habitual:7}[signal.priority];
  const date=new Date(today+'T00:00:00Z');
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}

export async function recordFollowUp(tx:EntityManager, row:CaseRow, viewer:Viewer,
  input:{status:'agreed'|'rescheduled'|'completed'|'cancelled';due_date?:string;event_id:string;case_revision:number}) {
  const ref=customerReference(row);
  if (!ref) throw new ForbiddenException('Se requiere titularidad verificada');
  const due=input.due_date ?? null;
  const demo=process.env.DEMO_MODE==='true';
  const [existing]=await tx.query('SELECT * FROM case_ml_follow_up WHERE case_id=$1 AND customer_ref=$2 FOR UPDATE',[row.id,ref]);
  const owner=row.snapshot.owner_id===viewer.id;
  if (!owner && !(demo && existing && (existing.responsible_id===viewer.id || canManageAdministration(viewer)))) throw new ForbiddenException();
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('ml-feedback'),hashtext($1))",[input.event_id]);
  const [prior]=await tx.query('SELECT * FROM ml_feedback WHERE event_id=$1',[input.event_id]);
  if (prior) {
    if (prior.case_id!==row.id || prior.kind!=='follow_up' || prior.payload.customer_ref!==ref || prior.payload.status!==input.status ||
        prior.payload.due_date!==due || prior.payload.case_revision!==input.case_revision || prior.payload.actor_id!==viewer.id) {
      throw new ConflictException('Evento reutilizado');
    }
    return false;
  }
  if (row.snapshot.revision!==input.case_revision) throw new ConflictException('El caso cambió');
  if (due && demo && due<bogotaDate()) throw new ConflictException('Selecciona una fecha de hoy en adelante');
  if (input.status==='agreed') {
    if (existing && !existing.cancelled_at) throw new ConflictException('El seguimiento ya está registrado');
    const signal=(await privateSignals(tx,row)).churn;
    if (signal.status!=='available' && !demo) throw new ConflictException('Se requiere una señal para esta cuenta');
    const provenance=signal.status==='available' ? [signal.model_version,signal.fecha_corte,signal.priority] : [null,null,'sin_prediccion'];
    await tx.query(`INSERT INTO case_ml_follow_up(case_id,customer_ref,responsible_id,due_date,model_version,fecha_corte,priority)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(case_id,customer_ref) DO UPDATE SET
      responsible_id=EXCLUDED.responsible_id,due_date=EXCLUDED.due_date,model_version=EXCLUDED.model_version,
      fecha_corte=EXCLUDED.fecha_corte,priority=EXCLUDED.priority,agreed_at=now(),cancelled_at=NULL,completed_at=NULL`,
      [row.id,ref,viewer.id,due,...provenance]);
  } else {
    if (!existing || existing.completed_at || existing.cancelled_at) throw new ConflictException('Se requiere un seguimiento programado');
    if (input.status==='rescheduled') {
      await tx.query('UPDATE case_ml_follow_up SET due_date=$3 WHERE case_id=$1 AND customer_ref=$2',[row.id,ref,due]);
    } else if (input.status==='completed') {
      await tx.query('UPDATE case_ml_follow_up SET completed_at=now() WHERE case_id=$1 AND customer_ref=$2',[row.id,ref]);
    } else {
      await tx.query('UPDATE case_ml_follow_up SET cancelled_at=now() WHERE case_id=$1 AND customer_ref=$2',[row.id,ref]);
    }
  }
  await tx.query("INSERT INTO ml_feedback(event_id,case_id,kind,payload) VALUES($1,$2,'follow_up',$3)",
    [input.event_id,row.id,{...input,customer_ref:ref,due_date:due,actor_id:viewer.id}]);
  await audit(tx,row.id,`ml_follow_up_${input.status}`,{channel:row.snapshot.channel,operator_id:viewer.id,due_date:due});
  return true;
}
