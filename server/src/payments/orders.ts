import { randomUUID } from 'node:crypto';
import type { DecisionRecord, PaymentOrder, RulesConfig } from '@payblink/shared';
import { log as audit } from '../audit/audit';
import { convertToBase } from '../core/money';
import * as repo from '../storage/repositories';
import { beneficiaryRecord } from './beneficiaries';

/**
 * RF-14.2: orden de pago preparada.
 * NO se ejecuta ni se envia a ninguna plataforma: es un documento de revision.
 */
export function buildPaymentOrder(record: DecisionRecord, config: RulesConfig): PaymentOrder | null {
  const extraccion = record.extraccion;
  if (!extraccion) return null;
  const montoConvertido = convertToBase(extraccion.monto, extraccion.moneda, config);
  if (montoConvertido === null) return null;

  const ficha = beneficiaryRecord(extraccion.beneficiario);
  return {
    id: randomUUID(),
    invoiceId: record.invoiceId,
    beneficiario: extraccion.beneficiario,
    pais: ficha.pais,
    bancoFicticio: ficha.bancoFicticio,
    cuentaFicticia: ficha.cuentaFicticia,
    monedaPreferida: ficha.monedaPreferida,
    monto: extraccion.monto,
    moneda: extraccion.moneda,
    montoConvertido,
    monedaBase: config.monedaBase,
    fechaSugerida: extraccion.fechaVencimiento,
    referencia: extraccion.referencia,
    concepto: extraccion.concepto,
    estado: 'preparada',
    createdAt: repo.nowIso(),
  };
}

/** Idempotente: si la factura ya tiene orden, no se duplica. */
export function ensurePaymentOrder(record: DecisionRecord, config: RulesConfig): PaymentOrder | null {
  if (record.decisionFinal !== 'pagar') return null;
  const existente = repo.getPaymentOrder(record.invoiceId);
  if (existente) return existente;

  const order = buildPaymentOrder(record, config);
  if (!order) return null;

  repo.insertPaymentOrder(order);
  audit({
    actor: 'sistema',
    tipo: 'pago.orden',
    invoiceId: record.invoiceId,
    detalle: {
      ordenId: order.id,
      beneficiario: order.beneficiario,
      monto: order.monto,
      moneda: order.moneda,
      montoConvertido: order.montoConvertido,
      monedaBase: order.monedaBase,
      fechaSugerida: order.fechaSugerida,
      referencia: order.referencia,
      estado: order.estado,
    },
  });
  return order;
}
