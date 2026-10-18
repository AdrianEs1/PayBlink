import type { Contract, LedgerEntry, Moneda, RulesConfig } from '@blinka/shared';
import { formatMoney, round2 } from '../core/money';
import { normalizeKey, similarity } from '../core/text';
import type { InvoiceInput, PriorDecision } from '../core/types';
import { beneficiaryRecord } from '../payments/beneficiaries';

/**
 * RF-4.2: herramientas de SOLO LECTURA.
 * Ninguna puede escribir, pagar ni modificar el ledger.
 */
export interface ToolContext {
  invoice: InvoiceInput;
  config: RulesConfig;
  contratos: readonly Contract[];
  ledger: readonly LedgerEntry[];
  historial: readonly PriorDecision[];
}

export interface ToolExecution {
  /** Resultado serializado que se devuelve al modelo. */
  contenido: Record<string, unknown>;
  /** Version corta para la traza de auditoria. */
  resumen: string;
}

/** Declaraciones de funcion en el formato que espera Gemini (RF-4.1). */
export const TOOL_DECLARATIONS = [
  {
    name: 'get_invoice_text',
    description: 'Devuelve el texto original de la factura que se esta evaluando.',
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'lookup_beneficiary',
    description: 'Indica si un beneficiario esta en la lista autorizada por la empresa.',
    parameters: {
      type: 'OBJECT',
      properties: {
        beneficiario: { type: 'STRING', description: 'Nombre del beneficiario a consultar.' },
      },
      required: ['beneficiario'],
    },
  },
  {
    name: 'find_duplicates',
    description: 'Busca cobros previos con el mismo beneficiario, monto o referencia.',
    parameters: {
      type: 'OBJECT',
      properties: {
        beneficiario: { type: 'STRING' },
        monto: { type: 'NUMBER' },
        referencia: { type: 'STRING' },
      },
      required: ['beneficiario'],
    },
  },
  {
    name: 'get_contract_terms',
    description: 'Devuelve el contrato u orden de compra asociado a una referencia.',
    parameters: {
      type: 'OBJECT',
      properties: { referencia: { type: 'STRING' } },
      required: ['referencia'],
    },
  },
  {
    name: 'get_budget_status',
    description: 'Devuelve el presupuesto del periodo, lo comprometido y el saldo disponible.',
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'submit_decision',
    description:
      'Cierra el analisis con una propuesta. No ejecuta ningun pago: pasa por el guard de seguridad.',
    parameters: {
      type: 'OBJECT',
      properties: {
        decision: { type: 'STRING', description: 'pagar | escalar | frenar' },
        razones: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Motivos concretos de la propuesta.',
        },
      },
      required: ['decision', 'razones'],
    },
  },
] as const;

export const TOOL_NAMES = TOOL_DECLARATIONS.map((t) => t.name);
export const TOOL_DE_CIERRE = 'submit_decision';

export interface BudgetStatusTool {
  monedaBase: Moneda;
  presupuestoPeriodo: number;
  comprometido: number;
  disponible: number;
  utilizadoPct: number;
  limitePorPeriodo: number;
  pagosEnPeriodo: number;
  fechaReferencia: string;
}

/** Estado del presupuesto del periodo: siempre calculado en codigo (RF-8.4). */
export function budgetStatus(ctx: ToolContext): BudgetStatusTool {
  const comprometido = round2(ctx.ledger.reduce((total, entry) => total + entry.montoBase, 0));
  const presupuesto = ctx.config.presupuestoPeriodo;
  return {
    monedaBase: ctx.config.monedaBase,
    presupuestoPeriodo: presupuesto,
    comprometido,
    disponible: round2(presupuesto - comprometido),
    utilizadoPct: presupuesto > 0 ? round2((comprometido / presupuesto) * 100) : 0,
    limitePorPeriodo: ctx.config.limitePorPeriodo,
    pagosEnPeriodo: ctx.ledger.length,
    fechaReferencia: ctx.config.fechaReferencia,
  };
}

/** Ejecuta una tool de lectura. `submit_decision` se maneja en el orquestador. */
export function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): ToolExecution {
  switch (name) {
    case 'get_invoice_text':
      return {
        contenido: { texto: ctx.invoice.texto, formato: ctx.invoice.formato, archivo: ctx.invoice.archivo },
        resumen: `Texto de ${ctx.invoice.archivo} (${ctx.invoice.texto.length} caracteres).`,
      };

    case 'lookup_beneficiary': {
      const beneficiario = String(args.beneficiario ?? '');
      const permitido = ctx.config.beneficiariosPermitidos.some(
        (b) => normalizeKey(b) === normalizeKey(beneficiario),
      );
      const ficha = beneficiaryRecord(beneficiario);
      return {
        contenido: {
          beneficiario,
          permitido,
          totalPermitidos: ctx.config.beneficiariosPermitidos.length,
          pais: ficha.pais,
          monedaPreferida: ficha.monedaPreferida,
          bancoFicticio: ficha.bancoFicticio,
          cuentaFicticia: ficha.cuentaFicticia,
        },
        resumen: `${beneficiario}: ${permitido ? 'autorizado' : 'NO autorizado'} · ${ficha.pais} · cuenta ficticia ${ficha.cuentaFicticia}.`,
      };
    }

    case 'find_duplicates': {
      const beneficiario = normalizeKey(String(args.beneficiario ?? ''));
      const referencia = normalizeKey(String(args.referencia ?? ''));
      const monto = typeof args.monto === 'number' ? args.monto : null;

      const coincidencias = ctx.historial
        .filter((h) => h.estado !== 'rechazado_humano')
        .filter((h) => {
          const mismoBeneficiario = normalizeKey(h.beneficiario) === beneficiario;
          if (!mismoBeneficiario) return false;
          const mismoMonto = monto === null ? true : Math.abs(h.monto - monto) < 0.005;
          const mismaReferencia = referencia.length > 0 && normalizeKey(h.referencia) === referencia;
          const referenciaParecida =
            referencia.length > 0 && similarity(normalizeKey(h.referencia), referencia) >= 0.75;
          return (mismoMonto && mismaReferencia) || (mismoMonto && referenciaParecida);
        })
        .map((h) => ({
          invoiceId: h.invoiceId,
          referencia: h.referencia,
          monto: h.monto,
          moneda: h.moneda,
          decision: h.decision,
          estado: h.estado,
        }));

      return {
        contenido: { coincidencias, total: coincidencias.length },
        resumen:
          coincidencias.length === 0
            ? 'Sin cobros previos coincidentes.'
            : `${coincidencias.length} cobro(s) previo(s) coincidente(s): ${coincidencias
                .map((c) => c.invoiceId)
                .join(', ')}.`,
      };
    }

    case 'get_contract_terms': {
      const referencia = normalizeKey(String(args.referencia ?? ''));
      const contrato = ctx.contratos.find((c) => normalizeKey(c.referencia) === referencia);
      if (!contrato) {
        return {
          contenido: { encontrado: false, referencia: String(args.referencia ?? '') },
          resumen: 'No hay contrato ni orden de compra con esa referencia.',
        };
      }
      return {
        contenido: {
          encontrado: true,
          referencia: contrato.referencia,
          beneficiario: contrato.beneficiario,
          montoAcordado: contrato.montoAcordado,
          moneda: contrato.moneda,
          concepto: contrato.concepto,
          fecha: contrato.fecha,
        },
        resumen: `Contrato ${contrato.referencia}: ${formatMoney(contrato.montoAcordado, contrato.moneda)} con ${contrato.beneficiario}.`,
      };
    }

    case 'get_budget_status': {
      const status = budgetStatus(ctx);
      return {
        contenido: { ...status } as Record<string, unknown>,
        resumen: `Presupuesto ${status.presupuestoPeriodo} ${status.monedaBase}, comprometido ${status.comprometido}, disponible ${status.disponible}.`,
      };
    }

    default:
      return {
        contenido: { error: `Herramienta desconocida: ${name}` },
        resumen: `Herramienta desconocida: ${name}.`,
      };
  }
}
