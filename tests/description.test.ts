import { describe, expect, it } from 'vitest';
import { DECISION_LABEL, RULE_META, type RuleResult } from '@payblink/shared';
import { buildDescription } from '../server/src/core/explain';

function regla(id: RuleResult['id'], resultado: RuleResult['resultado'], motivo: string): RuleResult {
  return { id, regla: id, nombre: RULE_META[id].nombre, resultado, motivo };
}

const reglasOk = (['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'] as const).map((id) =>
  regla(id, 'pasa', 'Cumple.'),
);

const reglasEscala = [
  ...reglasOk.filter((r) => r.id !== 'R7'),
  regla('R7', 'escala', 'El monto supera el umbral de aprobación humana.'),
];

const reglasBloquea = [
  ...reglasOk.filter((r) => r.id !== 'R1'),
  regla('R1', 'bloquea', 'Cobro duplicado exacto.'),
];

const base = {
  beneficiario: 'Ferretería El Tornillo S.A.S.',
  monto: 2450000,
  moneda: 'COP' as const,
  referencia: 'OC-2026-0451',
};

describe('RF-6 / CA-17: descripción con los 5 componentes', () => {
  it('pagar: resumen, qué hizo, decisión, siguiente paso y texto', () => {
    const d = buildDescription({ ...base, decision: 'pagar', propuesta: 'pagar', guardActuo: false, reglas: reglasOk });
    expect(d.resumen.length).toBeGreaterThan(20);
    expect(d.queHizo.length).toBeGreaterThan(0);
    expect(d.decisionYReglas).toContain(DECISION_LABEL.pagar);
    expect(d.siguientePaso).toContain('orden de pago');
    expect(d.texto.length).toBeGreaterThan(40);
    expect(d.cambioGuard).toBeNull();
  });

  it('escalar: incluye la regla que se activó y qué debe decidir la persona', () => {
    const d = buildDescription({ ...base, decision: 'escalar', propuesta: 'pagar', guardActuo: true, reglas: reglasEscala });
    expect(d.decisionYReglas).toContain('R7');
    expect(d.decisionYReglas).toContain(DECISION_LABEL.escalar);
    expect(d.cambioGuard).toContain('Propuse "pagar"');
    expect(d.siguientePaso.toLowerCase()).toContain('aprobar o rechazar');
  });

  it('frenar: explica el bloqueo y que no admite aprobación', () => {
    const d = buildDescription({ ...base, decision: 'frenar', propuesta: 'pagar', guardActuo: true, reglas: reglasBloquea });
    expect(d.decisionYReglas).toContain('R1');
    expect(d.decisionYReglas).toContain(DECISION_LABEL.frenar);
    expect(d.siguientePaso).toContain('confirmar el rechazo');
  });

  it('fallo irrecuperable: nunca deja la descripción vacía y explica el error', () => {
    const d = buildDescription({
      ...base,
      beneficiario: null,
      monto: null,
      moneda: null,
      referencia: null,
      decision: 'escalar',
      propuesta: 'escalar',
      guardActuo: false,
      reglas: reglasEscala,
      errorFatal: 'Gemini no respondió (timeout).',
    });
    expect(d.resumen).toContain('timeout');
    expect(d.texto).toContain(DECISION_LABEL.escalar);
    expect(d.siguientePaso.length).toBeGreaterThan(10);
  });

  it('CA-18: una narrativa que contradice la decisión se descarta', () => {
    const d = buildDescription({
      ...base,
      decision: 'escalar',
      propuesta: 'pagar',
      guardActuo: true,
      reglas: reglasEscala,
      narrativaLlm: 'Registré el pago porque todo estaba en orden.',
    });
    expect(d.resumen).not.toContain('Registré el pago');
    expect(d.texto).toContain(DECISION_LABEL.escalar);
  });
});
