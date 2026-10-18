import { z } from 'zod';

/**
 * RF-4 / RF-5: la decision final es la mas restrictiva (pagar < escalar < frenar).
 * Este modulo es codigo puro y determinista: no conoce el LLM ni la base de datos.
 */

export const DecisionSchema = z.enum(['pagar', 'escalar', 'frenar']);
export type Decision = z.infer<typeof DecisionSchema>;

/** Orden de restrictividad. Mayor numero = mas restrictivo. */
export const DECISION_SEVERITY: Record<Decision, number> = {
  pagar: 0,
  escalar: 1,
  frenar: 2,
};

export const DECISION_LABEL: Record<Decision, string> = {
  pagar: 'Pagar',
  escalar: 'Escalar a una persona',
  frenar: 'Frenar',
};

/**
 * Devuelve la decision mas restrictiva entre dos.
 * Es la primitiva del guard de seguridad (RF-5.1/RF-5.2).
 */
export function mostRestrictive(a: Decision, b: Decision): Decision {
  return DECISION_SEVERITY[a] >= DECISION_SEVERITY[b] ? a : b;
}

/** Reduce una lista de decisiones a la mas restrictiva. */
export function mostRestrictiveOf(decisiones: readonly Decision[]): Decision {
  return decisiones.reduce<Decision>(mostRestrictive, 'pagar');
}

/** Estado visible de una factura en la UI (RF-8.2). */
export const EstadoSchema = z.enum([
  'pagado',
  'frenado',
  'pendiente_aprobacion',
  'aprobado_humano',
  'rechazado_humano',
]);
export type Estado = z.infer<typeof EstadoSchema>;

export const ESTADO_LABEL: Record<Estado, string> = {
  pagado: 'Pago registrado',
  frenado: 'Frenado',
  pendiente_aprobacion: 'Pendiente de aprobacion',
  aprobado_humano: 'Aprobado por humano',
  rechazado_humano: 'Rechazado por humano',
};

/** Traduce la decision del motor/guard al estado inicial que ve la UI. */
export function decisionToEstado(decision: Decision): Estado {
  if (decision === 'pagar') return 'pagado';
  if (decision === 'frenar') return 'frenado';
  return 'pendiente_aprobacion';
}
