import type { ExtractionCheck, InvoiceExtraction } from '@payblink/shared';
import { findAmountInText, formatMoney } from '../core/money';
import { beneficiaryAppearsInText, detectPromptInjection } from '../core/text';

/**
 * RF-2.2: verificacion literal en codigo (no la hace el LLM).
 * El monto y el beneficiario extraidos deben aparecer en el texto de la factura.
 * RF-2.4: si el unico numero compatible es ambiguo, se marca y se escala.
 * RF-2.5: las instrucciones dentro de la factura solo se registran, nunca se obedecen.
 */
export function verifyExtraction(extraccion: InvoiceExtraction, texto: string): ExtractionCheck {
  const inyeccionesDetectadas = detectPromptInjection(texto);
  const beneficiarioPresente = beneficiaryAppearsInText(extraccion.beneficiario, texto);
  const monto = findAmountInText(extraccion.monto, texto);

  const motivos: string[] = [];
  if (!beneficiarioPresente) {
    motivos.push(
      `El beneficiario "${extraccion.beneficiario}" no aparece en el texto de la factura.`,
    );
  }
  if (!monto.presente) {
    motivos.push(
      `El monto ${formatMoney(extraccion.monto, extraccion.moneda)} no aparece en el texto de la factura.`,
    );
  }
  if (monto.ambiguo) {
    motivos.push(
      `El monto "${formatMoney(extraccion.monto, extraccion.moneda)}" aparece en el texto con un formato ambiguo (un solo separador de miles o decimales).`,
    );
  }

  return {
    beneficiarioPresente,
    montoPresente: monto.presente,
    montoAmbiguo: monto.ambiguo,
    inyeccionesDetectadas,
    ok: beneficiarioPresente && monto.presente && !monto.ambiguo,
    motivos,
  };
}

/** Verificacion cuando no hubo extraccion valida: solo se conserva la deteccion de inyeccion. */
export function failedCheck(texto: string, motivos: readonly string[]): ExtractionCheck {
  return {
    beneficiarioPresente: false,
    montoPresente: false,
    montoAmbiguo: false,
    inyeccionesDetectadas: detectPromptInjection(texto),
    ok: false,
    motivos: [...motivos],
  };
}
