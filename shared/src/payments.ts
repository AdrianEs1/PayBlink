import { z } from 'zod';
import { IsoDateSchema, MonedaSchema } from './invoice';

/** RF-14.1: ficha ficticia del beneficiario (sin datos reales). */
export const BeneficiarySchema = z.object({
  nombre: z.string().min(1),
  pais: z.string().min(1),
  monedaPreferida: MonedaSchema,
  bancoFicticio: z.string().min(1),
  cuentaFicticia: z.string().min(1),
});
export type Beneficiary = z.infer<typeof BeneficiarySchema>;

/** RF-14.2: orden de pago preparada. No se ejecuta ni se envia a ninguna plataforma. */
export const PaymentOrderSchema = z.object({
  id: z.string(),
  invoiceId: z.string(),
  beneficiario: z.string(),
  pais: z.string(),
  bancoFicticio: z.string(),
  cuentaFicticia: z.string(),
  monedaPreferida: MonedaSchema,
  monto: z.number(),
  moneda: MonedaSchema,
  montoConvertido: z.number(),
  monedaBase: MonedaSchema,
  fechaSugerida: IsoDateSchema,
  referencia: z.string(),
  concepto: z.string(),
  estado: z.literal('preparada'),
  createdAt: z.string(),
});
export type PaymentOrder = z.infer<typeof PaymentOrderSchema>;
