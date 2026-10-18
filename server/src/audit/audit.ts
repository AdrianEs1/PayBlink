import { createHash, randomUUID } from 'node:crypto';
import {
  AuditEventSchema,
  type AuditActor,
  type AuditEvent,
  type AuditEventType,
  type AuditFilters,
} from '@payblink/shared';
import { getDb } from '../storage/db';

/**
 * RF-13: log de auditoria global, append-only.
 *
 * No hay funciones de actualizacion ni borrado: la unica escritura es `log()`.
 * Cada evento encadena el hash del anterior (RF-13.5), de modo que alterar un
 * evento viejo rompe la cadena y `verifyChain()` lo evidencia.
 */

const CLAVES_SENSIBLES = /(api[_-]?key|token|secret|password|authorization|bearer)/i;

/** RF-13.8: nunca se registran secretos. */
function limpiarDetalle(valor: unknown, profundidad = 0): unknown {
  if (profundidad > 6) return '[profundidad maxima]';
  if (Array.isArray(valor)) return valor.map((v) => limpiarDetalle(v, profundidad + 1));
  if (valor && typeof valor === 'object') {
    const salida: Record<string, unknown> = {};
    for (const [clave, contenido] of Object.entries(valor as Record<string, unknown>)) {
      if (CLAVES_SENSIBLES.test(clave)) {
        salida[clave] = '[redactado]';
        continue;
      }
      salida[clave] = limpiarDetalle(contenido, profundidad + 1);
    }
    return salida;
  }
  if (typeof valor === 'string' && valor.length > 4000) return `${valor.slice(0, 4000)}...`;
  return valor;
}

export interface AuditInput {
  actor: AuditActor;
  tipo: AuditEventType;
  invoiceId?: string | null;
  detalle?: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  ts: string;
  actor: string;
  tipo: string;
  invoice_id: string | null;
  detalle_json: string;
  hash_prev: string | null;
  hash: string;
}

function hashear(evento: {
  id: string;
  ts: string;
  actor: string;
  tipo: string;
  invoiceId: string | null;
  detalleJson: string;
  hashPrev: string | null;
}): string {
  return createHash('sha256')
    .update(
      `${evento.hashPrev ?? ''}|${evento.id}|${evento.ts}|${evento.actor}|${evento.tipo}|${
        evento.invoiceId ?? ''
      }|${evento.detalleJson}`,
    )
    .digest('hex');
}

function rowToEvent(row: AuditRow): AuditEvent {
  return AuditEventSchema.parse({
    id: row.id,
    ts: row.ts,
    actor: row.actor,
    tipo: row.tipo,
    invoiceId: row.invoice_id,
    detalle: JSON.parse(row.detalle_json) as Record<string, unknown>,
    hashPrev: row.hash_prev,
    hash: row.hash,
  });
}

export function log(input: AuditInput): AuditEvent {
  const db = getDb();
  const anterior = db
    .prepare('SELECT hash FROM audit_events ORDER BY rowid DESC LIMIT 1')
    .get() as { hash: string } | undefined;

  const id = randomUUID();
  const ts = new Date().toISOString();
  const invoiceId = input.invoiceId ?? null;
  const detalleJson = JSON.stringify(limpiarDetalle(input.detalle ?? {}));
  const hashPrev = anterior?.hash ?? null;
  const hash = hashear({ id, ts, actor: input.actor, tipo: input.tipo, invoiceId, detalleJson, hashPrev });

  db.prepare(
    `INSERT INTO audit_events (id, ts, actor, tipo, invoice_id, detalle_json, hash_prev, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ts, input.actor, input.tipo, invoiceId, detalleJson, hashPrev, hash);

  return {
    id,
    ts,
    actor: input.actor,
    tipo: input.tipo,
    invoiceId,
    detalle: JSON.parse(detalleJson) as Record<string, unknown>,
    hashPrev,
    hash,
  };
}

export function listEvents(filters: AuditFilters = {}): AuditEvent[] {
  const condiciones: string[] = [];
  const parametros: unknown[] = [];

  if (filters.invoiceId) {
    condiciones.push('invoice_id = ?');
    parametros.push(filters.invoiceId);
  }
  if (filters.actor) {
    condiciones.push('actor = ?');
    parametros.push(filters.actor);
  }
  if (filters.tipo) {
    condiciones.push('tipo = ?');
    parametros.push(filters.tipo);
  }
  if (filters.desde) {
    condiciones.push('ts >= ?');
    parametros.push(filters.desde);
  }
  if (filters.hasta) {
    condiciones.push('ts <= ?');
    parametros.push(filters.hasta);
  }

  const where = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';
  const limite = filters.limite ? `LIMIT ${Math.trunc(filters.limite)}` : '';
  const filas = getDb()
    .prepare(`SELECT * FROM audit_events ${where} ORDER BY rowid ASC ${limite}`)
    .all(...parametros) as AuditRow[];
  return filas.map(rowToEvent);
}

export function eventCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS total FROM audit_events').get() as { total: number };
  return row.total;
}

/** RF-13.5: detecta manipulaciones comprobando la cadena completa. */
export function verifyChain(): { ok: boolean; rotoEn: string | null } {
  const filas = getDb().prepare('SELECT * FROM audit_events ORDER BY rowid ASC').all() as AuditRow[];
  let previo: string | null = null;
  for (const fila of filas) {
    const esperado = hashear({
      id: fila.id,
      ts: fila.ts,
      actor: fila.actor,
      tipo: fila.tipo,
      invoiceId: fila.invoice_id,
      detalleJson: fila.detalle_json,
      hashPrev: previo,
    });
    if (fila.hash_prev !== previo || fila.hash !== esperado) {
      return { ok: false, rotoEn: fila.id };
    }
    previo = fila.hash;
  }
  return { ok: true, rotoEn: null };
}

function csv(valor: unknown): string {
  const texto = String(valor ?? '');
  return `"${texto.replace(/"/g, '""')}"`;
}

/** RF-13.6: exportacion legible para conciliacion. */
export function exportEventsCsv(filters: AuditFilters = {}): string {
  const eventos = listEvents(filters);
  const lineas = ['id,fecha,actor,tipo,factura,detalle'];
  for (const evento of eventos) {
    lineas.push(
      [
        csv(evento.id),
        csv(evento.ts),
        csv(evento.actor),
        csv(evento.tipo),
        csv(evento.invoiceId ?? ''),
        csv(JSON.stringify(evento.detalle)),
      ].join(','),
    );
  }
  return `${lineas.join('\n')}\n`;
}

export function exportEventsJson(filters: AuditFilters = {}): string {
  return `${JSON.stringify({ eventos: listEvents(filters) }, null, 2)}\n`;
}
