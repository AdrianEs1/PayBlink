import { describe, expect, it } from 'vitest';
import type { InvoiceExtraction, LedgerEntry } from '@payblink/shared';
import { evaluateRules } from '../server/src/core/engine';
import { RULES } from '../server/src/core/rules';
import { contexto, previo } from './helpers';

const base: InvoiceExtraction = {
  beneficiario: 'Ferretería El Tornillo S.A.S.',
  monto: 2450000,
  moneda: 'COP',
  fechaVencimiento: '2026-10-25',
  referencia: 'OC-2026-0451',
  concepto: 'Tornillería y herramienta menor para bodega',
  confianza: 0.97,
};

const verificacionOk = {
  beneficiarioPresente: true,
  montoPresente: true,
  montoAmbiguo: false,
  inyeccionesDetectadas: [],
  ok: true,
  motivos: [],
};

function ledger(montoBase: number, id = 'INV-X'): LedgerEntry {
  return {
    id: `L-${id}`,
    invoiceId: id,
    beneficiario: 'Proveedor',
    monto: montoBase,
    moneda: 'COP',
    montoBase,
    referencia: 'OC-X',
    fecha: '2026-10-16',
    origen: 'agente',
  };
}

describe('R1 - cobro duplicado', () => {
  it('bloquea un duplicado exacto', () => {
    const resultado = RULES.R1(contexto({ extraccion: base, historial: [previo()] }));
    expect(resultado.ok).toBe(false);
    expect(resultado.forzar).toBeUndefined(); // usa la severidad configurada (bloquea)
  });

  it('escala un duplicado con referencia casi igual', () => {
    const resultado = RULES.R1(
      contexto({
        extraccion: { ...base, referencia: 'OC-2026-0451B' },
        historial: [previo({ referencia: 'OC-2026-0451' })],
      }),
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.forzar).toBe('escala');
  });

  it('no marca como duplicado si el monto es distinto', () => {
    const resultado = RULES.R1(
      contexto({ extraccion: { ...base, monto: 999 }, historial: [previo()] }),
    );
    expect(resultado.ok).toBe(true);
  });

  it('ignora las facturas rechazadas por una persona', () => {
    const resultado = RULES.R1(
      contexto({ extraccion: base, historial: [previo({ estado: 'rechazado_humano' })] }),
    );
    expect(resultado.ok).toBe(true);
  });
});

describe('R2 - beneficiario permitido', () => {
  it('acepta un beneficiario de la lista', () => {
    expect(RULES.R2(contexto({ extraccion: base })).ok).toBe(true);
  });

  it('escala un beneficiario nuevo', () => {
    const resultado = RULES.R2(
      contexto({ extraccion: { ...base, beneficiario: 'Muebles y Enseres del Caribe S.A.S.' } }),
    );
    expect(resultado.ok).toBe(false);
  });
});

describe('R3 - limite por pago', () => {
  it('pasa por debajo del limite', () => {
    expect(RULES.R3(contexto({ extraccion: base })).ok).toBe(true);
  });

  it('escala por encima del limite', () => {
    expect(RULES.R3(contexto({ extraccion: { ...base, monto: 20000000 } })).ok).toBe(false);
  });

  it('compara en moneda base', () => {
    // 4000 USD = 16.200.000 COP, por encima del limite de 15.000.000.
    const resultado = RULES.R3(
      contexto({ extraccion: { ...base, monto: 4000, moneda: 'USD' } }),
    );
    expect(resultado.ok).toBe(false);
  });
});

describe('R4 - limite por periodo', () => {
  it('suma el ledger del periodo', () => {
    const resultado = RULES.R4(
      contexto({ extraccion: base, ledger: [ledger(39000000)] }),
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.detalle?.total).toBe(41450000);
  });

  it('pasa si todavia cabe', () => {
    expect(RULES.R4(contexto({ extraccion: base, ledger: [ledger(1000000)] })).ok).toBe(true);
  });
});

describe('R5 - presupuesto disponible', () => {
  it('escala cuando falta presupuesto', () => {
    const resultado = RULES.R5(contexto({ extraccion: base, ledger: [ledger(44000000)] }));
    expect(resultado.ok).toBe(false);
  });
});

describe('R6 - coincide con lo acordado', () => {
  it('acepta la coincidencia exacta', () => {
    expect(RULES.R6(contexto({ extraccion: base })).ok).toBe(true);
  });

  it('escala si el monto no cuadra', () => {
    const resultado = RULES.R6(contexto({ extraccion: { ...base, monto: 1600000 } }));
    expect(resultado.ok).toBe(false);
    expect(resultado.motivo).toContain('monto no coincide');
  });

  it('escala si la moneda no cuadra aunque el valor en base coincida', () => {
    const resultado = RULES.R6(
      contexto({ extraccion: { ...base, monto: 4860000, referencia: 'OC-2026-0471', beneficiario: 'Tecnología y Redes del Sur S.A.S.', moneda: 'COP' } }),
    );
    expect(resultado.ok).toBe(true); // control: el contrato esta en COP

    const conMoneda = RULES.R6(
      contexto({
        extraccion: {
          ...base,
          monto: 1200,
          moneda: 'USD',
          referencia: 'OC-2026-0471',
          beneficiario: 'Tecnología y Redes del Sur S.A.S.',
        },
      }),
    );
    expect(conMoneda.ok).toBe(false);
    expect(conMoneda.motivo).toContain('moneda no coincide');
  });

  it('escala si se exige contrato y no existe', () => {
    const config = { ...contexto().config, exigirContrato: true };
    const resultado = RULES.R6(contexto({ extraccion: { ...base, referencia: 'OC-INEXISTENTE' }, config }));
    expect(resultado.ok).toBe(false);
  });
});

describe('R7 - aprobacion humana por monto', () => {
  it('escala por encima del umbral', () => {
    expect(RULES.R7(contexto({ extraccion: { ...base, monto: 13500000 } })).ok).toBe(false);
  });

  it('pasa por debajo del umbral', () => {
    expect(RULES.R7(contexto({ extraccion: base })).ok).toBe(true);
  });
});

describe('R8 - datos completos y verificados', () => {
  it('escala sin extraccion', () => {
    expect(RULES.R8(contexto()).ok).toBe(false);
  });

  it('escala si la verificacion del beneficiario falla', () => {
    const resultado = RULES.R8(
      contexto({
        extraccion: base,
        verificacion: { ...verificacionOk, beneficiarioPresente: false, ok: false },
      }),
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.motivo).toContain('no aparece en el texto');
  });

  it('escala por formato ambiguo del monto', () => {
    const resultado = RULES.R8(
      contexto({
        extraccion: base,
        verificacion: { ...verificacionOk, montoAmbiguo: true, ok: false },
      }),
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.motivo).toContain('ambiguo');
  });

  it('escala por confianza baja', () => {
    const resultado = RULES.R8(
      contexto({ extraccion: { ...base, confianza: 0.4 }, verificacion: verificacionOk }),
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.motivo).toContain('confianza');
  });

  it('escala una factura vencida', () => {
    const resultado = RULES.R8(
      contexto({
        extraccion: { ...base, fechaVencimiento: '2026-08-20' },
        verificacion: verificacionOk,
      }),
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.motivo).toContain('vencida');
  });

  it('escala una fecha incoherente a futuro', () => {
    const resultado = RULES.R8(
      contexto({
        extraccion: { ...base, fechaVencimiento: '2028-05-10' },
        verificacion: verificacionOk,
      }),
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.motivo).toContain('incoherente');
  });

  it('pasa con datos completos y verificados', () => {
    const resultado = RULES.R8(contexto({ extraccion: base, verificacion: verificacionOk }));
    expect(resultado.ok).toBe(true);
  });
});

describe('integracion: factura valida dentro de todas las reglas', () => {
  it('todas las reglas pasan', () => {
    const reglas = evaluateRules(contexto({ extraccion: base, verificacion: verificacionOk }));
    expect(reglas.every((r) => r.resultado === 'pasa')).toBe(true);
  });
});
