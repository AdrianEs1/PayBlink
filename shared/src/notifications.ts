import { z } from 'zod';
import { MonedaSchema } from './invoice';

/** RF-12.3: directorio ficticio de aprobadores. */
export const ApproverSchema = z.object({
  id: z.string().min(1),
  nombre: z.string().min(1),
  cargo: z.string().min(1),
  telefono: z.string().min(1),
  email: z.string().min(1),
  canalPreferido: z.enum(['whatsapp', 'email']),
  /** Monto maximo (en moneda base) que puede aprobar. null = sin limite. */
  montoMaximo: z.number().positive().nullable(),
});
export type Approver = z.infer<typeof ApproverSchema>;

export const NotificationChannelSchema = z.enum(['whatsapp', 'email', 'slack']);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationStatusSchema = z.enum(['enviado', 'entregado', 'respondido']);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

/** RF-12.4: contenido del mensaje simulado. */
export const NotificationContentSchema = z.object({
  facturaId: z.string(),
  beneficiario: z.string(),
  /** Pueden ser nulos cuando la escalada viene de una extracción fallida. */
  monto: z.number().nullable(),
  moneda: MonedaSchema.nullable(),
  motivo: z.string(),
  resumen: z.string(),
  acciones: z.array(z.string()),
});
export type NotificationContent = z.infer<typeof NotificationContentSchema>;

export const NotificationResponseSchema = z.object({
  accion: z.enum(['aprobar', 'rechazar']),
  quien: z.string(),
  comentario: z.string(),
  fecha: z.string(),
});
export type NotificationResponse = z.infer<typeof NotificationResponseSchema>;

/** RF-12.7: outbox de notificaciones simuladas. */
export const NotificationSchema = z.object({
  id: z.string(),
  invoiceId: z.string(),
  approverId: z.string(),
  approverNombre: z.string(),
  canal: NotificationChannelSchema,
  destinatario: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
  contenido: NotificationContentSchema,
  estado: NotificationStatusSchema,
  respuesta: NotificationResponseSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Notification = z.infer<typeof NotificationSchema>;
