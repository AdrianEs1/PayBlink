import { describe, expect, it } from 'vitest';
import {
  amountVariants,
  convertToBase,
  findAmountInText,
  formatMoney,
  parseAmount,
  sameAmount,
} from '../server/src/core/money';

const config = { monedaBase: 'COP' as const, tasas: { COP: 1, USD: 4050, EUR: 4400 } };

describe('parseAmount (RF-2.4)', () => {
  it('interpreta el formato es-CO sin ambiguedad', () => {
    expect(parseAmount('1.500,00')).toEqual({ value: 1500, ambiguous: false });
    expect(parseAmount('$ 2.450.000,00')).toEqual({ value: 2450000, ambiguous: false });
  });

  it('interpreta el formato en-US sin ambiguedad', () => {
    expect(parseAmount('1,500.00')).toEqual({ value: 1500, ambiguous: false });
    expect(parseAmount('4,860,000.50')).toEqual({ value: 4860000.5, ambiguous: false });
  });

  it('trata varios grupos del mismo separador como miles', () => {
    expect(parseAmount('1.234.567')).toEqual({ value: 1234567, ambiguous: false });
  });

  it('marca ambiguedad cuando hay un solo separador y tres digitos', () => {
    const coma = parseAmount('1,500');
    expect(coma.ambiguous).toBe(true);
    expect(coma.value).toBe(1500);

    const punto = parseAmount('1.500');
    expect(punto.ambiguous).toBe(true);
    expect(punto.value).toBe(1500);
  });

  it('no marca ambiguedad con dos decimales', () => {
    expect(parseAmount('12,50')).toEqual({ value: 12.5, ambiguous: false });
    expect(parseAmount('12.50')).toEqual({ value: 12.5, ambiguous: false });
  });

  it('devuelve null si no hay digitos', () => {
    expect(parseAmount('pendiente')).toEqual({ value: null, ambiguous: false });
  });
});

describe('verificacion del monto en el texto (RF-2.2)', () => {
  it('encuentra el monto en cualquiera de sus escrituras', () => {
    expect(findAmountInText(2450000, 'Monto: $ 2.450.000,00 COP').presente).toBe(true);
    expect(findAmountInText(1500, 'Total: USD 1,500.00').presente).toBe(true);
    expect(findAmountInText(48500, 'Monto: 48.500').presente).toBe(true);
  });

  it('detecta el formato ambiguo y no lo da por verificado en limpio', () => {
    const hallazgo = findAmountInText(48500, 'Monto: 48.500');
    expect(hallazgo.presente).toBe(true);
    expect(hallazgo.ambiguo).toBe(true);
  });

  it('no confunde un monto mayor con uno menor', () => {
    expect(findAmountInText(1500, 'Monto: 15000').presente).toBe(false);
  });

  it('las variantes no incluyen la escritura ambigua de miles', () => {
    expect(amountVariants(1500)).not.toContain('1.500');
    expect(amountVariants(1500)).toContain('1.500,00');
  });
});

describe('conversion de moneda (RF-3.3)', () => {
  it('convierte a moneda base con tasas fijas', () => {
    expect(convertToBase(900, 'USD', config)).toBe(3645000);
    expect(convertToBase(350, 'EUR', config)).toBe(1540000);
    expect(convertToBase(1000, 'COP', config)).toBe(1000);
  });

  it('devuelve null si falta la tasa', () => {
    expect(convertToBase(100, 'USD', { monedaBase: 'COP', tasas: { COP: 1, USD: 0, EUR: 1 } })).toBeNull();
  });

  it('sameAmount tolera diferencias de redondeo', () => {
    expect(sameAmount(1500.004, 1500)).toBe(true);
    expect(sameAmount(1500.02, 1500)).toBe(false);
  });

  it('formatea en es-CO', () => {
    expect(formatMoney(1500, 'COP')).toContain('1.500');
  });
});
