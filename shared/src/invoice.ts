import { z } from 'zod';

export const MONEDAS = ['COP', 'USD', 'EUR'] as const;
export const MonedaSchema = z.enum(MONEDAS);
export type Moneda = z.infer<typeof MonedaSchema>;

/** Formatos de entrada aceptados por la ingesta (RF-1.1). */
export const InvoiceFormatoSchema = z.enum(['correo', 'chat', 'pdf', 'imagen', 'texto']);
export type InvoiceFormato = z.infer<typeof InvoiceFormatoSchema>;

/** Fecha ISO corta: YYYY-MM-DD. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const IsoDateSchema = z.string().regex(ISO_DATE, 'la fecha debe tener formato YYYY-MM-DD');

/**
 * Datos que el agente debe extraer de cada factura (RF-2.1).
 * `fechaVencimiento` es obligatoria: si falta, el resultado es escalar (RF-2.3).
 */
export const InvoiceExtractionSchema = z.object({
  beneficiario: z.string().min(1),
  monto: z.number().positive().finite(),
  moneda: MonedaSchema,
  fechaVencimiento: IsoDateSchema,
  referencia: z.string().min(1),
  concepto: z.string().min(1),
  /** Confianza auto-reportada por el LLM, 0..1. */
  confianza: z.number().min(0).max(1),
});
export type InvoiceExtraction = z.infer<typeof InvoiceExtractionSchema>;

/** Campos obligatorios para poder decidir sin intervencion humana. */
export const CAMPOS_OBLIGATORIOS = [
  'beneficiario',
  'monto',
  'moneda',
  'fechaVencimiento',
  'referencia',
  'concepto',
] as const satisfies readonly (keyof InvoiceExtraction)[];

/**
 * Salida cruda del LLM: permisiva a proposito.
 * El LLM puede devolver numeros como texto, campos nulos o basura.
 * La normalizacion y la validacion estricta ocurren en `extraction/`.
 */
export const RawExtractionSchema = z.object({
  beneficiario: z.unknown().optional(),
  monto: z.unknown().optional(),
  moneda: z.unknown().optional(),
  fechaVencimiento: z.unknown().optional(),
  referencia: z.unknown().optional(),
  concepto: z.unknown().optional(),
  confianza: z.unknown().optional(),
});
export type RawExtraction = z.infer<typeof RawExtractionSchema>;

/** Resultado de la verificacion literal de la extraccion (RF-2.2). */
export const ExtractionCheckSchema = z.object({
  beneficiarioPresente: z.boolean(),
  montoPresente: z.boolean(),
  /** Si el formato numerico del texto es ambiguo y no se pudo resolver (RF-2.4). */
  montoAmbiguo: z.boolean(),
  /** Frases detectadas dentro de la factura con intencion de instruir al agente (RF-2.5). */
  inyeccionesDetectadas: z.array(z.string()),
  ok: z.boolean(),
  motivos: z.array(z.string()),
});
export type ExtractionCheck = z.infer<typeof ExtractionCheckSchema>;

/** Factura tal como vive en la base de datos. */
export const InvoiceSchema = z.object({
  id: z.string(),
  archivo: z.string(),
  formato: InvoiceFormatoSchema,
  asunto: z.string().nullable(),
  texto: z.string(),
  remitente: z.string().nullable(),
  createdAt: z.string(),
});
export type Invoice = z.infer<typeof InvoiceSchema>;
