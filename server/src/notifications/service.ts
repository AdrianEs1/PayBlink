import { randomUUID } from 'node:crypto';
import type {
  DecisionRecord,
  Notification,
  NotificationContent,
  NotificationResponse,
  RulesConfig,
} from '@payblink/shared';
import { log as audit } from '../audit/audit';
import { formatMoney, convertToBase } from '../core/money';
import { etiquetaRegla } from '../core/explain';
import { decideHuman, type HumanDecisionResult, type OrchestratorDeps } from '../agent/orchestrator';
import * as repo from '../storage/repositories';
import { chooseApprover } from './approvers';
import { senderFor } from './channels';

function resumenEscalada(record: DecisionRecord): string {
  const reglas = record.reglas.filter((r) => r.resultado !== 'pasa');
  if (reglas.length === 0) return 'La factura necesita una revisión humana antes de pagarse.';
  return reglas.slice(0, 2).map((r) => `${etiquetaRegla(r)}: ${r.motivo}`).join(' ');
}

/**
 * RF-12: al escalar, se "envia" un mensaje al aprobador y queda en el outbox.
 * No se envia nada real (canales simulados).
 */
export async function notifyEscalation(
  record: DecisionRecord,
  config: RulesConfig,
): Promise<Notification | null> {
  if (record.estado !== 'pendiente_aprobacion') return null;
  const existente = repo.getNotificationByInvoice(record.invoiceId);
  if (existente) return existente;

  // RF-12.1: se notifica siempre, tambien cuando la extraccion fallo.
  const extraccion = record.extraccion;
  const montoBase = extraccion ? convertToBase(extraccion.monto, extraccion.moneda, config) : null;
  const approver = chooseApprover(montoBase ?? extraccion?.monto ?? config.umbralAprobacionHumana);
  if (!approver) return null;

  const contenido: NotificationContent = {
    facturaId: record.invoiceId,
    beneficiario: extraccion?.beneficiario ?? 'Beneficiario sin extraer',
    monto: extraccion?.monto ?? null,
    moneda: extraccion?.moneda ?? null,
    motivo: resumenEscalada(record),
    resumen: record.descripcion.resumen,
    acciones: ['Aprobar', 'Rechazar', 'Ver detalle', 'Preguntar al agente'],
  };

  const cuerpo =
    `Hola ${approver.nombre}, necesito tu decisión sobre una factura.\n\n` +
    `Beneficiario: ${contenido.beneficiario}\n` +
    `Monto: ${extraccion ? formatMoney(extraccion.monto, extraccion.moneda) : 'sin extraer'}\n` +
    `Motivo: ${contenido.motivo}\n\n` +
    `${contenido.resumen}\n\n` +
    'Responde con Aprobar o Rechazar, o abre el detalle en la app.';

  const sender = senderFor(approver.canalPreferido);
  const destino = approver.canalPreferido === 'email' ? approver.email : approver.telefono;
  const envio = await sender.send({
    destinatario: destino,
    asunto: `Factura ${record.invoiceId} pendiente de aprobación`,
    cuerpo,
    contenido,
  });

  const timestamp = repo.nowIso();
  const notification: Notification = {
    id: randomUUID(),
    invoiceId: record.invoiceId,
    approverId: approver.id,
    approverNombre: approver.nombre,
    canal: sender.canal,
    destinatario: destino,
    asunto: `Factura ${record.invoiceId} pendiente de aprobación`,
    cuerpo,
    contenido,
    estado: envio.ok ? 'entregado' : 'enviado',
    respuesta: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  repo.insertNotification(notification);

  audit({
    actor: 'sistema',
    tipo: 'notificacion.enviada',
    invoiceId: record.invoiceId,
    detalle: {
      notificacionId: notification.id,
      approver: approver.nombre,
      canal: sender.canal,
      destinatario: destino,
      estado: notification.estado,
      simulado: true,
      motivo: contenido.motivo,
    },
  });

  // RF-10.6: el agente deja un mensaje en el hilo de la factura.
  const mensaje = `Escalé esta factura por ${contenido.motivo} Necesito que una persona apruebe o rechace el pago; desde el chat solo puedo consultar y proponer, no ejecutar.`;
  repo.appendChatMessage(record.invoiceId, 'agente', mensaje);
  audit({
    actor: 'agente',
    tipo: 'chat.mensaje',
    invoiceId: record.invoiceId,
    detalle: { hilo: record.invoiceId, rol: 'agente', contenido: mensaje },
  });

  return notification;
}

/**
 * RF-12.6 / CA-20: los botones de la notificacion llaman al MISMO endpoint de
 * aprobacion humana, con la identidad del aprobador y su registro.
 */
export function respondFromNotification(
  notificationId: string,
  accion: 'aprobar' | 'rechazar',
  quien: string,
  comentario: string,
  deps: OrchestratorDeps,
): { result: HumanDecisionResult; notification: Notification | null } {
  const notification = repo.getNotification(notificationId);
  if (!notification) {
    return { result: { ok: false, error: 'No existe la notificacion.' }, notification: null };
  }
  if (notification.estado === 'respondido') {
    return { result: { ok: false, error: 'La notificacion ya fue respondida.' }, notification };
  }

  const identidad = quien.trim() || notification.approverNombre;
  const result = decideHuman(notification.invoiceId, accion, identidad, comentario, deps);

  if (!result.ok) return { result, notification };

  const respuesta: NotificationResponse = {
    accion,
    quien: identidad,
    comentario,
    fecha: repo.nowIso(),
  };
  const actualizada = repo.respondNotification(notificationId, respuesta);

  audit({
    actor: 'persona',
    tipo: 'notificacion.respondida',
    invoiceId: notification.invoiceId,
    detalle: { notificacionId: notificationId, accion, quien: identidad, comentario },
  });

  return { result, notification: actualizada };
}
