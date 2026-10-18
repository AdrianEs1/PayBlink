import { z } from 'zod';
import { MonedaSchema, IsoDateSchema } from './invoice';

/** Identificadores del motor de reglas (RF-3). */
export const RULE_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'] as const;
export const RuleIdSchema = z.enum(RULE_IDS);
export type RuleId = z.infer<typeof RuleIdSchema>;

/** Metadatos legibles: la UI muestra esto sin mirar el codigo (RNF-2). */
export const RULE_META: Record<RuleId, { nombre: string; descripcion: string }> = {
  R1: {
    nombre: 'Cobro duplicado',
    descripcion:
      'El mismo beneficiario, monto y referencia ya fueron decididos en el periodo. Bloquea.',
  },
  R2: {
    nombre: 'Beneficiario permitido',
    descripcion: 'El beneficiario debe estar en la lista autorizada por la empresa.',
  },
  R3: {
    nombre: 'Limite por pago',
    descripcion: 'El monto, convertido a la moneda base, no debe superar el limite por pago.',
  },
  R4: {
    nombre: 'Limite por periodo',
    descripcion:
      'La suma de lo ya aprobado en el periodo mas esta factura no debe superar el limite del periodo.',
  },
  R5: {
    nombre: 'Presupuesto disponible',
    descripcion: 'Debe quedar saldo suficiente en el presupuesto del periodo.',
  },
  R6: {
    nombre: 'Coincide con lo acordado',
    descripcion:
      'Si existe un contrato u orden de compra, el monto, la moneda y el beneficiario deben coincidir.',
  },
  R7: {
    nombre: 'Aprobacion humana por monto',
    descripcion: 'Sobre el umbral configurado, siempre requiere una persona.',
  },
  R8: {
    nombre: 'Datos completos y verificados',
    descripcion:
      'Campos obligatorios presentes, extraccion verificada literalmente contra el texto y fechas coherentes con la fecha de referencia.',
  },
};

export const RuleOutcomeSchema = z.enum(['pasa', 'escala', 'bloquea']);
export type RuleOutcome = z.infer<typeof RuleOutcomeSchema>;

export const OUTCOME_LABEL: Record<RuleOutcome, string> = {
  pasa: 'Pasa',
  escala: 'Escala',
  bloquea: 'Bloquea',
};

/** Lo que devuelve cada regla (RF-3: funcion pura). */
export const RuleResultSchema = z.object({
  id: RuleIdSchema,
  regla: z.string(),
  nombre: z.string(),
  resultado: RuleOutcomeSchema,
  motivo: z.string(),
  detalle: z.record(z.string(), z.unknown()).optional(),
});
export type RuleResult = z.infer<typeof RuleResultSchema>;

/** Configuracion por regla: activa y que severidad usa al incumplirse (RF-3.1). */
export const ReglaConfigSchema = z.object({
  activa: z.boolean(),
  severidad: z.enum(['escala', 'bloquea']),
});
export type ReglaConfig = z.infer<typeof ReglaConfigSchema>;

/**
 * Configuracion completa editable desde `data/rules.json` y desde la UI (RF-8.1).
 * Es la entrada del motor de reglas; el motor no lee nada mas.
 */
export const RulesConfigSchema = z.object({
  /** Fecha de referencia para calcular periodos y vencimientos (RF-3.4). */
  fechaReferencia: IsoDateSchema,
  monedaBase: MonedaSchema,
  /** Tasas fijas de conversion a moneda base (RF-3.3). */
  tasas: z.record(MonedaSchema, z.number().positive()),
  limitePorPago: z.number().positive(),
  limitePorPeriodo: z.number().positive(),
  presupuestoPeriodo: z.number().positive(),
  umbralAprobacionHumana: z.number().positive(),
  confianzaMinima: z.number().min(0).max(1),
  /** Si es true, una factura sin contrato/OC asociado escala (R6). */
  exigirContrato: z.boolean(),
  beneficiariosPermitidos: z.array(z.string().min(1)).min(1),
  reglas: z.record(RuleIdSchema, ReglaConfigSchema),
});
export type RulesConfig = z.infer<typeof RulesConfigSchema>;

/** Contrato u orden de compra (R6). */
export const ContractSchema = z.object({
  referencia: z.string().min(1),
  beneficiario: z.string().min(1),
  montoAcordado: z.number().positive(),
  moneda: MonedaSchema,
  concepto: z.string().min(1),
  fecha: IsoDateSchema,
});
export type Contract = z.infer<typeof ContractSchema>;
