import { createHash, randomBytes } from 'node:crypto';
import { basename, extname } from 'node:path';
import type { IngestEntry, InvoiceFormato, SourceInfo as SourceInfoType } from '@blinka/shared';
import type { InvoiceInput } from '../core/types';
import { extractPdfText } from './pdf';

export interface NormalizedInvoice {
  invoice: InvoiceInput;
  source: SourceInfoType;
  hash: string;
}

function hashContenido(texto: string, remitente: string | null, asunto: string | null): string {
  const normalizado = `${remitente ?? ''}|${asunto ?? ''}|${texto}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalizado).digest('hex');
}

function nuevoId(prefijo: string, fijado?: string): string {
  if (fijado) return fijado;
  const marca = Date.now().toString(36).toUpperCase();
  const azar = randomBytes(2).toString('hex').toUpperCase();
  return `${prefijo}-${marca}-${azar}`;
}

const ETIQUETA: Record<IngestEntry['tipo'], string> = {
  pdf: 'Simulador: PDF',
  correo: 'Simulador: Correo',
  chat: 'Simulador: Chat',
};

/**
 * RF-1.4: cualquier fuente se normaliza a un unico registro `invoice` con
 * estado pendiente, fuente de origen y hash para no reprocesar dos veces.
 */
export async function normalizeEntry(entry: IngestEntry): Promise<NormalizedInvoice> {
  const recibidoEn = new Date().toISOString();
  const formato: InvoiceFormato = entry.tipo;

  let texto = '';
  let archivo = '';
  let asunto: string | null = null;
  let remitente: string | null = entry.remitente?.trim() || null;

  if (entry.tipo === 'pdf') {
    const nombre = entry.archivoNombre?.trim() || 'factura.pdf';
    if (!entry.archivoBase64) throw new Error('El PDF no llego como archivo adjunto.');
    const buffer = Buffer.from(entry.archivoBase64, 'base64');
    if (buffer.length === 0) throw new Error('El archivo PDF esta vacio.');
    if (buffer.length > 8 * 1024 * 1024) throw new Error('El PDF supera el limite de 8 MB.');
    texto = await extractPdfText(buffer);
    archivo = basename(nombre);
    asunto = basename(nombre, extname(nombre));
    if (!texto.trim()) {
      // RF-1.10: un PDF ilegible no se descarta: se registra y el agente escala.
      texto = `PDF ilegible: no se pudo extraer texto del archivo ${archivo}.`;
    }
  } else if (entry.tipo === 'correo') {
    const cuerpo = (entry.cuerpo ?? '').trim();
    if (!cuerpo) throw new Error('El correo no tiene cuerpo.');
    asunto = entry.asunto?.trim() || 'Correo sin asunto';
    texto = `De: ${remitente ?? 'desconocido'}\nAsunto: ${asunto}\n\n${cuerpo}`;
    archivo = `correo-${Date.now()}.eml`;
  } else {
    const cuerpo = (entry.cuerpo ?? '').trim();
    if (!cuerpo) throw new Error('El mensaje de chat esta vacio.');
    const canal = entry.canal ?? 'interno';
    const primera = cuerpo.split(/\r?\n/).find((linea) => linea.trim().length > 0) ?? 'Mensaje de chat';
    asunto = primera.length > 90 ? `${primera.slice(0, 87)}...` : primera;
    texto = `[${canal}] ${remitente ?? 'desconocido'}: ${cuerpo}`;
    archivo = `chat-${Date.now()}.txt`;
  }

  if (!texto.trim()) {
    throw new Error('La entrada no tiene contenido que procesar.');
  }

  const id = nuevoId(entry.tipo === 'pdf' ? 'PDF' : entry.tipo === 'correo' ? 'MAIL' : 'CHAT', entry.id);
  const hash = hashContenido(texto, remitente, asunto);
  const source: SourceInfoType = {
    conector: `simulador-${entry.tipo}`,
    conectorNombre: ETIQUETA[entry.tipo],
    canal: entry.tipo,
    etiqueta: ETIQUETA[entry.tipo],
    remitente,
    mensajeId: hash.slice(0, 12),
    recibidoEn,
  };

  return {
    invoice: { id, archivo, formato, asunto, remitente, texto },
    source,
    hash,
  };
}

export function folderSourceInfo(invoice: InvoiceInput, recibidoEn = new Date().toISOString()): SourceInfoType {
  return {
    conector: 'carpeta-demo',
    conectorNombre: 'Carpeta de demo',
    canal: folderCanal(invoice.formato),
    etiqueta: 'Carpeta de demo (data/invoices)',
    remitente: invoice.remitente,
    mensajeId: `archivo:${invoice.archivo}`,
    recibidoEn,
  };
}

function folderCanal(formato: InvoiceFormato): string {
  return formato === 'imagen' ? 'imagen' : formato;
}

export function hashFolderInvoice(invoice: InvoiceInput): string {
  return hashContenido(invoice.texto, invoice.remitente, invoice.asunto);
}
