import { readFile } from 'node:fs/promises';
import { adminClient } from './storage.mjs';

const load = file => readFile(new URL(file, import.meta.url), 'utf8');
const customers = JSON.parse(await load('./fixtures/crm.json'));
const invoices = JSON.parse(await load('./fixtures/billing.json'));
const admin = new URL(process.env.DATABASE_URL);
const platformName = decodeURIComponent(admin.pathname.slice(1));
const settings = [
  ['PLATFORM_DATABASE_URL', platformName],
  ['CRM_DATABASE_URL', 'claro_crm'],
  ['BILLING_DATABASE_URL', 'claro_facturacion']
].map(([key, name]) => {
  const url = new URL(process.env[key]);
  const role = decodeURIComponent(url.username);
  if (!/^[a-z][a-z0-9_]{0,49}$/.test(name) || !/^[a-z][a-z0-9_]{0,49}$/.test(role) ||
      decodeURIComponent(url.pathname.slice(1)) !== name || !url.password || role === decodeURIComponent(admin.username) ||
      url.hostname !== admin.hostname || (url.port || '5432') !== (admin.port || '5432')) {
    throw new Error(`Invalid isolated database settings for ${key}`);
  }
  return { role, name, password: decodeURIComponent(url.password) };
});
if (new Set(settings.map(x => x.name)).size !== 3 || new Set(settings.map(x => x.role)).size !== 3) {
  throw new Error('Three distinct runtime roles and databases are required');
}

async function legacyEffects(db) {
  const { rows: offers } = await db.query(`
    SELECT e.id AS ref, p.id AS proposal_id, p.option_id, c.snapshot->>'owner_id' AS advisor, p.proposal->>'detail' AS detail,
      COALESCE(c.account_ref, CASE WHEN c.contact_ref LIKE 'web-c1001:%' THEN 'C-1001' ELSE c.contact_ref END) AS customer_ref,
      COALESCE(r.turn->>'business_date',e.confirmed_at::date::text) AS business_date
    FROM crm_effect e JOIN retention_proposal p ON p.id=e.proposal_id
    JOIN attention_case c ON c.id=p.case_id JOIN agent_run r ON r.id=p.run_id`);
  const { rows: tickets } = await db.query(`
    SELECT t.id AS ref, p.id AS proposal_id, t.category, t.priority,
      COALESCE(c.account_ref, CASE WHEN c.contact_ref LIKE 'web-c1001:%' THEN 'C-1001' ELSE c.contact_ref END) AS customer_ref,
      COALESCE(r.turn->>'business_date',t.created_at::date::text) AS business_date
    FROM support_ticket t JOIN retention_proposal p ON p.id=t.proposal_id
    JOIN attention_case c ON c.id=p.case_id JOIN agent_run r ON r.id=p.run_id`);
  return { offers, tickets };
}

try {
  await adminClient(admin.toString(), async control => {
    await control.query("SELECT pg_advisory_lock(hashtext('claro-simulator-bootstrap'))");
    for (const { role, password } of settings) {
      const { rows: [found] } = await control.query('SELECT * FROM pg_roles WHERE rolname=$1', [role]);
      if (found && (found.rolsuper || found.rolcreatedb || found.rolcreaterole || found.rolreplication || found.rolbypassrls ||
        (await control.query('SELECT 1 FROM pg_auth_members WHERE member=$1', [found.oid])).rowCount)) {
        throw new Error('Runtime role has privileged grants');
      }
      const { rows: [{ literal }] } = await control.query('SELECT quote_literal($1) AS literal', [password]);
      await control.query(`${found ? 'ALTER' : 'CREATE'} ROLE "${role}" LOGIN PASSWORD ${literal}`);
    }
    for (const { role, name } of settings) {
      if (!(await control.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) {
        await control.query(`CREATE DATABASE "${name}"`);
      }
      await control.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC;
        GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
      for (const other of settings.filter(item => item.role !== role)) {
        await control.query(`REVOKE ALL ON DATABASE "${name}" FROM "${other.role}"`);
      }
    }
    const legacy = await legacyEffects(control);
    for (const [index, { name, role }] of settings.entries()) {
      const url = new URL(admin);
      url.pathname = '/' + name;
      await adminClient(url.toString(), async db => {
        await db.query('BEGIN');
        try {
          if (index > 0) {
            await db.query(await load(index === 1 ? './crm.sql' : './billing.sql'));
            await db.query(await load('./shared.sql'));
          }
          if (index === 1) {
            for (const customer of customers) {
              const { numero_documento, tipo_documento, email, celular, tickets_recientes, ofertas_retencion_12m, ...profile } = customer;
              await db.query('INSERT INTO customer(ref,document_kind,document_number,email,phone,profile) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (ref) DO NOTHING',
                [customer.cliente_id,tipo_documento,numero_documento,email,celular,profile]);
              for (const ticket of tickets_recientes) {
                await db.query('INSERT INTO crm_ticket VALUES ($1,$2,$3,$4) ON CONFLICT (ref) DO NOTHING',
                  [ticket.ticket_id,customer.cliente_id,ticket.fecha,ticket]);
              }
              for (const [i, offer] of ofertas_retencion_12m.entries()) {
                await db.query('INSERT INTO crm_offer VALUES ($1,$2,$3,$4) ON CONFLICT (ref) DO NOTHING',
                  [`seed:${customer.cliente_id}:${i}`,customer.cliente_id,offer.fecha,offer]);
              }
            }
            const known = new Set(customers.map(customer => customer.cliente_id));
            for (const [entries, type] of [[legacy.offers,'oferta'],[legacy.tickets,'ticket']]) {
              for (const item of entries.filter(effect => known.has(effect.customer_ref))) {
                const key = `agent:${item.proposal_id}`;
                const body = type === 'oferta'
                  ? { codigo: item.option_id === 'upgrade' ? 'RET-B' : 'RET-A', descripcion: item.detail, fecha: item.business_date, asesor_id: item.advisor }
                  : { ticket_id:item.ref, categoria:item.category, prioridad:item.priority, fecha:item.business_date, estado:'abierto' };
                const receipt = { clave:key, referencia:item.ref, tipo:type };
                const reserved = await db.query('INSERT INTO operation_receipt VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
                  [key,'legacy',receipt,type === 'ticket' ? body : null]);
                if (reserved.rowCount) {
                  const table = type === 'oferta' ? 'crm_offer' : 'crm_ticket';
                  await db.query(`INSERT INTO ${table} VALUES ($1,$2,$3,$4) ON CONFLICT (ref) DO NOTHING`,
                    [item.ref,item.customer_ref,item.business_date,body]);
                }
              }
            }
          }
          if (index === 2) {
            for (const { cliente_id } of customers) {
              await db.query('INSERT INTO billing_customer VALUES ($1) ON CONFLICT DO NOTHING', [cliente_id]);
            }
            for (const invoice of invoices) {
              await db.query('INSERT INTO invoice VALUES ($1,$2,$3,$4) ON CONFLICT (ref) DO NOTHING',
                [invoice.factura_id,invoice.cliente_id,invoice.periodo,invoice]);
            }
          }
          await db.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
            GRANT USAGE ON SCHEMA public TO "${role}"`);
          if (index === 0) {
            await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${role}";
              GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}";
              REVOKE ALL ON TABLE claro_migrations FROM "${role}"`);
          } else {
            const readOnly = index === 1 ? 'customer' : 'billing_customer,invoice';
            const writable = index === 1 ? 'operation_receipt,crm_ticket,crm_offer' : 'operation_receipt,credit';
            // Row locks require UPDATE permission. Use immutable-adjacent advisory locks for business records.
            await db.query(`GRANT SELECT ON ${readOnly} TO "${role}";
              GRANT SELECT,INSERT ON ${writable} TO "${role}"`);
            if (index === 1) await db.query(`GRANT INSERT (ref,document_kind,document_number,email,phone,profile),
              UPDATE (profile,email,phone,revision) ON customer TO "${role}"`);
          }
          await db.query('COMMIT');
        } catch (error) {
          await db.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      });
    }
  });
  console.log('Three database schemas and simulator fixtures are ready');
} catch (error) {
  console.error('Database bootstrap failed', error.code ?? error.name);
  process.exitCode = 1;
}
