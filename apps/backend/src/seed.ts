import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { createAuth } from './auth.js';
import { audit, createDatabase } from './database.js';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { demoChurnFeatures } from './ml-advisory.js';

if (process.env.DEMO_MODE !== 'true') throw new Error('Set DEMO_MODE=true to seed synthetic cases');
const db = await createDatabase().initialize();
const { auth, database } = createAuth(true);

async function upsertOperator(kind: 'ASESSOR' | 'ADMIN' | 'N2' | 'SUPERVISOR', name: string, role: 'asesor' | 'admin') {
  const email = process.env[`DEMO_${kind}_EMAIL`]?.trim().toLowerCase();
  const password = process.env[`DEMO_${kind}_PASSWORD`];
  const local = ['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.BETTER_AUTH_URL!).hostname);
  if (!email || !password || (password.length < 12 && !(local && password === 'password'))) {
    throw new Error(`Configure credentials for ${kind}. The short demo password is only supported on loopback.`);
  }
  const [existing] = await db.query(`SELECT u.id,o.role FROM "user" u LEFT JOIN operator_role o ON o.user_id=u.id WHERE u.email=$1`,[email]);
  if (existing) {
    if (existing.role !== role) throw new Error(`Existing account is outside the configured demo role for ${kind}`);
    await db.transaction(async tx => {
      const [credential] = await tx.query(`SELECT id,password FROM account
        WHERE "userId"=$1 AND "providerId"='credential' AND "accountId"=$1 FOR UPDATE`,[existing.id]);
      if (!credential?.password) throw new Error(`Missing email credential for ${kind}`);
      if (await verifyPassword({hash:credential.password,password})) return;
      await tx.query('UPDATE account SET password=$1,"updatedAt"=now() WHERE id=$2',[await hashPassword(password),credential.id]);
      await tx.query('DELETE FROM session WHERE "userId"=$1',[existing.id]);
    });
    return existing.id;
  }
  const { user:{id} } = await auth.api.signUpEmail({body:{email,password,name}});
  await db.query("INSERT INTO operator_role(user_id,role,capabilities) VALUES ($1,$2,CASE WHEN $2='asesor' THEN ARRAY['n1'] ELSE ARRAY['admin','supervisor'] END)",[id,role]);
  return id;
}

try {
  if (process.env.DEMO_ASESSOR_EMAIL?.trim().toLowerCase() === process.env.DEMO_ADMIN_EMAIL?.trim().toLowerCase()) {
    throw new Error('Demo operators require different emails');
  }
  const advisor = await upsertOperator('ASESSOR', 'Asesor Claro', 'asesor');
  const admin=await upsertOperator('ADMIN', 'Administración Claro', 'admin');
  await db.transaction(async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('superadmin-management'))");
    const [current]=await tx.query("SELECT enabled AND 'admin'=ANY(capabilities) AS ready FROM operator_role WHERE user_id=$1 FOR UPDATE",[admin]);
    if (!current?.ready) throw new Error('La cuenta Administración debe estar activa antes de retirar la identidad anterior');
    const oldEmail=process.env.DEMO_SUPERADMIN_EMAIL?.trim().toLowerCase() ?? '';
    const retired=await tx.query(`WITH retired AS (
      UPDATE operator_role o SET enabled=false,available=false FROM "user" u
      WHERE o.user_id=u.id AND o.user_id<>$1 AND o.enabled AND o.capabilities=ARRAY['superadmin']
      AND (u.email=$2 OR u.name='Superadministración') RETURNING o.user_id
    ) SELECT user_id FROM retired`,[admin,oldEmail]);
    for (const {user_id} of retired) {
      await tx.query('DELETE FROM session WHERE "userId"=$1',[user_id]);
      await audit(tx,null,'operator_retired',{operator_id:admin,target_id:user_id});
    }
  });
  for (const [kind,name,caps,specialties] of [['N2','Soporte N2',['n2'],['soporte_tecnico','facturacion','comercial_portabilidad']],['SUPERVISOR','Supervisión',['supervisor'],[]]] as const) {
    if (!process.env[`DEMO_${kind}_EMAIL`] || !process.env[`DEMO_${kind}_PASSWORD`]) continue;
    const id = await upsertOperator(kind, name, 'asesor');
    await db.query('UPDATE operator_role SET capabilities=$2,specialties=$3 WHERE user_id=$1',[id,caps,specialties]);
  }
  const scenarios = [
    ['C-1001', process.env.DEMO_BILLING_CHAT_ID, 'Cliente C-1001', null],
    ['C-1004', process.env.DEMO_RETENTION_CHAT_ID, 'Cliente C-1004', null],
    ['C-1007', process.env.DEMO_ASSIGNED_CHAT_ID, 'Cliente C-1007', advisor],
    ...(process.env.DEMO_SUPPORT_CHAT_ID ? [['C-1013', process.env.DEMO_SUPPORT_CHAT_ID, 'Cliente C-1013', advisor] as const] : [])
  ] as const;
  for (const [ref, chatId, name, owner] of scenarios) {
    await db.query(`INSERT INTO telegram_contact (ref,chat_id,display_name,direct_owner,fixture) VALUES ($1,$2,$3,$4,$1)
      ON CONFLICT(ref) DO UPDATE SET chat_id=CASE WHEN telegram_contact.managed_by_admin THEN telegram_contact.chat_id
        ELSE EXCLUDED.chat_id END, direct_owner=EXCLUDED.direct_owner`, [ref, chatId?.trim() || null, name, owner]);
  }
  const cutoff='2026-11-18';
  const customers=JSON.parse(await readFile(new URL('../../simulators/fixtures/crm.json',import.meta.url),'utf8')) as
    (Parameters<typeof demoChurnFeatures>[0] & {cliente_id:string})[];
  for (const ref of ['C-1001','C-1002','C-1003','C-1004','C-1005','C-1007','C-1020']) {
    const customer=customers.find(row=>row.cliente_id===ref);
    if (!customer) throw new Error(`Falta la cuenta de demo ${ref}`);
    const features=demoChurnFeatures(customer,cutoff);
    await db.query(`INSERT INTO ml_customer_snapshot(customer_ref,fecha_corte,synthetic,features) VALUES($1,$2,true,$3)
      ON CONFLICT(customer_ref,fecha_corte) DO NOTHING`,[ref,cutoff,features]);
  }
  console.log('Synthetic demo contacts and operator roles are ready');
} finally {
  await Promise.all([db.destroy(), database.end()]);
}
