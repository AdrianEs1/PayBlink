import { formatMoney, sameAmount } from '../money';
import { normalizeKey, similarity } from '../text';
import type { Rule } from '../types';
import { sinExtraccion } from './shared';

/** Estados que NO cuentan como "cobro ya decidido". */
const ESTADOS_IGNORADOS = new Set(['rechazado_humano']);

/** Umbral de similitud para considerar dos referencias "casi iguales". */
const UMBRAL_REFERENCIA_SIMILAR = 0.75;

/**
 * R1 - Cobro duplicado.
 * Exacto (mismo beneficiario, monto y referencia) -> usa la severidad configurada (bloquea).
 * Casi duplicado (mismo beneficiario y monto, referencia parecida) -> escala.
 */
export const r1Duplicado: Rule = ({ extraccion, historial }) => {
  if (!extraccion) return sinExtraccion('Sin extraccion valida no se pueden comprobar duplicados.');

  const claveBeneficiario = normalizeKey(extraccion.beneficiario);
  const claveReferencia = normalizeKey(extraccion.referencia);
  const candidatos = historial.filter((h) => !ESTADOS_IGNORADOS.has(h.estado));
  const montoTexto = formatMoney(extraccion.monto, extraccion.moneda);

  const exacto = candidatos.find(
    (h) =>
      normalizeKey(h.beneficiario) === claveBeneficiario &&
      sameAmount(h.monto, extraccion.monto) &&
      normalizeKey(h.referencia) === claveReferencia,
  );
  if (exacto) {
    return {
      ok: false,
      motivo:
        `Cobro duplicado: la factura ${exacto.invoiceId} ya fue decidida con el mismo beneficiario ` +
        `(${extraccion.beneficiario}), el mismo monto (${montoTexto}) y la misma referencia (${extraccion.referencia}).`,
      detalle: { tipo: 'exacto', duplicadoDe: exacto.invoiceId, estadoPrevio: exacto.estado },
    };
  }

  const cercano = candidatos.find(
    (h) =>
      normalizeKey(h.beneficiario) === claveBeneficiario &&
      sameAmount(h.monto, extraccion.monto) &&
      claveReferencia.length > 0 &&
      similarity(normalizeKey(h.referencia), claveReferencia) >= UMBRAL_REFERENCIA_SIMILAR,
  );
  if (cercano) {
    return {
      ok: false,
      forzar: 'escala',
      motivo:
        `Posible duplicado: la factura ${cercano.invoiceId} tiene el mismo beneficiario y el mismo monto (${montoTexto}) ` +
        `con una referencia casi identica (${cercano.referencia} frente a ${extraccion.referencia}).`,
      detalle: { tipo: 'cercano', duplicadoDe: cercano.invoiceId, referenciaPrevia: cercano.referencia },
    };
  }

  return {
    ok: true,
    motivo: 'No hay cobros previos con el mismo beneficiario, monto y referencia.',
  };
};
