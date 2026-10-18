import { convertToBase, formatMoney } from '../money';
import type { Rule } from '../types';
import { sinExtraccion } from './shared';

/** R7 - Aprobacion humana obligatoria por monto. */
export const r7UmbralHumano: Rule = ({ extraccion, config }) => {
  if (!extraccion) return sinExtraccion();

  const montoBase = convertToBase(extraccion.monto, extraccion.moneda, config);
  if (montoBase === null) {
    return {
      ok: false,
      forzar: 'escala',
      motivo: `No hay una tasa de cambio valida para ${extraccion.moneda}; no se puede comparar con el umbral de aprobacion.`,
    };
  }

  const umbral = config.umbralAprobacionHumana;
  const detalle = { montoBase, umbral, monedaBase: config.monedaBase };

  if (montoBase > umbral) {
    return {
      ok: false,
      motivo:
        `${formatMoney(montoBase, config.monedaBase)} supera el umbral de aprobacion humana de ` +
        `${formatMoney(umbral, config.monedaBase)}: requiere una persona.`,
      detalle,
    };
  }

  return {
    ok: true,
    motivo: `${formatMoney(montoBase, config.monedaBase)} no supera el umbral de aprobacion humana (${formatMoney(umbral, config.monedaBase)}).`,
    detalle,
  };
};
