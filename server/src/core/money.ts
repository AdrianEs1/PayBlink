/**
 * Aritmetica de dinero y parseo de formatos numericos ambiguos.
 * Codigo puro y determinista (RF-2.4, RF-3.3).
 */
import type { Moneda } from '@payblink/shared';

export interface ParsedAmount {
  /** Mejor lectura posible del numero, o null si no hay digitos. */
  value: number | null;
  /** true cuando el texto admite dos lecturas razonables. */
  ambiguous: boolean;
}

function toNum(value: string): number | null {
  if (value === '' || value === '.' || value === ',') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function countChar(value: string, char: string): number {
  let total = 0;
  for (const c of value) if (c === char) total += 1;
  return total;
}

/**
 * Interpreta numeros escritos con convenciones distintas.
 *
 *   "1.500,00" (es-CO) -> 1500      sin ambiguedad (el ultimo separador es el decimal)
 *   "1,500.00" (en-US) -> 1500      sin ambiguedad
 *   "1.234.567"        -> 1234567   sin ambiguedad (solo puede ser separador de miles)
 *   "12,50"            -> 12.5      sin ambiguedad (dos decimales)
 *   "1,500" / "1.500"  -> 1500 + ambiguous=true  (¿1500 o 1,5?)
 */
export function parseAmount(raw: string): ParsedAmount {
  const s = String(raw ?? '').replace(/[^\d.,]/g, '');
  if (!s || !/\d/.test(s)) return { value: null, ambiguous: false };

  const dotCount = countChar(s, '.');
  const commaCount = countChar(s, ',');

  // Ambos separadores: el que aparece mas a la derecha es el decimal.
  if (dotCount > 0 && commaCount > 0) {
    const decimalSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const milesSep = decimalSep === '.' ? ',' : '.';
    const normalized = s.split(milesSep).join('').replace(decimalSep, '.');
    return { value: toNum(normalized), ambiguous: false };
  }

  // Varios grupos del mismo separador: solo puede ser separador de miles.
  if (dotCount > 1) return { value: toNum(s.split('.').join('')), ambiguous: false };
  if (commaCount > 1) return { value: toNum(s.split(',').join('')), ambiguous: false };

  // Un unico separador.
  if (dotCount === 1 || commaCount === 1) {
    const sep = dotCount === 1 ? '.' : ',';
    const partes = s.split(sep);
    const entero = partes[0] ?? '';
    const decimales = partes.slice(1).join('');

    // Exactamente 3 digitos detras del separador: miles o decimales.
    if (decimales.length === 3) {
      return { value: toNum(`${entero}${decimales}`), ambiguous: true };
    }
    return { value: toNum(`${entero}.${decimales}`), ambiguous: false };
  }

  return { value: toNum(s), ambiguous: false };
}

/** Redondeo a 2 decimales con epsilon para evitar errores de coma flotante. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Dos montos son iguales si difieren menos de medio centavo. */
export function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

/**
 * Escrituras alternativas de un monto, para verificarlo contra el texto (RF-2.2).
 * A proposito NO incluye separador de miles sin decimales ("1.500"), porque
 * esa forma es justamente la ambigua.
 */
export function amountVariants(monto: number): string[] {
  if (!Number.isFinite(monto)) return [];
  const fixed = Math.abs(monto).toFixed(2);
  const [intPart = '0', decPart = '00'] = fixed.split('.');
  const groupedDot = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const groupedComma = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const variantes = new Set<string>([
    `${groupedDot},${decPart}`,
    `${groupedComma}.${decPart}`,
    `${intPart},${decPart}`,
    `${intPart}.${decPart}`,
    fixed,
    intPart,
  ]);
  // "1500.00" y "1500" ya estan cubiertos por fixed/intPart.
  return [...variantes].filter((v) => v.length >= 1);
}

/** Busca una variante literal en el texto, sin pegarse a digitos vecinos. */
export function textContainsAmount(text: string, variant: string): boolean {
  if (!variant) return false;
  const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\d.,])${escaped}(?![\\d.,])`, 'i');
  return re.test(text);
}

export interface AmountFinding {
  presente: boolean;
  ambiguo: boolean;
  coincidencias: string[];
}

/**
 * Verifica el monto extraido contra el texto original y detecta ambiguedad real.
 * Si el texto solo ofrece una lectura ambigua del numero, se marca `ambiguo`.
 */
export function findAmountInText(monto: number, text: string): AmountFinding {
  const coincidenciasLiterales = amountVariants(monto).filter((v) => textContainsAmount(text, v));
  const literales = coincidenciasLiterales.length > 0;

  const tokens = text.match(/\d+(?:[.,]\d+)*/g) ?? [];
  let porToken = false;
  let ambiguo = false;
  for (const token of tokens) {
    const parsed = parseAmount(token);
    if (parsed.value === null) continue;
    if (sameAmount(parsed.value, monto)) {
      porToken = true;
      if (parsed.ambiguous) ambiguo = true;
    }
  }

  const presente = literales || porToken;
  // Si hay una escritura inequivoca en el texto, la ambiguedad desaparece.
  if (literales) ambiguo = false;

  const coincidencias = [...new Set(coincidenciasLiterales)];
  return { presente, ambiguo: presente && ambiguo, coincidencias };
}

/** Convierte a moneda base usando tasas fijas (RF-3.3). Devuelve null si falta la tasa. */
export function convertToBase(
  monto: number,
  moneda: Moneda,
  config: { tasas: Partial<Record<Moneda, number>>; monedaBase: Moneda },
): number | null {
  if (!Number.isFinite(monto)) return null;
  if (moneda === config.monedaBase) return round2(monto);
  const tasa = config.tasas[moneda];
  if (!tasa || !Number.isFinite(tasa) || tasa <= 0) return null;
  return round2(monto * tasa);
}

/** Formato legible para la UI y las explicaciones. */
export function formatMoney(monto: number, moneda: Moneda): string {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: moneda,
      maximumFractionDigits: 2,
    }).format(monto);
  } catch {
    return `${moneda} ${monto.toFixed(2)}`;
  }
}

/** Formato corto sin simbolo de moneda. */
export function formatNumber(monto: number): string {
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(monto);
}
