import { z } from 'zod';
import { DecisionSchema, EstadoSchema } from './decision';
import { InvoiceFormatoSchema, ExtractionCheckSchema, InvoiceExtractionSchema, MonedaSchema } from './invoice';
import { RuleResultSchema } from './rules';
import { AgentDescriptionSchema } from './agent';
import { AuditEventSchema } from './audit';
import { QueueStateSchema, SourceInfoSchema } from './ingestion';
import { PaymentOrderSchema } from './payments';
import { ChatMessageSchema } from './chat';

/** Traza de una llamada de tool del agente (RF-4.2, RF-6). */
export const ToolCallSchema = z.object({
  paso: z.number().int().nonnegative(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  resultado: z.string(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** Propuesta del LLM: NUNCA es vinculante (RF-5). */
export const LlmProposalSchema = z.object({
  decision: DecisionSchema,
  razones: z.array(z.string()),
  origen: z.enum(['loop', 'pipeline', 'fallback']),
});
export type LlmProposal = z.infer<typeof LlmProposalSchema>;

/** Decision humana sobre una factura escalada (RF-6, RF-8.3). */
export const HumanDecisionSchema = z.object({
  accion: z.enum(['aprobar', 'rechazar']),
  quien: z.string().min(1),
  comentario: z.string(),
  fecha: z.string(),
});
export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

/** Opciones de una regla tal como se evaluo (para la UI de detalle). */
export const RuleDecisionSchema = z.object({
  regla: z.string(),
  razones: z.array(z.string()),
});
export type RuleDecision = z.infer<typeof RuleDecisionSchema>;

/** Registro completo de auditoria de una factura (RF-6). */
export const DecisionRecordSchema = z.object({
  id: z.string(),
  invoiceId: z.string(),
  archivo: z.string(),
  formato: InvoiceFormatoSchema,
  asunto: z.string().nullable(),
  /** Texto original de la factura (dato no confiable, se muestra tal cual). */
  texto: z.string(),

  extraccion: InvoiceExtractionSchema.nullable(),
  extraccionOk: z.boolean(),
  verificacion: ExtractionCheckSchema.nullable(),

  reglas: z.array(RuleResultSchema),
  toolCalls: z.array(ToolCallSchema),
  propuestaLlm: LlmProposalSchema,

  decisionFinal: DecisionSchema,
  estado: EstadoSchema,
  /** Estado visible en la cola (RF-1.9). */
  queueState: QueueStateSchema,
  /** Verdadero si el guard tuvo que endurecer la propuesta del LLM. */
  guardActuo: z.boolean(),
  /** RF-6: descripcion obligatoria, con sus 5 componentes. */
  descripcion: AgentDescriptionSchema,
  explicacion: z.string(),
  origenExplicacion: z.enum(['llm', 'plantilla']),

  humano: HumanDecisionSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** Fila de la tabla de facturas y decisiones (RF-8.2). */
export const InvoiceListItemSchema = z.object({
  id: z.string(),
  archivo: z.string(),
  formato: InvoiceFormatoSchema,
  asunto: z.string().nullable(),
  procesada: z.boolean(),
  beneficiario: z.string().nullable(),
  monto: z.number().nullable(),
  moneda: MonedaSchema.nullable(),
  montoBase: z.number().nullable(),
  referencia: z.string().nullable(),
  decisionFinal: DecisionSchema.nullable(),
  estado: EstadoSchema.nullable(),
  queueState: QueueStateSchema,
  fuente: SourceInfoSchema.nullable(),
  intentos: z.number().int(),
  ultimoError: z.string().nullable(),
  guardActuo: z.boolean(),
  motivoResumen: z.string(),
  /** RF-6.6: una linea de la descripcion para la tabla de decisiones. */
  descripcionLinea: z.string(),
  confianza: z.number().nullable(),
  inyecciones: z.array(z.string()),
  actualizadoEn: z.string().nullable(),
});
export type InvoiceListItem = z.infer<typeof InvoiceListItemSchema>;

/** RF-8.10 / RF-13.6 / RF-14.2: todo lo que necesita el detalle de una factura. */
export const InvoiceDetailSchema = z.object({
  record: DecisionRecordSchema,
  bitacora: z.array(AuditEventSchema),
  paymentOrder: PaymentOrderSchema.nullable(),
  chat: z.array(ChatMessageSchema),
});
export type InvoiceDetail = z.infer<typeof InvoiceDetailSchema>;

/** Linea del ledger de pagos (RF-7). */
export const LedgerEntrySchema = z.object({
  id: z.string(),
  invoiceId: z.string(),
  beneficiario: z.string(),
  monto: z.number(),
  moneda: MonedaSchema,
  montoBase: z.number(),
  referencia: z.string(),
  fecha: z.string(),
  origen: z.enum(['agente', 'humano']),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** Estado del periodo: consumido, disponible y utilizacion. */
export const BudgetStatusSchema = z.object({
  monedaBase: MonedaSchema,
  presupuestoPeriodo: z.number(),
  comprometido: z.number(),
  disponible: z.number(),
  utilizadoPct: z.number(),
  limitePorPeriodo: z.number(),
  utilizacionLimitePct: z.number(),
});
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;

/** Contadores de la pantalla principal (RF-8.4). */
export const SummarySchema = z.object({
  total: z.number().int(),
  pagados: z.number().int(),
  frenados: z.number().int(),
  pendientes: z.number().int(),
  aprobadosHumanos: z.number().int(),
  rechazadosHumanos: z.number().int(),
  porProcesar: z.number().int(),
  presupuesto: BudgetStatusSchema,
});
export type Summary = z.infer<typeof SummarySchema>;

/** Reporte de la ultima evaluacion (RF-8.4, RF-9.2). */
export const EvaluationReportSchema = z.object({
  total: z.number().int(),
  correctas: z.number().int(),
  autonomia: z.number(),
  seguridad: z.number().int(),
  explicabilidad: z.number(),
  pagosIndebidos: z.array(z.string()),
  /** CA-17: porcentaje de descripciones completas (5 componentes). */
  descripcionOk: z.number().default(0),
  casos: z.array(
    z.object({
      id: z.string(),
      esperado: DecisionSchema,
      obtenido: DecisionSchema,
      estado: EstadoSchema,
      correcto: z.boolean(),
      explicacionOk: z.boolean(),
      descripcionOk: z.boolean().default(false),
      reglasClave: z.array(z.string()),
    }),
  ),
  generadoEn: z.string(),
  modoLlm: z.string(),
});
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;

/** Respuestas de error de la API. */
export const ApiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;
