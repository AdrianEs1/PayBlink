import { z } from 'zod';

/**
 * RF-11: tarjetas del menu Conectores.
 * `vista_previa` deja claro que NO hay conexion real en este MVP.
 */
export const ConnectorStatusSchema = z.enum(['activo', 'vista_previa']);
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;

export const ConnectorSchema = z.object({
  id: z.string(),
  nombre: z.string(),
  categoria: z.string(),
  estado: ConnectorStatusSchema,
  descripcion: z.string(),
  icono: z.string(),
  permisos: z.array(z.string()),
  flujo: z.array(z.string()),
  nota: z.string(),
});
export type Connector = z.infer<typeof ConnectorSchema>;
