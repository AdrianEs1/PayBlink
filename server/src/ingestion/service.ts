import {
  IngestEntrySchema,
  IngestExampleSchema,
  type IngestEntry,
  type IngestExample,
  type IngestResult,
  type SourceInfo,
} from '@blinka/shared';
import { z } from 'zod';
import { log as audit } from '../audit/audit';
import { PATHS, readJson } from '../config';
import * as repo from '../storage/repositories';
import { enqueueInvoice } from '../jobs/queue';
import { normalizeEntry, type NormalizedInvoice } from './normalize';
import { FolderSource } from './sources';

/** Persiste una factura normalizada, la audita y decide si entra a la cola (RF-1.8). */
async function persistir(normalized: NormalizedInvoice): Promise<IngestResult> {
  const { invoice, source, hash } = normalized;
  const resultado = repo.insertIncomingInvoice(invoice, source, hash, 'pendiente');

  audit({
    actor: 'sistema',
    tipo: 'factura.recibida',
    invoiceId: resultado.invoiceId,
    detalle: {
      archivo: invoice.archivo,
      formato: invoice.formato,
      fuente: source,
      hash,
      duplicada: resultado.duplicada,
    },
  });

  let enCola = false;
  if (resultado.inserted && repo.getIngestMode() === 'automatico') {
    enqueueInvoice(resultado.invoiceId);
    enCola = true;
  }

  const stored = repo.getStoredInvoice(resultado.invoiceId);
  return {
    invoiceId: resultado.invoiceId,
    duplicada: resultado.duplicada,
    queueState: stored?.queueState ?? 'pendiente',
    enCola,
  };
}

/** RF-1.6 / RF-1.7: crea una factura desde el simulador de entradas. */
export async function ingestEntry(raw: unknown): Promise<IngestResult> {
  const entry: IngestEntry = IngestEntrySchema.parse(raw);
  const normalized = await normalizeEntry(entry);
  return persistir(normalized);
}

/** RF-1.6: "Cargar set completo" desde la carpeta de demo. */
export async function ingestFolderAll(): Promise<{
  total: number;
  insertadas: number;
  duplicadas: number;
  enCola: number;
}> {
  const normalized = await new FolderSource().pull();
  let insertadas = 0;
  let duplicadas = 0;
  let enCola = 0;

  for (const item of normalized) {
    const resultado = await persistir(item);
    if (resultado.duplicada) duplicadas += 1;
    else insertadas += 1;
    if (resultado.enCola) enCola += 1;
  }

  return { total: normalized.length, insertadas, duplicadas, enCola };
}

/** Galeria de ejemplos normales y trampa (RF-1.6). */
export function listExamples(): IngestExample[] {
  const archivo = `${PATHS.data}/examples.json`;
  try {
    const raw = readJson<unknown>(archivo);
    return z.array(IngestExampleSchema).parse(raw);
  } catch {
    return [];
  }
}

export interface EntryPreview {
  source: SourceInfo;
  invoiceId: string;
  archivo: string;
  formato: string;
  caracteres: number;
  /** Texto extraido (recortado para no enviar archivos enormes a la UI). */
  texto: string;
  truncado: boolean;
}

/** Solo para la UI: permite verificar la lectura antes de crear la factura. */
export async function previewEntry(raw: unknown): Promise<EntryPreview> {
  const entry: IngestEntry = IngestEntrySchema.parse(raw);
  const normalized = await normalizeEntry(entry);
  const texto = normalized.invoice.texto;
  const limite = 6000;
  return {
    source: normalized.source,
    invoiceId: normalized.invoice.id,
    archivo: normalized.invoice.archivo,
    formato: normalized.invoice.formato,
    caracteres: texto.length,
    texto: texto.slice(0, limite),
    truncado: texto.length > limite,
  };
}
