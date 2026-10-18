import type { Connector } from '@payblink/shared';

/**
 * RF-11: catalogo de fuentes de facturas.
 * Los conectores de vista previa NO estan conectados en este MVP y no piden
 * credenciales: la UI lo muestra de forma explicita.
 */
export const CONNECTORS: readonly Connector[] = [
  {
    id: 'carpeta-demo',
    nombre: 'Carpeta de demo',
    categoria: 'Archivos',
    estado: 'activo',
    descripcion: 'Lee las facturas simuladas de data/invoices y las crea como pendientes.',
    icono: '📁',
    permisos: ['Lectura de la carpeta local del proyecto'],
    flujo: ['Al iniciar, el seed carga las facturas', 'Cada archivo se normaliza con su hash', 'La factura queda pendiente o en cola'],
    nota: 'Activo en el MVP.',
  },
  {
    id: 'subida-manual',
    nombre: 'Subida manual',
    categoria: 'Archivos',
    estado: 'activo',
    descripcion: 'Permite subir un PDF desde la pantalla Entradas y crear una factura pendiente.',
    icono: '⬆️',
    permisos: ['Acceso al archivo que la persona elige'],
    flujo: ['La persona sube el PDF', 'Se extrae el texto y se normaliza', 'La factura entra a la cola'],
    nota: 'Activo en el MVP.',
  },
  {
    id: 'gmail',
    nombre: 'Gmail',
    categoria: 'Correo',
    estado: 'vista_previa',
    descripcion: 'Lee el buzon facturas@empresa.com y crea facturas pendientes desde los correos.',
    icono: '✉️',
    permisos: ['gmail.readonly', 'Acceso solo a la etiqueta /facturas'],
    flujo: ['Se consulta el buzon cada 5 minutos', 'Cada correo se normaliza a factura', 'Se descartan mensajes ya procesados por message-id'],
    nota: 'Vista previa: no conectado en este MVP. No se piden credenciales.',
  },
  {
    id: 'outlook',
    nombre: 'Outlook',
    categoria: 'Correo',
    estado: 'vista_previa',
    descripcion: 'Lee un buzon compartido de facturacion con Microsoft Graph.',
    icono: '📨',
    permisos: ['Mail.Read', 'Acceso solo al buzon de facturacion'],
    flujo: ['Suscripcion a cambios del buzon', 'Normalizacion del correo', 'Creacion de la factura pendiente'],
    nota: 'Vista previa: no conectado en este MVP.',
  },
  {
    id: 'slack',
    nombre: 'Slack',
    categoria: 'Mensajeria',
    estado: 'vista_previa',
    descripcion: 'Escucha el canal #facturas-proveedores y convierte los mensajes en facturas.',
    icono: '💬',
    permisos: ['channels:history', 'files:read'],
    flujo: ['Evento message en el canal', 'Se descarga el adjunto', 'La factura queda pendiente'],
    nota: 'Vista previa: no conectado en este MVP.',
  },
  {
    id: 'whatsapp',
    nombre: 'WhatsApp',
    categoria: 'Mensajeria',
    estado: 'vista_previa',
    descripcion: 'Recibe cuentas de cobro por WhatsApp Business en un numero dedicado.',
    icono: '📱',
    permisos: ['whatsapp_business_messaging', 'webhook de mensajes'],
    flujo: ['Webhook del proveedor', 'Se descarga la imagen o PDF', 'La factura entra a la cola'],
    nota: 'Vista previa: no conectado en este MVP.',
  },
  {
    id: 'drive',
    nombre: 'Google Drive',
    categoria: 'Archivos',
    estado: 'vista_previa',
    descripcion: 'Vigila una carpeta compartida de facturas y procesa los archivos nuevos.',
    icono: '🗂️',
    permisos: ['drive.readonly'],
    flujo: ['Cambio en la carpeta', 'Descarga del PDF', 'Normalizacion y encolado'],
    nota: 'Vista previa: no conectado en este MVP.',
  },
  {
    id: 'erp',
    nombre: 'ERP / contabilidad',
    categoria: 'Sistemas',
    estado: 'vista_previa',
    descripcion: 'Importa cuentas de cobro y ordenes de compra desde el ERP de la empresa.',
    icono: '🏢',
    permisos: ['Lectura de cuentas por pagar', 'Lectura de ordenes de compra'],
    flujo: ['Sincronizacion de cuentas por pagar', 'Cruce con ordenes de compra', 'Creacion de facturas pendientes'],
    nota: 'Vista previa: no conectado en este MVP.',
  },
];

export function getConnector(id: string): Connector | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
