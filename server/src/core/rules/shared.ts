import type { RuleEvaluation } from '../types';

/** Resultado comun cuando no hay extraccion valida: nunca se asume nada, se escala. */
export function sinExtraccion(
  motivo = 'No hay una extraccion valida de la factura; la regla no puede evaluarse.',
): RuleEvaluation {
  return { ok: false, forzar: 'escala', motivo };
}
