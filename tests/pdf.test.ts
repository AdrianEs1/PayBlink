import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractPdfText,
  extraerTextoDeStream,
  extraerTextoPdfSimple,
} from '../server/src/ingestion/pdf';
import { normalizeEntry } from '../server/src/ingestion/normalize';
import { buildPdf } from '../server/src/storage/pdf-writer';
import { PATHS } from '../server/src/config';

/** PDF de una pagina con el content stream comprimido (como los reales). */
function buildCompressedPdf(lines: readonly string[]): Buffer {
  const contenido = lines
    .map(
      (line, index) =>
        `BT /F1 11 Tf 56 ${780 - index * 15} Td (${line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')}) Tj ET`,
    )
    .join('\n');
  const comprimido = deflateSync(Buffer.from(contenido, 'latin1'));

  const objetos: Buffer[] = [
    Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'),
    Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'latin1'),
    Buffer.from(
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
      'latin1',
    ),
    Buffer.concat([
      Buffer.from(
        `4 0 obj\n<< /Length ${comprimido.length} /Filter /FlateDecode >>\nstream\n`,
        'latin1',
      ),
      comprimido,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]),
    Buffer.from(
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
      'latin1',
    ),
  ];

  const cabecera = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const offsets: number[] = [];
  let cursor = cabecera.length;
  for (const objeto of objetos) {
    offsets.push(cursor);
    cursor += objeto.length;
  }
  let xref = `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`;
  return Buffer.concat([cabecera, ...objetos, Buffer.from(xref + trailer, 'latin1')]);
}

const LINEAS = [
  'FACTURA DE VENTA ELECTRONICA',
  'Beneficiario: Ferretería El Tornillo S.A.S.',
  'Referencia: OC-2026-0451',
  'Monto: $ 2.450.000,00 COP',
  'Fecha de vencimiento: 2026-10-25',
];

describe('lectura de PDF (RF-1.1)', () => {
  it('lee el PDF simulado del proyecto', async () => {
    const texto = await extractPdfText(readFileSync(resolve(PATHS.invoices, 'pdf', 'INV-004.pdf')));
    expect(texto).toContain('Beneficiario: Servicios Eléctricos Andinos S.A.S.');
    expect(texto).toContain('Monto: $ 13.500.000,00 COP');
  });

  it('lee un PDF con el stream comprimido (FlateDecode)', async () => {
    const texto = await extractPdfText(buildCompressedPdf(LINEAS));
    expect(texto).toContain('Beneficiario: Ferretería El Tornillo S.A.S.');
    expect(texto).toContain('Monto: $ 2.450.000,00 COP');
  });

  it('el respaldo propio tambien entiende streams comprimidos', () => {
    const texto = extraerTextoPdfSimple(buildCompressedPdf(LINEAS));
    expect(texto).toContain('Beneficiario: Ferretería El Tornillo S.A.S.');
    expect(texto).toContain('Fecha de vencimiento: 2026-10-25');
  });

  it('lee texto mostrado con TJ y cadenas hexadecimales', () => {
    const contenido = [
      'BT /F1 11 Tf 56 780 Td',
      '[(Beneficiario: ) -80 (Ferretería El Tornillo)] TJ',
      '<4d6f6e746f3a202420322e3435302e3030302c303020434f50> Tj',
      'ET',
    ].join('\n');
    const texto = extraerTextoDeStream(contenido);
    expect(texto).toContain('Beneficiario: Ferretería El Tornillo');
    expect(texto).toContain('Monto: $ 2.450.000,00 COP');
  });

  it('devuelve cadena vacia ante un archivo que no es PDF', async () => {
    expect(await extractPdfText(Buffer.from('no soy un pdf'))).toBe('');
    expect(await extractPdfText(Buffer.alloc(0))).toBe('');
  });

  it('normaliza el PDF a una factura con texto y huella', async () => {
    const base64 = buildPdf(LINEAS).toString('base64');
    const normalizada = await normalizeEntry({
      tipo: 'pdf',
      archivoNombre: 'factura-prueba.pdf',
      archivoBase64: base64,
    });
    expect(normalizada.invoice.formato).toBe('pdf');
    expect(normalizada.invoice.texto).toContain('Beneficiario: Ferretería El Tornillo S.A.S.');
    expect(normalizada.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marca como ilegible un PDF sin texto en vez de inventar datos', async () => {
    const base64 = Buffer.from('%PDF-1.4\n%basura sin objetos\n%%EOF\n', 'latin1').toString('base64');
    const normalizada = await normalizeEntry({
      tipo: 'pdf',
      archivoNombre: 'roto.pdf',
      archivoBase64: base64,
    });
    expect(normalizada.invoice.texto).toContain('PDF ilegible');
  });
});
