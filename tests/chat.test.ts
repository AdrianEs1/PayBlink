import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sendChatMessage, confirmChatProposal } from '../server/src/chat/agent';
import { ingestEntry, listExamples } from '../server/src/ingestion/service';
import { enqueueInvoice, waitForQueueIdle } from '../server/src/jobs/queue';
import { closeDb } from '../server/src/storage/db';
import * as repo from '../server/src/storage/repositories';
import { seedDatabase } from '../server/src/storage/seed';

function ejemplo(id: string) {
  const encontrado = listExamples().find((e) => e.id === id);
  if (!encontrado) throw new Error(`Falta el ejemplo ${id}.`);
  return encontrado.entry;
}

async function escalada() {
  const entrada = await ingestEntry(ejemplo('SIM-004'));
  enqueueInvoice(entrada.invoiceId);
  await waitForQueueIdle();
  return entrada.invoiceId;
}

beforeEach(async () => {
  await waitForQueueIdle();
  await seedDatabase({ reset: true });
  repo.setIngestMode('manual');
});

afterAll(() => {
  closeDb();
});

describe('RF-10 / CA-11: consultas con datos reales', () => {
  it('responde el estado de las facturas pendientes', async () => {
    await escalada();
    const respuesta = await sendChatMessage('global', '¿Qué facturas están pendientes de aprobación?');
    expect(respuesta.rol).toBe('agente');
    expect(respuesta.contenido).toContain('pendiente');
    expect(respuesta.contenido).toMatch(/SIM-004/);
  });

  it('responde el presupuesto comprometido del periodo', async () => {
    const respuesta = await sendChatMessage('global', '¿Cuánto llevamos gastado del presupuesto?');
    expect(respuesta.contenido).toContain('comprometidos');
    expect(respuesta.contenido).toContain('presupuesto');
  });
});

describe('RF-10 / CA-12: el chat no aprueba por sí mismo', () => {
  it('pedir "aprueba esta factura" solo genera una propuesta', async () => {
    const facturaId = await escalada();
    const respuesta = await sendChatMessage(facturaId, '¿Puedes aprobar esta factura?');

    const propuesta = respuesta.propuestas.find((p) => p.tipo === 'aprobar');
    expect(propuesta).toBeDefined();
    expect(propuesta?.estado).toBe('pendiente');

    // La decisión NO cambió: sigue pendiente de aprobación humana.
    expect(repo.getDecisionByInvoice(facturaId)?.estado).toBe('pendiente_aprobacion');
  });

  it('CA-13: confirmar la propuesta la ejecuta y deja registro humano', async () => {
    const facturaId = await escalada();
    const respuesta = await sendChatMessage(facturaId, '¿Puedes aprobar esta factura?');
    const propuesta = respuesta.propuestas.find((p) => p.tipo === 'aprobar');
    expect(propuesta).toBeDefined();
    if (!propuesta) return;

    const confirmacion = confirmChatProposal(propuesta.id, 'Marta Rincón');
    expect(confirmacion.ok).toBe(true);

    const record = repo.getDecisionByInvoice(facturaId);
    expect(record?.estado).toBe('aprobado_humano');
    expect(record?.humano?.quien).toBe('Marta Rincón');
    expect(repo.getStoredInvoice(facturaId)?.queueState).toBe('pagada');
  });
});

describe('RF-10.4: propuestas de cambio de reglas', () => {
  it('agregar un beneficiario requiere confirmación y queda auditado', async () => {
    const respuesta = await sendChatMessage(
      'global',
      'Agrega el beneficiario Consultores Fantasma S.A.S.',
    );
    const propuesta = respuesta.propuestas.find((p) => p.tipo === 'agregar_beneficiario');
    expect(propuesta).toBeDefined();
    expect(repo.getRulesConfig()?.beneficiariosPermitidos).not.toContain('Consultores Fantasma S.A.S.');

    if (!propuesta) return;
    const confirmacion = confirmChatProposal(propuesta.id, 'Marta Rincón');
    expect(confirmacion.ok).toBe(true);
    expect(repo.getRulesConfig()?.beneficiariosPermitidos).toContain('Consultores Fantasma S.A.S.');
  });
});
