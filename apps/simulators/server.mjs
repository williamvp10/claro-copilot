import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import express from 'express';
import { ZodError } from 'zod';
import { OperationKey } from '@claro/contracts';
import { crmRoutes } from './crm.mjs';
import { billingRoutes } from './billing.mjs';
import { ApiError, database, notFound } from './storage.mjs';

const hash = value => createHash('sha256').update(value).digest();

export function createSimulator({ service, pool, key, date, faults = 'off', quota = 60, now = Date.now, faultDelay = 3500 }) {
  const app = express();
  const router = express.Router();
  const expected = hash(key);
  let used = 0;
  let requests = 0;
  let bucketEnds = now() + 60_000;
  app.disable('x-powered-by');
  app.get('/readyz', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status:'ready' });
  });
  router.use(async (req,res,next) => {
    const supplied = req.get('X-Request-ID');
    res.locals.trace = supplied && /^[A-Za-z0-9_-]{1,80}$/.test(supplied) ? supplied : randomUUID();
    res.set('X-Request-ID',res.locals.trace).set('Cache-Control','no-store');
    if (!timingSafeEqual(hash(req.get('X-API-Key') ?? ''),expected)) throw new ApiError(401,'NO_AUTORIZADO','API key inválida');
    const time = now();
    if (time >= bucketEnds) {
      used = 0;
      bucketEnds = time + 60_000;
    }
    if (used >= quota) {
      res.set('Retry-After',String(Math.ceil((bucketEnds-time)/1000)));
      throw new ApiError(429,'LIMITE_EXCEDIDO','Límite de solicitudes alcanzado');
    }
    used++;
    requests++;
    const fault = faults === 'test' ? req.get('X-Simulator-Fault') : undefined;
    if (fault === '503' || (faults === 'every-50' && requests % 50 === 0)) {
      throw new ApiError(503,'NO_DISPONIBLE','Servicio temporalmente no disponible');
    }
    if (fault === 'timeout') {
      await wait(faultDelay);
      if (res.destroyed) return;
    }
    next();
  });
  router.use(express.json({ limit:'16kb' }));
  router.get('/operaciones/:key', async (req,res) => {
    const key = OperationKey.parse(req.params.key);
    const { rows:[row] } = await pool.query('SELECT receipt FROM operation_receipt WHERE operation_key=$1', [key]);
    if (!row) throw notFound('Recibo no encontrado');
    res.json(row.receipt);
  });
  const write = async (req,res,execute) => {
    // Legacy clients may omit the extension. The BFF always supplies a stable key.
    const key = OperationKey.parse(req.get('Idempotency-Key') ?? randomUUID());
    const result = await execute(key);
    if (faults === 'test' && req.get('X-Simulator-Fault') === 'lost-after-commit') {
      res.destroy();
      return;
    }
    res.set('X-Operation-Reference',result.receipt.referencia).set('Idempotency-Key',key).status(201);
    if (result.body) res.json(result.body);
    else res.end();
  };
  (service === 'crm' ? crmRoutes : billingRoutes)(router,pool,date,write);
  app.use('/v1',router);
  app.use((_req,_res) => { throw notFound(); });
  app.use((error,_req,res,_next) => {
    const expressed = error instanceof ApiError ? error :
      error instanceof ZodError || error.type === 'entity.parse.failed' || error.type === 'entity.too.large'
        ? new ApiError(400,'SOLICITUD_INVALIDA','Revisa los parámetros solicitados')
        : new ApiError(503,'NO_DISPONIBLE','Servicio temporalmente no disponible');
    res.status(expressed.status).json({ codigo:expressed.code, mensaje:expressed.message, trace_id:res.locals.trace });
  });
  return app;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const service = process.argv[2];
  const prefix = service === 'crm' ? 'CRM' : 'BILLING';
  const url = process.env[prefix + '_DATABASE_URL'];
  const key = process.env[prefix + '_API_KEY'];
  const date = process.env.DEMO_BUSINESS_DATE || '2026-11-18';
  if (!['crm','billing'].includes(service) || !url || !key || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Configure the simulator service, database, API key and business date');
  }
  const pool = database(url);
  pool.on('error', () => console.error('Simulator database connection interrupted'));
  const port = Number(process.env[prefix + '_PORT'] || (service === 'crm' ? 8081 : 8082));
  const app = createSimulator({ service,pool,key,date,faults:process.env.SIMULATOR_FAULT_MODE });
  const server = app.listen(port, process.env.SIMULATOR_HOST || '0.0.0.0', () => console.log(`${service} simulator listening on port ${port}`));
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => server.close(() => void pool.end()));
}
