import { randomUUID } from 'node:crypto';
import {
  CompanySchema,
  ContractSchema,
  DecisionRecordSchema,
  InvoiceExtractionSchema,
  LedgerEntrySchema,
  NotificationSchema,
  PaymentOrderSchema,
  RulesConfigSchema,
  ChatMessageSchema,
  ChatProposalSchema,
  SourceInfoSchema,
  type AgentDescription,
  type ChatMessage,
  type ChatProposal,
  type ChatProposalStatus,
  type ChatProposalType,
  type Contract,
  type Company,
  type DecisionRecord,
  type HumanDecision,
  type IngestMode,
  type LedgerEntry,
  type Notification,
  type NotificationChannel,
  type NotificationResponse,
  type PaymentOrder,
  type QueueState,
  type RulesConfig,
  type SourceInfo,
} from '@payblink/shared';
import { z } from 'zod';
import type { InvoiceInput, PriorDecision } from '../core/types';
import { getDb } from './db';

export function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Ajustes (JSON en la tabla settings)                                 */
/* ------------------------------------------------------------------ */

export function getSetting<T>(key: string, schema: z.ZodType<T>): T | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  const parsed = schema.safeParse(parseJson<unknown>(row.value, null));
  return parsed.success ? parsed.data : null;
}

export function setSetting<T>(key: string, value: T): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), nowIso());
}

export const getRulesConfig = (): RulesConfig | null => getSetting('rules', RulesConfigSchema);
export const saveRulesConfig = (config: RulesConfig): void => setSetting('rules', config);
export const getCompany = (): Company | null => getSetting('company', CompanySchema);
export const saveCompany = (company: Company): void => setSetting('company', company);
export const getContracts = (): Contract[] =>
  getSetting('contracts', z.array(ContractSchema)) ?? [];
export const saveContracts = (contracts: Contract[]): void => setSetting('contracts', contracts);

export const getIngestMode = (): IngestMode =>
  getSetting('ingestMode', z.enum(['manual', 'automatico'])) ?? 'manual';
export const setIngestMode = (mode: IngestMode): void => setSetting('ingestMode', mode);

/* ------------------------------------------------------------------ */
/* Facturas                                                            */
/* ------------------------------------------------------------------ */

interface InvoiceRow {
  id: string;
  archivo: string;
  formato: string;
  asunto: string | null;
  remitente: string | null;
  texto: string;
  orden: number;
  source_json: string | null;
  queue_state: string;
  intentos: number;
  ultimo_error: string | null;
  hash: string | null;
  recibido_en: string | null;
}

export interface StoredInvoice extends InvoiceInput {
  orden: number;
  fuente: SourceInfo | null;
  queueState: QueueState;
  intentos: number;
  ultimoError: string | null;
  hash: string | null;
  recibidoEn: string;
}

function rowToInvoice(row: InvoiceRow): InvoiceInput {
  return {
    id: row.id,
    archivo: row.archivo,
    formato: row.formato as InvoiceInput['formato'],
    asunto: row.asunto,
    remitente: row.remitente,
    texto: row.texto,
  };
}

function rowToStored(row: InvoiceRow): StoredInvoice {
  return {
    ...rowToInvoice(row),
    orden: row.orden,
    fuente: parseJson<unknown>(row.source_json, null) as SourceInfo | null,
    queueState: (row.queue_state as QueueState) ?? 'pendiente',
    intentos: row.intentos ?? 0,
    ultimoError: row.ultimo_error,
    hash: row.hash,
    recibidoEn: row.recibido_en ?? '',
  };
}

const INVOICE_COLUMNS = `id, archivo, formato, asunto, remitente, texto, orden,
  source_json, queue_state, intentos, ultimo_error, hash, recibido_en`;

export function insertInvoices(invoices: readonly InvoiceInput[]): void {
  const stmt = getDb().prepare(
    `INSERT INTO invoices (id, archivo, formato, asunto, remitente, texto, orden, created_at, recibido_en)
     VALUES (@id, @archivo, @formato, @asunto, @remitente, @texto, @orden, @created_at, @recibido_en)
     ON CONFLICT(id) DO UPDATE SET
       archivo = excluded.archivo, formato = excluded.formato, asunto = excluded.asunto,
       remitente = excluded.remitente, texto = excluded.texto, orden = excluded.orden`,
  );
  const created = nowIso();
  const insertMany = getDb().transaction((list: readonly InvoiceInput[]) => {
    list.forEach((invoice, index) => {
      stmt.run({
        id: invoice.id,
        archivo: invoice.archivo,
        formato: invoice.formato,
        asunto: invoice.asunto,
        remitente: invoice.remitente,
        texto: invoice.texto,
        orden: index + 1,
        created_at: created,
        recibido_en: created,
      });
    });
  });
  insertMany(invoices);
}

/**
 * Inserta una factura normalizada por la ingesta. Idempotente por id y por hash
 * (RF-1.4): el mismo mensaje o archivo no se procesa dos veces.
 */
export function insertIncomingInvoice(
  invoice: InvoiceInput,
  source: SourceInfo,
  hash: string,
  queueState: QueueState,
): { inserted: boolean; duplicada: boolean; invoiceId: string } {
  const existente = getDb()
    .prepare('SELECT id, hash FROM invoices WHERE id = ? OR hash = ?')
    .get(invoice.id, hash) as { id: string; hash: string | null } | undefined;
  if (existente) {
    return { inserted: false, duplicada: true, invoiceId: existente.id };
  }

  const orden = (getDb().prepare('SELECT COALESCE(MAX(orden), 0) + 1 AS orden FROM invoices').get() as {
    orden: number;
  }).orden;
  const created = nowIso();

  getDb()
    .prepare(
      `INSERT INTO invoices (id, archivo, formato, asunto, remitente, texto, orden, created_at,
                             source_json, queue_state, intentos, hash, recibido_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      invoice.id,
      invoice.archivo,
      invoice.formato,
      invoice.asunto,
      invoice.remitente,
      invoice.texto,
      orden,
      created,
      JSON.stringify(source),
      queueState,
      hash,
      source.recibidoEn || created,
    );

  return { inserted: true, duplicada: false, invoiceId: invoice.id };
}

export function listInvoices(): InvoiceInput[] {
  const rows = getDb().prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices ORDER BY orden ASC`).all() as InvoiceRow[];
  return rows.map(rowToInvoice);
}

export function listStoredInvoices(): StoredInvoice[] {
  const rows = getDb().prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices ORDER BY orden ASC`).all() as InvoiceRow[];
  return rows.map(rowToStored);
}

export function getInvoice(id: string): InvoiceInput | null {
  const row = getDb()
    .prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = ?`)
    .get(id) as InvoiceRow | undefined;
  return row ? rowToInvoice(row) : null;
}

export function getStoredInvoice(id: string): StoredInvoice | null {
  const row = getDb()
    .prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = ?`)
    .get(id) as InvoiceRow | undefined;
  return row ? rowToStored(row) : null;
}

export function setQueueState(
  invoiceId: string,
  state: QueueState,
  extra: { error?: string | null; incrementarIntento?: boolean } = {},
): void {
  const incremento = extra.incrementarIntento ? 1 : 0;
  getDb()
    .prepare(
      `UPDATE invoices
       SET queue_state = ?, ultimo_error = ?, intentos = intentos + ?
       WHERE id = ?`,
    )
    .run(state, extra.error ?? null, incremento, invoiceId);
}

/** Toma la siguiente factura ENCOLADA de forma atomica (un solo worker). */
export function claimNextInvoice(): StoredInvoice | null {
  const row = getDb()
    .prepare(
      `SELECT ${INVOICE_COLUMNS} FROM invoices
       WHERE queue_state = 'en_cola'
       ORDER BY orden ASC LIMIT 1`,
    )
    .get() as InvoiceRow | undefined;
  if (!row) return null;

  const cambio = getDb()
    .prepare(
      `UPDATE invoices SET queue_state = 'procesando'
       WHERE id = ? AND queue_state = 'en_cola'`,
    )
    .run(row.id);

  if (cambio.changes === 0) return null;
  return rowToStored({ ...row, queue_state: 'procesando' });
}

/** Facturas sin decision que aun no terminaron su ciclo. */
export function listProcessableInvoices(): StoredInvoice[] {
  const rows = getDb()
    .prepare(
      `SELECT i.*
       FROM invoices i
       LEFT JOIN decisions d ON d.invoice_id = i.id
       WHERE d.id IS NULL AND i.queue_state IN ('pendiente', 'en_cola', 'error')
       ORDER BY i.orden ASC`,
    )
    .all() as InvoiceRow[];
  return rows.map(rowToStored);
}

/** Recupera trabajos que quedaron a medias si el proceso se reinicio. */
export function recoverStaleQueue(): number {
  const cambio = getDb()
    .prepare(
      `UPDATE invoices SET queue_state = 'en_cola'
       WHERE queue_state = 'procesando'`,
    )
    .run();
  return cambio.changes;
}

/* ------------------------------------------------------------------ */
/* Decisiones                                                          */
/* ------------------------------------------------------------------ */

interface DecisionRow {
  id: string;
  invoice_id: string;
  orden: number;
  propuesta: string;
  veredicto_motor: string;
  decision_final: string;
  estado: string;
  guard_actuo: number;
  extraccion_json: string | null;
  verificacion_json: string | null;
  reglas_json: string;
  tool_calls_json: string;
  propuesta_json: string;
  explicacion: string;
  descripcion_json: string | null;
  origen_explicacion: string;
  humano_json: string | null;
  created_at: string;
  updated_at: string;
  archivo: string;
  formato: string;
  asunto: string | null;
  texto: string;
  queue_state: string;
}

const DECISION_SELECT = `
  SELECT d.*, i.archivo, i.formato, i.asunto, i.texto, i.queue_state
  FROM decisions d
  JOIN invoices i ON i.id = d.invoice_id
`;

/** Respaldo para decisiones guardadas antes de existir RF-6. */
function descripcionFallback(explicacion: string): AgentDescription {
  return {
    resumen: explicacion,
    queHizo: ['Se evaluaron las reglas con el rastro registrado para esta factura.'],
    decisionYReglas: explicacion,
    cambioGuard: null,
    siguientePaso: 'Revisar el detalle de la factura.',
    texto: explicacion,
  };
}

function rowToDecision(row: DecisionRow): DecisionRecord {
  const estado = row.estado as DecisionRecord['estado'];
  const queueFallback: QueueState =
    estado === 'pagado' || estado === 'aprobado_humano'
      ? 'pagada'
      : estado === 'frenado' || estado === 'rechazado_humano'
        ? 'frenada'
        : 'escalada';

  // El estado de cola manda cuando es terminal; si la fila quedo a medias (por ejemplo,
  // una evaluacion que procesa sin pasar por la cola), se deriva de la decision.
  const crudo = (row.queue_state as QueueState) ?? queueFallback;
  const queueState: QueueState =
    crudo === 'pendiente' || crudo === 'en_cola' || crudo === 'procesando' ? queueFallback : crudo;

  const candidate = {
    id: row.id,
    invoiceId: row.invoice_id,
    archivo: row.archivo,
    formato: row.formato,
    asunto: row.asunto,
    texto: row.texto,
    extraccion: parseJson<unknown>(row.extraccion_json, null),
    extraccionOk: parseJson<unknown>(row.extraccion_json, null) !== null,
    verificacion: parseJson<unknown>(row.verificacion_json, null),
    reglas: parseJson<unknown>(row.reglas_json, []),
    toolCalls: parseJson<unknown>(row.tool_calls_json, []),
    propuestaLlm: parseJson<unknown>(row.propuesta_json, { decision: 'pagar', razones: [], origen: 'pipeline' }),
    decisionFinal: row.decision_final,
    estado,
    queueState,
    guardActuo: row.guard_actuo === 1,
    descripcion: parseJson<unknown>(row.descripcion_json, null) ?? descripcionFallback(row.explicacion),
    explicacion: row.explicacion,
    origenExplicacion: row.origen_explicacion,
    humano: parseJson<unknown>(row.humano_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return DecisionRecordSchema.parse(candidate);
}

export function nextDecisionOrder(): number {
  const row = getDb().prepare('SELECT COALESCE(MAX(orden), 0) + 1 AS orden FROM decisions').get() as {
    orden: number;
  };
  return row.orden;
}

export function insertDecision(record: DecisionRecord, orden: number): void {
  getDb()
    .prepare(
      `INSERT INTO decisions (
         id, invoice_id, orden, propuesta, veredicto_motor, decision_final, estado, guard_actuo,
         extraccion_json, verificacion_json, reglas_json, tool_calls_json, propuesta_json,
         explicacion, descripcion_json, origen_explicacion, humano_json, created_at, updated_at
       ) VALUES (
         @id, @invoice_id, @orden, @propuesta, @veredicto_motor, @decision_final, @estado, @guard_actuo,
         @extraccion_json, @verificacion_json, @reglas_json, @tool_calls_json, @propuesta_json,
         @explicacion, @descripcion_json, @origen_explicacion, @humano_json, @created_at, @updated_at
       )
       ON CONFLICT(invoice_id) DO UPDATE SET
         propuesta = excluded.propuesta, veredicto_motor = excluded.veredicto_motor,
         decision_final = excluded.decision_final, estado = excluded.estado,
         guard_actuo = excluded.guard_actuo, extraccion_json = excluded.extraccion_json,
         verificacion_json = excluded.verificacion_json, reglas_json = excluded.reglas_json,
         tool_calls_json = excluded.tool_calls_json, propuesta_json = excluded.propuesta_json,
         explicacion = excluded.explicacion, descripcion_json = excluded.descripcion_json,
         origen_explicacion = excluded.origen_explicacion,
         humano_json = excluded.humano_json, updated_at = excluded.updated_at`,
    )
    .run({
      id: record.id,
      invoice_id: record.invoiceId,
      orden,
      propuesta: record.propuestaLlm.decision,
      veredicto_motor: deriveVeredicto(record),
      decision_final: record.decisionFinal,
      estado: record.estado,
      guard_actuo: record.guardActuo ? 1 : 0,
      extraccion_json: record.extraccion ? JSON.stringify(record.extraccion) : null,
      verificacion_json: record.verificacion ? JSON.stringify(record.verificacion) : null,
      reglas_json: JSON.stringify(record.reglas),
      tool_calls_json: JSON.stringify(record.toolCalls),
      propuesta_json: JSON.stringify(record.propuestaLlm),
      explicacion: record.explicacion,
      descripcion_json: JSON.stringify(record.descripcion),
      origen_explicacion: record.origenExplicacion,
      humano_json: record.humano ? JSON.stringify(record.humano) : null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    });

  // Mantiene la cola sincronizada con la decision (RF-1.9), incluso cuando el
  // procesamiento no paso por el worker (evaluacion o llamada directa).
  const estadoCola: QueueState =
    record.queueState === 'error'
      ? 'error'
      : record.estado === 'pagado' || record.estado === 'aprobado_humano'
        ? 'pagada'
        : record.estado === 'frenado' || record.estado === 'rechazado_humano'
          ? 'frenada'
          : 'escalada';
  getDb().prepare('UPDATE invoices SET queue_state = ? WHERE id = ?').run(estadoCola, record.invoiceId);
}

/** El veredicto del motor se puede reconstruir desde las reglas almacenadas. */
function deriveVeredicto(record: DecisionRecord): string {
  if (record.reglas.some((r) => r.resultado === 'bloquea')) return 'frenar';
  if (record.reglas.some((r) => r.resultado === 'escala')) return 'escalar';
  return 'pagar';
}

export function listDecisions(): DecisionRecord[] {
  const rows = getDb().prepare(`${DECISION_SELECT} ORDER BY d.orden ASC`).all() as DecisionRow[];
  return rows.map(rowToDecision);
}

export function getDecisionByInvoice(invoiceId: string): DecisionRecord | null {
  const row = getDb().prepare(`${DECISION_SELECT} WHERE d.invoice_id = ?`).get(invoiceId) as
    | DecisionRow
    | undefined;
  return row ? rowToDecision(row) : null;
}

export function updateHumanDecision(
  invoiceId: string,
  humano: HumanDecision,
  decisionFinal: DecisionRecord['decisionFinal'],
  estado: DecisionRecord['estado'],
  explicacion: string,
  descripcion: AgentDescription,
): void {
  getDb()
    .prepare(
      `UPDATE decisions
       SET humano_json = ?, decision_final = ?, estado = ?, explicacion = ?,
           descripcion_json = ?, updated_at = ?
       WHERE invoice_id = ?`,
    )
    .run(
      JSON.stringify(humano),
      decisionFinal,
      estado,
      explicacion,
      JSON.stringify(descripcion),
      nowIso(),
      invoiceId,
    );
}

/** Solo para reevaluar una factura tras una propuesta confirmada (RF-10.5). */
export function deleteDecisionByInvoice(invoiceId: string): void {
  getDb().prepare('DELETE FROM decisions WHERE invoice_id = ?').run(invoiceId);
}

/* ------------------------------------------------------------------ */
/* Ledger de pagos                                                     */
/* ------------------------------------------------------------------ */

interface LedgerRow {
  id: string;
  invoice_id: string;
  beneficiario: string;
  monto: number;
  moneda: string;
  monto_base: number;
  referencia: string;
  fecha: string;
  origen: string;
}

function rowToLedger(row: LedgerRow): LedgerEntry {
  return LedgerEntrySchema.parse({
    id: row.id,
    invoiceId: row.invoice_id,
    beneficiario: row.beneficiario,
    monto: row.monto,
    moneda: row.moneda,
    montoBase: row.monto_base,
    referencia: row.referencia,
    fecha: row.fecha,
    origen: row.origen,
  });
}

export function insertLedgerEntry(entry: LedgerEntry): void {
  getDb()
    .prepare(
      `INSERT INTO ledger (id, invoice_id, decision_id, beneficiario, monto, moneda, monto_base,
                           referencia, fecha, origen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(invoice_id) DO NOTHING`,
    )
    .run(
      entry.id,
      entry.invoiceId,
      entry.invoiceId,
      entry.beneficiario,
      entry.monto,
      entry.moneda,
      entry.montoBase,
      entry.referencia,
      entry.fecha,
      entry.origen,
      nowIso(),
    );
}

export function removeLedgerEntry(invoiceId: string): void {
  getDb().prepare('DELETE FROM ledger WHERE invoice_id = ?').run(invoiceId);
}

export function listLedger(): LedgerEntry[] {
  const rows = getDb().prepare('SELECT * FROM ledger ORDER BY fecha ASC, id ASC').all() as LedgerRow[];
  return rows.map(rowToLedger);
}

/* ------------------------------------------------------------------ */
/* Insumos del motor de reglas                                         */
/* ------------------------------------------------------------------ */

/** Decisiones previas (para R1). Incluye pagadas, escaladas y aprobadas por humano. */
export function listPriorDecisions(): PriorDecision[] {
  const rows = getDb()
    .prepare(
      `SELECT invoice_id, decision_final, estado, extraccion_json
       FROM decisions
       ORDER BY orden ASC`,
    )
    .all() as Array<{
    invoice_id: string;
    decision_final: string;
    estado: string;
    extraccion_json: string | null;
  }>;

  const resultado: PriorDecision[] = [];
  for (const row of rows) {
    const extraccion = InvoiceExtractionSchema.safeParse(parseJson<unknown>(row.extraccion_json, null));
    if (!extraccion.success) continue;
    resultado.push({
      invoiceId: row.invoice_id,
      beneficiario: extraccion.data.beneficiario,
      monto: extraccion.data.monto,
      moneda: extraccion.data.moneda,
      referencia: extraccion.data.referencia,
      decision: row.decision_final as PriorDecision['decision'],
      estado: row.estado as PriorDecision['estado'],
      origen: row.estado === 'aprobado_humano' ? 'humano' : 'agente',
    });
  }
  return resultado;
}

export function countInvoices(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS total FROM invoices').get() as { total: number };
  return row.total;
}

/* ------------------------------------------------------------------ */
/* Ordenes de pago preparadas (RF-14)                                  */
/* ------------------------------------------------------------------ */

interface PaymentOrderRow {
  id: string;
  invoice_id: string;
  beneficiario: string;
  pais: string;
  banco_ficticio: string;
  cuenta_ficticia: string;
  moneda_preferida: string;
  monto: number;
  moneda: string;
  monto_convertido: number;
  moneda_base: string;
  fecha_sugerida: string;
  referencia: string;
  concepto: string;
  estado: string;
  created_at: string;
}

export function insertPaymentOrder(order: PaymentOrder): void {
  getDb()
    .prepare(
      `INSERT INTO payment_orders (
         id, invoice_id, beneficiario, pais, banco_ficticio, cuenta_ficticia, moneda_preferida,
         monto, moneda, monto_convertido, moneda_base, fecha_sugerida, referencia, concepto,
         estado, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(invoice_id) DO NOTHING`,
    )
    .run(
      order.id,
      order.invoiceId,
      order.beneficiario,
      order.pais,
      order.bancoFicticio,
      order.cuentaFicticia,
      order.monedaPreferida,
      order.monto,
      order.moneda,
      order.montoConvertido,
      order.monedaBase,
      order.fechaSugerida,
      order.referencia,
      order.concepto,
      order.estado,
      order.createdAt,
    );
}

export function getPaymentOrder(invoiceId: string): PaymentOrder | null {
  const row = getDb().prepare('SELECT * FROM payment_orders WHERE invoice_id = ?').get(invoiceId) as
    | PaymentOrderRow
    | undefined;
  if (!row) return null;
  return PaymentOrderSchema.parse({
    id: row.id,
    invoiceId: row.invoice_id,
    beneficiario: row.beneficiario,
    pais: row.pais,
    bancoFicticio: row.banco_ficticio,
    cuentaFicticia: row.cuenta_ficticia,
    monedaPreferida: row.moneda_preferida,
    monto: row.monto,
    moneda: row.moneda,
    montoConvertido: row.monto_convertido,
    monedaBase: row.moneda_base,
    fechaSugerida: row.fecha_sugerida,
    referencia: row.referencia,
    concepto: row.concepto,
    estado: 'preparada',
    createdAt: row.created_at,
  });
}

export function listPaymentOrders(): PaymentOrder[] {
  const rows = getDb().prepare('SELECT invoice_id FROM payment_orders ORDER BY created_at ASC').all() as Array<{
    invoice_id: string;
  }>;
  return rows.map((row) => getPaymentOrder(row.invoice_id)).filter((o): o is PaymentOrder => o !== null);
}

/* ------------------------------------------------------------------ */
/* Notificaciones simuladas (RF-12)                                    */
/* ------------------------------------------------------------------ */

interface NotificationRow {
  id: string;
  invoice_id: string;
  approver_id: string;
  approver_nombre: string;
  canal: string;
  destinatario: string;
  asunto: string;
  cuerpo: string;
  contenido_json: string;
  estado: string;
  respuesta_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToNotification(row: NotificationRow): Notification {
  return NotificationSchema.parse({
    id: row.id,
    invoiceId: row.invoice_id,
    approverId: row.approver_id,
    approverNombre: row.approver_nombre,
    canal: row.canal as NotificationChannel,
    destinatario: row.destinatario,
    asunto: row.asunto,
    cuerpo: row.cuerpo,
    contenido: parseJson<unknown>(row.contenido_json, {}),
    estado: row.estado,
    respuesta: parseJson<unknown>(row.respuesta_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function insertNotification(notification: Notification): void {
  getDb()
    .prepare(
      `INSERT INTO notifications (
         id, invoice_id, approver_id, approver_nombre, canal, destinatario, asunto, cuerpo,
         contenido_json, estado, respuesta_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      notification.id,
      notification.invoiceId,
      notification.approverId,
      notification.approverNombre,
      notification.canal,
      notification.destinatario,
      notification.asunto,
      notification.cuerpo,
      JSON.stringify(notification.contenido),
      notification.estado,
      notification.respuesta ? JSON.stringify(notification.respuesta) : null,
      notification.createdAt,
      notification.updatedAt,
    );
}

export function listNotifications(): Notification[] {
  const rows = getDb()
    .prepare('SELECT * FROM notifications ORDER BY created_at DESC')
    .all() as NotificationRow[];
  return rows.map(rowToNotification);
}

export function getNotification(id: string): Notification | null {
  const row = getDb().prepare('SELECT * FROM notifications WHERE id = ?').get(id) as
    | NotificationRow
    | undefined;
  return row ? rowToNotification(row) : null;
}

export function getNotificationByInvoice(invoiceId: string): Notification | null {
  const row = getDb()
    .prepare('SELECT * FROM notifications WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(invoiceId) as NotificationRow | undefined;
  return row ? rowToNotification(row) : null;
}

export function respondNotification(
  id: string,
  respuesta: NotificationResponse,
): Notification | null {
  getDb()
    .prepare(
      `UPDATE notifications SET estado = 'respondido', respuesta_json = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(JSON.stringify(respuesta), nowIso(), id);
  return getNotification(id);
}

/* ------------------------------------------------------------------ */
/* Chat (RF-10)                                                        */
/* ------------------------------------------------------------------ */

interface ChatMessageRow {
  id: string;
  thread_id: string;
  rol: string;
  contenido: string;
  created_at: string;
}

interface ChatProposalRow {
  id: string;
  message_id: string;
  thread_id: string;
  tipo: string;
  factura_id: string | null;
  titulo: string;
  descripcion: string;
  payload_json: string;
  estado: string;
  created_at: string;
  confirmada_por: string | null;
  confirmada_en: string | null;
}

function rowToProposal(row: ChatProposalRow): ChatProposal {
  return ChatProposalSchema.parse({
    id: row.id,
    threadId: row.thread_id,
    tipo: row.tipo as ChatProposalType,
    facturaId: row.factura_id,
    titulo: row.titulo,
    descripcion: row.descripcion,
    payload: parseJson<unknown>(row.payload_json, {}),
    estado: row.estado as ChatProposalStatus,
    createdAt: row.created_at,
    confirmadaPor: row.confirmada_por,
    confirmadaEn: row.confirmada_en,
  });
}

export function listChatMessages(threadId: string): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(threadId) as ChatMessageRow[];
  const propuestas = getDb()
    .prepare('SELECT * FROM chat_proposals WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(threadId) as ChatProposalRow[];

  const porMensaje = new Map<string, ChatProposal[]>();
  for (const row of propuestas) {
    const lista = porMensaje.get(row.message_id) ?? [];
    lista.push(rowToProposal(row));
    porMensaje.set(row.message_id, lista);
  }

  return rows.map((row) =>
    ChatMessageSchema.parse({
      id: row.id,
      threadId: row.thread_id,
      rol: row.rol,
      contenido: row.contenido,
      propuestas: porMensaje.get(row.id) ?? [],
      createdAt: row.created_at,
    }),
  );
}

export function appendChatMessage(
  threadId: string,
  rol: ChatMessage['rol'],
  contenido: string,
  propuestas: Array<{
    tipo: ChatProposalType;
    facturaId: string | null;
    titulo: string;
    descripcion: string;
    payload: Record<string, unknown>;
  }> = [],
): ChatMessage {
  const db = getDb();
  const id = randomUUID();
  const createdAt = nowIso();
  db.prepare('INSERT INTO chat_messages (id, thread_id, rol, contenido, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    threadId,
    rol,
    contenido,
    createdAt,
  );

  const insertar = db.prepare(
    `INSERT INTO chat_proposals (
       id, message_id, thread_id, tipo, factura_id, titulo, descripcion, payload_json,
       estado, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)`,
  );
  const creadas: ChatProposal[] = [];
  for (const propuesta of propuestas) {
    const propuestaId = randomUUID();
    insertar.run(
      propuestaId,
      id,
      threadId,
      propuesta.tipo,
      propuesta.facturaId,
      propuesta.titulo,
      propuesta.descripcion,
      JSON.stringify(propuesta.payload),
      createdAt,
    );
    creadas.push({
      id: propuestaId,
      threadId,
      tipo: propuesta.tipo,
      facturaId: propuesta.facturaId,
      titulo: propuesta.titulo,
      descripcion: propuesta.descripcion,
      payload: propuesta.payload,
      estado: 'pendiente',
      createdAt,
      confirmadaPor: null,
      confirmadaEn: null,
    });
  }

  return {
    id,
    threadId,
    rol,
    contenido,
    propuestas: creadas,
    createdAt,
  };
}

export function getChatProposal(id: string): ChatProposal | null {
  const row = getDb().prepare('SELECT * FROM chat_proposals WHERE id = ?').get(id) as
    | ChatProposalRow
    | undefined;
  return row ? rowToProposal(row) : null;
}

export function confirmChatProposal(id: string, quien: string): ChatProposal | null {
  getDb()
    .prepare(
      `UPDATE chat_proposals SET estado = 'confirmada', confirmada_por = ?, confirmada_en = ?
       WHERE id = ? AND estado = 'pendiente'`,
    )
    .run(quien, nowIso(), id);
  return getChatProposal(id);
}

export function discardChatProposal(id: string): void {
  getDb()
    .prepare("UPDATE chat_proposals SET estado = 'descartada' WHERE id = ? AND estado = 'pendiente'")
    .run(id);
}
