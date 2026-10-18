import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DecisionSchema, type Decision } from '@payblink/shared';
import { z } from 'zod';
import { PATHS, readJson } from '../server/src/config';
import { createFixtureClient } from '../server/src/agent/llm/fixtures';
import {
  decideHuman,
  processInvoice,
  processPending,
  type OrchestratorDeps,
} from '../server/src/agent/orchestrator';
import type { LlmClient } from '../server/src/agent/llm/types';
import { closeDb } from '../server/src/storage/db';
import { seedDatabase } from '../server/src/storage/seed';
import * as repo from '../server/src/storage/repositories';

const ExpectedSchema = z.object({
  orden: z.array(z.string()),
  esperado: z.record(
    z.string(),
    z.object({ decision: DecisionSchema, caso: z.string().optional(), reglas: z.array(z.string()).optional() }),
  ),
});

const esperado = ExpectedSchema.parse(readJson<unknown>(PATHS.expected));
const resultados = new Map<string, Decision>();

function deps(llm: LlmClient = createFixtureClient()): OrchestratorDeps {
  const config = repo.getRulesConfig();
  const company = repo.getCompany();
  if (!config || !company) throw new Error('Base no sembrada.');
  return { llm, config, contratos: repo.getContracts(), company };
}

beforeAll(async () => {
  await seedDatabase({ reset: true });
  const procesadas = await processPending(deps());
  for (const { record } of procesadas) resultados.set(record.invoiceId, record.decisionFinal);
});

afterAll(() => {
  closeDb();
});

describe('CA-1 / CA-2: cero pagos indebidos (RNF-1)', () => {
  it('procesa el set completo', () => {
    expect(resultados.size).toBe(esperado.orden.length);
  });

  it('ninguna factura se paga cuando no correspondia', () => {
    const indebidos = [...resultados.entries()].filter(
      ([id, decision]) => decision === 'pagar' && esperado.esperado[id]?.decision !== 'pagar',
    );
    expect(indebidos).toEqual([]);
  });

  it('ningun caso trampa termina en pagar', () => {
    const trampas = esperado.orden.filter((id) => esperado.esperado[id]?.decision !== 'pagar');
    const pagadas = trampas.filter((id) => resultados.get(id) === 'pagar');
    expect(pagadas).toEqual([]);
  });

  it('cada decision coincide con la esperada', () => {
    const discrepancias = esperado.orden
      .filter((id) => resultados.get(id) !== esperado.esperado[id]?.decision)
      .map((id) => `${id}: esperado ${esperado.esperado[id]?.decision}, obtenido ${resultados.get(id)}`);
    expect(discrepancias).toEqual([]);
  });

  it('el duplicado exacto frena y el casi duplicado escala', () => {
    expect(resultados.get('INV-021')).toBe('frenar');
    expect(resultados.get('INV-022')).toBe('escalar');
  });
});

describe('CA-5: prompt injection no altera la decision', () => {
  it('una factura valida con instrucciones embebidas se paga igual', () => {
    expect(esperado.esperado['INV-026']?.decision).toBe('pagar');
    expect(resultados.get('INV-026')).toBe('pagar');
  });

  it('una factura con datos faltantes e inyeccion escala', () => {
    expect(resultados.get('INV-027')).toBe('escalar');
  });

  it('la inyeccion queda registrada en la auditoria', () => {
    const record = repo.getDecisionByInvoice('INV-026');
    expect(record?.verificacion?.inyeccionesDetectadas.length).toBeGreaterThan(0);
  });
});

describe('CA-6: fallo del LLM termina en escalar', () => {
  it('extraccion fallida, JSON invalido o timeout escalan', async () => {
    await seedDatabase({ reset: true });

    const llmRoto: LlmClient = {
      modo: 'mock',
      descripcion: 'LLM simulado que siempre falla',
      async extract() {
        return { ok: false, error: 'timeout simulado' };
      },
      async propose() {
        return { decision: 'pagar', razones: ['El modelo simulado propone pagar.'] };
      },
      async explain() {
        return null;
      },
      async responderChat() {
        return 'No puedo responder en este modo de prueba.';
      },
    };

    const factura = repo.listInvoices()[0];
    expect(factura).toBeDefined();
    if (!factura) return;

    const { record } = await processInvoice(factura, deps(llmRoto));
    expect(record.decisionFinal).toBe('escalar');
    expect(record.extraccion).toBeNull();
    expect(record.guardActuo).toBe(true);
  });

  it('un LLM que propone pagar no logra pagar si las reglas escalan', async () => {
    await seedDatabase({ reset: true });

    const llmPermisivo: LlmClient = {
      modo: 'mock',
      descripcion: 'Propone pagar siempre',
      async extract(invoice) {
        return createFixtureClient().extract(invoice);
      },
      async propose() {
        return { decision: 'pagar', razones: ['Todo bien, pago.'] };
      },
      async explain() {
        return null;
      },
      async responderChat() {
        return 'No puedo responder en este modo de prueba.';
      },
    };

    const facturas = repo.listInvoices();
    const beneficiarioDesconocido = facturas.find((f) => f.id === 'INV-018');
    expect(beneficiarioDesconocido).toBeDefined();
    if (!beneficiarioDesconocido) return;

    const { record } = await processInvoice(beneficiarioDesconocido, deps(llmPermisivo));
    expect(record.propuestaLlm.decision).toBe('pagar');
    expect(record.decisionFinal).toBe('escalar');
  });
});

describe('CA-7: aprobacion y rechazo humano', () => {
  it('aprueba una escalada y la registra en el ledger', async () => {
    await seedDatabase({ reset: true });
    const dependencias = deps();
    await processPending(dependencias);

    const antes = repo.listLedger().length;
    const resultado = decideHuman('INV-004', 'aprobar', 'Marta Rincón', 'Autorizado por gerencia.', dependencias);

    expect(resultado.ok).toBe(true);
    expect(resultado.record?.estado).toBe('aprobado_humano');
    expect(resultado.record?.decisionFinal).toBe('pagar');
    expect(resultado.record?.humano?.quien).toBe('Marta Rincón');
    expect(repo.listLedger().length).toBe(antes + 1);
  });

  it('rechaza una escalada y no toca el ledger', async () => {
    const dependencias = deps();
    const antes = repo.listLedger().length;
    const resultado = decideHuman('INV-019', 'rechazar', 'Marta Rincón', 'Falta soporte.', dependencias);

    expect(resultado.ok).toBe(true);
    expect(resultado.record?.estado).toBe('rechazado_humano');
    expect(repo.listLedger().length).toBe(antes);
  });

  it('no permite aprobar una factura frenada por una regla de bloqueo', () => {
    const resultado = decideHuman('INV-021', 'aprobar', 'Marta Rincón', '', deps());
    expect(resultado.ok).toBe(false);
    expect(repo.getDecisionByInvoice('INV-021')?.decisionFinal).toBe('frenar');
  });

  it('no permite decidir dos veces la misma factura', () => {
    const resultado = decideHuman('INV-004', 'rechazar', 'Marta Rincón', '', deps());
    expect(resultado.ok).toBe(false);
  });
});
