import { convertToBase, formatMoney, round2 } from '../money';
import type { Rule } from '../types';
import { sinExtraccion } from './shared';

/** R5 - Presupuesto o saldo suficiente en el periodo. */
export const r5Presupuesto: Rule = ({ extraccion, config, ledger }) => {
  if (!extraccion) return sinExtraccion();

  const montoBase = convertToBase(extraccion.monto, extraccion.moneda, config);
  if (montoBase === null) {
    return {
      ok: false,
      forzar: 'escala',
      motivo: `No hay una tasa de cambio valida para ${extraccion.moneda}; no se puede verificar el presupuesto.`,
    };
  }

  const comprometido = round2(ledger.reduce((total, entry) => total + entry.montoBase, 0));
  const presupuesto = config.presupuestoPeriodo;
  const disponible = round2(presupuesto - comprometido);
  const detalle = {
    presupuesto,
    comprometido,
    disponible,
    montoBase,
    monedaBase: config.monedaBase,
  };

  if (montoBase <= disponible) {
    return {
      ok: true,
      motivo:
        `Quedan ${formatMoney(disponible, config.monedaBase)} de presupuesto en el periodo; ` +
        `la factura de ${formatMoney(montoBase, config.monedaBase)} cabe.`,
      detalle,
    };
  }

  return {
    ok: false,
    motivo:
      `Presupuesto insuficiente: quedan ${formatMoney(disponible, config.monedaBase)} y la factura es de ` +
      `${formatMoney(montoBase, config.monedaBase)}.`,
    detalle,
  };
};
