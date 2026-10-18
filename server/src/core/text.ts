/**
 * Normalizacion de texto para comparaciones deterministas.
 * Codigo puro: sin LLM, sin red, sin base de datos (RNF-3).
 */

/** Minusculas, sin acentos, espacios colapsados. Conserva puntuacion. */
export function normalizeText(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clave de comparacion agresiva: minusculas, sin acentos, sin puntuacion.
 * "Ferreteria El Tornillo S.A.S." y "FERRETERIA EL TORNILLO SAS" dan la misma clave.
 *
 * Los puntos se ELIMINAN (no se cambian por espacio) porque casi siempre van dentro
 * del token: "S.A.S." debe quedar "sas", no "s a s", o las razones sociales no
 * coincidirian entre si. El resto de la puntuacion si separa palabras.
 */
export function normalizeKey(value: string): string {
  return normalizeText(value)
    .replace(/\./g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SUFIJOS_SOCIETARIOS = new Set([
  'sas',
  'sa',
  'ltda',
  'limitada',
  'inc',
  'corp',
  'corporation',
  'srl',
  'sl',
  'sac',
  'eirl',
  'cia',
  'compania',
  'company',
  'gmbh',
  'llc',
]);

/** Quita sufijos societarios del final ("... sas", "... ltda"). */
export function stripLegalSuffix(normalizedKey: string): string {
  const tokens = normalizedKey.split(' ').filter(Boolean);
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (last && SUFIJOS_SOCIETARIOS.has(last)) {
      tokens.pop();
      continue;
    }
    break;
  }
  return tokens.join(' ');
}

/**
 * RF-2.2: el beneficiario extraido debe aparecer en el texto de la factura.
 * Acepta coincidencia exacta normalizada o sin sufijos societarios.
 */
export function beneficiaryAppearsInText(beneficiario: string, text: string): boolean {
  const clave = normalizeKey(beneficiario);
  if (clave.length < 2) return false;
  const hay = normalizeKey(text);
  if (hay.includes(clave)) return true;
  const nucleo = stripLegalSuffix(clave);
  return nucleo.length >= 4 && hay.includes(nucleo);
}

/** Distancia de Levenshtein acotada (para detectar referencias casi iguales). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length] ?? 0;
}

/** Similitud 0..1 derivada de Levenshtein. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

/**
 * Frases tipicas de prompt injection (RF-2.5).
 * NO cambian la decision: solo se registran en la auditoria.
 */
const PATRONES_INYECCION = [
  /ignora\s+(todas\s+)?(las\s+)?instrucciones/i,
  /ignore\s+(all\s+)?(previous\s+)?instructions/i,
  /aprueba\s+(este|el)\s+pago/i,
  /approve\s+this\s+payment/i,
  /paga(lo)?\s+(de\s+inmediato|sin\s+revisar|ahora)/i,
  /marca(r)?\s+como\s+pagad[oa]/i,
  /eres\s+un\s+agente\s+que\s+siempre/i,
  /system\s*:\s*/i,
  /nuevas?\s+instrucciones/i,
  /override\s+(the\s+)?(rules|instructions)/i,
];

/** Devuelve las frases sospechosas encontradas dentro del texto de la factura. */
export function detectPromptInjection(text: string): string[] {
  const encontrados: string[] = [];
  for (const patron of PATRONES_INYECCION) {
    const match = patron.exec(text);
    if (match) encontrados.push(match[0].trim());
  }
  return [...new Set(encontrados)];
}
