import { CAMPOS_OBLIGATORIOS } from '@blinka/shared';
import { daysBetween, isValidIsoDate } from '../period';
import type { Rule } from '../types';

/** Una factura vencida mas de estos dias respecto a la fecha de referencia requiere revision. */
const DIAS_VENCIDA_TOLERADOS = 30;
/** Un vencimiento a mas de un ano de la fecha de referencia se considera incoherente. */
const DIAS_FUTURO_MAXIMO = 365;

/**
 * R8 - Datos obligatorios completos y extraccion verificada.
 * Incluye la coherencia de fechas contra la fecha de referencia configurada.
 */
export const r8DatosCompletos: Rule = ({ extraccion, verificacion, config }) => {
  if (!extraccion) {
    return {
      ok: false,
      forzar: 'escala',
      motivo: 'La extraccion no produjo datos validos: faltan campos obligatorios o el formato no es interpretable.',
      detalle: { camposObligatorios: [...CAMPOS_OBLIGATORIOS] },
    };
  }

  const motivos: string[] = [];

  if (!verificacion) {
    motivos.push('No se pudo verificar la extraccion contra el texto original de la factura.');
  } else {
    if (!verificacion.beneficiarioPresente) {
      motivos.push(`El beneficiario "${extraccion.beneficiario}" no aparece en el texto de la factura.`);
    }
    if (!verificacion.montoPresente) {
      motivos.push(`El monto ${extraccion.monto} ${extraccion.moneda} no aparece en el texto de la factura.`);
    }
    if (verificacion.montoAmbiguo) {
      motivos.push(
        'El formato numerico del monto es ambiguo: admite dos lecturas (por ejemplo 1.500 frente a 1,500) y no se puede resolver con certeza.',
      );
    }
    if (!verificacion.ok && motivos.length === 0) {
      motivos.push('La verificacion de la extraccion contra el texto fallo.');
    }
  }

  if (extraccion.confianza < config.confianzaMinima) {
    motivos.push(
      `La confianza de la extraccion (${extraccion.confianza.toFixed(2)}) esta por debajo del minimo configurado (${config.confianzaMinima.toFixed(2)}).`,
    );
  }

  // Coherencia de fechas contra la fecha de referencia (RF-3.4).
  if (!isValidIsoDate(extraccion.fechaVencimiento)) {
    motivos.push(`La fecha de vencimiento "${extraccion.fechaVencimiento}" no es una fecha valida.`);
  } else {
    const dias = daysBetween(config.fechaReferencia, extraccion.fechaVencimiento);
    if (dias === null) {
      motivos.push('No se pudo comparar la fecha de vencimiento con la fecha de referencia.');
    } else if (dias < -DIAS_VENCIDA_TOLERADOS) {
      motivos.push(
        `La factura esta vencida hace ${Math.abs(dias)} dias respecto a la fecha de referencia del periodo (${config.fechaReferencia}).`,
      );
    } else if (dias > DIAS_FUTURO_MAXIMO) {
      motivos.push(
        `La fecha de vencimiento esta ${dias} dias en el futuro respecto a la fecha de referencia; es incoherente.`,
      );
    }
  }

  const unicos = [...new Set(motivos)];
  if (unicos.length > 0) {
    return {
      ok: false,
      motivo: unicos.join(' '),
      detalle: { motivos: unicos, confianza: extraccion.confianza, confianzaMinima: config.confianzaMinima },
    };
  }

  return {
    ok: true,
    motivo: 'Datos obligatorios completos, extraccion verificada contra el texto y fechas coherentes.',
    detalle: { confianza: extraccion.confianza, confianzaMinima: config.confianzaMinima },
  };
};
