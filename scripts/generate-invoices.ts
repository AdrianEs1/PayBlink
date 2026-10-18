/**
 * Genera los PDF simulados de `data/invoices/pdf/` a partir de sus fuentes `.txt`.
 * `seed` ya lo hace automaticamente; este script sirve para regenerarlos a mano.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../server/src/config';
import { ensurePdfFiles } from '../server/src/storage/load-invoices';

const forzar = process.argv.includes('--force');

if (forzar) {
  for (const id of ['INV-004', 'INV-009', 'INV-012', 'INV-017']) {
    rmSync(join(PATHS.pdfSources, `${id}.pdf`), { force: true });
  }
}

const { generados } = ensurePdfFiles();
console.log(
  generados.length > 0
    ? `PDF generados: ${generados.map((g) => g.split(/[\\/]/).pop()).join(', ')}`
    : 'No habia PDFs por generar (usa --force para regenerarlos).',
);
