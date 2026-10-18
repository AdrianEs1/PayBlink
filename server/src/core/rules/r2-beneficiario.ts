import { normalizeKey } from '../text';
import type { Rule } from '../types';
import { sinExtraccion } from './shared';

/** R2 - Beneficiario en la lista permitida. */
export const r2BeneficiarioPermitido: Rule = ({ extraccion, config }) => {
  if (!extraccion) return sinExtraccion();

  const permitidos = config.beneficiariosPermitidos.map(normalizeKey);
  const clave = normalizeKey(extraccion.beneficiario);

  if (permitidos.includes(clave)) {
    return {
      ok: true,
      motivo: `"${extraccion.beneficiario}" esta en la lista de beneficiarios permitidos.`,
      detalle: { beneficiario: extraccion.beneficiario },
    };
  }

  return {
    ok: false,
    motivo:
      `El beneficiario "${extraccion.beneficiario}" no esta en la lista de ${config.beneficiariosPermitidos.length} ` +
      'beneficiarios permitidos por la empresa.',
    detalle: { beneficiario: extraccion.beneficiario },
  };
};
