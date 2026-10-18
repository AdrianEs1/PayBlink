import type { RuleId } from '@payblink/shared';
import type { Rule } from '../types';
import { r1Duplicado } from './r1-duplicado';
import { r2BeneficiarioPermitido } from './r2-beneficiario';
import { r3LimitePorPago } from './r3-limite-pago';
import { r4LimitePorPeriodo } from './r4-limite-periodo';
import { r5Presupuesto } from './r5-presupuesto';
import { r6Contrato } from './r6-contrato';
import { r7UmbralHumano } from './r7-umbral';
import { r8DatosCompletos } from './r8-datos';

/**
 * Registro de reglas. Una regla por archivo (RNF-6) y todas con la misma firma,
 * para que el motor las recorra sin casos especiales.
 */
export const RULES: Record<RuleId, Rule> = {
  R1: r1Duplicado,
  R2: r2BeneficiarioPermitido,
  R3: r3LimitePorPago,
  R4: r4LimitePorPeriodo,
  R5: r5Presupuesto,
  R6: r6Contrato,
  R7: r7UmbralHumano,
  R8: r8DatosCompletos,
};

export { r1Duplicado, r2BeneficiarioPermitido, r3LimitePorPago, r4LimitePorPeriodo };
export { r5Presupuesto, r6Contrato, r7UmbralHumano, r8DatosCompletos };
