/**
 * Calculo deterministico de periodos (RF-3.4).
 * Toda fecha de referencia viene de la configuracion, nunca de `new Date()`,
 * para que la demo y la evaluacion sean reproducibles.
 */
import type { PeriodoTipo } from '@payblink/shared';

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

function isoWeekKey(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // lunes = 0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // jueves de esa semana
  const firstThursday = date.getTime();
  date.setUTCMonth(0, 1);
  if (date.getUTCDay() !== 4) {
    date.setUTCMonth(0, 1 + ((4 - date.getUTCDay()) + 7) % 7);
  }
  const week = 1 + Math.round((firstThursday - date.getTime()) / 604800000);
  return `${new Date(firstThursday).getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Clave del periodo al que pertenece una fecha. Fechas invalidas dan 'invalido'. */
export function periodKey(fecha: string, tipo: PeriodoTipo): string {
  if (!isValidIsoDate(fecha)) return 'invalido';
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number];
  const mm = String(m).padStart(2, '0');
  if (tipo === 'mensual') return `${y}-${mm}`;
  if (tipo === 'quincenal') return `${y}-${mm}-Q${d <= 15 ? 1 : 2}`;
  return isoWeekKey(y, m, d);
}

export function samePeriod(a: string, b: string, tipo: PeriodoTipo): boolean {
  const ka = periodKey(a, tipo);
  return ka !== 'invalido' && ka === periodKey(b, tipo);
}

/** Milisegundos desde epoch para una fecha ISO corta (UTC). */
export function epochDay(fecha: string): number | null {
  if (!isValidIsoDate(fecha)) return null;
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** Dias de `desde` a `hasta` (positivo si `hasta` es posterior). */
export function daysBetween(desde: string, hasta: string): number | null {
  const a = epochDay(desde);
  const b = epochDay(hasta);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86400000);
}
