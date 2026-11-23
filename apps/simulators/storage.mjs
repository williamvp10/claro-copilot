import { createHash, randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (message = 'Recurso no encontrado') => new ApiError(404, 'NO_ENCONTRADO', message);

export function database(url) {
  return new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 1500, statement_timeout: 2500 });
}

export async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function operation(pool, key, command, execute) {
  const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
  return transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('simulator-operation'),hashtext($1))", [key]);
    const { rows: [previous] } = await db.query('SELECT * FROM operation_receipt WHERE operation_key=$1', [key]);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ApiError(409, 'CLAVE_REUTILIZADA', 'La clave ya identifica otra solicitud');
      return previous;
    }
    const reference = randomUUID();
    const { type, body } = await execute(db, reference);
    const receipt = { clave: key, referencia: body?.ticket_id ?? reference, tipo: type };
    await db.query('INSERT INTO operation_receipt VALUES ($1,$2,$3,$4)', [key, fingerprint, receipt, body ?? null]);
    return { receipt, body };
  });
}

export async function adminClient(url, fn) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
