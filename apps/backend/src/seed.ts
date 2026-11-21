import 'reflect-metadata';
import { createAuth } from './auth.js';
import { createDatabase } from './database.js';

if (process.env.DEMO_MODE !== 'true') throw new Error('Set DEMO_MODE=true to seed synthetic cases');
const db = await createDatabase().initialize();
const { auth, database } = createAuth(true);

async function upsertOperator(kind: 'ASESSOR' | 'ADMIN', name: string, role: 'asesor' | 'admin') {
  const email = process.env[`DEMO_${kind}_EMAIL`];
  const password = process.env[`DEMO_${kind}_PASSWORD`];
  if (!email || !password || password.length < 12) throw new Error(`Configure email and a 12-character password for ${kind}`);
  const [existing] = await db.query('SELECT id FROM "user" WHERE email=$1', [email.toLowerCase()]);
  const id = existing?.id ?? (await auth.api.signUpEmail({ body: { email, password, name } })).user.id;
  await db.query('INSERT INTO operator_role VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET role=EXCLUDED.role', [id,role]);
  return id;
}

try {
  if (process.env.DEMO_ASESSOR_EMAIL?.toLowerCase() === process.env.DEMO_ADMIN_EMAIL?.toLowerCase()) {
    throw new Error('Demo operators require different emails');
  }
  const advisor = await upsertOperator('ASESSOR', 'Asesor Claro', 'asesor');
  await upsertOperator('ADMIN', 'Administración Claro', 'admin');
  const scenarios = [
    ['C-1001', process.env.DEMO_BILLING_CHAT_ID, 'Cliente C-1001', null],
    ['C-1004', process.env.DEMO_RETENTION_CHAT_ID, 'Cliente C-1004', null],
    ['C-1007', process.env.DEMO_ASSIGNED_CHAT_ID, 'Cliente C-1007', advisor]
  ] as const;
  for (const [ref, chatId, name, owner] of scenarios) {
    await db.query(`INSERT INTO telegram_contact (ref,chat_id,display_name,direct_owner,fixture) VALUES ($1,$2,$3,$4,$1)
      ON CONFLICT(ref) DO UPDATE SET chat_id=EXCLUDED.chat_id, direct_owner=EXCLUDED.direct_owner`, [ref, chatId?.trim() || null, name, owner]);
  }
  console.log('Synthetic demo contacts and operator roles are ready');
} finally {
  await Promise.all([db.destroy(), database.end()]);
}
