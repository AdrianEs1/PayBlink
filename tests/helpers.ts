import { ContractSchema, RulesConfigSchema, type RulesConfig } from '@payblink/shared';
import { z } from 'zod';
import { PATHS, readJson } from '../server/src/config';
import type { InvoiceInput, PriorDecision, RuleContext } from '../server/src/core/types';

/** Se usan los datos reales de `data/` para que un error alli rompa los tests. */
export const configBase: RulesConfig = RulesConfigSchema.parse(readJson<unknown>(PATHS.rules));

export const contratosBase = z.array(ContractSchema).parse(readJson<unknown>(PATHS.contracts));

export function factura(parcial: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    id: 'INV-TEST',
    archivo: 'INV-TEST.eml',
    formato: 'correo',
    asunto: 'Factura de prueba',
    remitente: 'proveedor@ejemplo.com',
    texto: 'Beneficiario: Ferretería El Tornillo S.A.S.\nMonto: $ 2.450.000,00 COP',
    ...parcial,
  };
}

export function contexto(parcial: Partial<RuleContext> = {}): RuleContext {
  return {
    invoice: factura(),
    extraccion: null,
    verificacion: null,
    config: configBase,
    contratos: contratosBase,
    ledger: [],
    historial: [],
    ...parcial,
  };
}

export function previo(parcial: Partial<PriorDecision> = {}): PriorDecision {
  return {
    invoiceId: 'INV-PREV',
    beneficiario: 'Ferretería El Tornillo S.A.S.',
    monto: 2450000,
    moneda: 'COP',
    referencia: 'OC-2026-0451',
    decision: 'pagar',
    estado: 'pagado',
    origen: 'agente',
    ...parcial,
  };
}
