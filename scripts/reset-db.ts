/** Reinicia la base local: borra decisiones, ledger y vuelve a sembrar (util antes del pitch). */
import { closeDb } from '../server/src/storage/db';
import { seedDatabase } from '../server/src/storage/seed';

const resultado = await seedDatabase({ reset: true });
console.log(
  `Base reiniciada: ${resultado.facturas} facturas cargadas, sin decisiones registradas` +
    (resultado.pdfsGenerados > 0 ? ` (${resultado.pdfsGenerados} PDF generados)` : '') +
    '.',
);
closeDb();
