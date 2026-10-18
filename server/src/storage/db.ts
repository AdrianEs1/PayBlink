import Database from 'better-sqlite3';
import { existsSync, rmSync } from 'node:fs';
import { PATHS } from '../config';

export type Db = Database.Database;

/** DDL completo de la base. Se reutiliza para crear el esquema en Turso. */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id           TEXT PRIMARY KEY,
  archivo      TEXT NOT NULL,
  formato      TEXT NOT NULL,
  asunto       TEXT,
  remitente    TEXT,
  texto        TEXT NOT NULL,
  orden        INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  source_json  TEXT,
  queue_state  TEXT NOT NULL DEFAULT 'pendiente',
  intentos     INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  hash         TEXT,
  recibido_en  TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id                 TEXT PRIMARY KEY,
  invoice_id         TEXT NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE CASCADE,
  orden              INTEGER NOT NULL,
  propuesta          TEXT NOT NULL,
  veredicto_motor    TEXT NOT NULL,
  decision_final     TEXT NOT NULL,
  estado             TEXT NOT NULL,
  guard_actuo        INTEGER NOT NULL,
  extraccion_json    TEXT,
  verificacion_json  TEXT,
  reglas_json        TEXT NOT NULL,
  tool_calls_json    TEXT NOT NULL,
  propuesta_json     TEXT NOT NULL,
  explicacion        TEXT NOT NULL,
  descripcion_json   TEXT,
  origen_explicacion TEXT NOT NULL,
  humano_json        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id          TEXT PRIMARY KEY,
  invoice_id  TEXT NOT NULL UNIQUE,
  decision_id TEXT NOT NULL,
  beneficiario TEXT NOT NULL,
  monto       REAL NOT NULL,
  moneda      TEXT NOT NULL,
  monto_base  REAL NOT NULL,
  referencia  TEXT NOT NULL,
  fecha       TEXT NOT NULL,
  origen      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  tipo         TEXT NOT NULL,
  invoice_id   TEXT,
  detalle_json TEXT NOT NULL,
  hash_prev    TEXT,
  hash         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  invoice_id      TEXT NOT NULL,
  approver_id     TEXT NOT NULL,
  approver_nombre TEXT NOT NULL,
  canal           TEXT NOT NULL,
  destinatario    TEXT NOT NULL,
  asunto          TEXT NOT NULL,
  cuerpo          TEXT NOT NULL,
  contenido_json  TEXT NOT NULL,
  estado          TEXT NOT NULL,
  respuesta_json  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  rol        TEXT NOT NULL,
  contenido  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_proposals (
  id             TEXT PRIMARY KEY,
  message_id     TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  tipo           TEXT NOT NULL,
  factura_id     TEXT,
  titulo         TEXT NOT NULL,
  descripcion    TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  estado         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  confirmada_por TEXT,
  confirmada_en  TEXT
);

CREATE TABLE IF NOT EXISTS payment_orders (
  id               TEXT PRIMARY KEY,
  invoice_id       TEXT NOT NULL UNIQUE,
  beneficiario     TEXT NOT NULL,
  pais             TEXT NOT NULL,
  banco_ficticio   TEXT NOT NULL,
  cuenta_ficticia  TEXT NOT NULL,
  moneda_preferida TEXT NOT NULL,
  monto            REAL NOT NULL,
  moneda           TEXT NOT NULL,
  monto_convertido REAL NOT NULL,
  moneda_base      TEXT NOT NULL,
  fecha_sugerida   TEXT NOT NULL,
  referencia       TEXT NOT NULL,
  concepto         TEXT NOT NULL,
  estado           TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_fecha ON ledger(fecha);
CREATE INDEX IF NOT EXISTS idx_decisions_orden ON decisions(orden);
CREATE INDEX IF NOT EXISTS idx_invoices_orden ON invoices(orden);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_hash ON invoices(hash) WHERE hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_audit_invoice ON audit_events(invoice_id);
CREATE INDEX IF NOT EXISTS idx_notifications_invoice ON notifications(invoice_id);
CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat_messages(thread_id, created_at);
`;

let db: Db | null = null;

function columnas(database: Db, tabla: string): Set<string> {
  const filas = database.prepare(`PRAGMA table_info(${tabla})`).all() as Array<{ name: string }>;
  return new Set(filas.map((f) => f.name));
}

function agregarColumna(database: Db, tabla: string, columna: string, ddl: string): boolean {
  if (columnas(database, tabla).has(columna)) return false;
  database.exec(`ALTER TABLE ${tabla} ADD COLUMN ${ddl}`);
  return true;
}

/**
 * Migraciones incrementales sobre bases existentes.
 * `CREATE TABLE IF NOT EXISTS` no agrega columnas nuevas, asi que la demo
 * puede actualizarse sin perder las decisiones ya registradas.
 */
function migrar(database: Db): void {
  const nuevaCola = agregarColumna(database, 'invoices', 'queue_state', "queue_state TEXT NOT NULL DEFAULT 'pendiente'");
  agregarColumna(database, 'invoices', 'source_json', 'source_json TEXT');
  agregarColumna(database, 'invoices', 'intentos', 'intentos INTEGER NOT NULL DEFAULT 0');
  agregarColumna(database, 'invoices', 'ultimo_error', 'ultimo_error TEXT');
  agregarColumna(database, 'invoices', 'hash', 'hash TEXT');
  agregarColumna(database, 'invoices', 'recibido_en', 'recibido_en TEXT');
  agregarColumna(database, 'decisions', 'descripcion_json', 'descripcion_json TEXT');

  database.exec(
    "UPDATE invoices SET recibido_en = created_at WHERE recibido_en IS NULL OR recibido_en = ''",
  );

  // Si la base viene de la version anterior, reconstruye el estado de cola.
  if (nuevaCola) {
    database.exec(`
      UPDATE invoices SET queue_state = (
        SELECT CASE d.estado
          WHEN 'pagado' THEN 'pagada'
          WHEN 'aprobado_humano' THEN 'pagada'
          WHEN 'frenado' THEN 'frenada'
          WHEN 'rechazado_humano' THEN 'frenada'
          WHEN 'pendiente_aprobacion' THEN 'escalada'
          ELSE 'pendiente'
        END
        FROM decisions d WHERE d.invoice_id = invoices.id
      ) WHERE EXISTS (SELECT 1 FROM decisions d WHERE d.invoice_id = invoices.id)
    `);
  }
}

/** Abre (y crea si hace falta) la base de datos local. */
export function getDb(): Db {
  if (db) return db;
  db = new Database(PATHS.db);
  db.exec(SCHEMA);
  migrar(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Borra el archivo de base de datos (usado por `npm run reset` y por el seed). */
export function dropDbFile(): void {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${PATHS.db}${suffix}`;
    if (!existsSync(file)) continue;
    try {
      rmSync(file, { force: true });
    } catch {
      // En Windows el archivo queda tomado mientras el servidor este en ejecucion.
      throw new Error(
        `No se pudo borrar la base de datos (${file}): la tiene abierta otro proceso. ` +
          'Cierra `pnpm dev` (o el servidor) y vuelve a intentarlo.',
      );
    }
  }
}
