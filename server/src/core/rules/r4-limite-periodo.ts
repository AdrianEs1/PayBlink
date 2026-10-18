import { convertToBase, formatMoney, round2 } from '../money';
import type { Rule } from '../types';
import { sinExtraccion } from './shared';

/**
 * R4 - Limite por periodo.
 * Suma lo ya aprobado en el periodo (ledger) mas esta factura y lo compara con el limite.
 */
export const r4LimitePorPeriodo: Rule = ({ extraccion, config, ledger }) => {
  if (!extraccion) return sinExtraccion();

  const montoBase = convertToBase(extraccion.monto, extraccion.moneda, config);
  if (montoBase === null) {
    return {
      ok: false,
      forzar: 'escala',
      motivo: `No hay una tasa de cambio valida para ${extraccion.moneda}; no se puede calcular el consumo del periodo.`,
    };
  }

  const comprometido = round2(ledger.reduce((total, entry) => total + entry.montoBase, 0));
  const totalConEsta = round2(comprometido + montoBase);
  const limite = config.limitePorPeriodo;
  const detalle = {
    comprometido,
    montoBase,
    total: totalConEsta,
    limitePorPeriodo: limite,
    monedaBase: config.monedaBase,
    pagosEnPeriodo: ledger.length,
  };

  if (totalConEsta <= limite) {
    return {
      ok: true,
      motivo:
        `Con esta factura el periodo llega a ${formatMoney(totalConEsta, config.monedaBase)} de ` +
        `${formatMoney(limite, config.monedaBase)}, dentro del limite.`,
      detalle,
    };
  }

  return {
    ok: false,
    motivo:
      `La suma del periodo llegaria a ${formatMoney(totalConEsta, config.monedaBase)} ` +
      `(${formatMoney(comprometido, config.monedaBase)} ya aprobados + ${formatMoney(montoBase, config.monedaBase)}), ` +
      `por encima del limite por periodo de ${formatMoney(limite, config.monedaBase)}.`,
    detalle,
  };
};
