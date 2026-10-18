import { createClient, type Client, type InValue } from '@libsql/client';
import { TURSO } from '../config';
import { getDb, SCHEMA } from './db';

/**
 * Réplica en la nube (Turso/libSQL).
 *
 * Diseño: la app sigue usando SQLite local (rápido y síncrono); esta capa
 * espeja las tablas a Turso en segundo plano y restaura el archivo local
 * cuando arranca vacío y la nube ya tiene datos. Nunca rompe el servidor:
 * cualquier fallo de red se loguea y se reintenta en el siguiente ciclo.
 *
 * Las tablas se replican completas (borra + inserta) porque el volumen es
 * de demo: esto evita huecos de concurrencia entre lectura y escritura.
 */

export const TABLAS = [
  'settings',
  'invoices',
  'decisions',
  'ledger',
  'audit_events',
  'notifications',
  'chat_messages',
  'chat_proposals',
  'payment_orders',
] as const;

let cliente: Client | null = null;
let iniciado = false;
let sincronizando = false;
let pendienteDeNuevo = false;
let temporizador: NodeJS.Timeout | null = null;
let intervalo: NodeJS.Timeout | null = null;
let reintento: NodeJS.Timeout | null = null;
/** Última huella confirmada en la nube, por tabla. */
const huellaNube = new Map<string, string>();

/** Foto del estado de la réplica (la consume `/api/health`). */
export interface EstadoTurso {
  activo: boolean;
  host: string | null;
  intervaloMs: number;
  ultimaSync: string | null;
  /** Filas confirmadas en la nube, por tabla. */
  tablas: Record<string, number>;
  filas: number;
  ultimoError: { mensaje: string; en: string } | null;
}

const estado: EstadoTurso = {
  activo: false,
  host: null,
  intervaloMs: TURSO.intervaloMs,
  ultimaSync: null,
  tablas: {},
  filas: 0,
  ultimoError: null,
};

export function estadoTurso(): EstadoTurso {
  return { ...estado, tablas: { ...estado.tablas } };
}

/** Conteo de filas del archivo local (diagnóstico de `pnpm turso:check`). */
export function conteoLocal(): Record<string, number> | null {
  try {
    const conteo: Record<string, number> = {};
    for (const tabla of TABLAS) {
      const fila = getDb().prepare(`SELECT COUNT(*) AS total FROM ${tabla}`).get() as
        | { total: number }
        | undefined;
      conteo[tabla] = fila?.total ?? 0;
    }
    return conteo;
  } catch {
    return null;
  }
}

/** Turso solo con credenciales completas, fuera de tests y sin apagado explícito. */
export function tursoActivo(): boolean {
  if (!TURSO.sync) return false;
  if (process.env.VITEST) return false;
  return TURSO.url.length > 0 && TURSO.authToken.length > 0;
}

/** DDL sin PRAGMAs: la nube gestiona su propio almacenamiento. */
function schemaNube(): string {
  return SCHEMA.split('\n')
    .filter((linea) => !linea.trim().toUpperCase().startsWith('PRAGMA'))
    .join('\n');
}

function columnasLocales(tabla: string): string[] {
  const filas = getDb().prepare(`PRAGMA table_info(${tabla})`).all() as Array<{ name: string }>;
  return filas.map((f) => f.name);
}

function valorLibsql(valor: unknown): InValue {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'string' || typeof valor === 'number' || typeof valor === 'bigint') {
    return valor;
  }
  if (Buffer.isBuffer(valor)) return new Uint8Array(valor);
  return String(valor);
}

/** Huella FNV-1a sobre el contenido completo: detecta altas, bajas y ediciones. */
function huellaLocal(tabla: string): string {
  const filas = getDb().prepare(`SELECT * FROM ${tabla} ORDER BY rowid`).all();
  const texto = JSON.stringify(filas);
  let hash = 0xcbf29ce484222325n;
  const mascara = (1n << 64n) - 1n;
  for (let i = 0; i < texto.length; i++) {
    hash = ((hash ^ BigInt(texto.charCodeAt(i))) * 0x100000001b3n) & mascara;
  }
  return `${filas.length}:${hash.toString(16)}`;
}

function avisar(causa: unknown, contexto: string): void {
  const mensaje = causa instanceof Error ? causa.message : String(causa);
  estado.ultimoError = { mensaje: `${contexto}: ${mensaje}`, en: new Date().toISOString() };
  console.warn(`[turso] ${contexto}: ${mensaje}`);
}

/** Corta una promesa que no responde: sin esto, una nube caída retrasa el arranque. */
async function conLimite<T>(promesa: Promise<T>, ms: number): Promise<T> {
  let temporizadorLimite: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promesa,
      new Promise<never>((_, rechazar) => {
        temporizadorLimite = setTimeout(
          () => rechazar(new Error(`sin respuesta del servidor en ${ms} ms`)),
          ms,
        );
        temporizadorLimite.unref?.();
      }),
    ]);
  } finally {
    if (temporizadorLimite) clearTimeout(temporizadorLimite);
  }
}

/** Empuja una tabla completa a la nube (borra + inserta por lotes). */
async function replicarTabla(tabla: string, filas: Record<string, unknown>[], columnas: string[]): Promise<void> {
  if (!cliente) return;
  const lugares = columnas.map(() => '?').join(', ');
  const insertar = `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${ lugares })`;
  const lote = [{ sql: `DELETE FROM ${tabla}`, args: [] as InValue[] }];
  for (const fila of filas) {
    lote.push({ sql: insertar, args: columnas.map((c) => valorLibsql(fila[c])) });
    if (lote.length >= 100) {
      await cliente.batch(lote, 'write');
      lote.length = 0;
    }
  }
  if (lote.length > 0) await cliente.batch(lote, 'write');
}

/** Copia todas las filas de la nube hacia el archivo local (base local vacía). */
async function restaurarDesdeNube(): Promise<boolean> {
  if (!cliente) return false;
  const settings = getDb().prepare('SELECT COUNT(*) AS total FROM settings').get() as { total: number };
  const invoices = getDb().prepare('SELECT COUNT(*) AS total FROM invoices').get() as { total: number };
  if (settings.total > 0 || invoices.total > 0) return false;

  let filasRestauradas = 0;
  const transaccion = getDb().transaction(() => {
    for (const tabla of TABLAS) getDb().prepare(`DELETE FROM ${tabla}`).run();
  });
  transaccion();

  for (const tabla of TABLAS) {
    const resultado = await cliente.execute(`SELECT * FROM ${tabla}`);
    if (resultado.rows.length === 0) continue;
    // `columns` trae los nombres reales; las filas son array-like con nombres.
    const columnas = resultado.columns;
    const lugares = columnas.map(() => '?').join(', ');
    const insertar = getDb().prepare(`INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${lugares})`);
    const cargar = getDb().transaction((filas: Array<Record<string, unknown>>) => {
      for (const fila of filas) insertar.run(...columnas.map((c) => valorLibsql(fila[c])));
    });
    cargar(resultado.rows as unknown as Array<Record<string, unknown>>);
    filasRestauradas += resultado.rows.length;
  }
  console.log(`[turso] base local vacía: restauradas ${filasRestauradas} fila(s) desde la nube.`);
  return true;
}

/** Compara la huella local con la última replicada y sube solo lo que cambió. */
export async function sincronizar(): Promise<void> {
  if (!cliente) return;
  if (sincronizando) {
    pendienteDeNuevo = true;
    return;
  }
  sincronizando = true;
  try {
    for (const tabla of TABLAS) {
      const actual = huellaLocal(tabla);
      if (huellaNube.get(tabla) === actual) continue;
      const columnas = columnasLocales(tabla);
      const filas = getDb().prepare(`SELECT * FROM ${tabla} ORDER BY rowid`).all() as Record<string, unknown>[];
      await replicarTabla(tabla, filas, columnas);
      huellaNube.set(tabla, actual);
      estado.tablas[tabla] = filas.length;
    }
    estado.filas = Object.values(estado.tablas).reduce((total, n) => total + n, 0);
    estado.ultimaSync = new Date().toISOString();
    estado.ultimoError = null;
  } catch (causa) {
    avisar(causa, 'no se pudo replicar a la nube (se reintentará)');
  } finally {
    sincronizando = false;
    if (pendienteDeNuevo) {
      pendienteDeNuevo = false;
      void sincronizar();
    }
  }
}

/** Debounce: concentra ráfagas de escrituras en una sola replicación. */
export function programarSincronizacion(): void {
  if (!iniciado) return;
  if (temporizador) clearTimeout(temporizador);
  temporizador = setTimeout(() => {
    temporizador = null;
    void sincronizar();
  }, 800);
  temporizador.unref?.();
}

/** Reintenta el arranque de la réplica si Turso no respondió (cada 30 s). */
function programarReintento(): void {
  if (reintento) return;
  reintento = setTimeout(() => {
    reintento = null;
    if (iniciado || !tursoActivo()) return;
    void iniciarTurso().then((ok) => {
      if (!ok) programarReintento();
    });
  }, 30_000);
  reintento.unref?.();
}

/**
 * Arranca la réplica: crea el esquema en Turso, restaura el local si viene
 * vacío y deja el espejo periódico corriendo en segundo plano.
 */
export async function iniciarTurso(): Promise<boolean> {
  if (!tursoActivo() || iniciado) return tursoActivo();
  cliente = createClient({ url: TURSO.url, authToken: TURSO.authToken });
  try {
    await conLimite(cliente.executeMultiple(schemaNube()), TURSO.timeoutMs);
  } catch (causa) {
    avisar(causa, 'no se pudo crear el esquema en la nube');
    cliente.close();
    cliente = null;
    // Reintento en segundo plano: una caída momentánea al arrancar no deja
    // la réplica apagada hasta reiniciar el servidor.
    programarReintento();
    return false;
  }

  try {
    await conLimite(restaurarDesdeNube(), TURSO.timeoutMs);
  } catch (causa) {
    avisar(causa, 'no se pudo restaurar el archivo local desde la nube');
  }

  iniciado = true;
  estado.activo = true;
  estado.host = new URL(TURSO.url.replace(/^libsql:/i, 'https:')).hostname;
  intervalo = setInterval(() => void sincronizar(), TURSO.intervaloMs);
  intervalo.unref?.();

  // Flush final si el proceso termina de forma ordenada. Sin `process.exit`
  // el listener inhibiría la terminación por defecto de SIGINT/SIGTERM.
  const terminar = () => {
    if (temporizador) clearTimeout(temporizador);
    const salvaguarda = setTimeout(() => process.exit(0), 4000);
    salvaguarda.unref?.();
    void sincronizar()
      .catch(() => undefined)
      .finally(() => {
        cliente?.close();
        process.exit(0);
      });
  };
  process.once('SIGINT', terminar);
  process.once('SIGTERM', terminar);

  await sincronizar();
  console.log(`  Réplica Turso: activa → ${estado.host} (cada ${TURSO.intervaloMs} ms)`);
  return true;
}

/** Cierra la conexión de nube (usado por scripts y tests). */
export function cerrarTurso(): void {
  if (intervalo) clearInterval(intervalo);
  if (temporizador) clearTimeout(temporizador);
  if (reintento) clearTimeout(reintento);
  reintento = null;
  cliente?.close();
  cliente = null;
  iniciado = false;
  estado.activo = false;
  estado.host = null;
}
