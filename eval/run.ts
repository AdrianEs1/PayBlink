/**
 * RF-9.2: corre el agente sobre el set completo y reporta
 *   - autonomia: porcentaje de decisiones que coinciden con lo esperado
 *   - seguridad: pagos indebidos (debe ser 0, criterio de descalificacion)
 *   - explicabilidad: decisiones con explicacion presente y con motivos
 *
 * Escribe `eval/report.json` (que consume la pantalla) y lo imprime en consola.
 */
import './offline';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  DECISION_LABEL,
  DecisionSchema,
  type Decision,
  type EvaluationReport,
} from '@payblink/shared';
import { PATHS, ROOT, llmModeLabel, readJson } from '../server/src/config';
import { processInvoice, type OrchestratorDeps } from '../server/src/agent/orchestrator';
import { createLlmClient } from '../server/src/agent/llm';
import { seedDatabase } from '../server/src/storage/seed';
import * as repo from '../server/src/storage/repositories';
import { closeDb } from '../server/src/storage/db';

const ExpectedFileSchema = z.object({
  orden: z.array(z.string()).min(1),
  esperado: z.record(
    z.string(),
    z.object({
      decision: DecisionSchema,
      caso: z.string().optional(),
      reglas: z.array(z.string()).optional(),
    }),
  ),
});

function deps(): OrchestratorDeps {
  const config = repo.getRulesConfig();
  const company = repo.getCompany();
  if (!config || !company) throw new Error('La base de datos no esta sembrada.');
  return { llm: createLlmClient(), config, contratos: repo.getContracts(), company };
}

function explicacionOk(record: ReturnType<typeof repo.listDecisions>[number]): boolean {
  const texto = record.explicacion.trim();
  if (texto.length < 40) return false;
  const relevantes = record.reglas.filter((r) => r.resultado !== 'pasa');
  if (relevantes.length === 0) return true;
  return relevantes.some((r) => texto.includes(r.nombre));
}

/** CA-17 / CA-18: descripcion no vacia con los 5 componentes y decision consistente. */
function descripcionCompleta(record: ReturnType<typeof repo.listDecisions>[number]): boolean {
  const d = record.descripcion;
  if (!d) return false;
  const componentes = [d.resumen, d.decisionYReglas, d.siguientePaso].every((t) => t.trim().length > 0);
  const decisionCitada = d.decisionYReglas.includes(DECISION_LABEL[record.decisionFinal]);
  return componentes && d.queHizo.length > 0 && d.texto.trim().length >= 40 && decisionCitada;
}

export async function runEvaluation(): Promise<EvaluationReport> {
  const esperadoArchivo = ExpectedFileSchema.parse(readJson<unknown>(PATHS.expected));

  // Base limpia: el ledger y el orden de procesamiento deben ser reproducibles (RF-7.2).
  await seedDatabase({ reset: true });

  const dependencias = deps();
  const facturas = repo.listInvoices();
  const porId = new Map(facturas.map((f) => [f.id, f]));

  const orden = esperadoArchivo.orden.filter((id) => porId.has(id));
  const fueraDeOrden = facturas.filter((f) => !orden.includes(f.id)).map((f) => f.id);
  for (const id of fueraDeOrden) orden.push(id);

  for (const id of orden) {
    const factura = porId.get(id);
    if (!factura) continue;
    await processInvoice(factura, dependencias);
  }

  const decisiones = new Map(repo.listDecisions().map((d) => [d.invoiceId, d]));

  const casos: EvaluationReport['casos'] = [];
  const pagosIndebidos: string[] = [];
  let correctas = 0;
  let conExplicacion = 0;
  let conDescripcion = 0;

  for (const id of orden) {
    const esperado = esperadoArchivo.esperado[id];
    if (!esperado) continue;

    const record = decisiones.get(id);
    const obtenido: Decision = record?.decisionFinal ?? 'escalar';
    const correcto = record !== undefined && obtenido === esperado.decision;
    if (correcto) correctas += 1;

    // Seguridad: un pago donde no correspondia es la falla mas grave.
    if (obtenido === 'pagar' && esperado.decision !== 'pagar') pagosIndebidos.push(id);

    const okExplicacion = record ? explicacionOk(record) : false;
    if (okExplicacion) conExplicacion += 1;
    const okDescripcion = record ? descripcionCompleta(record) : false;
    if (okDescripcion) conDescripcion += 1;

    casos.push({
      id,
      esperado: esperado.decision,
      obtenido,
      estado: record?.estado ?? 'pendiente_aprobacion',
      correcto,
      explicacionOk: okExplicacion,
      descripcionOk: okDescripcion,
      reglasClave: record ? record.reglas.filter((r) => r.resultado !== 'pasa').map((r) => r.id) : [],
    });
  }

  const total = casos.length;
  const reporte: EvaluationReport = {
    total,
    correctas,
    autonomia: total > 0 ? Math.round((correctas / total) * 1000) / 10 : 0,
    seguridad: pagosIndebidos.length,
    explicabilidad: total > 0 ? Math.round((conExplicacion / total) * 1000) / 10 : 0,
    descripcionOk: total > 0 ? Math.round((conDescripcion / total) * 1000) / 10 : 0,
    pagosIndebidos,
    casos,
    generadoEn: new Date().toISOString(),
    modoLlm: llmModeLabel(),
  };

  writeFileSync(resolve(ROOT, 'eval', 'report.json'), `${JSON.stringify(reporte, null, 2)}\n`, 'utf8');
  return reporte;
}

function imprimir(reporte: EvaluationReport): void {
  const etiqueta: Record<Decision, string> = { pagar: 'PAGAR ', escalar: 'ESCALA', frenar: 'FRENAR' };
  console.log('');
  console.log('Factura   Esperado  Obtenido  OK   Reglas que no pasaron');
  console.log('---------------------------------------------------------------');
  for (const caso of reporte.casos) {
    const marca = caso.correcto ? ' ok ' : 'FALLA';
    console.log(
      `${caso.id.padEnd(9)} ${etiqueta[caso.esperado]}   ${etiqueta[caso.obtenido]}   ${marca}  ${
        caso.reglasClave.join(', ') || '-'
      }`,
    );
  }
  console.log('---------------------------------------------------------------');
  console.log(`Total de facturas:      ${reporte.total}`);
  console.log(`Decisiones correctas:   ${reporte.correctas}`);
  console.log(`Autonomia:              ${reporte.autonomia}%  (meta: >= 80%)`);
  console.log(`Pagos indebidos:        ${reporte.seguridad}  (debe ser 0)`);
  console.log(`Explicabilidad:         ${reporte.explicabilidad}%`);
  console.log(`Descripcion completa:   ${reporte.descripcionOk}%  (CA-17/CA-18)`);
  console.log(`Modo LLM:               ${reporte.modoLlm}`);
  if (reporte.pagosIndebidos.length > 0) {
    console.log(`\nPAGOS INDEBIDOS: ${reporte.pagosIndebidos.join(', ')}`);
  }
  console.log('');
}

const esEjecucionDirecta =
  typeof process.argv[1] === 'string' &&
  /run\.(ts|js)$/.test(process.argv[1].replace(/\\/g, '/'));

if (esEjecucionDirecta) {
  const reporte = await runEvaluation();
  imprimir(reporte);
  closeDb();
  if (reporte.seguridad > 0) process.exitCode = 1;
}
