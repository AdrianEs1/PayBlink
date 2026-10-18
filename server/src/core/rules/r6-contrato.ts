import { convertToBase, formatMoney, sameAmount } from '../money';
import { normalizeKey } from '../text';
import type { Rule } from '../types';
import { sinExtraccion } from './shared';

/**
 * R6 - Coincide con lo acordado.
 * Si existe un contrato u orden de compra con la misma referencia, el beneficiario,
 * el monto y la moneda deben coincidir exactamente.
 */
export const r6Contrato: Rule = ({ extraccion, config, contratos }) => {
  if (!extraccion) return sinExtraccion();

  const contrato = contratos.find(
    (c) => normalizeKey(c.referencia) === normalizeKey(extraccion.referencia),
  );

  if (!contrato) {
    if (config.exigirContrato) {
      return {
        ok: false,
        motivo: `No existe contrato ni orden de compra con la referencia "${extraccion.referencia}".`,
        detalle: { referencia: extraccion.referencia },
      };
    }
    return {
      ok: true,
      motivo: `No hay contrato ni orden de compra con la referencia "${extraccion.referencia}"; la regla no aplica.`,
      detalle: { referencia: extraccion.referencia, contratoEncontrado: false },
    };
  }

  const problemas: string[] = [];
  if (normalizeKey(contrato.beneficiario) !== normalizeKey(extraccion.beneficiario)) {
    problemas.push(
      `el beneficiario no coincide (factura: "${extraccion.beneficiario}", acordado: "${contrato.beneficiario}")`,
    );
  }
  if (contrato.moneda !== extraccion.moneda) {
    problemas.push(`la moneda no coincide (factura: ${extraccion.moneda}, acordado: ${contrato.moneda})`);
  }

  // El monto se compara en la escritura original y, si la moneda difiere, en moneda base:
  // asi una factura en USD por el equivalente exacto no se reporta como "monto distinto".
  const montoAcordadoBase = convertToBase(contrato.montoAcordado, contrato.moneda, config);
  const montoFacturaBase = convertToBase(extraccion.monto, extraccion.moneda, config);
  const coincideEnBase =
    montoAcordadoBase !== null &&
    montoFacturaBase !== null &&
    sameAmount(montoAcordadoBase, montoFacturaBase);
  if (!sameAmount(contrato.montoAcordado, extraccion.monto) && !coincideEnBase) {
    problemas.push(
      `el monto no coincide (factura: ${formatMoney(extraccion.monto, extraccion.moneda)}, ` +
        `acordado: ${formatMoney(contrato.montoAcordado, contrato.moneda)})`,
    );
  }

  const detalle = {
    contrato: contrato.referencia,
    conceptoAcordado: contrato.concepto,
    montoAcordado: contrato.montoAcordado,
    monedaAcordada: contrato.moneda,
  };

  if (problemas.length > 0) {
    return {
      ok: false,
      motivo: `La factura no coincide con el contrato ${contrato.referencia}: ${problemas.join('; ')}.`,
      detalle,
    };
  }

  return {
    ok: true,
    motivo: `Coincide con el contrato ${contrato.referencia} en beneficiario, monto y moneda.`,
    detalle,
  };
};
