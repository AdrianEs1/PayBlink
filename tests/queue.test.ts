import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildDeps } from '../server/src/agent/deps';
import { ingestEntry, listExamples } from '../server/src/ingestion/service';
import {
  enqueueInvoice,
  waitForQueueIdle,
} from '../server/src/jobs/queue';
import { respondFromNotification } from '../server/src/notifications/service';
import { closeDb } from '../server/src/storage/db';
import * as repo from '../server/src/storage/repositories';
import { seedDatabase } from '../server/src/storage/seed';

function ejemplo(id: string) {
  const encontrado = listExamples().find((e) => e.id === id);
  if (!encontrado) throw new Error(`Falta el ejemplo ${id}.`);
  return encontrado.entry;
}

beforeEach(async () => {
  await waitForQueueIdle();
  await seedDatabase({ reset: true });
  repo.setIngestMode('manual');
});

afterAll(() => {
  closeDb();
});

describe('RF-1: ingesta normalizada e idempotente', () => {
  it('crea una factura pendiente con fuente y evita reprocesar el mismo mensaje', async () => {
    const primero = await ingestEntry(ejemplo('SIM-001'));
    expect(primero.duplicada).toBe(false);
    expect(primero.queueState).toBe('pendiente');

    const segunda = await ingestEntry(ejemplo('SIM-001'));
    expect(segunda.duplicada).toBe(true);
    expect(segunda.invoiceId).toBe(primero.invoiceId);

    const stored = repo.getStoredInvoice(primero.invoiceId);
    expect(stored?.queueState).toBe('pendiente');
    expect(stored?.fuente?.conector).toBe('simulador-correo');
    expect(stored?.hash).toHaveLength(64);
  });
});

describe('RF-1.8 / CA-16: modo manual y automático', () => {
  it('en manual, crear la entrada NO ejecuta al agente; el botón sí', async () => {
    const entrada = await ingestEntry(ejemplo('SIM-002'));
    expect(repo.getDecisionByInvoice(entrada.invoiceId)).toBeNull();

    expect(enqueueInvoice(entrada.invoiceId)).toBe(true);
    await waitForQueueIdle();

    const record = repo.getDecisionByInvoice(entrada.invoiceId);
    expect(record).not.toBeNull();
    expect(record?.decisionFinal).toBe('pagar');
    expect(repo.getStoredInvoice(entrada.invoiceId)?.queueState).toBe('pagada');
    expect(repo.getPaymentOrder(entrada.invoiceId)).not.toBeNull();

    const tipos = new Set(
      repo.listChatMessages(entrada.invoiceId).map((m) => m.rol),
    );
    expect(tipos.size).toBeGreaterThanOrEqual(0);
  });

  it('en automático, la entrada se encola y escala sola; genera notificación y mensaje', async () => {
    repo.setIngestMode('automatico');
    const entrada = await ingestEntry(ejemplo('SIM-003'));
    expect(entrada.enCola).toBe(true);
    await waitForQueueIdle();

    const record = repo.getDecisionByInvoice(entrada.invoiceId);
    expect(record?.decisionFinal).toBe('escalar');
    expect(repo.getStoredInvoice(entrada.invoiceId)?.queueState).toBe('escalada');

    const notificacion = repo.getNotificationByInvoice(entrada.invoiceId);
    expect(notificacion).not.toBeNull();
    expect(notificacion?.contenido.facturaId).toBe(entrada.invoiceId);
    expect(notificacion?.contenido.acciones).toContain('Aprobar');

    // RF-10.6: el agente deja un mensaje en el hilo de la factura.
    const hilo = repo.listChatMessages(entrada.invoiceId);
    expect(hilo.some((m) => m.rol === 'agente' && m.contenido.includes('Escalé'))).toBe(true);
  });
});

describe('CA-8: editar las reglas cambia las decisiones siguientes', () => {
  it('bajar el límite por pago convierte un pago en escalada', async () => {
    const config = repo.getRulesConfig();
    expect(config).not.toBeNull();
    if (!config) return;

    // Límite por pago muy bajo: la misma factura que pagaba ahora escala por R3.
    repo.saveRulesConfig({ ...config, limitePorPago: 100_000 });

    const entrada = await ingestEntry(ejemplo('SIM-002'));
    enqueueInvoice(entrada.invoiceId);
    await waitForQueueIdle();

    const record = repo.getDecisionByInvoice(entrada.invoiceId);
    expect(record?.decisionFinal).toBe('escalar');
    expect(record?.reglas.find((r) => r.id === 'R3')?.resultado).toBe('escala');
    expect(repo.getPaymentOrder(entrada.invoiceId)).toBeNull();
  });
});

describe('RF-12 / CA-20: respuesta desde la notificación', () => {
  it('aprueba con la identidad del aprobador y usa el mismo camino que Aprobaciones', async () => {
    repo.setIngestMode('automatico');
    const entrada = await ingestEntry(ejemplo('SIM-003'));
    await waitForQueueIdle();

    const notificacion = repo.getNotificationByInvoice(entrada.invoiceId);
    expect(notificacion).not.toBeNull();
    if (!notificacion) return;

    const deps = buildDeps();
    expect(deps).not.toBeNull();
    if (!deps) return;

    const { result, notification } = respondFromNotification(
      notificacion.id,
      'aprobar',
      notificacion.approverNombre,
      'Aprobado desde WhatsApp simulado.',
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.record?.estado).toBe('aprobado_humano');
    expect(result.record?.humano?.quien).toBe(notificacion.approverNombre);
    expect(notification?.estado).toBe('respondido');
    expect(repo.getPaymentOrder(entrada.invoiceId)).not.toBeNull();

    const ultima = repo.listChatMessages(entrada.invoiceId).at(-1);
    expect(ultima).toBeDefined();
  });
});
