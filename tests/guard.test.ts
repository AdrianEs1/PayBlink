import { describe, expect, it } from 'vitest';
import { mostRestrictive, mostRestrictiveOf, RULE_META } from '@payblink/shared';
import { applyGuard } from '../server/src/core/guard';
import { evaluateRules } from '../server/src/core/engine';
import { contexto } from './helpers';
import type { RuleResult } from '@payblink/shared';

function regla(id: RuleResult['id'], resultado: RuleResult['resultado']): RuleResult {
  return {
    id,
    regla: id,
    nombre: `${id} - ${RULE_META[id].nombre}`,
    resultado,
    motivo: `Resultado simulado: ${resultado}.`,
  };
}

describe('orden de restrictividad (RF-5.1)', () => {
  it('pagar < escalar < frenar', () => {
    expect(mostRestrictive('pagar', 'escalar')).toBe('escalar');
    expect(mostRestrictive('escalar', 'frenar')).toBe('frenar');
    expect(mostRestrictive('pagar', 'pagar')).toBe('pagar');
    expect(mostRestrictive('frenar', 'pagar')).toBe('frenar');
    expect(mostRestrictiveOf(['pagar', 'escalar', 'pagar'])).toBe('escalar');
  });
});

describe('guard de seguridad (RF-5)', () => {
  it('el LLM nunca puede ser mas laxo que el motor', () => {
    const salida = applyGuard({ propuesta: 'pagar', reglas: [regla('R7', 'escala')] });
    expect(salida.decisionFinal).toBe('escalar');
    expect(salida.guardActuo).toBe(true);
  });

  it('el LLM puede ser mas estricto que el motor', () => {
    const salida = applyGuard({ propuesta: 'frenar', reglas: [regla('R2', 'pasa')] });
    expect(salida.decisionFinal).toBe('frenar');
    expect(salida.veredictoMotor).toBe('pagar');
  });

  it('un bloqueo gana sobre todo lo demas', () => {
    const salida = applyGuard({
      propuesta: 'pagar',
      reglas: [regla('R1', 'bloquea'), regla('R3', 'escala')],
    });
    expect(salida.decisionFinal).toBe('frenar');
    expect(salida.bloqueos).toHaveLength(1);
  });

  it('la aprobacion humana solo puede convertir una escalada en pago (RF-5.4)', () => {
    const aprobado = applyGuard({
      propuesta: 'escalar',
      reglas: [regla('R7', 'escala')],
      aprobacionHumana: true,
    });
    expect(aprobado.decisionFinal).toBe('pagar');

    const conBloqueo = applyGuard({
      propuesta: 'escalar',
      reglas: [regla('R1', 'bloquea')],
      aprobacionHumana: true,
    });
    expect(conBloqueo.decisionFinal).toBe('frenar');
  });
});

describe('motor de reglas (RF-3.2)', () => {
  it('evalua siempre las ocho reglas', () => {
    const reglas = evaluateRules(contexto());
    expect(reglas).toHaveLength(8);
    expect(reglas.map((r) => r.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']);
  });

  it('sin extraccion valida todas las reglas que la necesitan escalan', () => {
    const reglas = evaluateRules(contexto());
    const escaladas = reglas.filter((r) => r.resultado === 'escala').map((r) => r.id);
    expect(escaladas).toContain('R8');
    expect(escaladas).toContain('R2');
  });

  it('respeta la desactivacion de una regla (RF-3.1)', () => {
    const config = { ...contexto().config, reglas: { ...contexto().config.reglas } };
    config.reglas.R8 = { activa: false, severidad: 'escala' };
    const reglas = evaluateRules(contexto({ config }));
    const r8 = reglas.find((r) => r.id === 'R8');
    expect(r8?.resultado).toBe('pasa');
    expect(r8?.motivo).toContain('desactivada');
  });
});
