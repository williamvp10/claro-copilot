import { z } from 'zod';
import { ADVISOR_ADJUSTMENT_LIMIT, AdjustmentInput, BillingPeriod, CustomerId, DiscountSchedule, InvoiceId } from '@claro/contracts';
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

function monthAfter(period,count=1) {
  const [year,month]=period.split('-').map(Number);
  return new Date(Date.UTC(year,month-1+count,1)).toISOString().slice(0,7);
}

const discountPrefix='Descuento de retención · ';
const fixedCharge=terms=>`Cargo fijo ${terms.plan}`;
function validateCharge(lines,terms) {
  const matching=lines.filter(line=>line.concepto===fixedCharge(terms));
  if (matching.length!==1 || matching[0].valor!==terms.base) {
    throw new ApiError(409,'CARGO_FIJO_CAMBIO','La factura requiere revisar el cargo fijo del servicio');
  }
}
async function issueContext(db,ref,date) {
  const {rows:[latest]}=await db.query('SELECT body,business_period FROM invoice WHERE customer_ref=$1 ORDER BY business_period DESC,ref DESC LIMIT 1',[ref]);
  if (!latest) throw notFound('Esta cuenta no tiene una facturación base');
  const operatingPeriod=date.slice(0,7);
  return {latest:latest.body, next:monthAfter(latest.business_period>operatingPeriod ? latest.business_period : operatingPeriod),
    lines:latest.body.detalle.filter(line=>!line.concepto.startsWith(discountPrefix))};
}
async function discountStatus(db,ref,offer,date) {
  const {rows:[row]}=await db.query('SELECT offer_ref,terms,start_period,end_period FROM billing_discount WHERE customer_ref=$1 AND offer_ref=$2',[ref,offer]);
  if (!row) throw notFound('Programación no encontrada');
  const {rows:[applied]}=await db.query(`SELECT ref FROM invoice WHERE customer_ref=$1 AND
    EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(body->'descuentos','[]'::jsonb)) b WHERE b->>'offer_ref'=$2)
    ORDER BY business_period DESC LIMIT 1`,[ref,offer]);
  return {...row,next_period:(await issueContext(db,ref,date)).next,...(applied ? {last_invoice:applied.ref} : {})};
}

export function billingRoutes(router, pool, date, write) {
  router.get('/clientes/:id/descuentos/:offer', async (req,res) => {
    const ref=CustomerId.parse(req.params.id);
    res.json(await discountStatus(pool,ref,req.params.offer,date));
  });
  router.post('/clientes/:id/descuentos', async (req,res) => {
    const ref=CustomerId.parse(req.params.id);
    const input=DiscountSchedule.parse(req.body);
    await write(req,res,key=>operation(pool,key,{type:'programar_descuento',ref,input},async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtext('billing-cycle'),hashtext($1))",[ref]);
      await assertCustomer(db,ref);
      const {lines,next}=await issueContext(db,ref,date);
      validateCharge(lines,input.terms);
      const end=monthAfter(next,input.terms.cycles-1);
      const {rows:[prior]}=await db.query('SELECT customer_ref,service_id FROM billing_discount WHERE offer_ref=$1',[input.offer_ref]);
      if (prior && (prior.customer_ref!==ref || prior.service_id!==input.terms.service_id)) {
        throw new ApiError(409,'SERVICIO_CAMBIO','La enmienda debe mantener el servicio');
      }
      const overlap=await db.query(`SELECT 1 FROM billing_discount WHERE customer_ref=$1 AND service_id=$2
        AND offer_ref<>$3 AND start_period<=$5 AND end_period>=$4`,[ref,input.terms.service_id,input.offer_ref,next,end]);
      if (overlap.rowCount) throw new ApiError(409,'DESCUENTO_DUPLICADO','El servicio ya tiene un beneficio en ese ciclo');
      await db.query(`INSERT INTO billing_discount(offer_ref,customer_ref,service_id,start_period,end_period,terms)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(offer_ref) DO UPDATE SET
        start_period=EXCLUDED.start_period,end_period=EXCLUDED.end_period,terms=EXCLUDED.terms`,
        [input.offer_ref,ref,input.terms.service_id,next,end,input.terms]);
      return {type:'programacion',body:await discountStatus(db,ref,input.offer_ref,date)};
    }));
  });
  router.post('/clientes/:id/ciclos', async (req,res) => {
    const ref=CustomerId.parse(req.params.id);
    const {periodo}=z.object({periodo:BillingPeriod}).strict().parse(req.body);
    await write(req,res,key=>operation(pool,key,{type:'emitir_ciclo',ref,periodo},async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtext('billing-cycle'),hashtext($1))",[ref]);
      const {rows:[prior]}=await db.query('SELECT ref FROM invoice WHERE customer_ref=$1 AND business_period=$2 ORDER BY ref LIMIT 1',[ref,periodo]);
      if (prior) return {type:'factura',body:{factura_id:prior.ref}};
      const {lines,latest,next}=await issueContext(db,ref,date);
      if (periodo!==next) throw new ApiError(409,'CICLO_CAMBIO','Emite el siguiente ciclo disponible');
      const {rows:schedules}=await db.query(`SELECT offer_ref,terms FROM billing_discount WHERE customer_ref=$1
        AND start_period<=$2 AND end_period>=$2 ORDER BY service_id`,[ref,periodo]);
      const discounts=schedules.map(({offer_ref,terms})=>{
        validateCharge(lines,terms);
        const amount=Math.round(terms.base*terms.percentage/100);
        return {...terms,offer_ref,amount,net:terms.base-amount};
      });
      const detail=[...lines,...discounts.map(item=>({concepto:discountPrefix+item.plan,valor:-item.amount}))];
      const [{number}]=(await db.query("SELECT nextval('demo_invoice_number') AS number")).rows;
      const id=`F-${number}`;
      const cutDay=Math.min(28,Number(latest.fecha_corte.slice(-2)));
      const dueDay=Math.min(28,Math.max(cutDay,Number(latest.fecha_limite_pago.slice(-2))));
      const day=value=>String(value).padStart(2,'0');
      const body={factura_id:id,cliente_id:ref,periodo,fecha_corte:`${periodo}-${day(cutDay)}`,
        fecha_limite_pago:`${periodo}-${day(dueDay)}`,valor_total:detail.reduce((total,line)=>total+line.valor,0),
        detalle:detail,estado:'pendiente',fecha_pago:null,descuentos:discounts};
      await db.query('INSERT INTO invoice VALUES($1,$2,$3,$4)',[id,ref,periodo,body]);
      return {type:'factura',body:{factura_id:id}};
    }));
  });
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
