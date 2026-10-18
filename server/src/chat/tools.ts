import {
  type ChatProposalDraft,
  type ChatProposalType,
  type Company,
  type Contract,
  type RulesConfig,
} from '@payblink/shared';
import type { ChatToolDeclaration, ChatToolResult } from '../agent/llm/types';
import { formatMoney, round2 } from '../core/money';
import { samePeriod } from '../core/period';
import { normalizeKey, similarity } from '../core/text';
import * as repo from '../storage/repositories';

export interface ChatToolContext {
  threadId: string;
  invoiceId: string | null;
  config: RulesConfig;
  company: Company;
  contratos: readonly Contract[];
}

/** RF-10.2: tools de SOLO LECTURA. `propose_action` solo crea una tarjeta. */
export const CHAT_TOOL_DECLARATIONS: readonly ChatToolDeclaration[] = [
  {
    name: 'get_decision',
    description: 'Devuelve la decision registrada de una factura, sus reglas y su descripcion.',
    parameters: {
      type: 'OBJECT',
      properties: { facturaId: { type: 'STRING', description: 'ID de la factura, por ejemplo INV-016.' } },
      required: [],
    },
  },
  {
    name: 'list_invoices',
    description: 'Lista las facturas con su estado y decision final.',
    parameters: {
      type: 'OBJECT',
      properties: { limite: { type: 'NUMBER', description: 'Cuantas facturas devolver (maximo 15).' } },
    },
  },
  {
    name: 'list_pending',
    description: 'Lista las facturas escaladas pendientes de aprobacion humana.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'get_rules',
    description: 'Devuelve las reglas vigentes: limites, umbral, presupuesto, tasas y beneficiarios.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'get_contract_terms',
    description: 'Busca un contrato u orden de compra por referencia o beneficiario.',
    parameters: {
      type: 'OBJECT',
      properties: { referencia: { type: 'STRING' }, beneficiario: { type: 'STRING' } },
    },
  },
  {
    name: 'find_duplicates',
    description: 'Busca cobros previos coincidentes por beneficiario, monto o referencia.',
    parameters: {
      type: 'OBJECT',
      properties: {
        facturaId: { type: 'STRING' },
        beneficiario: { type: 'STRING' },
        monto: { type: 'NUMBER' },
        referencia: { type: 'STRING' },
      },
    },
  },
  {
    name: 'get_budget_status',
    description: 'Devuelve presupuesto del periodo, comprometido, disponible y uso del limite.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'propose_action',
    description:
      'Propone una accion para que una persona la confirme en la UI. NO ejecuta nada y NO cambia datos.',
    parameters: {
      type: 'OBJECT',
      properties: {
        tipo: {
          type: 'STRING',
          enum: ['aprobar', 'rechazar', 'agregar_beneficiario', 'ajustar_limite'],
        },
        facturaId: { type: 'STRING' },
        nombreBeneficiario: { type: 'STRING' },
        campo: {
          type: 'STRING',
          enum: ['limitePorPago', 'limitePorPeriodo', 'presupuestoPeriodo', 'umbralAprobacionHumana'],
        },
        valor: { type: 'NUMBER' },
        explicacion: { type: 'STRING' },
      },
      required: ['tipo'],
    },
  },
];

function decisionResumen(invoiceId: string): ChatToolResult {
  const record = repo.getDecisionByInvoice(invoiceId);
  if (!record) {
    return {
      contenido: { encontrada: false, facturaId: invoiceId },
      resumen: `No hay decision registrada para ${invoiceId}.`,
    };
  }
  const noPasan = record.reglas.filter((r) => r.resultado !== 'pasa');
  return {
    contenido: {
      encontrada: true,
      facturaId: record.invoiceId,
      decisionFinal: record.decisionFinal,
      estado: record.estado,
      beneficiario: record.extraccion?.beneficiario ?? null,
      monto: record.extraccion?.monto ?? null,
      moneda: record.extraccion?.moneda ?? null,
      resumen: record.descripcion.resumen,
      siguientePaso: record.descripcion.siguientePaso,
      reglasNoPasan: noPasan.map((r) => ({ id: r.id, nombre: r.nombre, resultado: r.resultado, motivo: r.motivo })),
      humano: record.humano,
    },
    resumen: `${record.invoiceId}: ${record.decisionFinal} (${record.estado})${
      noPasan.length > 0 ? ` por ${noPasan.map((r) => r.id).join(', ')}` : ''
    }.`,
  };
}

function listaPendientes(): ChatToolResult {
  const pendientes = repo.listDecisions().filter((d) => d.estado === 'pendiente_aprobacion');
  return {
    contenido: {
      total: pendientes.length,
      facturas: pendientes.map((d) => ({
        facturaId: d.invoiceId,
        beneficiario: d.extraccion?.beneficiario ?? null,
        monto: d.extraccion?.monto ?? null,
        moneda: d.extraccion?.moneda ?? null,
        motivo: d.reglas.filter((r) => r.resultado !== 'pasa').map((r) => `${r.id} ${r.motivo}`),
      })),
    },
    resumen:
      pendientes.length === 0
        ? 'No hay facturas pendientes de aprobacion.'
        : `${pendientes.length} factura(s) pendiente(s): ${pendientes.map((d) => d.invoiceId).join(', ')}.`,
  };
}

function estadoPresupuesto(ctx: ChatToolContext): ChatToolResult {
  const ledger = repo
    .listLedger()
    .filter((e) => samePeriod(e.fecha, ctx.config.fechaReferencia, ctx.company.periodo.tipo));
  const comprometido = round2(ledger.reduce((total, e) => total + e.montoBase, 0));
  const disponible = round2(ctx.config.presupuestoPeriodo - comprometido);
  return {
    contenido: {
      monedaBase: ctx.config.monedaBase,
      presupuestoPeriodo: ctx.config.presupuestoPeriodo,
      comprometido,
      disponible,
      utilizadoPct: round2((comprometido / ctx.config.presupuestoPeriodo) * 100),
      limitePorPeriodo: ctx.config.limitePorPeriodo,
      pagosEnPeriodo: ledger.length,
      fechaReferencia: ctx.config.fechaReferencia,
    },
    resumen: `Presupuesto ${ctx.config.presupuestoPeriodo} ${ctx.config.monedaBase}; comprometido ${comprometido}; disponible ${disponible}.`,
  };
}

function validarPropuesta(
  args: Record<string, unknown>,
  ctx: ChatToolContext,
): { ok: true; propuesta: ChatProposalDraft } | { ok: false; error: string } {
  const tipo = String(args.tipo ?? '') as ChatProposalType;
  const facturaId =
    typeof args.facturaId === 'string' && args.facturaId.trim()
      ? args.facturaId.trim()
      : ctx.invoiceId;
  const explicacion = typeof args.explicacion === 'string' ? args.explicacion.trim() : '';

  if (tipo === 'aprobar' || tipo === 'rechazar') {
    if (!facturaId) return { ok: false, error: 'Indica la factura sobre la que quieres proponer la accion.' };
    const record = repo.getDecisionByInvoice(facturaId);
    if (!record) return { ok: false, error: `No existe una decision para ${facturaId}.` };
    if (record.estado !== 'pendiente_aprobacion') {
      return { ok: false, error: `La factura ${facturaId} no esta pendiente de aprobacion (estado: ${record.estado}).` };
    }
    return {
      ok: true,
      propuesta: {
        tipo,
        facturaId,
        titulo: `${tipo === 'aprobar' ? 'Aprobar' : 'Rechazar'} ${facturaId}`,
        descripcion:
          explicacion ||
          `Esta accion se ejecutara solo si una persona pulsa Confirmar. Queda registrada con quien y cuando.`,
        payload: {},
      },
    };
  }

  if (tipo === 'agregar_beneficiario') {
    const nombre = typeof args.nombreBeneficiario === 'string' ? args.nombreBeneficiario.trim() : '';
    if (!nombre) return { ok: false, error: 'Indica el nombre del beneficiario a agregar.' };
    if (ctx.config.beneficiariosPermitidos.some((b) => normalizeKey(b) === normalizeKey(nombre))) {
      return { ok: false, error: `${nombre} ya esta en la lista de beneficiarios permitidos.` };
    }
    return {
      ok: true,
      propuesta: {
        tipo,
        facturaId: facturaId ?? null,
        titulo: `Agregar beneficiario: ${nombre}`,
        descripcion:
          explicacion ||
          `Agregar ${nombre} a la lista permitida cambia las reglas. Si se confirma, la factura se reevalua con el motor.`,
        payload: { nombre, facturaId: facturaId ?? null },
      },
    };
  }

  if (tipo === 'ajustar_limite') {
    const campo = String(args.campo ?? '');
    const campos = ['limitePorPago', 'limitePorPeriodo', 'presupuestoPeriodo', 'umbralAprobacionHumana'];
    if (!campos.includes(campo)) return { ok: false, error: 'Indica que limite quieres ajustar.' };
    const valor = typeof args.valor === 'number' ? args.valor : Number(args.valor);
    if (!Number.isFinite(valor) || valor <= 0) return { ok: false, error: 'El nuevo limite debe ser un numero positivo.' };
    return {
      ok: true,
      propuesta: {
        tipo,
        facturaId: facturaId ?? null,
        titulo: `Ajustar ${campo} a ${valor}`,
        descripcion:
          explicacion ||
          `Cambiar ${campo} modifica las reglas de la empresa. Si se confirma, la factura se reevalua con el motor.`,
        payload: { campo, valor, facturaId: facturaId ?? null },
      },
    };
  }

  return { ok: false, error: `Tipo de propuesta no soportado: ${tipo}` };
}

/** Ejecuta una tool del chat. Nunca escribe decisiones ni pagos. */
export function executeChatTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ChatToolContext,
): ChatToolResult {
  switch (name) {
    case 'get_decision': {
      const id = typeof args.facturaId === 'string' && args.facturaId.trim() ? args.facturaId.trim() : ctx.invoiceId;
      if (!id) return { contenido: { error: 'Falta facturaId.' }, resumen: 'Falta la factura a consultar.' };
      return decisionResumen(id);
    }

    case 'list_invoices': {
      const limite = Math.min(Math.max(Number(args.limite) || 10, 1), 15);
      const decisiones = repo.listDecisions().slice(0, limite);
      return {
        contenido: {
          total: decisiones.length,
          facturas: decisiones.map((d) => ({
            facturaId: d.invoiceId,
            beneficiario: d.extraccion?.beneficiario ?? null,
            monto: d.extraccion?.monto ?? null,
            moneda: d.extraccion?.moneda ?? null,
            decisionFinal: d.decisionFinal,
            estado: d.estado,
          })),
        },
        resumen: `${decisiones.length} factura(s) consultada(s).`,
      };
    }

    case 'list_pending':
      return listaPendientes();

    case 'get_rules': {
      return {
        contenido: {
          fechaReferencia: ctx.config.fechaReferencia,
          monedaBase: ctx.config.monedaBase,
          tasas: ctx.config.tasas,
          limitePorPago: ctx.config.limitePorPago,
          limitePorPeriodo: ctx.config.limitePorPeriodo,
          presupuestoPeriodo: ctx.config.presupuestoPeriodo,
          umbralAprobacionHumana: ctx.config.umbralAprobacionHumana,
          confianzaMinima: ctx.config.confianzaMinima,
          exigirContrato: ctx.config.exigirContrato,
          beneficiariosPermitidos: ctx.config.beneficiariosPermitidos,
        },
        resumen: `Limite por pago ${ctx.config.limitePorPago}; umbral humano ${ctx.config.umbralAprobacionHumana}; presupuesto ${ctx.config.presupuestoPeriodo} ${ctx.config.monedaBase}.`,
      };
    }

    case 'get_contract_terms': {
      const referencia = normalizeKey(String(args.referencia ?? ''));
      const beneficiario = normalizeKey(String(args.beneficiario ?? ''));
      const contrato = ctx.contratos.find(
        (c) =>
          (referencia && normalizeKey(c.referencia) === referencia) ||
          (beneficiario && normalizeKey(c.beneficiario) === beneficiario),
      );
      if (!contrato) {
        return { contenido: { encontrado: false }, resumen: 'No hay contrato u orden de compra coincidente.' };
      }
      return {
        contenido: { encontrado: true, ...contrato },
        resumen: `Contrato ${contrato.referencia}: ${formatMoney(contrato.montoAcordado, contrato.moneda)} con ${contrato.beneficiario}.`,
      };
    }

    case 'find_duplicates': {
      const facturaId = typeof args.facturaId === 'string' ? args.facturaId : ctx.invoiceId;
      const base = facturaId ? repo.getDecisionByInvoice(facturaId) : null;
      const beneficiario = normalizeKey(String(args.beneficiario ?? base?.extraccion?.beneficiario ?? ''));
      const referencia = normalizeKey(String(args.referencia ?? base?.extraccion?.referencia ?? ''));
      const monto =
        typeof args.monto === 'number'
          ? args.monto
          : typeof base?.extraccion?.monto === 'number'
            ? base.extraccion.monto
            : null;

      const coincidencias = repo
        .listPriorDecisions()
        .filter((h) => h.invoiceId !== facturaId)
        .filter((h) => {
          if (!beneficiario || normalizeKey(h.beneficiario) !== beneficiario) return false;
          const mismoMonto = monto === null || Math.abs(h.monto - monto) < 0.005;
          if (!mismoMonto) return false;
          if (!referencia) return true;
          return normalizeKey(h.referencia) === referencia || similarity(normalizeKey(h.referencia), referencia) >= 0.75;
        })
        .map((h) => ({
          facturaId: h.invoiceId,
          referencia: h.referencia,
          monto: h.monto,
          moneda: h.moneda,
          decision: h.decision,
          estado: h.estado,
        }));

      return {
        contenido: { total: coincidencias.length, coincidencias },
        resumen:
          coincidencias.length === 0
            ? 'No hay cobros previos coincidentes.'
            : `${coincidencias.length} cobro(s) coincidente(s): ${coincidencias.map((c) => c.facturaId).join(', ')}.`,
      };
    }

    case 'get_budget_status':
      return estadoPresupuesto(ctx);

    case 'propose_action': {
      const validacion = validarPropuesta(args, ctx);
      if (!validacion.ok) {
        return { contenido: { ok: false, error: validacion.error }, resumen: validacion.error };
      }
      return {
        contenido: { ok: true, propuesta: validacion.propuesta, nota: 'Requiere confirmacion humana en la UI.' },
        resumen: `Propuesta creada (${validacion.propuesta.tipo}); no se ejecuto nada.`,
        propuesta: validacion.propuesta,
      };
    }

    default:
      return {
        contenido: { error: `Herramienta desconocida: ${name}` },
        resumen: `Herramienta desconocida: ${name}.`,
      };
  }
}
