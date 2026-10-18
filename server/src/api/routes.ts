import { existsSync, readFileSync } from 'node:fs';
import { Router, type Request, type Response } from 'express';
import {
  AuditFiltersSchema,
  EvaluationReportSchema,
  IngestEntrySchema,
  IngestModeSchema,
  RulesConfigSchema,
  type DecisionRecord,
  type InvoiceListItem,
  type QueueState,
} from '@payblink/shared';
import { PATHS, SETTINGS, llmModeLabel } from '../config';
import { convertToBase, round2 } from '../core/money';
import {
  decideHuman,
  estadoPresupuesto,
  queueStateForEstado,
  type OrchestratorDeps,
} from '../agent/orchestrator';
import { buildDeps } from '../agent/deps';
import { log as audit, exportEventsCsv, exportEventsJson, listEvents, verifyChain } from '../audit/audit';
import { confirmChatProposal, getChatThread, sendChatMessage } from '../chat/agent';
import { CONNECTORS } from '../ingestion/connectors';
import { ingestEntry, ingestFolderAll, listExamples, previewEntry } from '../ingestion/service';
import { enqueueAllPending, enqueueInvoice, listQueue } from '../jobs/queue';
import { listApprovers } from '../notifications/approvers';
import { respondFromNotification } from '../notifications/service';
import * as repo from '../storage/repositories';
import { seedDatabase } from '../storage/seed';
import { estadoTurso } from '../storage/turso';

function error(res: Response, status: number, mensaje: string): void {
  res.status(status).json({ error: mensaje });
}

function deps(): OrchestratorDeps | null {
  return buildDeps();
}

function motivoResumen(record: DecisionRecord): string {
  const relevante = record.reglas.find((r) => r.resultado !== 'pasa');
  if (relevante) return relevante.motivo;
  return 'Cumple todas las reglas de la empresa.';
}

function aListItem(record: DecisionRecord | null, invoice: repo.StoredInvoice): InvoiceListItem {
  const config = repo.getRulesConfig();
  if (!record) {
    return {
      id: invoice.id,
      archivo: invoice.archivo,
      formato: invoice.formato,
      asunto: invoice.asunto,
      procesada: false,
      beneficiario: null,
      monto: null,
      moneda: null,
      montoBase: null,
      referencia: null,
      decisionFinal: null,
      estado: null,
      queueState: invoice.queueState,
      fuente: invoice.fuente,
      intentos: invoice.intentos,
      ultimoError: invoice.ultimoError,
      guardActuo: false,
      motivoResumen: invoice.ultimoError
        ? `Falló el procesamiento: ${invoice.ultimoError}`
        : 'Pendiente de procesar.',
      descripcionLinea: invoice.ultimoError
        ? `Error: ${invoice.ultimoError}`
        : 'Todavía no se procesó: no hay descripción del agente.',
      confianza: null,
      inyecciones: [],
      actualizadoEn: null,
    };
  }

  const extraccion = record.extraccion;
  const montoBase =
    extraccion && config ? convertToBase(extraccion.monto, extraccion.moneda, config) : null;
  const queueState: QueueState = record.queueState ?? queueStateForEstado(record.estado);

  return {
    id: record.invoiceId,
    archivo: record.archivo,
    formato: record.formato,
    asunto: record.asunto,
    procesada: true,
    beneficiario: extraccion?.beneficiario ?? null,
    monto: extraccion?.monto ?? null,
    moneda: extraccion?.moneda ?? null,
    montoBase,
    referencia: extraccion?.referencia ?? null,
    decisionFinal: record.decisionFinal,
    estado: record.estado,
    queueState,
    fuente: invoice.fuente,
    intentos: invoice.intentos,
    ultimoError: invoice.ultimoError,
    guardActuo: record.guardActuo,
    motivoResumen: motivoResumen(record),
    descripcionLinea:
      record.descripcion.resumen.length > 180
        ? `${record.descripcion.resumen.slice(0, 177)}...`
        : record.descripcion.resumen,
    confianza: extraccion?.confianza ?? null,
    inyecciones: record.verificacion?.inyeccionesDetectadas ?? [],
    actualizadoEn: record.updatedAt,
  };
}

function csv(valor: unknown): string {
  return `"${String(valor ?? '').replace(/"/g, '""')}"`;
}

export function createApiRouter(): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      llm: llmModeLabel(),
      estrategia: SETTINGS.agentStrategy,
      ingestMode: repo.getIngestMode(),
      // Estado de la réplica en Turso: la app funciona en local aunque esté caída.
      turso: estadoTurso(),
    });
  });

  /** RF-8.1: todo lo que la pantalla de reglas necesita. */
  router.get('/config', (_req: Request, res: Response) => {
    const config = repo.getRulesConfig();
    const company = repo.getCompany();
    if (!config || !company) return error(res, 503, 'La base de datos no esta inicializada.');
    res.json({
      company,
      rules: config,
      contratos: repo.getContracts(),
      ingestMode: repo.getIngestMode(),
      llm: {
        modo: llmModeLabel(),
        estrategia: SETTINGS.agentStrategy,
        maxSteps: SETTINGS.maxSteps,
        apiKeyConfigurada: SETTINGS.geminiApiKey.length > 0,
      },
    });
  });

  /** RF-8.1 / CA-8: editar reglas cambia las decisiones siguientes. */
  router.put('/rules', (req: Request, res: Response) => {
    const parsed = RulesConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return error(
        res,
        400,
        `Configuracion de reglas invalida: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    }
    const antes = repo.getRulesConfig();
    repo.saveRulesConfig(parsed.data);

    const company = repo.getCompany();
    if (company) {
      repo.saveCompany({
        ...company,
        monedaBase: parsed.data.monedaBase,
        presupuestoPeriodo: parsed.data.presupuestoPeriodo,
        tasas: parsed.data.tasas,
        periodo: { ...company.periodo, fechaReferencia: parsed.data.fechaReferencia },
      });
    }

    const quien = typeof req.body?.quien === 'string' && req.body.quien.trim() ? req.body.quien.trim() : 'Persona (pantalla Reglas)';
    audit({
      actor: 'persona',
      tipo: 'reglas.cambiadas',
      detalle: {
        quien,
        antes: antes
          ? {
              limitePorPago: antes.limitePorPago,
              limitePorPeriodo: antes.limitePorPeriodo,
              presupuestoPeriodo: antes.presupuestoPeriodo,
              umbralAprobacionHumana: antes.umbralAprobacionHumana,
              beneficiariosPermitidos: antes.beneficiariosPermitidos,
            }
          : null,
        despues: {
          limitePorPago: parsed.data.limitePorPago,
          limitePorPeriodo: parsed.data.limitePorPeriodo,
          presupuestoPeriodo: parsed.data.presupuestoPeriodo,
          umbralAprobacionHumana: parsed.data.umbralAprobacionHumana,
          beneficiariosPermitidos: parsed.data.beneficiariosPermitidos,
        },
      },
    });

    res.json({ ok: true, rules: parsed.data });
  });

  /** RF-8.2: tabla de facturas y decisiones. */
  router.get('/invoices', (_req: Request, res: Response) => {
    const stored = repo.listStoredInvoices();
    const items = stored.map((invoice) => aListItem(repo.getDecisionByInvoice(invoice.id), invoice));
    res.json({ items, total: items.length });
  });

  /** RF-14.3: CSV de conciliacion (antes de /invoices/:id). */
  router.get('/invoices/export.csv', (_req: Request, res: Response) => {
    const decisiones = repo.listDecisions();
    const lineas = ['fecha,beneficiario,monto,moneda,monto_convertido,decision,motivo,aprobador'];
    for (const record of decisiones) {
      const config = repo.getRulesConfig();
      const montoConvertido =
        record.extraccion && config
          ? convertToBase(record.extraccion.monto, record.extraccion.moneda, config)
          : null;
      lineas.push(
        [
          csv(record.updatedAt),
          csv(record.extraccion?.beneficiario ?? ''),
          csv(record.extraccion?.monto ?? ''),
          csv(record.extraccion?.moneda ?? ''),
          csv(montoConvertido ?? ''),
          csv(record.decisionFinal),
          csv(motivoResumen(record)),
          csv(record.humano?.quien ?? ''),
        ].join(','),
      );
    }
    audit({
      actor: 'sistema',
      tipo: 'exportacion',
      detalle: { formato: 'csv', recurso: 'facturas', filas: decisiones.length },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="payblink-facturas.csv"');
    res.send(`${lineas.join('\n')}\n`);
  });

  /** RF-8.10: detalle con rastro, bitacora, orden de pago y chat. */
  router.get('/invoices/:id', (req: Request, res: Response) => {
    const record = repo.getDecisionByInvoice(req.params.id);
    if (!record) return error(res, 404, `No hay decision registrada para ${req.params.id}.`);
    res.json({
      record,
      bitacora: listEvents({ invoiceId: req.params.id }),
      paymentOrder: repo.getPaymentOrder(req.params.id),
      chat: repo.listChatMessages(req.params.id),
    });
  });

  /** RF-1.3 / RF-1.8: boton "Procesar todas las pendientes". */
  router.post('/invoices/process', (_req: Request, res: Response) => {
    const encoladas = enqueueAllPending();
    res.json({ encoladas, mensaje: encoladas === 0 ? 'No había facturas pendientes.' : `${encoladas} factura(s) en cola.` });
  });

  /** RF-1.8: procesar una factura concreta. */
  router.post('/invoices/:id/process', (req: Request, res: Response) => {
    const record = repo.getDecisionByInvoice(req.params.id);
    if (record) return error(res, 409, `La factura ${req.params.id} ya fue procesada.`);
    const ok = enqueueInvoice(req.params.id);
    if (!ok) return error(res, 404, `No se pudo encolar ${req.params.id}.`);
    res.json({ ok: true, invoiceId: req.params.id, queueState: 'en_cola' });
  });

  /** RF-8.3: lista de escaladas pendientes de aprobacion. */
  router.get('/approvals', (_req: Request, res: Response) => {
    const pendientes = repo.listDecisions().filter((d) => d.estado === 'pendiente_aprobacion');
    res.json({ items: pendientes, total: pendientes.length });
  });

  /** RF-8.3 / CA-7: aprobar o rechazar una factura escalada. */
  router.post('/approvals/:id', (req: Request, res: Response) => {
    const dependencias = deps();
    if (!dependencias) return error(res, 503, 'La base de datos no esta inicializada.');

    const body = req.body as { accion?: unknown; quien?: unknown; comentario?: unknown };
    const accion = body.accion;
    if (accion !== 'aprobar' && accion !== 'rechazar') {
      return error(res, 400, 'La accion debe ser "aprobar" o "rechazar".');
    }
    const quien =
      typeof body.quien === 'string' && body.quien.trim()
        ? body.quien.trim()
        : dependencias.company.responsable;
    const comentario = typeof body.comentario === 'string' ? body.comentario.trim() : '';

    const resultado = decideHuman(req.params.id, accion, quien, comentario, dependencias);
    if (!resultado.ok) return error(res, 409, resultado.error ?? 'No se pudo registrar la decision humana.');

    // Si habia una notificacion simulada, queda respondida con la misma identidad.
    const notificacion = repo.getNotificationByInvoice(req.params.id);
    if (notificacion && notificacion.estado !== 'respondido') {
      repo.respondNotification(notificacion.id, {
        accion,
        quien,
        comentario,
        fecha: repo.nowIso(),
      });
    }

    res.json(resultado.record);
  });

  /** RF-8.4: contadores y presupuesto del periodo. */
  router.get('/summary', (_req: Request, res: Response) => {
    const dependencias = deps();
    if (!dependencias) return error(res, 503, 'La base de datos no esta inicializada.');
    const config = dependencias.config;

    const decisiones = repo.listDecisions();
    const invoices = repo.listInvoices();
    const presupuesto = estadoPresupuesto(dependencias);
    const comprometido = round2(presupuesto.comprometido);

    res.json({
      total: invoices.length,
      pagados: decisiones.filter((d) => d.estado === 'pagado').length,
      frenados: decisiones.filter((d) => d.estado === 'frenado').length,
      pendientes: decisiones.filter((d) => d.estado === 'pendiente_aprobacion').length,
      aprobadosHumanos: decisiones.filter((d) => d.estado === 'aprobado_humano').length,
      rechazadosHumanos: decisiones.filter((d) => d.estado === 'rechazado_humano').length,
      porProcesar: invoices.length - decisiones.length,
      presupuesto: {
        monedaBase: config.monedaBase,
        presupuestoPeriodo: config.presupuestoPeriodo,
        comprometido,
        disponible: round2(config.presupuestoPeriodo - comprometido),
        utilizadoPct:
          config.presupuestoPeriodo > 0 ? round2((comprometido / config.presupuestoPeriodo) * 100) : 0,
        limitePorPeriodo: config.limitePorPeriodo,
        utilizacionLimitePct:
          config.limitePorPeriodo > 0 ? round2((comprometido / config.limitePorPeriodo) * 100) : 0,
      },
    });
  });

  /** RF-8.4: metricas de la ultima evaluacion (la escribe `npm run eval`). */
  router.get('/evaluation', (_req: Request, res: Response) => {
    const ruta = `${PATHS.root}/eval/report.json`;
    if (!existsSync(ruta)) {
      return error(res, 404, 'Todavia no hay reporte. Ejecuta `npm run eval` para generarlo.');
    }
    try {
      const parsed = EvaluationReportSchema.safeParse(JSON.parse(readFileSync(ruta, 'utf8')));
      if (!parsed.success) return error(res, 500, 'El reporte guardado no tiene el formato esperado.');
      res.json(parsed.data);
    } catch (causa) {
      error(res, 500, causa instanceof Error ? causa.message : String(causa));
    }
  });

  /** Reinicia la demo: borra decisiones y vuelve a sembrar. */
  router.post('/reset', async (_req: Request, res: Response) => {
    try {
      const resultado = await seedDatabase({ reset: true });
      audit({
        actor: 'persona',
        tipo: 'factura.estado',
        detalle: { accion: 'reset_demo', facturas: resultado.facturas },
      });
      res.json({ ok: true, ...resultado });
    } catch (causa) {
      error(res, 500, causa instanceof Error ? causa.message : String(causa));
    }
  });

  /* ---------------------------------------------------------------- */
  /* Ingreso y cola (RF-1, RF-8.9)                                    */
  /* ---------------------------------------------------------------- */

  router.get('/ingest-mode', (_req: Request, res: Response) => {
    res.json({ modo: repo.getIngestMode() });
  });

  router.put('/ingest-mode', (req: Request, res: Response) => {
    const parsed = IngestModeSchema.safeParse(req.body?.modo);
    if (!parsed.success) return error(res, 400, 'El modo debe ser "manual" o "automatico".');
    repo.setIngestMode(parsed.data);
    audit({
      actor: 'persona',
      tipo: 'reglas.cambiadas',
      detalle: { cambio: 'ingestMode', despues: parsed.data },
    });
    res.json({ ok: true, modo: parsed.data });
  });

  router.get('/ingest/examples', (_req: Request, res: Response) => {
    res.json({ items: listExamples() });
  });

  /** Permite a la UI comprobar la extraccion (sobre todo PDF) antes de crear la factura. */
  router.post('/ingest/preview', async (req: Request, res: Response) => {
    try {
      res.json(await previewEntry(req.body));
    } catch (causa) {
      error(res, 400, causa instanceof Error ? causa.message : String(causa));
    }
  });

  router.post('/ingest', async (req: Request, res: Response) => {
    const parsed = IngestEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      return error(res, 400, `Entrada invalida: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    try {
      const resultado = await ingestEntry(parsed.data);
      res.status(resultado.duplicada ? 200 : 201).json(resultado);
    } catch (causa) {
      error(res, 400, causa instanceof Error ? causa.message : String(causa));
    }
  });

  router.post('/ingest/load-all', async (_req: Request, res: Response) => {
    try {
      const resultado = await ingestFolderAll();
      res.json(resultado);
    } catch (causa) {
      error(res, 500, causa instanceof Error ? causa.message : String(causa));
    }
  });

  router.get('/queue', (_req: Request, res: Response) => {
    res.json({ items: listQueue(), modo: repo.getIngestMode() });
  });

  /* ---------------------------------------------------------------- */
  /* Conectores, notificaciones y auditoria (RF-11, RF-12, RF-13)     */
  /* ---------------------------------------------------------------- */

  router.get('/connectors', (_req: Request, res: Response) => {
    res.json({ items: CONNECTORS });
  });

  router.get('/notifications', (_req: Request, res: Response) => {
    res.json({ items: repo.listNotifications(), aprobadores: listApprovers() });
  });

  /** RF-12.6: mismo endpoint de aprobacion humana, con la identidad del aprobador. */
  router.post('/notifications/:id/respond', (req: Request, res: Response) => {
    const dependencias = deps();
    if (!dependencias) return error(res, 503, 'La base de datos no esta inicializada.');
    const body = req.body as { accion?: unknown; quien?: unknown; comentario?: unknown };
    if (body.accion !== 'aprobar' && body.accion !== 'rechazar') {
      return error(res, 400, 'La accion debe ser "aprobar" o "rechazar".');
    }
    const quien = typeof body.quien === 'string' ? body.quien : '';
    const comentario = typeof body.comentario === 'string' ? body.comentario : '';
    const { result, notification } = respondFromNotification(
      req.params.id,
      body.accion,
      quien,
      comentario,
      dependencias,
    );
    if (!result.ok) return error(res, 409, result.error ?? 'No se pudo responder la notificacion.');
    res.json({ record: result.record, notification });
  });

  /** RF-12.6: el texto libre del aprobador va al chat del agente (solo consulta/propone). */
  router.post('/notifications/:id/message', async (req: Request, res: Response) => {
    const notificacion = repo.getNotification(req.params.id);
    if (!notificacion) return error(res, 404, 'No existe la notificacion.');
    const mensaje = typeof req.body?.mensaje === 'string' ? req.body.mensaje.trim() : '';
    if (!mensaje) return error(res, 400, 'Se requiere un mensaje.');
    try {
      const respuesta = await sendChatMessage(
        notificacion.invoiceId,
        mensaje,
        typeof req.body?.quien === 'string' ? req.body.quien : notificacion.approverNombre,
      );
      res.json({ mensaje: respuesta });
    } catch (causa) {
      error(res, 500, causa instanceof Error ? causa.message : String(causa));
    }
  });

  router.get('/audit/verify', (_req: Request, res: Response) => {
    res.json(verifyChain());
  });

  router.get('/audit/export.csv', (req: Request, res: Response) => {
    const filtros = AuditFiltersSchema.parse(req.query);
    const contenido = exportEventsCsv(filtros);
    audit({ actor: 'sistema', tipo: 'exportacion', detalle: { formato: 'csv', recurso: 'auditoria', filtros } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="payblink-auditoria.csv"');
    res.send(contenido);
  });

  router.get('/audit/export.json', (req: Request, res: Response) => {
    const filtros = AuditFiltersSchema.parse(req.query);
    const contenido = exportEventsJson(filtros);
    audit({ actor: 'sistema', tipo: 'exportacion', detalle: { formato: 'json', recurso: 'auditoria', filtros } });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="payblink-auditoria.json"');
    res.send(contenido);
  });

  router.get('/audit', (req: Request, res: Response) => {
    const filtros = AuditFiltersSchema.parse(req.query);
    const items = listEvents(filtros);
    res.json({ items, total: items.length, cadena: verifyChain() });
  });

  /* ---------------------------------------------------------------- */
  /* Chat (RF-10)                                                     */
  /* ---------------------------------------------------------------- */

  router.get('/chat', (req: Request, res: Response) => {
    const threadId = typeof req.query.threadId === 'string' && req.query.threadId.trim() ? req.query.threadId : 'global';
    res.json({ threadId, mensajes: getChatThread(threadId) });
  });

  router.post('/chat', async (req: Request, res: Response) => {
    const body = req.body as { mensaje?: unknown; threadId?: unknown; autor?: unknown };
    if (typeof body.mensaje !== 'string' || !body.mensaje.trim()) {
      return error(res, 400, 'Se requiere un mensaje.');
    }
    const threadId =
      typeof body.threadId === 'string' && body.threadId.trim() ? body.threadId.trim() : 'global';
    try {
      const mensaje = await sendChatMessage(
        threadId,
        body.mensaje.trim(),
        typeof body.autor === 'string' ? body.autor : 'Persona',
      );
      res.json({ threadId, mensaje });
    } catch (causa) {
      error(res, 500, causa instanceof Error ? causa.message : String(causa));
    }
  });

  /** RF-10.4 / CA-12 / CA-13: confirmar una propuesta (nunca se ejecuta sola). */
  router.post('/chat/proposals/:id/confirm', (req: Request, res: Response) => {
    const quien = typeof req.body?.quien === 'string' ? req.body.quien.trim() : '';
    const resultado = confirmChatProposal(req.params.id, quien);
    if (!resultado.ok) return error(res, 409, resultado.error ?? 'No se pudo confirmar la propuesta.');
    res.json(resultado);
  });

  return router;
}
