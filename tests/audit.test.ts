import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureClient } from '../server/src/agent/llm/fixtures';
import { processInvoice, type OrchestratorDeps } from '../server/src/agent/orchestrator';
import {
  exportEventsCsv,
  listEvents,
  log,
  verifyChain,
} from '../server/src/audit/audit';
import { closeDb } from '../server/src/storage/db';
import * as repo from '../server/src/storage/repositories';
import { seedDatabase } from '../server/src/storage/seed';

function deps(): OrchestratorDeps {
  const config = repo.getRulesConfig();
  const company = repo.getCompany();
  if (!config || !company) throw new Error('Base no sembrada.');
  return { llm: createFixtureClient(), config, contratos: repo.getContracts(), company };
}

beforeAll(async () => {
  await seedDatabase({ reset: true });
});

afterAll(() => {
  closeDb();
});

describe('RF-13: auditoría append-only y encadenada', () => {
  it('encadena hashes y verifica la integridad', () => {
    log({ actor: 'sistema', tipo: 'factura.recibida', invoiceId: 'INV-TEST-AUDIT', detalle: { paso: 1 } });
    log({ actor: 'agente', tipo: 'extraccion.realizada', invoiceId: 'INV-TEST-AUDIT', detalle: { paso: 2 } });
    log({
      actor: 'persona',
      tipo: 'accion.humana',
      invoiceId: 'INV-TEST-AUDIT',
      detalle: { paso: 3, apiKey: 'NO-DEBE-APARECER' },
    });

    const eventos = listEvents({ invoiceId: 'INV-TEST-AUDIT' });
    expect(eventos.length).toBe(3);
    expect(eventos[0]?.hashPrev).toBeNull();
    expect(eventos[1]?.hashPrev).toBe(eventos[0]?.hash);
    expect(eventos[2]?.hashPrev).toBe(eventos[1]?.hash);
    expect(verifyChain().ok).toBe(true);

    // RF-13.8: los secretos se redactan.
    expect(JSON.stringify(eventos[2]?.detalle)).not.toContain('NO-DEBE-APARECER');
    expect(JSON.stringify(eventos[2]?.detalle)).toContain('[redactado]');
  });

  it('filtra por actor y exporta CSV', () => {
    const personas = listEvents({ invoiceId: 'INV-TEST-AUDIT', actor: 'persona' });
    expect(personas).toHaveLength(1);
    const csv = exportEventsCsv({ invoiceId: 'INV-TEST-AUDIT' });
    expect(csv.split('\n')[0]).toContain('id,fecha,actor,tipo,factura,detalle');
    expect(csv).toContain('accion.humana');
  });

  it('CA-21: un procesamiento completo deja los eventos mínimos en orden', async () => {
    const factura = repo.getInvoice('INV-001');
    expect(factura).toBeDefined();
    if (!factura) return;

    await processInvoice(factura, deps());
    const eventos = listEvents({ invoiceId: 'INV-001' });
    const tipos = eventos.map((e) => e.tipo);

    const indice = (tipo: string) => tipos.indexOf(tipo as (typeof tipos)[number]);
    expect(indice('extraccion.realizada')).toBeGreaterThanOrEqual(0);
    expect(indice('regla.evaluada')).toBeGreaterThan(indice('extraccion.realizada'));
    expect(indice('llm.propuesta')).toBeGreaterThan(indice('regla.evaluada'));
    expect(indice('guard.decision')).toBeGreaterThan(indice('llm.propuesta'));
    expect(indice('descripcion.generada')).toBeGreaterThan(indice('guard.decision'));
    expect(indice('decision.registrada')).toBeGreaterThan(indice('descripcion.generada'));

    const decision = eventos.find((e) => e.tipo === 'decision.registrada');
    expect(decision?.detalle.promptVersion).toBeTruthy();
    expect(decision?.detalle.reglasVersion).toBeTruthy();
    expect(decision?.detalle.modelo).toBeTruthy();
  });
});
