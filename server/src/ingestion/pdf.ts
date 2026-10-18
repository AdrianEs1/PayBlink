import { inflateRawSync, inflateSync } from 'node:zlib';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * RF-1.1: extraccion de texto de un PDF.
 *
 * El motor principal es `unpdf` (PDF.js moderno, sin DOM). Se mantiene un
 * respaldo propio para PDFs de texto sin comprimir, util si PDF.js no puede
 * con un archivo danado: es preferible leer lo que haya a escalar por un fallo
 * del parser. Nunca se inventan datos: si no hay texto, se devuelve ''.
 */

function normalizarTexto(texto: string): string {
  return texto
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parecePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 1024).toString('latin1').includes('%PDF-');
}

async function extraerConPdfJs(buffer: Buffer): Promise<string> {
  try {
    // `verbosity: 0` silencia los avisos del parser con PDFs danados.
    const documento = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
    const resultado = await extractText(documento, { mergePages: true });
    return normalizarTexto(resultado.text);
  } catch {
    return '';
  }
}

/** Decodifica una cadena literal PDF: `\(texto\)` y escapes octales. */
function decodificarLiteral(contenido: string): string {
  return contenido.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_todo, escape: string) => {
    switch (escape) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '(':
      case ')':
      case '\\':
        return escape;
      default:
        if (/^[0-7]{1,3}$/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
        return escape;
    }
  });
}

/** Decodifica una cadena hexadecimal PDF, incluyendo UTF-16BE con BOM. */
function decodificarHex(hex: string): string {
  let limpio = hex.replace(/\s+/g, '');
  if (limpio.length % 2 !== 0) limpio += '0';
  if (limpio.length === 0) return '';
  const bytes = Buffer.from(limpio, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const pares: string[] = [];
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      pares.push(String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!));
    }
    return pares.join('');
  }
  return bytes.toString('latin1');
}

/** Convierte un fragmento `(...)`, `<...>` o `[ ... ] TJ` en texto plano. */
function leerCadenas(fragmento: string): string {
  let salida = '';
  const patron = /\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>/g;
  for (const coincidencia of fragmento.matchAll(patron)) {
    const valor = coincidencia[0];
    if (valor.startsWith('(')) salida += decodificarLiteral(valor.slice(1, -1));
    else salida += decodificarHex(valor.slice(1, -1));
  }
  return salida;
}

/** Extrae texto de un content stream PDF (con o sin compresion). */
export function extraerTextoDeStream(contenido: string): string {
  if (!contenido || !/(?:Tj|TJ|T\*)/.test(contenido)) return '';
  const lineas: string[] = [];

  const operadores =
    /(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]+>)\s*(?:Tj|'|")|\[((?:[^\]\\]|\\.)*)\]\s*TJ|T\*|Td|TD/g;

  for (const coincidencia of contenido.matchAll(operadores)) {
    if (coincidencia[0] === 'T*' || coincidencia[0] === 'Td' || coincidencia[0] === 'TD') {
      lineas.push('');
      continue;
    }
    const texto =
      coincidencia[1] !== undefined
        ? leerCadenas(coincidencia[1])
        : leerCadenas(coincidencia[2] ?? '');
    if (texto.length > 0) lineas.push(texto);
  }

  return normalizarTexto(lineas.join('\n'));
}

function descomprimir(datos: Buffer): string {
  try {
    return inflateSync(datos).toString('latin1');
  } catch {
    try {
      return inflateRawSync(datos).toString('latin1');
    } catch {
      return datos.toString('latin1');
    }
  }
}

/** Recorre los `stream ... endstream` del PDF y junta su texto visible. */
export function extraerTextoPdfSimple(buffer: Buffer): string {
  const crudo = buffer.toString('latin1');
  const fragmentos: string[] = [];
  let buscandoDesde = 0;

  while (buscandoDesde < crudo.length) {
    const inicio = crudo.indexOf('stream', buscandoDesde);
    if (inicio === -1) break;
    // `endstream` contiene la palabra `stream`: hay que ignorarla.
    if (crudo.slice(Math.max(0, inicio - 3), inicio) === 'end') {
      buscandoDesde = inicio + 6;
      continue;
    }

    let cursor = inicio + 'stream'.length;
    if (crudo[cursor] === '\r') cursor += 1;
    if (crudo[cursor] === '\n') cursor += 1;
    const fin = crudo.indexOf('endstream', cursor);
    if (fin === -1) break;

    let datos = buffer.subarray(cursor, fin);
    while (
      datos.length > 0 &&
      (datos[datos.length - 1] === 0x0a || datos[datos.length - 1] === 0x0d)
    ) {
      datos = datos.subarray(0, datos.length - 1);
    }

    const texto = extraerTextoDeStream(descomprimir(datos));
    if (texto) fragmentos.push(texto);
    buscandoDesde = fin + 'endstream'.length;
  }

  // PDFs sin streams separados (raros): se intenta sobre todo el archivo.
  if (fragmentos.length === 0) {
    const texto = extraerTextoDeStream(crudo);
    if (texto) fragmentos.push(texto);
  }

  return normalizarTexto(fragmentos.join('\n'));
}

/** RF-1.1: PDF como fuente de factura. Devuelve '' si no se pudo leer. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  if (buffer.length === 0 || !parecePdf(buffer)) return '';

  const conPdfJs = await extraerConPdfJs(buffer);
  if (conPdfJs.length > 0) return conPdfJs;

  return extraerTextoPdfSimple(buffer);
}
