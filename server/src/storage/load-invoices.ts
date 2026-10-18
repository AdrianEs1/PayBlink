import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { InvoiceFormato } from '@payblink/shared';
import { PATHS } from '../config';
import type { InvoiceInput } from '../core/types';
import { extractPdfText } from '../ingestion/pdf';
import { buildPdf } from './pdf-writer';

const EXTENSION_A_FORMATO: Record<string, InvoiceFormato> = {
  '.eml': 'correo',
  '.msg': 'correo',
  '.chat': 'chat',
  '.json': 'chat',
  '.pdf': 'pdf',
  '.txt': 'texto',
  '.md': 'texto',
  '.png': 'imagen',
  '.jpg': 'imagen',
  '.jpeg': 'imagen',
};

/**
 * Genera los PDF simulados a partir de las fuentes `data/invoices/pdf/*.txt`
 * si todavia no existen. Idempotente.
 */
export function ensurePdfFiles(): { generados: string[] } {
  const generados: string[] = [];
  if (!existsSync(PATHS.pdfSources)) return { generados };

  for (const entry of readdirSync(PATHS.pdfSources)) {
    if (extname(entry).toLowerCase() !== '.txt') continue;
    const id = basename(entry, '.txt');
    const destino = join(PATHS.pdfSources, `${id}.pdf`);
    if (existsSync(destino)) continue;
    const lineas = readFileSync(join(PATHS.pdfSources, entry), 'utf8').split(/\r?\n/);
    writeFileSync(destino, buildPdf(lineas));
    generados.push(destino);
  }
  return { generados };
}

/**
 * Texto de una factura PDF.
 * Usa el mismo extractor que las entradas del simulador (unpdf + respaldo propio),
 * de modo que la carpeta de demo y la subida manual se comporten igual.
 */
async function leerTextoPdf(ruta: string): Promise<string> {
  const texto = await extractPdfText(readFileSync(ruta));
  if (texto.trim().length > 0) return texto;
  // RF-1.10: un PDF ilegible no se descarta; el agente lo escala con este motivo.
  return `PDF ilegible: no se pudo extraer texto del archivo ${basename(ruta)}.`;
}

/** Cabeceras de un correo simulado: De / Asunto. */
function parseHeaders(texto: string): { remitente: string | null; asunto: string | null } {
  const remitente = /^De:\s*(.+)$/im.exec(texto)?.[1]?.trim() ?? null;
  const asunto = /^Asunto:\s*(.+)$/im.exec(texto)?.[1]?.trim() ?? null;
  return { remitente, asunto };
}

/** Asunto de un chat: primera linea util. */
function asuntoChat(texto: string): string | null {
  const primera = texto.split(/\r?\n/).find((linea) => linea.trim().length > 0);
  if (!primera) return null;
  return primera.length > 90 ? `${primera.slice(0, 87)}...` : primera;
}

async function construirFactura(ruta: string, id: string): Promise<InvoiceInput> {
  const formato = EXTENSION_A_FORMATO[extname(ruta).toLowerCase()] ?? 'texto';
  const texto = formato === 'pdf' ? await leerTextoPdf(ruta) : readFileSync(ruta, 'utf8');
  const headers = formato === 'correo' ? parseHeaders(texto) : { remitente: null, asunto: null };
  const asunto = headers.asunto ?? (formato === 'chat' ? asuntoChat(texto) : null);

  return {
    id,
    archivo: basename(ruta),
    formato,
    asunto,
    remitente: headers.remitente,
    texto,
  };
}

/**
 * Carga todas las facturas simuladas (RF-1.2).
 * Orden determinista: por id ascendente, igual que el orden del ledger (RF-7.2).
 */
export async function loadInvoicesFromDisk(): Promise<InvoiceInput[]> {
  ensurePdfFiles();

  const rutas: string[] = [];
  if (existsSync(PATHS.invoices)) {
    for (const entry of readdirSync(PATHS.invoices)) {
      const ruta = join(PATHS.invoices, entry);
      if (statSync(ruta).isDirectory()) continue;
      if (extname(entry).toLowerCase() === '.pdf' && entry.endsWith('.pdf')) {
        rutas.push(ruta);
        continue;
      }
      if (entry.toLowerCase().endsWith('.pdf.txt')) continue;
      if (EXTENSION_A_FORMATO[extname(entry).toLowerCase()]) rutas.push(ruta);
    }
  }

  // Facturas PDF: viven en data/invoices/pdf/ y su fuente .txt no se carga aparte.
  if (existsSync(PATHS.pdfSources)) {
    for (const entry of readdirSync(PATHS.pdfSources)) {
      if (extname(entry).toLowerCase() !== '.pdf') continue;
      rutas.push(join(PATHS.pdfSources, entry));
    }
  }

  // Orden lexicografico puro (no dependiente del locale): INV-001, INV-002, ... (RF-7.2).
  rutas.sort((a, b) => {
    const na = basename(a);
    const nb = basename(b);
    if (na < nb) return -1;
    if (na > nb) return 1;
    return 0;
  });

  const facturas: InvoiceInput[] = [];
  for (const ruta of rutas) {
    const id = basename(ruta, extname(ruta));
    facturas.push(await construirFactura(ruta, id));
  }
  return facturas;
}
