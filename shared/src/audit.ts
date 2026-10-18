import { z } from 'zod';

/**
 * RF-13: registro de auditoria global, append-only.
 * No existe ningun evento sin actor ni tipo: la UI y los tests se apoyan en esto.
 */
export const AuditActorSchema = z.enum(['agente', 'sistema', 'persona', 'chat']);
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AUDIT_EVENT_TYPES = [
  'factura.recibida',
  'factura.encolada',
  'factura.procesando',
  'factura.estado',
  'extraccion.realizada',
  'tool.llamada',
  'regla.evaluada',
  'llm.propuesta',
  'guard.decision',
  'descripcion.generada',
  'decision.registrada',
  'pago.orden',
  'notificacion.enviada',
  'notificacion.respondida',
  'accion.humana',
  'chat.mensaje',
  'chat.propuesta',
  'chat.confirmacion',
  'reglas.cambiadas',
  'exportacion',
  'conector.consultado',
  'error',
  'reintento',
] as const;

export const AuditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AUDIT_EVENT_LABEL: Record<AuditEventType, string> = {
  'factura.recibida': 'Factura recibida',
  'factura.encolada': 'Factura en cola',
  'factura.procesando': 'Procesando factura',
  'factura.estado': 'Cambio de estado',
  'extraccion.realizada': 'Extracción',
  'tool.llamada': 'Herramienta consultada',
  'regla.evaluada': 'Regla evaluada',
  'llm.propuesta': 'Propuesta del LLM',
  'guard.decision': 'Decisión del guard',
  'descripcion.generada': 'Descripción generada',
  'decision.registrada': 'Decisión registrada',
  'pago.orden': 'Orden de pago preparada',
  'notificacion.enviada': 'Notificación enviada',
  'notificacion.respondida': 'Notificación respondida',
  'accion.humana': 'Acción humana',
  'chat.mensaje': 'Mensaje de chat',
  'chat.propuesta': 'Propuesta del chat',
  'chat.confirmacion': 'Propuesta confirmada',
  'reglas.cambiadas': 'Reglas modificadas',
  exportacion: 'Exportación',
  'conector.consultado': 'Conector consultado',
  error: 'Error',
  reintento: 'Reintento',
};

export const AuditEventSchema = z.object({
  id: z.string(),
  ts: z.string(),
  actor: AuditActorSchema,
  tipo: AuditEventTypeSchema,
  invoiceId: z.string().nullable(),
  detalle: z.record(z.string(), z.unknown()),
  hashPrev: z.string().nullable(),
  hash: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditFiltersSchema = z.object({
  invoiceId: z.string().optional(),
  actor: AuditActorSchema.optional(),
  tipo: AuditEventTypeSchema.optional(),
  desde: z.string().optional(),
  hasta: z.string().optional(),
  limite: z.number().int().positive().max(2000).optional(),
});
export type AuditFilters = z.infer<typeof AuditFiltersSchema>;
