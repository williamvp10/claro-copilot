import { z } from 'zod';

export const CustomerId = z.string().regex(/^C-\d{4}$/);
export const InvoiceId = z.string().regex(/^F-\d{4,10}$/);
export const OperationKey = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);
const description = z.string().trim().min(1).max(1000);

export const TicketInput = z.object({
  categoria: z.enum(['soporte_tecnico', 'facturacion', 'consulta_planes', 'cancelacion', 'portabilidad']),
  descripcion: description,
  prioridad: z.enum(['estandar', 'prioritaria']).default('estandar'),
  escalar_a: z.enum(['nivel2', 'supervisor', 'mesa_retencion']).nullish()
});
export const Ticket = z.object({
  ticket_id: z.string(), fecha: z.iso.date(), categoria: TicketInput.shape.categoria,
  estado: z.enum(['abierto', 'cerrado']), prioridad: TicketInput.shape.prioridad.optional(),
  escalar_a: TicketInput.shape.escalar_a
});
export const OfferCode = z.enum(['RET-A', 'RET-B']);
export const OfferInput = z.object({
  codigo: OfferCode, descripcion: description, fecha: z.iso.date().optional(),
  asesor_id: z.string().max(128).optional()
});
export const Service = z.object({
  servicio_id: z.string(), tipo: z.enum(['hogar', 'movil']), plan: z.string(), valor_mensual: z.number().int(),
  fecha_activacion: z.iso.date(), permanencia_hasta: z.iso.date().nullable(), estado: z.string()
});
export const Customer = z.object({
  cliente_id: CustomerId, nombre: z.string(), ciudad: z.string(), segmento: z.string(),
  estado: z.enum(['activo', 'suspendido', 'retirado']), antiguedad_meses: z.number().int(),
  dias_mora: z.number().int(), ciclo_facturacion: z.number().int(), valor_mensual_total: z.number().int(),
  fecha_vinculacion: z.iso.date(), autorizacion_tratamiento_datos: z.boolean(),
  servicios: z.array(Service), tickets_recientes: z.array(Ticket), ofertas_retencion_12m: z.array(OfferInput)
});
export const Eligibility = z.object({
  eligible: z.boolean(), reason: z.string(), options: z.array(z.object({
    id: z.enum(['discount', 'upgrade']), codigo: OfferCode, title: z.string(), detail: z.string()
  }))
});
export const Invoice = z.object({
  factura_id: InvoiceId, cliente_id: CustomerId, periodo: z.string(), fecha_corte: z.iso.date(),
  fecha_limite_pago: z.iso.date(), valor_total: z.number().int(),
  detalle: z.array(z.object({ concepto: z.string(), valor: z.number().int() })),
  estado: z.enum(['pagada', 'pendiente', 'vencida']), fecha_pago: z.iso.date().nullable(),
  saldo_abierto: z.number().int().nonnegative(), total_ajustado: z.number().int().nonnegative()
});
export const Balance = z.object({
  cliente_id: CustomerId, saldo_pendiente: z.number().int(), saldo_vencido: z.number().int(),
  proxima_fecha_limite: z.iso.date().nullable()
});
export const AdjustmentInput = z.object({
  valor: z.number().int().positive().lte(2147483647), motivo: description, aprobado_por: z.string().trim().min(1).max(128).nullish()
});
export const Adjustment = AdjustmentInput.extend({ ajuste_id: z.string(), fecha: z.iso.date() });
export const InvoiceDetail = Invoice.extend({ ajustes: z.array(Adjustment) });
export const Receipt = z.object({
  clave: OperationKey, referencia: z.string(), tipo: z.enum(['ticket', 'oferta', 'ajuste'])
});
export const ManualAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ticket'), ticket: TicketInput }),
  z.object({ kind: z.literal('offer'), codigo: OfferCode, customer_accepted: z.literal(true) }),
  z.object({ kind: z.literal('adjustment'), invoice_id: InvoiceId, adjustment: AdjustmentInput.omit({ aprobado_por: true }) })
]);
export const ConfirmIntegration = z.object({ idempotency_key: OperationKey, action: ManualAction });
export const ADVISOR_ADJUSTMENT_LIMIT = 50_000;

export type CrmView = {
  customer: z.infer<typeof Customer>;
  eligibility: z.infer<typeof Eligibility>;
};
export type BillingView = { balance: z.infer<typeof Balance>; invoices: z.infer<typeof Invoice>[] };
export type InvoiceDetail = z.infer<typeof InvoiceDetail>;
export type ManualAction = z.infer<typeof ManualAction>;
export type IntegrationOperation = {
  id: string; case_id: string; action: ManualAction;
  status: 'queued' | 'pending_supervisor' | 'pending_verification' | 'confirmed' | 'rejected' | 'expired';
  reference: string | null; failure_code: string | null;
};
export type IntegrationHealth = {
  service: 'crm' | 'billing'; available: boolean; latency_ms: number;
  requests: number; errors: number;
};
