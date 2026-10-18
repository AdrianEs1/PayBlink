import type { ExtractionCheck, InvoiceExtraction } from '@blinka/shared';
import type { InvoiceInput } from '../core/types';
import type { LlmClient } from '../agent/llm/types';
import { normalizeExtraction } from './normalize';
import { failedCheck, verifyExtraction } from './verify';

export interface ExtractionOutcome {
  /** Salida cruda del modelo, para la auditoria (RF-6). */
  raw: unknown;
  extraccion: InvoiceExtraction | null;
  verificacion: ExtractionCheck;
  /** Motivos por los que no hay extraccion valida. */
  motivos: string[];
  /** true si el modelo fallo o devolvio algo invalido (RF-4.5). */
  fallo: boolean;
}

/**
 * RF-2: extrae los datos de la factura y los verifica en codigo.
 * Cualquier fallo termina en escalada; nunca se asume un valor.
 */
export async function extractInvoice(invoice: InvoiceInput, llm: LlmClient): Promise<ExtractionOutcome> {
  const respuesta = await llm.extract(invoice);

  if (!respuesta.ok) {
    return {
      raw: null,
      extraccion: null,
      verificacion: failedCheck(invoice.texto, [`Fallo la extraccion: ${respuesta.error}`]),
      motivos: [`Fallo la extraccion: ${respuesta.error}`],
      fallo: true,
    };
  }

  const normalizado = normalizeExtraction(respuesta.raw);
  if (!normalizado.extraccion) {
    return {
      raw: respuesta.raw,
      extraccion: null,
      verificacion: failedCheck(invoice.texto, normalizado.motivos),
      motivos: normalizado.motivos,
      fallo: false,
    };
  }

  const verificacion = verifyExtraction(normalizado.extraccion, invoice.texto);
  return {
    raw: respuesta.raw,
    extraccion: normalizado.extraccion,
    verificacion,
    motivos: [...normalizado.motivos, ...verificacion.motivos],
    fallo: false,
  };
}
