import { z } from 'zod';
import { CustomerId, OfferInput, TicketInput } from '@claro/contracts';
import { ApiError, notFound, operation } from './storage.mjs';

async function customer(db, ref) {
  const { rows: [row] } = await db.query('SELECT profile,email,phone,document_kind,revision FROM customer WHERE ref=$1', [ref]);
  if (!row) throw notFound('Cliente no encontrado');
  return row;
}

async function tickets(db, ref, date, days) {
  const { rows } = await db.query(`SELECT body FROM crm_ticket WHERE customer_ref=$1
    AND business_date BETWEEN $2::date - $3::integer AND $2::date ORDER BY business_date DESC,ref`, [ref,date,days]);
  return rows.map(row => row.body);
}

async function offers(db, ref, date) {
  const { rows } = await db.query(`SELECT body FROM crm_offer WHERE customer_ref=$1
    AND business_date BETWEEN $2::date - interval '12 months' AND $2::date ORDER BY business_date DESC,ref`, [ref,date]);
  return rows.map(row => row.body);
}

export function retentionEligibility(profile, recentOffers, recentTickets) {
  const deny = reason => ({ eligible: false, reason, options: [] });
  if (profile.dias_mora > 30) return deny(`${profile.dias_mora} días de mora superan el límite de 30 días.`);
  if (recentOffers.length) return deny('Ya se aplicó una oferta en los últimos 12 meses.');
  const active = profile.servicios.filter(service => service.estado === 'activo');
  if (!active.length || profile.estado !== 'activo') return deny('El cliente requiere atención sobre el estado de sus servicios.');
  if (recentTickets.filter(ticket => ticket.categoria === 'soporte_tecnico').length >= 3) {
    return deny('Primero coordina una visita técnica prioritaria por fallas recurrentes.');
  }
  let options;
  if (profile.antiguedad_meses < 12) {
    options = [
      ...(active.some(service => service.tipo === 'hogar') ? [{ id:'discount', codigo:'RET-A', title:'Repetidor WiFi gratis', detail:'Para el servicio Hogar durante seis meses.' }] : []),
      ...(active.some(service => service.tipo === 'movil') ? [{ id:'upgrade', codigo:'RET-B', title:'10 GB adicionales', detail:'Para el servicio Móvil durante tres meses.' }] : [])
    ];
  } else {
    const senior = profile.antiguedad_meses > 24;
    const term = senior ? 'seis meses' : 'tres meses';
    const exact = active.some(service => service.plan === 'Hogar Fibra 300');
    const onlyPlan = active.length === 1 ? active[0] : null;
    const charge = onlyPlan ? ` de $${new Intl.NumberFormat('es-CO').format(onlyPlan.valor_mensual)}` : '';
    options = [
      { id:'discount', codigo:'RET-A', title:`${senior ? 30 : 20} % de descuento`,
        detail:`Sobre el cargo fijo${charge}, durante ${term}.` },
      { id:'upgrade', codigo:'RET-B', title:exact ? 'Mejora a Fibra 500' : 'Mejora al siguiente plan',
        detail:`Sin costo adicional durante ${term}.` }
    ];
  }
  return { eligible: true, reason: `${profile.antiguedad_meses} meses de antigüedad y sin ofertas en los últimos 12 meses.`, options };
}

export function crmRoutes(router, pool, date, write) {
  const doc = z.object({ tipo_documento: z.enum(['CC','CE','NIT','PAS']), numero_documento: z.string().min(1).max(64) });
  // Administrative extensions are separate from the original ten mock operations.
  router.get('/admin/clientes', async (req,res) => {
    const offset=z.coerce.number().int().min(0).default(0).parse(req.query.offset);
    const limit=z.coerce.number().int().min(1).max(100).default(25).parse(req.query.limit);
    const q=z.string().trim().max(100).default('').parse(req.query.q);
    const refs=req.query.refs === undefined ? null : z.string().max(80000).parse(req.query.refs).split(',').map(ref=>CustomerId.parse(ref));
    const {rows}=await pool.query(`SELECT ref AS cliente_id,profile->>'nombre' AS nombre,profile->>'estado' AS estado,revision FROM customer
      WHERE ($3='' OR position(lower($3) in lower(ref))>0 OR position(lower($3) in lower(profile->>'nombre'))>0)
      AND ($4::text[] IS NULL OR ref=ANY($4::text[])) ORDER BY ref LIMIT $1 OFFSET $2`,[limit,offset,q,refs]);
    res.json(rows);
  });
  router.post('/admin/clientes', async (req,res) => {
    const input=z.object({cliente_id:CustomerId,nombre:z.string().trim().min(1).max(100),tipo_documento:z.enum(['CC','CE','NIT','PAS']),numero_documento:z.string().min(1).max(64),celular:z.string().min(3).max(32),email:z.email().max(254),motivo:z.string().min(3).max(120)}).parse(req.body);
    await write(req,res,key=>operation(pool,key,{type:'cliente_alta',input},async db=>{
      const profile={cliente_id:input.cliente_id,nombre:input.nombre,ciudad:'Sin especificar',segmento:'regular',fecha_vinculacion:date,antiguedad_meses:0,ciclo_facturacion:1,dias_mora:0,estado:'activo',valor_mensual_total:0,autorizacion_tratamiento_datos:true,servicios:[]};
      await db.query('INSERT INTO customer(ref,document_kind,document_number,email,phone,profile) VALUES($1,$2,$3,$4,$5,$6)',[input.cliente_id,input.tipo_documento,input.numero_documento,input.email.toLowerCase(),input.celular,profile]);
      return {type:'cliente_alta',body:{cliente_id:input.cliente_id,revision:1}};
    }));
  });
  router.post('/admin/clientes/:id', async (req,res) => {
    const ref=CustomerId.parse(req.params.id);
    const input=z.object({revision:z.number().int().positive(),motivo:z.string().min(3).max(120),nombre:z.string().trim().min(1).max(100).optional(),celular:z.string().min(3).max(32).optional(),email:z.email().max(254).optional(),estado:z.enum(['activo','suspendido','retirado']).optional()}).parse(req.body);
    await write(req,res,key=>operation(pool,key,{type:'cliente_actualizacion',ref,input},async db=>{
      const {rows:[row]}=await db.query('SELECT profile,revision FROM customer WHERE ref=$1 FOR UPDATE',[ref]);
      if (!row) throw notFound('Cliente no encontrado');
      if (row.revision!==input.revision) throw new ApiError(409,'REVISION_OBSOLETA','El cliente cambió');
      const profile={...row.profile,...(input.nombre?{nombre:input.nombre}:{}),...(input.estado?{estado:input.estado}:{})};
      await db.query('UPDATE customer SET profile=$2,email=COALESCE($3,email),phone=COALESCE($4,phone),revision=revision+1 WHERE ref=$1',[ref,profile,input.email?.toLowerCase() ?? null,input.celular ?? null]);
      return {type:'cliente_actualizacion',body:{cliente_id:ref,revision:row.revision+1}};
    }));
  });
  router.get('/clientes', async (req, res) => {
    const { tipo_documento, numero_documento } = doc.parse(req.query);
    const { rows: [row] } = await pool.query(`SELECT ref AS cliente_id,profile->>'nombre' AS nombre,
      profile->>'estado' AS estado FROM customer WHERE document_kind=$1 AND document_number=$2`, [tipo_documento,numero_documento]);
    if (!row) throw notFound('Cliente no encontrado');
    res.json(row);
  });
  router.post('/identidades/resolver', async (req, res) => {
    const { alias } = z.object({ alias:z.string().trim().min(3).max(128) }).parse(req.body);
    const value = alias.includes('@') ? alias.toLowerCase() : alias.replace(/[\s()+.-]/g, '');
    const { rows: [row] } = await pool.query('SELECT ref AS cliente_id FROM customer WHERE email=$1 OR phone=$1', [value]);
    if (!row) throw notFound('Alias de prueba no encontrado');
    res.json(row);
  });
  router.get('/clientes/:id', async (req, res) => {
    const ref = CustomerId.parse(req.params.id);
    const row = await customer(pool, ref);
    const [recentTickets, recentOffers] = await Promise.all([tickets(pool,ref,date,90), offers(pool,ref,date)]);
    res.json({ ...row.profile, revision:row.revision, tipo_documento:row.document_kind, celular:row.phone, email:row.email, tickets_recientes:recentTickets, ofertas_retencion_12m:recentOffers });
  });
  router.get('/clientes/:id/servicios', async (req, res) => {
    const { profile } = await customer(pool, CustomerId.parse(req.params.id));
    res.json(profile.servicios.filter(service => service.estado === 'activo'));
  });
  router.get('/clientes/:id/tickets', async (req, res) => {
    const ref = CustomerId.parse(req.params.id);
    const days = z.coerce.number().int().min(1).max(365).default(90).parse(req.query.dias);
    await customer(pool, ref);
    res.json(await tickets(pool,ref,date,days));
  });
  router.get('/clientes/:id/elegibilidad-retencion', async (req, res) => {
    const ref = CustomerId.parse(req.params.id);
    const { profile } = await customer(pool,ref);
    const [recentOffers, recentTickets] = await Promise.all([offers(pool,ref,date), tickets(pool,ref,date,90)]);
    res.json(retentionEligibility(profile, recentOffers, recentTickets));
  });
  router.post('/clientes/:id/tickets', async (req, res) => {
    const ref = CustomerId.parse(req.params.id);
    const payload = TicketInput.parse(req.body);
    await write(req, res, key => operation(pool,key,{type:'ticket',ref,payload}, async (db,id) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('crm-customer'),hashtext($1))", [ref]);
      await customer(db,ref);
      const body = { ticket_id:`T-${id}`, fecha:date, estado:'abierto', ...payload };
      await db.query('INSERT INTO crm_ticket VALUES ($1,$2,$3,$4)', [body.ticket_id,ref,date,body]);
      return { type:'ticket', body };
    }));
  });
  router.post('/clientes/:id/ofertas-retencion', async (req, res) => {
    const ref = CustomerId.parse(req.params.id);
    const payload = OfferInput.parse(req.body);
    await write(req, res, key => operation(pool,key,{type:'oferta',ref,payload}, async (db,id) => {
      // Serialize decisions even when an integration submits distinct operation keys.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('crm-customer'),hashtext($1))", [ref]);
      const { profile } = await customer(db,ref);
      const eligibility = retentionEligibility(profile, await offers(db,ref,date), await tickets(db,ref,date,90));
      const option = eligibility.options.find(candidate => candidate.codigo === payload.codigo);
      if (!option) throw new ApiError(409, 'NO_ELEGIBLE', eligibility.eligible ? 'Oferta fuera de la política' : eligibility.reason);
      const body = { ...payload, descripcion:`${option.title}. ${option.detail}`, fecha:date };
      await db.query('INSERT INTO crm_offer VALUES ($1,$2,$3,$4)', [id,ref,date,body]);
      return { type:'oferta' };
    }));
  });
}
