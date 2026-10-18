import { MONEDAS, type InvoiceExtraction, type Moneda } from '@blinka/shared';
import { parseAmount } from '../core/money';
import { isValidIsoDate } from '../core/period';

export interface NormalizeResult {
  extraccion: InvoiceExtraction | null;
  motivos: string[];
}

function texto(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const limpio = value.trim();
  return limpio.length > 0 ? limpio : null;
}

/** Acepta ISO, DD/MM/YYYY y DD-MM-YYYY; devuelve ISO o null. */
export function normalizeDate(value: unknown): string | null {
  const raw = texto(value);
  if (!raw) return null;

  if (isValidIsoDate(raw)) return raw;

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
  if (dmy) {
    const [, d, m, y] = dmy as unknown as [string, string, string, string];
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    return isValidIsoDate(iso) ? iso : null;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const iso = parsed.toISOString().slice(0, 10);
  return isValidIsoDate(iso) ? iso : null;
}

function normalizeMoneda(value: unknown): Moneda | null {
  const raw = texto(value);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  const alias: Record<string, Moneda> = {
    'COL$': 'COP',
    '$': 'COP',
    PESOS: 'COP',
    'US$': 'USD',
    DOLARES: 'USD',
    DÓLARES: 'USD',
    '€': 'EUR',
    EUROS: 'EUR',
  };
  if ((MONEDAS as readonly string[]).includes(upper)) return upper as Moneda;
  return alias[upper] ?? null;
}

function normalizeMonto(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value * 100) / 100;
  }
  if (typeof value === 'string') {
    const parsed = parseAmount(value);
    if (parsed.value !== null && parsed.value > 0) {
      return Math.round(parsed.value * 100) / 100;
    }
  }
  return null;
}

function normalizeConfianza(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return value;
  if (typeof value === 'string') {
    const numero = Number(value.replace('%', ''));
    if (Number.isFinite(numero)) {
      const escalado = numero > 1 ? numero / 100 : numero;
      if (escalado >= 0 && escalado <= 1) return escalado;
    }
  }
  return null;
}

/**
 * RF-2.3: si falta un campo obligatorio o no se puede interpretar, NO se inventa nada.
 * Se devuelve `extraccion: null` y el motivo, que termina en una escalada.
 */
export function normalizeExtraction(raw: unknown): NormalizeResult {
  const motivos: string[] = [];
  if (raw === null || typeof raw !== 'object') {
    return { extraccion: null, motivos: ['El modelo no devolvio un objeto con los datos de la factura.'] };
  }

  const fuente = raw as Record<string, unknown>;
  const beneficiario = texto(fuente.beneficiario);
  const referencia = texto(fuente.referencia);
  const concepto = texto(fuente.concepto);
  const monto = normalizeMonto(fuente.monto);
  const moneda = normalizeMoneda(fuente.moneda);
  const fechaVencimiento = normalizeDate(fuente.fechaVencimiento);
  const confianza = normalizeConfianza(fuente.confianza);

  if (!beneficiario) motivos.push('Falta el beneficiario.');
  if (!referencia) motivos.push('Falta la referencia.');
  if (!concepto) motivos.push('Falta el concepto.');
  if (monto === null) motivos.push('Falta el monto o no se puede interpretar como numero.');
  if (!moneda) motivos.push('Falta la moneda o no es una de las soportadas (COP, USD, EUR).');
  if (!fechaVencimiento) motivos.push('Falta la fecha de vencimiento o no tiene un formato reconocible.');

  if (
    motivos.length > 0 ||
    monto === null ||
    !moneda ||
    !fechaVencimiento ||
    !beneficiario ||
    !referencia ||
    !concepto
  ) {
    return { extraccion: null, motivos };
  }

  const extraccion: InvoiceExtraction = {
    beneficiario,
    monto,
    moneda,
    fechaVencimiento,
    referencia,
    concepto,
    // Si el modelo no reporta confianza, se asume la mas baja: escala.
    confianza: confianza ?? 0,
  };

  if (confianza === null) {
    motivos.push('El modelo no reporto un nivel de confianza.');
  }

  return { extraccion, motivos };
}
