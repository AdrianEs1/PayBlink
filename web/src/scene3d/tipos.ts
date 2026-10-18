import type { InvoiceListItem, Summary } from '@blinka/shared';

/** Las ocho pantallas existentes, ahora estaciones de la sala 3D. */
export type SalaId =
  | 'entradas'
  | 'facturas'
  | 'aprobaciones'
  | 'reglas'
  | 'chat'
  | 'notificaciones'
  | 'conectores'
  | 'auditoria';

export interface SalaDatos {
  facturas: InvoiceListItem[];
  resumen: Summary | null;
}

export const SALA_LABEL: Record<SalaId, string> = {
  entradas: 'Entradas',
  facturas: 'Facturas',
  aprobaciones: 'Aprobaciones',
  reglas: 'Reglas',
  chat: 'Chat',
  notificaciones: 'Notificaciones',
  conectores: 'Conectores',
  auditoria: 'Auditoría',
};
