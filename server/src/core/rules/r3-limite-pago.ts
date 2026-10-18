import { convertToBase, formatMoney } from '../money';
import type { Rule } from '../types';
import { sinExtraccion } from './shared';

/** R3 - Limite por pago (comparado en moneda base). */
export const r3LimitePorPago: Rule = ({ extraccion, config }) => {
  if (!extraccion) return sinExtraccion();

  const montoBase = convertToBase(extraccion.monto, extraccion.moneda, config);
  if (montoBase === null) {
    return {
      ok: false,
      forzar: 'escala',
      motivo: `No hay una tasa de cambio valida para ${extraccion.moneda}; no se puede comparar con el limite por pago.`,
    };
  }

  const limite = config.limitePorPago;
  const detalle = { montoBase, monedaBase: config.monedaBase, limitePorPago: limite };

  if (montoBase <= limite) {
    return {
      ok: true,
      motivo: `${formatMoney(montoBase, config.monedaBase)} esta dentro del limite por pago (${formatMoney(limite, config.monedaBase)}).`,
      detalle,
    };
  }

  return {
    ok: false,
    motivo: `${formatMoney(montoBase, config.monedaBase)} supera el limite por pago de ${formatMoney(limite, config.monedaBase)}.`,
    detalle,
  };
};
