import { ContractSchema, CompanySchema, RulesConfigSchema } from '@payblink/shared';
import { z } from 'zod';
import { PATHS, readJson } from '../config';
import { dropDbFile, getDb } from './db';
import { countInvoices, insertIncomingInvoice, saveCompany, saveContracts, saveRulesConfig } from './repositories';
import { ensurePdfFiles } from './load-invoices';
import { FolderSource } from '../ingestion/sources';

export interface SeedResult {
  facturas: number;
  pdfsGenerados: number;
}

async function cargarDatos(): Promise<void> {
  const company = CompanySchema.parse(readJson<unknown>(PATHS.company));
  const rules = RulesConfigSchema.parse(readJson<unknown>(PATHS.rules));
  const contracts = z.array(ContractSchema).parse(readJson<unknown>(PATHS.contracts));

  saveCompany(company);
  saveRulesConfig(rules);
  saveContracts(contracts);
}

/**
 * Carga los datos simulados (empresa, reglas, contratos y facturas).
 * `reset: true` borra la base de datos para que la demo parta siempre igual.
 */
export async function seedDatabase({ reset = false }: { reset?: boolean } = {}): Promise<SeedResult> {
  if (reset) dropDbFile();
  getDb();

  const { generados } = ensurePdfFiles();
  await cargarDatos();

  // RF-1.2 / RF-1.4: el seed usa la misma interface de ingesta que la demo.
  const normalizadas = await new FolderSource().pull();
  for (const item of normalizadas) {
    insertIncomingInvoice(item.invoice, item.source, item.hash, 'pendiente');
  }

  return { facturas: normalizadas.length, pdfsGenerados: generados.length };
}

/** Siembra solo si la base esta vacia (usado al arrancar el servidor). */
export async function ensureSeeded(): Promise<SeedResult | null> {
  getDb();
  if (countInvoices() > 0) return null;
  return seedDatabase({ reset: false });
}

const esEjecucionDirecta =
  typeof process.argv[1] === 'string' &&
  /seed\.(ts|js)$/.test(process.argv[1].replace(/\\/g, '/'));

if (esEjecucionDirecta) {
  const resultado = await seedDatabase({ reset: true });
  console.log(
    `Seed listo: ${resultado.facturas} facturas cargadas` +
      (resultado.pdfsGenerados > 0 ? ` y ${resultado.pdfsGenerados} PDF generados` : '') +
      `.`,
  );
}
