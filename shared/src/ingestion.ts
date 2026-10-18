import { z } from 'zod';

/** RF-1.9: estados visibles de una factura en la cola. */
export const QueueStateSchema = z.enum([
  'pendiente',
  'en_cola',
  'procesando',
  'pagada',
  'frenada',
  'escalada',
  'error',
]);
export type QueueState = z.infer<typeof QueueStateSchema>;

export const QUEUE_STATE_LABEL: Record<QueueState, string> = {
  pendiente: 'Pendiente',
  en_cola: 'En cola',
  procesando: 'Procesando',
  pagada: 'Pagada',
  frenada: 'Frenada',
  escalada: 'Escalada',
  error: 'Error',
};

/** RF-1.8: manual (boton) o automatico (simula el webhook de produccion). */
export const IngestModeSchema = z.enum(['manual', 'automatico']);
export type IngestMode = z.infer<typeof IngestModeSchema>;

/** RF-1.4 / RF-11.5: de donde vino cada factura. */
export const SourceInfoSchema = z.object({
  conector: z.string().min(1),
  conectorNombre: z.string().min(1),
  canal: z.string().min(1),
  etiqueta: z.string().min(1),
  remitente: z.string().nullable(),
  mensajeId: z.string().nullable(),
  recibidoEn: z.string(),
});
export type SourceInfo = z.infer<typeof SourceInfoSchema>;

/** RF-1.6: entrada creada desde la pantalla Entradas. */
export const IngestEntrySchema = z.object({
  /** Identificador opcional (los ejemplos de la galeria lo fijan para la cache del LLM). */
  id: z.string().regex(/^[A-Za-z0-9_-]{3,60}$/).optional(),
  tipo: z.enum(['pdf', 'correo', 'chat']),
  remitente: z.string().max(200).optional(),
  asunto: z.string().max(300).optional(),
  cuerpo: z.string().max(20_000).optional(),
  canal: z.enum(['slack', 'whatsapp', 'interno']).optional(),
  archivoNombre: z.string().max(200).optional(),
  archivoBase64: z.string().optional(),
});
export type IngestEntry = z.infer<typeof IngestEntrySchema>;

/** RF-1.6: ejemplo de la galeria (normal o trampa). */
export const IngestExampleSchema = z.object({
  id: z.string(),
  titulo: z.string(),
  descripcion: z.string(),
  caso: z.enum(['normal', 'trampa']),
  entry: IngestEntrySchema,
});
export type IngestExample = z.infer<typeof IngestExampleSchema>;

/** Resultado de una ingesta. */
export const IngestResultSchema = z.object({
  invoiceId: z.string(),
  duplicada: z.boolean(),
  queueState: QueueStateSchema,
  enCola: z.boolean(),
});
export type IngestResult = z.infer<typeof IngestResultSchema>;

/** RF-1.9: fila de la cola para la UI. */
export const QueueItemSchema = z.object({
  id: z.string(),
  archivo: z.string(),
  asunto: z.string().nullable(),
  formato: z.string(),
  queueState: QueueStateSchema,
  intentos: z.number().int(),
  ultimoError: z.string().nullable(),
  fuente: SourceInfoSchema.nullable(),
  decisionFinal: z.enum(['pagar', 'escalar', 'frenar']).nullable(),
  recibidoEn: z.string(),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;
