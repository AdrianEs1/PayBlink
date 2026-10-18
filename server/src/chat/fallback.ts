import type { ChatProposalDraft, ChatProposalType } from '@payblink/shared';
import { formatMoney, round2 } from '../core/money';
import { samePeriod } from '../core/period';
import { normalizeKey, similarity } from '../core/text';
import * as repo from '../storage/repositories';
import type { ChatToolContext } from './tools';

export interface FallbackResult {
  texto: string;
  propuestas: ChatProposalDraft[];
}

const ID_FACTURA = /\b(?:INV|SIM|PDF|MAIL|CHAT)-[A-Za-z0-9-]+\b/;

function sinAcentos(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function montoColombiano(texto: string): number | null {
  const match = /(\d[\d.,]*)/.exec(texto);
  if (!match) return null;
  const crudo = match[1] ?? '';
  const normalizado = crudo.replace(/\./g, '').replace(/,/g, '.');
  const valor = Number(normalizado);
  return Number.isFinite(valor) && valor > 0 ? valor : null;
}

function propuestaAprobar(facturaId: string): ChatProposalDraft {
  return {
    tipo: 'aprobar',
    facturaId,
    titulo: `Aprobar ${facturaId}`,
    descripcion:
      'El chat no puede aprobar por sí mismo. Si confirmas, la aprobación se registra como decisión humana con quién y cuándo.',
    payload: {},
  };
}

function propuestaRechazar(facturaId: string): ChatProposalDraft {
  return {
    tipo: 'rechazar',
    facturaId,
    titulo: `Rechazar ${facturaId}`,
    descripcion:
      'El chat no puede rechazar por sí mismo. Si confirmas, el rechazo se registra como decisión humana con quién y cuándo.',
    payload: {},
  };
}

function resumenDecision(facturaId: string): string | null {
  const record = repo.getDecisionByInvoice(facturaId);
  if (!record) return null;
  const noPasan = record.reglas.filter((r) => r.resultado !== 'pasa');
  const motivos = noPasan.map((r) => `${r.id} ${r.nombre}: ${r.motivo}`).join(' ');
  return (
    `La factura ${record.invoiceId} de ${record.extraccion?.beneficiario ?? 'un beneficiario no identificado'}` +
    `${record.extraccion ? ` por ${formatMoney(record.extraccion.monto, record.extraccion.moneda)}` : ''} ` +
    `quedó en **${record.estado}** (decisión final: ${record.decisionFinal}). ` +
    (motivos ? `Motivos: ${motivos} ` : 'Todas las reglas pasaron. ') +
    record.descripcion.siguientePaso
  );
}

function pendientes(): string {
  const lista = repo.listDecisions().filter((d) => d.estado === 'pendiente_aprobacion');
  if (lista.length === 0) return 'No hay facturas pendientes de aprobación humana ahora mismo.';
  return `Hay ${lista.length} factura(s) pendiente(s) de aprobación:\n${lista
    .map(
      (d) =>
        `- ${d.invoiceId}: ${d.extraccion?.beneficiario ?? 'sin beneficiario'}${
          d.extraccion ? ` · ${formatMoney(d.extraccion.monto, d.extraccion.moneda)}` : ''
        } · ${d.reglas.filter((r) => r.resultado !== 'pasa').map((r) => r.id).join(', ') || 'sin reglas activadas'}`,
    )
    .join('\n')}\n\nPuedes aprobar o rechazar desde Aprobaciones o desde la notificación simulada.`;
}

function presupuesto(ctx: ChatToolContext): string {
  const ledger = repo
    .listLedger()
    .filter((e) => samePeriod(e.fecha, ctx.config.fechaReferencia, ctx.company.periodo.tipo));
  const comprometido = round2(ledger.reduce((total, e) => total + e.montoBase, 0));
  const disponible = round2(ctx.config.presupuestoPeriodo - comprometido);
  const pct = round2((comprometido / ctx.config.presupuestoPeriodo) * 100);
  return `El presupuesto del periodo (fecha de referencia ${ctx.config.fechaReferencia}) tiene ${formatMoney(
    ctx.config.presupuestoPeriodo,
    ctx.config.monedaBase,
  )}. Llevamos comprometidos ${formatMoney(comprometido, ctx.config.monedaBase)} (${pct}%) y quedan ${formatMoney(
    disponible,
    ctx.config.monedaBase,
  )} disponibles. El límite por periodo es ${formatMoney(ctx.config.limitePorPeriodo, ctx.config.monedaBase)}.`;
}

function duplicados(facturaId: string | null): string {
  const base = facturaId ? repo.getDecisionByInvoice(facturaId) : null;
  if (!base?.extraccion) return 'Necesito una factura con datos extraídos para buscar duplicados.';
  const beneficiario = normalizeKey(base.extraccion.beneficiario);
  const referencia = normalizeKey(base.extraccion.referencia);
  const coincidencias = repo
    .listPriorDecisions()
    .filter((h) => h.invoiceId !== base.invoiceId)
    .filter(
      (h) =>
        normalizeKey(h.beneficiario) === beneficiario &&
        Math.abs(h.monto - base.extraccion!.monto) < 0.005 &&
        (normalizeKey(h.referencia) === referencia ||
          similarity(normalizeKey(h.referencia), referencia) >= 0.75),
    );
  if (coincidencias.length === 0) return `No encontré cobros previos coincidentes con ${base.invoiceId}.`;
  return `Encontré ${coincidencias.length} cobro(s) previo(s) coincidente(s) con ${base.invoiceId}: ${coincidencias
    .map((c) => `${c.invoiceId} (${c.decision}, ${c.estado})`)
    .join(', ')}.`;
}

/**
 * RF-10 / CA-11 / CA-12: respaldo sin red. Usa los mismos datos que las tools
 * de lectura y devuelve propuestas que EXIGEN confirmacion humana.
 */
export function responderDeterministico(mensaje: string, ctx: ChatToolContext): FallbackResult {
  const texto = sinAcentos(mensaje);
  const idEnMensaje = ID_FACTURA.exec(mensaje.toUpperCase())?.[0] ?? null;
  const facturaId = idEnMensaje ?? ctx.invoiceId;
  const record = facturaId ? repo.getDecisionByInvoice(facturaId) : null;

  // 1) Intencion de aprobar o rechazar: NUNCA se ejecuta, solo se propone.
  if (/\b(aprueba|aprobar|aprobaria|dale luz verde|autoriza)\b/.test(texto)) {
    if (!facturaId || !record) {
      return {
        texto: 'Puedo preparar una propuesta de aprobación, pero necesito saber de qué factura hablas. Dime el ID (por ejemplo INV-016) o abre el detalle de la factura.',
        propuestas: [],
      };
    }
    if (record.estado !== 'pendiente_aprobacion') {
      return {
        texto: `No puedo proponer aprobar ${facturaId}: su estado actual es ${record.estado}. Solo las facturas escaladas se pueden aprobar.`,
        propuestas: [],
      };
    }
    return {
      texto: `No puedo aprobar ${facturaId} desde el chat: el chat solo consulta y propone. Dejé una tarjeta de propuesta; una persona debe pulsar Confirmar para que quede registrada la aprobación con su identidad y la fecha.`,
      propuestas: [propuestaAprobar(facturaId)],
    };
  }

  if (/\b(rechaza|rechazar|rechazaria|niega)\b/.test(texto)) {
    if (!facturaId || !record) {
      return {
        texto: 'Puedo preparar una propuesta de rechazo, pero necesito el ID de la factura.',
        propuestas: [],
      };
    }
    if (record.estado !== 'pendiente_aprobacion') {
      return {
        texto: `No puedo proponer rechazar ${facturaId}: su estado actual es ${record.estado}.`,
        propuestas: [],
      };
    }
    return {
      texto: `No puedo rechazar ${facturaId} desde el chat. Dejé una tarjeta de propuesta; se ejecutará solo si una persona pulsa Confirmar, y quedará registrada como decisión humana.`,
      propuestas: [propuestaRechazar(facturaId)],
    };
  }

  // 2) Agregar beneficiario (cambio de regla, requiere confirmacion).
  if (/(agrega|agregar|anade|incluye).*(beneficiari[oa])/.test(texto)) {
    const capturado = /beneficiari[oa]\s+(.+)$/i.exec(mensaje)?.[1]?.trim() ?? '';
    // El punto final de la frase no forma parte del nombre (pero "S.A.S." si).
    const original = /\.$/.test(capturado) && !/(s\.a\.s|sas|s\.a|s\.l|ltda|inc|corp)\.$/i.test(capturado)
      ? capturado.slice(0, -1).trim()
      : capturado;
    if (!original) {
      return { texto: 'Dime el nombre exacto del beneficiario que quieres agregar a la lista permitida.', propuestas: [] };
    }
    const yaEsta = ctx.config.beneficiariosPermitidos.some((b) => normalizeKey(b) === normalizeKey(original));
    if (yaEsta) {
      return { texto: `${original} ya está en la lista de beneficiarios permitidos. No hay nada que cambiar.`, propuestas: [] };
    }
    const propuesta: ChatProposalDraft = {
      tipo: 'agregar_beneficiario',
      facturaId: facturaId ?? null,
      titulo: `Agregar beneficiario: ${original}`,
      descripcion:
        'Agregar un beneficiario cambia las reglas de la empresa. Si se confirma, la factura se reevalúa con el motor; el chat no puede modificar reglas por sí solo.',
      payload: { nombre: original, facturaId: facturaId ?? null },
    };
    return {
      texto: `Puedo proponer agregar **${original}** a la lista permitida, pero eso modifica las reglas y debe confirmarlo una persona. Si se confirma, la factura se reevalúa con el motor: el chat no altera el veredicto.`,
      propuestas: [propuesta],
    };
  }

  // 3) Ajustar un limite (cambio de regla, requiere confirmacion).
  if (/(ajusta|cambia|sube|baja|modifica).*(limite|umbral|presupuesto)/.test(texto)) {
    const valor = montoColombiano(texto.replace(/limite|umbral|presupuesto/g, ''));
    const campo = /por pago/.test(texto)
      ? 'limitePorPago'
      : /umbral|aprobacion/.test(texto)
        ? 'umbralAprobacionHumana'
        : /presupuesto/.test(texto)
          ? 'presupuestoPeriodo'
          : 'limitePorPeriodo';
    if (!valor) {
      return { texto: 'Dime el nuevo valor numérico del límite que quieres ajustar.', propuestas: [] };
    }
    const propuesta: ChatProposalDraft = {
      tipo: 'ajustar_limite',
      facturaId: facturaId ?? null,
      titulo: `Ajustar ${campo} a ${valor}`,
      descripcion:
        'Cambiar un límite modifica las reglas de la empresa. Si se confirma, la factura se reevalúa con el motor y queda registro del cambio (antes y después).',
      payload: { campo, valor, facturaId: facturaId ?? null },
    };
    return {
      texto: `Puedo proponer cambiar **${campo}** a **${valor}**, pero es un cambio de reglas y requiere confirmación humana. Si se confirma, la factura se reevalúa con el motor.`,
      propuestas: [propuesta],
    };
  }

  // 4) Consultas sobre una factura concreta.
  if (record && /(por que|porque|motivo|explica|que paso|decision)/.test(texto)) {
    return { texto: resumenDecision(record.invoiceId) ?? 'No encontré esa factura.', propuestas: [] };
  }

  if (record && /(duplicad|cobro repetido)/.test(texto)) {
    return { texto: duplicados(record.invoiceId), propuestas: [] };
  }

  if (record && /(aprueba|aprobar|rechaza|rechazar)/.test(texto) === false && /(estado|como va|que necesita)/.test(texto)) {
    return { texto: resumenDecision(record.invoiceId) ?? 'No encontré esa factura.', propuestas: [] };
  }

  // 5) Consultas generales.
  if (/(pendiente|escalad|aprobar)/.test(texto)) {
    return { texto: pendientes(), propuestas: [] };
  }

  if (/(presupuesto|gastado|gastamos|saldo|disponible|cuanto llevamos)/.test(texto)) {
    return { texto: presupuesto(ctx), propuestas: [] };
  }

  if (/(reglas|limites|limite|beneficiarios permitidos|umbral)/.test(texto)) {
    return {
      texto:
        `Las reglas vigentes: límite por pago ${formatMoney(ctx.config.limitePorPago, ctx.config.monedaBase)}, ` +
        `límite por periodo ${formatMoney(ctx.config.limitePorPeriodo, ctx.config.monedaBase)}, ` +
        `presupuesto ${formatMoney(ctx.config.presupuestoPeriodo, ctx.config.monedaBase)} y umbral de aprobación humana ` +
        `${formatMoney(ctx.config.umbralAprobacionHumana, ctx.config.monedaBase)}. Hay ` +
        `${ctx.config.beneficiariosPermitidos.length} beneficiarios permitidos. Puedes editarlas en la pantalla Reglas.`,
      propuestas: [],
    };
  }

  if (/(hola|buenos dias|buenas tardes|buenas noches|hey)/.test(texto)) {
    return {
      texto: `Hola. Soy el agente de pagos de ${ctx.company.nombre}. Puedo explicarte decisiones, consultar pendientes y el presupuesto, y proponer acciones (que una persona debe confirmar). No puedo ejecutar pagos ni cambiar reglas por mi cuenta.`,
      propuestas: [],
    };
  }

  if (record) {
    return { texto: resumenDecision(record.invoiceId) ?? 'No encontré esa factura.', propuestas: [] };
  }

  if (idEnMensaje) {
    return {
      texto: `No encontré una decisión registrada para ${idEnMensaje}. Puede estar pendiente de procesar; revisa la pantalla Facturas o Entradas.`,
      propuestas: [],
    };
  }

  if (ctx.invoiceId) {
    return {
      texto: `Estoy en el hilo de ${ctx.invoiceId}. Puedo explicar por qué se decidió, buscar duplicados o proponer aprobar/rechazar. Para consultas generales, usa el chat general.`,
      propuestas: [],
    };
  }

  return {
    texto:
      'Puedo ayudarte con: por qué se decidió una factura ("¿por qué escalaste INV-016?"), cuánto llevamos gastado, qué facturas están pendientes, o proponer una acción (aprobar, rechazar, agregar beneficiario, ajustar un límite). Las propuestas solo se ejecutan cuando una persona pulsa Confirmar. Si tu pregunta es de otra área, revisa la pantalla correspondiente del menú.',
    propuestas: [],
  };
}
