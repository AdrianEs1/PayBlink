/**
 * Generador minimo de PDF en texto plano (sin dependencias).
 *
 * Se usa solo para producir las facturas simuladas en `data/invoices/pdf/*.pdf`
 * a partir de sus fuentes `.txt`, de modo que el set incluya de verdad el
 * formato PDF (RF-1.1) sin depender de una libreria externa ni de binarios
 * versionados a mano.
 */

const OBJETOS = 5;

function toLatin1(value: string): string {
  // WinAnsiEncoding cubre Latin-1; cualquier caracter fuera de rango se reemplaza.
  return value.replace(/[\u0100-\uffff]/g, '?');
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Construye un PDF de una pagina con las lineas indicadas. */
export function buildPdf(lines: readonly string[]): Buffer {
  const fontSize = 11;
  const leading = 15;
  const startY = 780;
  const x = 56;

  const contenido = lines
    .map((line, index) => {
      const y = startY - index * leading;
      return `BT /F1 ${fontSize} Tf ${x} ${y} Td (${escapePdfText(toLatin1(line))}) Tj ET`;
    })
    .join('\n');

  const objects: string[] = new Array(OBJETOS + 1).fill('');
  objects[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  objects[2] = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  objects[3] =
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
    '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n';
  objects[4] =
    `4 0 obj\n<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream\nendobj\n`;
  objects[5] =
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n';

  const header = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
  const partes: string[] = [header];
  const offsets: number[] = new Array(OBJETOS + 1).fill(0);

  let offset = header.length;
  for (let i = 1; i <= OBJETOS; i += 1) {
    const objeto = objects[i] ?? '';
    offsets[i] = offset;
    partes.push(objeto);
    offset += objeto.length;
  }

  const xrefStart = offset;
  let xref = `xref\n0 ${OBJETOS + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= OBJETOS; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${OBJETOS + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  partes.push(xref, trailer);

  return Buffer.from(partes.join(''), 'latin1');
}
