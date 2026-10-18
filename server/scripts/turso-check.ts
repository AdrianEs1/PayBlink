/**
 * Comprueba la conexión a Turso y el estado de la réplica.
 *
 *   pnpm turso:check
 *
 * No toca la nube salvo para crear el esquema si falta (mismo DDL que el
 * servidor). Nunca imprime el token.
 */
import { createClient } from '@libsql/client';
import { TURSO } from '../src/config';
import { SCHEMA } from '../src/storage/db';
import { TABLAS, conteoLocal } from '../src/storage/turso';

function schemaNube(): string {
  return SCHEMA.split('\n')
    .filter((linea) => !linea.trim().toUpperCase().startsWith('PRAGMA'))
    .join('\n');
}

function hostDe(url: string): string {
  try {
    return new URL(url.replace(/^libsql:/i, 'https:')).hostname;
  } catch {
    return '(url invalida)';
  }
}

async function main(): Promise<number> {
  if (!TURSO.url || !TURSO.authToken) {
    console.error('Faltan TURSO_DATABASE_URL y/o TURSO_AUTH_TOKEN en .env');
    return 1;
  }

  console.log(`Turso: ${hostDe(TURSO.url)}`);
  const cliente = createClient({ url: TURSO.url, authToken: TURSO.authToken });

  try {
    const inicio = performance.now();
    await cliente.execute('SELECT 1 AS ok');
    console.log(`  Conexion: OK (${Math.round(performance.now() - inicio)} ms)`);

    await cliente.executeMultiple(schemaNube());

    const tablas = await cliente.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const nombres = tablas.rows.map((fila) => String(fila.name));
    const faltantes = TABLAS.filter((tabla) => !nombres.includes(tabla));
    console.log(`  Esquema: ${nombres.length} tabla(s) en la nube`);
    if (faltantes.length > 0) {
      console.log(`  Aviso: faltan tablas -> ${faltantes.join(', ')}`);
      return 1;
    }

    let totalNube = 0;
    const filasNube = new Map<string, number>();
    for (const tabla of TABLAS) {
      const resultado = await cliente.execute(`SELECT COUNT(*) AS total FROM ${tabla}`);
      const total = Number(resultado.rows[0]?.total ?? 0);
      filasNube.set(tabla, total);
      totalNube += total;
    }

    const local = conteoLocal();
    console.log(`  Filas            nube   local`);
    for (const tabla of TABLAS) {
      const totalNubeTabla = String(filasNube.get(tabla) ?? 0);
      const totalLocal = local ? String(local[tabla] ?? 0) : '-';
      console.log(`  ${tabla.padEnd(16)} ${totalNubeTabla.padStart(5)} ${totalLocal.padStart(7)}`);
    }

    console.log(`  Total en la nube: ${totalNube} fila(s)`);
    console.log(
      totalNube > 0
        ? '  Estado: la replica tiene datos (si el local difiere, se iguala en el siguiente ciclo).'
        : '  Estado: la nube esta vacia; el servidor la llenara al arrancar.',
    );
    return 0;
  } catch (causa) {
    const mensaje = causa instanceof Error ? causa.message : String(causa);
    console.error(`  Error: ${mensaje}`);
    return 1;
  } finally {
    cliente.close();
  }
}

process.exitCode = await main();
