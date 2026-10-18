/**
 * Corre el agente desde la terminal sobre las facturas pendientes.
 *   npm run agent            -> procesa las pendientes
 *   npm run agent -- --reset -> reinicia la base y procesa todo el set
 */
import { ESTADO_LABEL } from '@blinka/shared';
import { llmModeLabel } from '../server/src/config';
import { processPending, type OrchestratorDeps } from '../server/src/agent/orchestrator';
import { createLlmClient } from '../server/src/agent/llm';
import { seedDatabase } from '../server/src/storage/seed';
import * as repo from '../server/src/storage/repositories';
import { closeDb } from '../server/src/storage/db';

if (process.argv.includes('--reset')) {
  await seedDatabase({ reset: true });
}

const config = repo.getRulesConfig();
const company = repo.getCompany();
if (!config || !company) throw new Error('La base de datos no esta sembrada. Ejecuta `npm run seed`.');

const dependencias: OrchestratorDeps = {
  llm: createLlmClient(),
  config,
  contratos: repo.getContracts(),
  company,
};

console.log(`Modo LLM: ${llmModeLabel()}`);
const resultados = await processPending(dependencias);

for (const { record } of resultados) {
  console.log(
    `${record.invoiceId}  ${record.decisionFinal.padEnd(7)}  ${ESTADO_LABEL[record.estado].padEnd(24)}  ${record.explicacion}`,
  );
}

console.log(`\nProcesadas: ${resultados.length}`);
console.log(
  `Pagos registrados: ${resultados.filter((r) => r.record.decisionFinal === 'pagar').length}` +
    ` · escaladas: ${resultados.filter((r) => r.record.decisionFinal === 'escalar').length}` +
    ` · frenadas: ${resultados.filter((r) => r.record.decisionFinal === 'frenar').length}`,
);
closeDb();
