import { z } from 'zod';
import { MonedaSchema, IsoDateSchema } from './invoice';

export const PeriodoTipoSchema = z.enum(['mensual', 'quincenal', 'semanal']);
export type PeriodoTipo = z.infer<typeof PeriodoTipoSchema>;

/** Empresa ficticia duena del presupuesto (RF-3.4, seccion 5). */
export const CompanySchema = z.object({
  nombre: z.string().min(1),
  nit: z.string().min(1),
  monedaBase: MonedaSchema,
  periodo: z.object({
    tipo: PeriodoTipoSchema,
    fechaReferencia: IsoDateSchema,
  }),
  presupuestoPeriodo: z.number().positive(),
  /** Tasas fijas hacia la moneda base (RF-3.3). */
  tasas: z.record(MonedaSchema, z.number().positive()),
  responsable: z.string().min(1),
});
export type Company = z.infer<typeof CompanySchema>;
