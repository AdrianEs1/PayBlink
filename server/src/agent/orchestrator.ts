import { createHash, randomUUID } from 'node:crypto';
import {
  decisionToEstado,
  type Company,
  type Contract,
  type Decision,
  type DecisionRecord,
  type LedgerEntry,
  type LlmProposal,
  type QueueState,
  type RulesConfig,
  type ToolCall,
} from '@payblink/shared';
import { SETTINGS } from '../config';
import { log as audit } from '../audit/audit';
import { ensurePaymentOrder } from '../payments/orders';

const log = (...args: unknown[]) => console.log(`[AGENTE] ${new Date().toISOString()}`, ...args);
const logBloqueante = (...args: unknown[]) => console.warn(`[AGENTE:BLOQUE] ${new Date().toISOString()}`, ...args);
const logTool = (...args: unknown[]) => console.log(`[AGENTE:TOOL] ${new Date().toISOString()}`, ...args);
import { evaluateRules } from '../core/engine';
import { applyGuard } from '../core/guard';
import { buildDescription } from '../core/explain';
import { convertToBase } from '../core/money';
import { samePeriod } from '../core/period';
import type { InvoiceInput, RuleContext } from '../core/types';
import { extractInvoice } from '../extraction/extract';
import * as repo from '../storage/repositories';
import { buildDecisionPrompt } from './prompt';
import type { LlmClient } from './llm/types';
import { budgetStatus, type BudgetStatusTool, type ToolContext } from './tools';

export interface OrchestratorDeps {
  llm: LlmClient;
  config: RulesConfig;
  contratos: readonly Contract[];
  company: Company;
}

export interface ProcessOutcome {
  record: DecisionRecord;
  ledgerEntry: LedgerEntry | null;
}

/** RF-13.4: versiones que permiten reproducir una decision. */
const PROMPT_VERSION = 'v1-2026-10-17';
export function rulesVersion(config: RulesConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 12);
}

export function queueStateForDecision(decision: Decision): QueueState {
  if (decision === 'pagar') return 'pagada';
  if (decision === 'frenar') return 'frenada';
  return 'escalada';
}

export function queueStateForEstado(estado: DecisionRecord['estado']): QueueState {
  if (estado === 'pagado' || estado === 'aprobado_humano') return 'pagada';
  if (estado === 'frenado' || estado === 'rechazado_humano') return 'frenada';
  return 'escalada';
}

/** Insumos del motor, leidos de la base en cada factura para respetar el orden (RF-7). */
function construirContexto(invoice: InvoiceInput, deps: OrchestratorDeps, extraccion: RuleContext['extraccion'], verificacion: RuleContext['verificacion']): RuleContext {
  const periodo = deps.company.periodo.tipo;
  return {
    invoice,
    extraccion,
    verificacion,
    config: deps.config,
    contratos: deps.contratos,
    ledger: repo.listLedger().filter((e) => samePeriod(e.fecha, deps.config.fechaReferencia, periodo)),
    historial: repo.listPriorDecisions(),
  };
}

/**
 * RF-4: procesa UNA factura de principio a fin.
 *
 *   extraer -> verificar -> evaluar reglas -> (loop o pipeline) -> guard -> explicar -> registrar
 *
 * Solo este modulo escribe decisiones, y siempre a traves del guard (RF-5.3).
 */
export async function processInvoice(invoice: InvoiceInput, deps: OrchestratorDeps): Promise<ProcessOutcome> {
  const { llm, config } = deps;

  log('╔══════════════════════════════════════════════════════════════╗');
  log(`║ FACTURA: ${invoice.id} · ${invoice.archivo} · ${invoice.asunto ?? 'sin asunto'} ║`);
  log(`║ formato: ${invoice.formato} ║`);
  if (invoice.texto) log(`║ texto (${invoice.texto.length} caracteres): ${invoice.texto.slice(0, 200).replace(/`/g, '\\`')}... ║`);
  log('╚══════════════════════════════════════════════════════════════╝');

  // 1) Extraccion con el LLM + verificacion en codigo (RF-2).
  const extraccion = await extractInvoice(invoice, llm);
  audit({
    actor: 'agente',
    tipo: 'extraccion.realizada',
    invoiceId: invoice.id,
    detalle: {
      extraccion: extraccion.extraccion,
      verificacion: extraccion.verificacion,
      motivos: extraccion.motivos,
      fallo: extraccion.fallo,
    },
  });

  // 2) Insumos deterministas y motor de reglas (RF-3).
  const ctx = construirContexto(invoice, deps, extraccion.extraccion, extraccion.verificacion);
  const reglas = evaluateRules(ctx);

  log('📋 REGLAS EVALUADAS (todas)'); 
  for (const r of reglas) {
    const icono = r.resultado === 'pasa' ? '✅' : r.resultado === 'escala' ? '⚠️' : '🚫';
    log(`  ${icono} ${r.nombre}: ${r.resultado} — ${r.motivo}`);
    if (r.detalle) log(`      detalle: ${r.detalle}`);
    audit({
      actor: 'agente',
      tipo: 'regla.evaluada',
      invoiceId: invoice.id,
      detalle: { regla: r.id, nombre: r.nombre, resultado: r.resultado, motivo: r.motivo, detalle: r.detalle ?? null },
    });
  }

  const toolContext: ToolContext = {
    invoice,
    config,
    contratos: deps.contratos,
    ledger: ctx.ledger,
    historial: ctx.historial,
  };

  // 3) Propuesta del LLM: por el loop con tools o por el pipeline fijo (RF-4.6).
  const toolCalls: ToolCall[] = [];
  let propuesta: LlmProposal;

  log(`🧠 Estrategia: ${SETTINGS.agentStrategy}${SETTINGS.agentStrategy === 'loop' ? ` (MAX_STEPS=${SETTINGS.maxSteps})` : ''}`);
  log(`🤖 LLM modo: ${llm.modo}${llm.descripcion ? ` — ${llm.descripcion}` : ''}`);

  if (SETTINGS.agentStrategy === 'loop' && typeof llm.runToolLoop === 'function') {
    log('🔄 Ejecutando loop con tools...');
    const resultado = await llm.runToolLoop({
      invoice,
      prompt: buildDecisionPrompt(invoice, reglas),
      toolContext,
      maxSteps: SETTINGS.maxSteps,
      traza: toolCalls,
    });

    if (resultado.cerro && resultado.decision) {
      propuesta = { decision: resultado.decision, razones: resultado.razones, origen: 'loop' };
      log(`✅ LOOP cerrado con decisión: ${resultado.decision}`);
    } else {
      log(`⚠️ LOOP ${resultado.agotoPasos ? 'agotó pasos' : 'falló'}: ${resultado.error ?? 'sin decisión'}`);
      // RF-4.4 / RF-4.5: se agoto MAX_STEPS o fallo -> la propuesta mas segura es escalar.
      propuesta = { decision: 'escalar', razones: resultado.razones, origen: 'fallback' };
    }
    if (toolCalls.length > 0) {
      log(`🔧 Tools llamadas (${toolCalls.length}):`);
      for (const tc of toolCalls) {
        logTool(`   - ${tc.tool}: ${JSON.stringify(tc.args)}`);
      }
    }
  } else {
    log('📝 Pipeline: pidiendo propuesta al LLM...');
    const respuesta = await llm.propose({
      invoice,
      extraccion: extraccion.extraccion,
      verificacion: extraccion.verificacion,
      reglas,
      toolCalls,
    });
    propuesta = { decision: respuesta.decision, razones: respuesta.razones, origen: 'pipeline' };
    log(`🎯 LLM propone: ${respuesta.decision}`);
    log(`💬 Razones del LLM:`);
    for (const razones of respuesta.razones) {
      log(`   - ${razones}`);
    }
  }

  audit({
    actor: 'agente',
    tipo: 'llm.propuesta',
    invoiceId: invoice.id,
    detalle: { decision: propuesta.decision, razones: propuesta.razones, origen: propuesta.origen },
  });
  for (const llamada of toolCalls) {
    audit({
      actor: 'agente',
      tipo: 'tool.llamada',
      invoiceId: invoice.id,
      detalle: { paso: llamada.paso, tool: llamada.tool, args: llamada.args, resultado: llamada.resultado },
    });
  }

  // 4) Guard: unico punto donde se fija la decision final (RF-5).
  const guard = applyGuard({ propuesta: propuesta.decision, reglas });
  audit({
    actor: 'agente',
    tipo: 'guard.decision',
    invoiceId: invoice.id,
    detalle: {
      propuesta: propuesta.decision,
      decisionFinal: guard.decisionFinal,
      guardActuo: guard.guardActuo,
      bloqueos: guard.bloqueos,
      escalamientos: guard.escalamientos,
    },
  });

  log(`🛡️ GUARD analiza propuesta "${propuesta.decision}"`);
  if (guard.guardActuo) {
    log(`   ✅ Guard permite: ${guard.decisionFinal}`);
    if (guard.bloqueos.length > 0) log(`   🚫 Bloqueos: ${guard.bloqueos.join(', ')}`);
    if (guard.escalamientos.length > 0) log(`   ⚠️ Escalamientos: ${guard.escalamientos.join(', ')}`);
  } else {
    logBloqueante(`   ❌ GUARD BLOQUEÓ: ${guard.decisionFinal}`);
    if (guard.bloqueos.length > 0) logBloqueante(`      Bloqueos: ${guard.bloqueos.join('; ')}`);
    if (guard.escalamientos.length > 0) logBloqueante(`      Escalamientos: ${guard.escalamientos.join('; ')}`);
  }

  // 5) Descripcion obligatoria (RF-6): parte determinista + narrativa opcional.
  const explicacionLlm = await llm.explain({
    invoice,
    reglas,
    decisionFinal: guard.decisionFinal,
  });
  const descripcion = buildDescription({
    beneficiario: extraccion.extraccion?.beneficiario ?? null,
    monto: extraccion.extraccion?.monto ?? null,
    moneda: extraccion.extraccion?.moneda ?? null,
    referencia: extraccion.extraccion?.referencia ?? null,
    decision: guard.decisionFinal,
    propuesta: propuesta.decision,
    guardActuo: guard.guardActuo,
    reglas,
    inyecciones: extraccion.verificacion.inyeccionesDetectadas,
    toolCalls: toolCalls.map((tc) => ({ tool: tc.tool, resultado: tc.resultado })),
    narrativaLlm: explicacionLlm,
  });
  const explicacion = descripcion.texto;
  audit({
    actor: 'agente',
    tipo: 'descripcion.generada',
    invoiceId: invoice.id,
    detalle: { origen: explicacionLlm ? 'llm' : 'plantilla', descripcion },
  });

  // 6) Registro de auditoria (RF-6).
  const timestamp = repo.nowIso();
  const record: DecisionRecord = {
    id: randomUUID(),
    invoiceId: invoice.id,
    archivo: invoice.archivo,
    formato: invoice.formato,
    asunto: invoice.asunto,
    texto: invoice.texto,
    extraccion: extraccion.extraccion,
    extraccionOk: extraccion.extraccion !== null,
    verificacion: extraccion.verificacion,
    reglas,
    toolCalls,
    propuestaLlm: propuesta,
    decisionFinal: guard.decisionFinal,
    estado: decisionToEstado(guard.decisionFinal),
    queueState: queueStateForDecision(guard.decisionFinal),
    guardActuo: guard.guardActuo,
    descripcion,
    explicacion,
    origenExplicacion: explicacionLlm ? 'llm' : 'plantilla',
    humano: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  repo.insertDecision(record, repo.nextDecisionOrder());
  audit({
    actor: 'agente',
    tipo: 'decision.registrada',
    invoiceId: invoice.id,
    detalle: {
      decisionFinal: record.decisionFinal,
      estado: record.estado,
      propuesta: record.propuestaLlm.decision,
      guardActuo: record.guardActuo,
      modelo: SETTINGS.geminiModel,
      promptVersion: PROMPT_VERSION,
      reglasVersion: rulesVersion(config),
      modoLlm: llm.modo,
    },
  });

  // 7) Ledger: solo los pagos entran (RF-7.1).
  let ledgerEntry: LedgerEntry | null = null;
  if (guard.decisionFinal === 'pagar' && extraccion.extraccion) {
    ledgerEntry = crearEntradaLedger(record, deps, 'agente');
    if (ledgerEntry) repo.insertLedgerEntry(ledgerEntry);
  }

  // RF-14.2: toda decision de pagar deja una orden de pago preparada.
  if (guard.decisionFinal === 'pagar') ensurePaymentOrder(record, config);

  // ═══════════════════════════════════════════════════════════════╗
  log('╔══════════════════════════════════════════════════════════════╗');
  const estadoIcono = record.estado === 'pagado' ? '✅' : record.estado === 'frenado' ? '🚫' : record.estado === 'pendiente_aprobacion' ? '⏳' : '⚠️';
  log(`║ RESULTADO FINAL: ${estadoIcono} ${record.estado.toUpperCase()} ${estadoIcono} ║`);
  log(`║ Factura: ${invoice.id} · ${invoice.archivo}`);
  log(`║ Beneficiario: ${extraccion.extraccion?.beneficiario ?? 'N/A'}`);
  if (extraccion.extraccion?.monto) log(`║ Monto: ${extraccion.extraccion.monto} ${extraccion.extraccion.moneda}`);
  log(`║ Decisión LLM: ${propuesta.decision} (origen: ${propuesta.origen})`);
  log(`║ Decisión final: ${guard.decisionFinal}`);
  log(`║ Explicación (${explicacion.length} chars): ${explicacion.slice(0, 150)}${explicacion.length > 150 ? '...' : ''}`);
  log('╚══════════════════════════════════════════════════════════════╝\n');
  // ═══════════════════════════════════════════════════════════════╝

  return { record, ledgerEntry };
}

function crearEntradaLedger(
  record: DecisionRecord,
  deps: OrchestratorDeps,
  origen: LedgerEntry['origen'],
): LedgerEntry | null {
  const extraccion = record.extraccion;
  if (!extraccion) return null;
  const montoBase = convertToBase(extraccion.monto, extraccion.moneda, deps.config);
  if (montoBase === null) return null;
  return {
    id: randomUUID(),
    invoiceId: record.invoiceId,
    beneficiario: extraccion.beneficiario,
    monto: extraccion.monto,
    moneda: extraccion.moneda,
    montoBase,
    referencia: extraccion.referencia,
    // Fecha de referencia del periodo: mantiene la evaluacion reproducible (RF-3.4).
    fecha: deps.config.fechaReferencia,
    origen,
  };
}

/** Procesa todas las facturas pendientes, en cola y de una en una (RF-1.3). */
export async function processPending(deps: OrchestratorDeps): Promise<ProcessOutcome[]> {
  const pendientes = repo.listInvoices().filter((invoice) => !repo.getDecisionByInvoice(invoice.id));
  
  log('📦 INICIANDO PROCESAMIENTO DE FACTURAS');
  log(`   Facturas pendientes: ${pendientes.length}`);
  log('──────────────────────────────────────────────────────────────');
  
  const resultados: ProcessOutcome[] = [];
  for (const invoice of pendientes) {
    resultados.push(await processInvoice(invoice, deps));
  }
  
  log('──────────────────────────────────────────────────────────────');
  log(`✅ PROCESAMIENTO COMPLETADO: ${resultados.length} facturas procesadas`);
  
  // Resumen rápido
  const pagados = resultados.filter(r => r.record.estado === 'pagado').length;
  const frenados = resultados.filter(r => r.record.estado === 'frenado').length;
  const escalados = resultados.filter(r => r.record.estado === 'pendiente_aprobacion').length;
  if (resultados.length > 0) {
    log(`   📊 Resumen: ${pagados} pagadas, ${frenados} frenadas, ${escalados} escaladas`);
  }
  
  return resultados;
}

export interface HumanDecisionResult {
  ok: boolean;
  error?: string;
  record?: DecisionRecord;
}

/**
 * RF-8.3 / RF-7.3: una persona aprueba o rechaza una factura escalada.
 * Es la UNICA via por la que una escalada puede convertirse en pago, y solo
 * si ninguna regla la bloqueo (RF-5.4).
 */
export function decideHuman(
  invoiceId: string,
  accion: 'aprobar' | 'rechazar',
  quien: string,
  comentario: string,
  deps: OrchestratorDeps,
): HumanDecisionResult {
  const actual = repo.getDecisionByInvoice(invoiceId);
  if (!actual) return { ok: false, error: `No hay decision registrada para ${invoiceId}.` };
  if (actual.estado !== 'pendiente_aprobacion') {
    return { ok: false, error: `La factura ${invoiceId} no esta pendiente de aprobacion.` };
  }

  const timestamp = repo.nowIso();
  const humano = { accion, quien, comentario, fecha: timestamp };
  const toolCalls = actual.toolCalls.map((tc) => ({ tool: tc.tool, resultado: tc.resultado }));

  if (accion === 'rechazar') {
    const descripcion = buildDescription({
      beneficiario: actual.extraccion?.beneficiario ?? null,
      monto: actual.extraccion?.monto ?? null,
      moneda: actual.extraccion?.moneda ?? null,
      referencia: actual.extraccion?.referencia ?? null,
      decision: 'escalar',
      propuesta: actual.propuestaLlm.decision,
      guardActuo: false,
      reglas: actual.reglas,
      inyecciones: actual.verificacion?.inyeccionesDetectadas ?? [],
      rechazoHumano: { quien, comentario },
      toolCalls,
    });

    repo.updateHumanDecision(invoiceId, humano, 'escalar', 'rechazado_humano', descripcion.texto, descripcion);
    repo.removeLedgerEntry(invoiceId);
    repo.setQueueState(invoiceId, 'frenada');

    audit({
      actor: 'persona',
      tipo: 'accion.humana',
      invoiceId,
      detalle: { accion, quien, comentario, antes: actual.estado, despues: 'rechazado_humano' },
    });
    audit({
      actor: 'agente',
      tipo: 'descripcion.generada',
      invoiceId,
      detalle: { origen: 'plantilla', descripcion },
    });
    audit({
      actor: 'sistema',
      tipo: 'factura.estado',
      invoiceId,
      detalle: { estado: 'rechazado_humano', queueState: 'frenada' },
    });
    return { ok: true, record: repo.getDecisionByInvoice(invoiceId) ?? undefined };
  }

  // Aprobacion humana explicita.
  const guard = applyGuard({
    propuesta: actual.propuestaLlm.decision,
    reglas: actual.reglas,
    aprobacionHumana: true,
  });

  if (guard.decisionFinal !== 'pagar') {
    return {
      ok: false,
      error: `No se puede aprobar ${invoiceId}: existe un bloqueo (${guard.bloqueos.join(' ') || 'regla de bloqueo'}).`,
    };
  }

  const descripcion = buildDescription({
    beneficiario: actual.extraccion?.beneficiario ?? null,
    monto: actual.extraccion?.monto ?? null,
    moneda: actual.extraccion?.moneda ?? null,
    referencia: actual.extraccion?.referencia ?? null,
    decision: 'pagar',
    propuesta: actual.propuestaLlm.decision,
    guardActuo: false,
    reglas: actual.reglas,
    aprobacionHumana: true,
    inyecciones: actual.verificacion?.inyeccionesDetectadas ?? [],
    toolCalls,
  });

  repo.updateHumanDecision(invoiceId, humano, 'pagar', 'aprobado_humano', descripcion.texto, descripcion);
  repo.setQueueState(invoiceId, 'pagada');

  const actualizado = repo.getDecisionByInvoice(invoiceId);
  if (actualizado) {
    const entrada = crearEntradaLedger(actualizado, deps, 'humano');
    if (entrada) repo.insertLedgerEntry(entrada);
    ensurePaymentOrder(actualizado, deps.config);
  }

  audit({
    actor: 'persona',
    tipo: 'accion.humana',
    invoiceId,
    detalle: { accion, quien, comentario, antes: actual.estado, despues: 'aprobado_humano' },
  });
  audit({
    actor: 'agente',
    tipo: 'guard.decision',
    invoiceId,
    detalle: {
      propuesta: actual.propuestaLlm.decision,
      decisionFinal: guard.decisionFinal,
      aprobacionHumana: true,
      bloqueos: guard.bloqueos,
    },
  });
  audit({
    actor: 'agente',
    tipo: 'descripcion.generada',
    invoiceId,
    detalle: { origen: 'plantilla', descripcion },
  });
  audit({
    actor: 'sistema',
    tipo: 'factura.estado',
    invoiceId,
    detalle: { estado: 'aprobado_humano', queueState: 'pagada' },
  });

  return { ok: true, record: repo.getDecisionByInvoice(invoiceId) ?? undefined };
}

/**
 * RF-1.10 / CA-6: fallo irrecuperable -> se registra una decision de escalar
 * con la descripcion del fallo. Nunca se deja la factura sin descripcion.
 */
export function recordFailure(
  invoice: InvoiceInput,
  mensaje: string,
  deps: OrchestratorDeps,
): DecisionRecord {
  const reglas = evaluateRules(construirContexto(invoice, deps, null, null));
  const guard = applyGuard({ propuesta: 'escalar', reglas });
  const verificacion = {
    beneficiarioPresente: false,
    montoPresente: false,
    montoAmbiguo: false,
    inyeccionesDetectadas: [],
    ok: false,
    motivos: [mensaje],
  };
  const descripcion = buildDescription({
    beneficiario: null,
    monto: null,
    moneda: null,
    referencia: null,
    decision: guard.decisionFinal,
    propuesta: 'escalar',
    guardActuo: guard.guardActuo,
    reglas,
    verificacion,
    errorFatal: mensaje,
  });
  const timestamp = repo.nowIso();
  const record: DecisionRecord = {
    id: randomUUID(),
    invoiceId: invoice.id,
    archivo: invoice.archivo,
    formato: invoice.formato,
    asunto: invoice.asunto,
    texto: invoice.texto,
    extraccion: null,
    extraccionOk: false,
    verificacion,
    reglas,
    toolCalls: [],
    propuestaLlm: { decision: 'escalar', razones: [`Fallo de procesamiento: ${mensaje}`], origen: 'fallback' },
    decisionFinal: guard.decisionFinal,
    estado: 'pendiente_aprobacion',
    queueState: 'error',
    guardActuo: guard.guardActuo,
    descripcion,
    explicacion: descripcion.texto,
    origenExplicacion: 'plantilla',
    humano: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  repo.insertDecision(record, repo.nextDecisionOrder());
  audit({
    actor: 'sistema',
    tipo: 'error',
    invoiceId: invoice.id,
    detalle: { mensaje, reintentos: repo.getStoredInvoice(invoice.id)?.intentos ?? 0 },
  });
  audit({
    actor: 'agente',
    tipo: 'descripcion.generada',
    invoiceId: invoice.id,
    detalle: { origen: 'plantilla', descripcion },
  });
  audit({
    actor: 'agente',
    tipo: 'decision.registrada',
    invoiceId: invoice.id,
    detalle: {
      decisionFinal: record.decisionFinal,
      estado: record.estado,
      propuesta: record.propuestaLlm.decision,
      fallo: mensaje,
      modelo: SETTINGS.geminiModel,
      promptVersion: PROMPT_VERSION,
      reglasVersion: rulesVersion(deps.config),
      modoLlm: deps.llm.modo,
    },
  });

  return record;
}

/** Presupuesto del periodo: se calcula siempre en codigo (RF-8.4). */
export function estadoPresupuesto(deps: OrchestratorDeps): BudgetStatusTool {
  const periodo = deps.company.periodo.tipo;
  const toolContext: ToolContext = {
    invoice: { id: '', archivo: '', formato: 'texto', asunto: null, remitente: null, texto: '' },
    config: deps.config,
    contratos: deps.contratos,
    ledger: repo.listLedger().filter((e) => samePeriod(e.fecha, deps.config.fechaReferencia, periodo)),
    historial: [],
  };
  return budgetStatus(toolContext);
}
