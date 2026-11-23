import { z } from 'zod';
import { ADVISOR_ADJUSTMENT_LIMIT, AdjustmentInput, CustomerId, InvoiceId } from '@claro/contracts';
import { ApiError, notFound, operation } from './storage.mjs';

export function invoiceProjection(row) {
  const total_ajustado = row.adjusted ?? 0;
  const { body } = row;
  return { ...body, total_ajustado, saldo_abierto:body.estado === 'pagada' ? 0 : body.valor_total - total_ajustado };
}

export function validateCredit(invoice, credit) {
  if (credit.valor > invoice.saldo_abierto) {
    throw new ApiError(409, 'AJUSTE_SUPERA_SALDO', 'El ajuste supera el saldo abierto');
  }
  if (invoice.total_ajustado + credit.valor > ADVISOR_ADJUSTMENT_LIMIT && !credit.aprobado_por) {
    throw new ApiError(403, 'AJUSTE_REQUIERE_APROBACION', 'El ajuste acumulado requiere aprobación de supervisor');
  }
}

const selectInvoice = `SELECT i.body, COALESCE((SELECT sum(c.amount) FROM credit c WHERE c.invoice_ref=i.ref),0)::integer AS adjusted FROM invoice i`;

async function getInvoice(db, ref) {
  const { rows:[row] } = await db.query(selectInvoice + ' WHERE i.ref=$1', [ref]);
  if (!row) throw notFound('Factura no encontrada');
  return invoiceProjection(row);
}

async function assertCustomer(db, ref) {
  if (!(await db.query('SELECT 1 FROM billing_customer WHERE ref=$1', [ref])).rowCount) throw notFound('Cliente no encontrado');
}

export function billingRoutes(router, pool, date, write) {
  router.get('/clientes/:id/facturas', async (req, res) => {
    const ref = CustomerId.parse(req.params.id);
    const limit = z.coerce.number().int().min(1).max(12).default(3).parse(req.query.limite);
    await assertCustomer(pool,ref);
    const { rows } = await pool.query(selectInvoice + ' WHERE i.customer_ref=$1 ORDER BY i.business_period DESC,i.ref LIMIT $2', [ref,limit]);
    res.json(rows.map(invoiceProjection));
  });
  router.get('/clientes/:id/saldo', async (req, res) => {
    const ref = CustomerId.parse(req.params.id);
    await assertCustomer(pool,ref);
    const { rows } = await pool.query(selectInvoice + ' WHERE i.customer_ref=$1 ORDER BY i.body->>\'fecha_limite_pago\'', [ref]);
    const open = rows.map(invoiceProjection).filter(invoice => invoice.saldo_abierto > 0);
    res.json({
      cliente_id:ref,
      saldo_pendiente:open.reduce((sum, invoice) => sum + invoice.saldo_abierto,0),
      saldo_vencido:open.filter(invoice => invoice.estado === 'vencida').reduce((sum, invoice) => sum + invoice.saldo_abierto,0),
      proxima_fecha_limite:open.find(invoice => invoice.estado === 'pendiente')?.fecha_limite_pago ?? null
    });
  });
  router.get('/facturas/:id', async (req, res) => {
    const ref = InvoiceId.parse(req.params.id);
    const { rows: [row] } = await pool.query(`SELECT i.body,
      COALESCE((SELECT sum(c.amount) FROM credit c WHERE c.invoice_ref=i.ref),0)::integer AS adjusted,
      COALESCE((SELECT jsonb_agg(c.body ORDER BY c.body->>'fecha',c.ref) FROM credit c WHERE c.invoice_ref=i.ref),'[]'::jsonb) AS credits
      FROM invoice i WHERE i.ref=$1`, [ref]);
    if (!row) throw notFound('Factura no encontrada');
    res.json({ ...invoiceProjection(row), ajustes:row.credits });
  });
  router.post('/facturas/:id/ajustes', async (req, res) => {
    const ref = InvoiceId.parse(req.params.id);
    const payload = AdjustmentInput.parse(req.body);
    await write(req, res, key => operation(pool,key,{type:'ajuste',ref,payload}, async (db,id) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('billing-invoice'),hashtext($1))", [ref]);
      const invoice = await getInvoice(db,ref);
      validateCredit(invoice,payload);
      const body = { ajuste_id:id, fecha:date, ...payload };
      await db.query('INSERT INTO credit VALUES ($1,$2,$3,$4)', [id,ref,payload.valor,body]);
      return { type:'ajuste' };
    }));
  });
}
