import type { ChatMessage, ChatProposalDraft } from '@blinka/shared';
import { buildDeps } from '../agent/deps';
import { decideHuman } from '../agent/orchestrator';
import { log as audit } from '../audit/audit';
import { enqueueInvoice } from '../jobs/queue';
import { respondFromNotification } from '../notifications/service';
import * as repo from '../storage/repositories';
import { responderDeterministico } from './fallback';
import { buildChatAgentPrompt } from './prompt';
import { CHAT_TOOL_DECLARATIONS, executeChatTool, type ChatToolContext } from './tools';

function contextoChat(threadId: string): ChatToolContext | null {
  const deps = buildDeps();
  if (!deps) return null;
  const invoiceId = repo.getStoredInvoice(threadId) ? threadId : null;
  return {
    threadId,
    invoiceId,
    config: deps.config,
    company: deps.company,
    contratos: deps.contratos,
  };
}

function dedupePropuestas(lista: readonly ChatProposalDraft[]): ChatProposalDraft[] {
  const vistos = new Set<string>();
  const salida: ChatProposalDraft[] = [];
  for (const propuesta of lista) {
    // Clave tolerante a diferencias de puntuacion entre la respuesta del LLM y la determinista.
    const payload = JSON.stringify(propuesta.payload).toLowerCase().replace(/[^a-z0-9]/g, '');
    const clave = `${propuesta.tipo}|${propuesta.facturaId ?? ''}|${payload}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push(propuesta);
  }
  return salida;
}

/**
 * RF-10.1 / RF-10.9: el chat solo consulta y propone.
 * Los mensajes se guardan en el hilo y forman parte de la auditoria.
 */
export async function sendChatMessage(
  threadId: string,
  mensaje: string,
  autor = 'Persona',
): Promise<ChatMessage> {
  const ctx = contextoChat(threadId);
  if (!ctx) throw new Error('La base de datos no esta inicializada.');

  repo.appendChatMessage(threadId, 'persona', mensaje);
  audit({
    actor: 'chat',
    tipo: 'chat.mensaje',
    invoiceId: ctx.invoiceId,
    detalle: { hilo: threadId, rol: 'persona', autor, contenido: mensaje },
  });

  // El respaldo determinista garantiza una respuesta con datos reales aunque
  // Gemini no responda (RNF-4 / CA-10).
  const respaldo = responderDeterministico(mensaje, ctx);
  let texto = respaldo.texto;
  let propuestas = respaldo.propuestas;

  const deps = buildDeps();
  if (deps?.llm.runChatLoop) {
    try {
      const resultado = await deps.llm.runChatLoop({
        prompt: buildChatAgentPrompt(mensaje, ctx),
        tools: CHAT_TOOL_DECLARATIONS,
        maxSteps: 4,
        ejecutar: (name, args) => executeChatTool(name, args, ctx),
      });
      if (resultado.texto.trim().length > 0) texto = resultado.texto.trim();
      propuestas = dedupePropuestas([...respaldo.propuestas, ...resultado.propuestas]);
    } catch (error) {
      audit({
        actor: 'chat',
        tipo: 'error',
        invoiceId: ctx.invoiceId,
        detalle: { contexto: 'chat', mensaje: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  const propuestasFinales = dedupePropuestas(propuestas);
  const mensajeAgente = repo.appendChatMessage(threadId, 'agente', texto, propuestasFinales);
  audit({
    actor: 'agente',
    tipo: 'chat.mensaje',
    invoiceId: ctx.invoiceId,
    detalle: { hilo: threadId, rol: 'agente', contenido: texto },
  });
  for (const propuesta of mensajeAgente.propuestas) {
    audit({
      actor: 'agente',
      tipo: 'chat.propuesta',
      invoiceId: ctx.invoiceId,
      detalle: { propuestaId: propuesta.id, tipo: propuesta.tipo, facturaId: propuesta.facturaId, payload: propuesta.payload },
    });
  }

  return mensajeAgente;
}

export function getChatThread(threadId: string): ChatMessage[] {
  return repo.listChatMessages(threadId);
}

/**
 * RF-10.4 / RF-10.5 / CA-13: una propuesta se ejecuta SOLO cuando una persona
 * pulsa Confirmar. La accion pasa por los endpoints normales y queda auditada.
 */
export function confirmChatProposal(
  proposalId: string,
  quien: string,
): { ok: boolean; error?: string; proposal?: ReturnType<typeof repo.confirmChatProposal>; record?: unknown } {
  const deps = buildDeps();
  if (!deps) return { ok: false, error: 'La base de datos no esta inicializada.' };

  const propuesta = repo.getChatProposal(proposalId);
  if (!propuesta) return { ok: false, error: 'No existe la propuesta.' };
  if (propuesta.estado !== 'pendiente') {
    return { ok: false, error: `La propuesta ya esta ${propuesta.estado}.` };
  }

  const identidad = quien.trim() || deps.company.responsable;

  if (propuesta.tipo === 'aprobar' || propuesta.tipo === 'rechazar') {
    if (!propuesta.facturaId) return { ok: false, error: 'La propuesta no indica la factura.' };
    const accion = propuesta.tipo;
    const notificacion = repo.getNotificationByInvoice(propuesta.facturaId);
    const resultado =
      notificacion && notificacion.estado !== 'respondido'
        ? respondFromNotification(notificacion.id, accion, identidad, 'Confirmado desde el chat.', deps).result
        : decideHuman(propuesta.facturaId, accion, identidad, 'Confirmado desde el chat.', deps);

    if (!resultado.ok) return { ok: false, error: resultado.error ?? 'No se pudo ejecutar la propuesta.' };

    const confirmada = repo.confirmChatProposal(proposalId, identidad);
    repo.appendChatMessage(
      propuesta.threadId,
      'sistema',
      `Propuesta confirmada por ${identidad}: ${accion} ${propuesta.facturaId}. Quedó registrada en la auditoría.`,
    );
    audit({
      actor: 'persona',
      tipo: 'chat.confirmacion',
      invoiceId: propuesta.facturaId,
      detalle: { propuestaId: proposalId, tipo: accion, quien: identidad },
    });
    return { ok: true, proposal: confirmada, record: resultado.record };
  }

  let reevaluar: string | null = null;

  if (propuesta.tipo === 'agregar_beneficiario') {
    const nombre = String(propuesta.payload.nombre ?? '').trim();
    if (!nombre) return { ok: false, error: 'La propuesta no tiene el nombre del beneficiario.' };
    if (deps.config.beneficiariosPermitidos.includes(nombre)) {
      return { ok: false, error: `${nombre} ya está en la lista permitida.` };
    }
    const antes = deps.config;
    const despues = { ...antes, beneficiariosPermitidos: [...antes.beneficiariosPermitidos, nombre] };
    repo.saveRulesConfig(despues);
    audit({
      actor: 'persona',
      tipo: 'reglas.cambiadas',
      invoiceId: propuesta.facturaId,
      detalle: {
        quien: identidad,
        cambio: 'agregar_beneficiario',
        antes: antes.beneficiariosPermitidos,
        despues: despues.beneficiariosPermitidos,
      },
    });
    reevaluar = propuesta.facturaId;
  } else if (propuesta.tipo === 'ajustar_limite') {
    const campo = String(propuesta.payload.campo ?? '');
    const valor = Number(propuesta.payload.valor);
    const campos = ['limitePorPago', 'limitePorPeriodo', 'presupuestoPeriodo', 'umbralAprobacionHumana'] as const;
    if (!(campos as readonly string[]).includes(campo) || !Number.isFinite(valor) || valor <= 0) {
      return { ok: false, error: 'El ajuste de límite no es válido.' };
    }
    const antes = deps.config;
    const despues = { ...antes, [campo]: valor } as typeof antes;
    repo.saveRulesConfig(despues);
    audit({
      actor: 'persona',
      tipo: 'reglas.cambiadas',
      invoiceId: propuesta.facturaId,
      detalle: { quien: identidad, cambio: campo, antes: (antes as unknown as Record<string, unknown>)[campo], despues: valor },
    });
    reevaluar = propuesta.facturaId;
  }

  const confirmada = repo.confirmChatProposal(proposalId, identidad);
  repo.appendChatMessage(
    propuesta.threadId,
    'sistema',
    `Propuesta confirmada por ${identidad}: ${propuesta.titulo}. Los cambios quedaron registrados en la auditoría.`,
  );
  audit({
    actor: 'persona',
    tipo: 'chat.confirmacion',
    invoiceId: propuesta.facturaId,
    detalle: { propuestaId: proposalId, tipo: propuesta.tipo, quien: identidad },
  });

  if (reevaluar) reevaluarFactura(reevaluar);

  return { ok: true, proposal: confirmada };
}

/** RF-10.5: una accion confirmada que cambia reglas obliga a reevaluar con el motor. */
export function reevaluarFactura(invoiceId: string): boolean {
  const record = repo.getDecisionByInvoice(invoiceId);
  if (!record) return false;
  // No se revierten pagos ya registrados: solo se reevalua lo que sigue abierto.
  if (record.estado !== 'pendiente_aprobacion') return false;

  repo.deleteDecisionByInvoice(invoiceId);
  repo.removeLedgerEntry(invoiceId);
  repo.setQueueState(invoiceId, 'pendiente', { error: null });

  audit({
    actor: 'sistema',
    tipo: 'factura.estado',
    invoiceId,
    detalle: { motivo: 'Reevaluacion tras una propuesta confirmada', queueState: 'pendiente' },
  });

  return enqueueInvoice(invoiceId);
}
