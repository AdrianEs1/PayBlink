import {
  RULE_IDS,
  RULE_META,
  type Decision,
  type RuleOutcome,
  type RuleResult,
} from '@payblink/shared';
import { RULES } from './rules';
import type { RuleContext } from './types';

/**
 * RF-3.2: se evaluan TODAS las reglas, nunca se corta en la primera.
 * Asi el registro de auditoria queda completo y explicable.
 */
export function evaluateRules(ctx: RuleContext): RuleResult[] {
  return RULE_IDS.map<RuleResult>((id) => {
    const meta = RULE_META[id];
    const config = ctx.config.reglas[id];
    const nombre = `${id} - ${meta.nombre}`;

    if (!config || !config.activa) {
      return {
        id,
        regla: id,
        nombre,
        resultado: 'pasa',
        motivo: 'Regla desactivada en el archivo de configuracion.',
      };
    }

    const evaluacion = RULES[id](ctx);
    const resultado: RuleOutcome = evaluacion.ok
      ? 'pasa'
      : (evaluacion.forzar ?? config.severidad);

    return {
      id,
      regla: id,
      nombre,
      resultado,
      motivo: evaluacion.motivo,
      ...(evaluacion.detalle ? { detalle: evaluacion.detalle } : {}),
    };
  });
}

/**
 * Veredicto del motor: la decision mas restrictiva implicada por las reglas.
 * bloquea -> frenar (cualquier bloqueo gana). escala -> escalar. si no -> pagar.
 */
export function engineVerdict(results: readonly RuleResult[]): Decision {
  if (results.some((r) => r.resultado === 'bloquea')) return 'frenar';
  if (results.some((r) => r.resultado === 'escala')) return 'escalar';
  return 'pagar';
}

/** Motivos que impiden el pago, agrupados por severidad (para la UI y la explicacion). */
export function motivosRelevantes(results: readonly RuleResult[]): {
  bloqueos: string[];
  escalamientos: string[];
} {
  const bloqueos: string[] = [];
  const escalamientos: string[] = [];
  for (const r of results) {
    if (r.resultado === 'bloquea') bloqueos.push(`${r.nombre}: ${r.motivo}`);
    else if (r.resultado === 'escala') escalamientos.push(`${r.nombre}: ${r.motivo}`);
  }
  return { bloqueos, escalamientos };
}
