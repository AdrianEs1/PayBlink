import type { NotificationChannel, NotificationContent } from '@blinka/shared';

export interface OutgoingMessage {
  destinatario: string;
  asunto: string;
  cuerpo: string;
  contenido: NotificationContent;
}

export interface SendResult {
  ok: boolean;
  estado: 'enviado' | 'entregado';
  error?: string;
}

/**
 * RF-12.2: interface de canal de notificacion.
 * NINGUNA implementacion del MVP envia mensajes reales.
 */
export interface NotificationSender {
  readonly canal: NotificationChannel;
  readonly nombre: string;
  send(message: OutgoingMessage): Promise<SendResult>;
}

export class SimulatedWhatsApp implements NotificationSender {
  readonly canal = 'whatsapp' as const;
  readonly nombre = 'WhatsApp simulado';

  async send(message: OutgoingMessage): Promise<SendResult> {
    console.log(`[WHATSAPP SIMULADO] -> ${message.destinatario}\n${message.cuerpo}`);
    return { ok: true, estado: 'entregado' };
  }
}

export class SimulatedEmail implements NotificationSender {
  readonly canal = 'email' as const;
  readonly nombre = 'Correo simulado';

  async send(message: OutgoingMessage): Promise<SendResult> {
    console.log(`[EMAIL SIMULADO] -> ${message.destinatario} · ${message.asunto}\n${message.cuerpo}`);
    return { ok: true, estado: 'entregado' };
  }
}

export function senderFor(canal: NotificationChannel): NotificationSender {
  return canal === 'email' ? new SimulatedEmail() : new SimulatedWhatsApp();
}
