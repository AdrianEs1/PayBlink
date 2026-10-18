import { mostRestrictive, type Decision, type RuleResult } from '@payblink/shared';
import { engineVerdict, motivosRelevantes } from './engine';

/**
 * RF-5: el guard es el unico lugar donde se fija la decision final.
 *
 *   decisionFinal = mostRestrictive(propuestaLLM, veredictoMotor)
 *
 * El LLM puede ser MAS estricto que el motor, nunca mas laxo (RF-5.2).
 * Ninguna ruta del codigo puede saltarse esta funcion (RF-5.3, RF-5.4).
 */
export interface GuardInput {
  /** Lo que propuso el LLM. Nunca es vinculante. */
  propuesta: Decision;
  reglas: readonly RuleResult[];
  /**
   * Excepcion explicita y auditada: una persona aprobo una factura previamente escalada.
   * Solo en ese caso se permite pasar de 'escalar' a 'pagar'.
   */
  aprobacionHumana?: boolean;
}

export interface GuardOutcome {
  propuesta: Decision;
  veredictoMotor: Decision;
  decisionFinal: Decision;
  /** true si el guard endurecio la propuesta del LLM. */
  guardActuo: boolean;
  bloqueos: string[];
  escalamientos: string[];
}

export function applyGuard({ propuesta, reglas, aprobacionHumana = false }: GuardInput): GuardOutcome {
  const veredictoMotor = engineVerdict(reglas);
  const { bloqueos, escalamientos } = motivosRelevantes(reglas);

  // Un bloqueo nunca se levanta, ni siquiera con aprobacion humana (RF-5.4).
  if (bloqueos.length > 0) {
    return {
      propuesta,
      veredictoMotor,
      decisionFinal: 'frenar',
      guardActuo: propuesta !== 'frenar',
      bloqueos,
      escalamientos,
    };
  }

  if (aprobacionHumana) {
    return {
      propuesta,
      veredictoMotor,
      decisionFinal: 'pagar',
      guardActuo: propuesta !== 'pagar',
      bloqueos,
      escalamientos,
    };
  }

  const decisionFinal = mostRestrictive(propuesta, veredictoMotor);
  return {
    propuesta,
    veredictoMotor,
    decisionFinal,
    guardActuo: decisionFinal !== propuesta,
    bloqueos,
    escalamientos,
  };
}
