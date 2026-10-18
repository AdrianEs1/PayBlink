import { QUEUE_STATE_LABEL, type QueueItem } from '@blinka/shared';
import { buildDeps } from '../agent/deps';
import {
  processInvoice,
  queueStateForEstado,
  recordFailure,
  type OrchestratorDeps,
} from '../agent/orchestrator';
import { log as audit } from '../audit/audit';
import { notifyEscalation } from '../notifications/service';
import * as repo from '../storage/repositories';

/** RF-1.9: reintentos acotados con backoff; nunca dos veces la misma factura. */
const INTENTOS_MAX = 2;
const BACKOFF_MS = Number(process.env.QUEUE_BACKOFF_MS ?? 500) || 500;

let drenando = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** RF-1.8: encola una factura sin ejecutar el agente de inmediato. */
export function enqueueInvoice(invoiceId: string): boolean {
  const invoice = repo.getStoredInvoice(invoiceId);
  if (!invoice) return false;
  if (repo.getDecisionByInvoice(invoiceId)) return false;
  if (invoice.queueState === 'procesando') return false;

  repo.setQueueState(invoiceId, 'en_cola');
  audit({
    actor: 'sistema',
    tipo: 'factura.encolada',
    invoiceId,
    detalle: { modo: repo.getIngestMode(), intentos: invoice.intentos },
  });

  void drainQueue();
  return true;
}

/** Boton "Procesar todas las pendientes". */
export function enqueueAllPending(): number {
  const pendientes = repo.listProcessableInvoices();
  let encoladas = 0;
  for (const invoice of pendientes) {
    if (enqueueInvoice(invoice.id)) encoladas += 1;
  }
  return encoladas;
}

/** El worker procesa de una en una, en orden determinista (RF-1.9, RF-7.2). */
export async function drainQueue(): Promise<void> {
  if (drenando) return;
  drenando = true;
  try {
    for (;;) {
      // Solo se procesa lo que fue encolado explicitamente (modo manual o webhook).
      const invoice = repo.claimNextInvoice();
      if (!invoice) break;
      await procesar(invoice.id);
    }
  } finally {
    drenando = false;
  }
}

async function procesar(invoiceId: string): Promise<void> {
  const deps = buildDeps();
  const invoice = repo.getStoredInvoice(invoiceId);
  if (!invoice) return;

  audit({ actor: 'sistema', tipo: 'factura.procesando', invoiceId, detalle: { intento: invoice.intentos + 1 } });

  if (!deps) {
    repo.setQueueState(invoiceId, 'error', { error: 'La base de datos no esta inicializada.' });
    return;
  }

  // Idempotencia: si ya existe decision, no se vuelve a procesar.
  const existente = repo.getDecisionByInvoice(invoiceId);
  if (existente) {
    repo.setQueueState(invoiceId, queueStateForEstado(existente.estado));
    return;
  }

  try {
    const { record } = await processInvoice(invoice, deps);
    const queueState = queueStateForEstado(record.estado);
    repo.setQueueState(invoiceId, queueState, { error: null });
    audit({
      actor: 'sistema',
      tipo: 'factura.estado',
      invoiceId,
      detalle: { estado: record.estado, queueState, decisionFinal: record.decisionFinal },
    });

    if (record.estado === 'pendiente_aprobacion') {
      await notifyEscalation(record, deps.config);
    }
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    const intento = invoice.intentos + 1;

    if (intento < INTENTOS_MAX) {
      repo.setQueueState(invoiceId, 'en_cola', { error: mensaje, incrementarIntento: true });
      audit({
        actor: 'sistema',
        tipo: 'reintento',
        invoiceId,
        detalle: { intento, maxIntentos: INTENTOS_MAX, error: mensaje, backoffMs: BACKOFF_MS },
      });
      await sleep(BACKOFF_MS * intento);
      return;
    }

    // RF-1.10: fallo irrecuperable -> decision escalada con la descripcion del fallo.
    const record = recordFailure(invoice, mensaje, deps);
    repo.setQueueState(invoiceId, 'error', { error: mensaje, incrementarIntento: true });
    audit({
      actor: 'sistema',
      tipo: 'factura.estado',
      invoiceId,
      detalle: { estado: record.estado, queueState: 'error', fallo: mensaje },
    });
    await notifyEscalation(record, deps.config);
  }
}

/** Vista de la cola para la pantalla Entradas (RF-8.9). */
export function listQueue(): QueueItem[] {
  return repo.listStoredInvoices().map((invoice) => {
    const record = repo.getDecisionByInvoice(invoice.id);
    const decidida = record !== null;
    return {
      id: invoice.id,
      archivo: invoice.archivo,
      asunto: invoice.asunto,
      formato: invoice.formato,
      queueState: decidida ? queueStateForEstado(record.estado) : invoice.queueState,
      intentos: invoice.intentos,
      ultimoError: invoice.ultimoError,
      fuente: invoice.fuente,
      decisionFinal: record?.decisionFinal ?? null,
      recibidoEn: invoice.recibidoEn,
    };
  });
}

export function queueLabel(state: QueueItem['queueState']): string {
  return QUEUE_STATE_LABEL[state];
}

/** Al arrancar: recupera trabajos a medias y drena lo que haya quedado. */
export function startQueue(): void {
  const recuperadas = repo.recoverStaleQueue();
  if (recuperadas > 0) {
    audit({
      actor: 'sistema',
      tipo: 'reintento',
      detalle: { recuperadas, motivo: 'Trabajos a medias recuperados al iniciar el servidor.' },
    });
  }
  void drainQueue();
}

/** Utilidad para tests y demos: espera a que la cola quede vacia. */
export async function waitForQueueIdle(timeoutMs = 30_000): Promise<void> {
  const inicio = Date.now();
  const activas = () =>
    repo.listStoredInvoices().some((i) => i.queueState === 'en_cola' || i.queueState === 'procesando');
  while (drenando || activas()) {
    if (Date.now() - inicio > timeoutMs) throw new Error('La cola no termino dentro del tiempo esperado.');
    await sleep(50);
  }
}

export type { OrchestratorDeps };
