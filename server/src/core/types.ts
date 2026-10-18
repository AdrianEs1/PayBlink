/**
 * Contratos internos del motor de reglas.
 * `core/` no importa de agent/, storage/ ni api/ (reglas de dependencia, seccion 8).
 */
import type {
  Contract,
  Decision,
  Estado,
  ExtractionCheck,
  InvoiceExtraction,
  InvoiceFormato,
  LedgerEntry,
  RuleOutcome,
  RulesConfig,
} from '@blinka/shared';

/** Factura cruda tal como entra al motor. */
export interface InvoiceInput {
  id: string;
  archivo: string;
  formato: InvoiceFormato;
  asunto: string | null;
  remitente: string | null;
  texto: string;
}

/** Decision previa ya registrada, insumo de la regla de duplicados. */
export interface PriorDecision {
  invoiceId: string;
  beneficiario: string;
  monto: number;
  moneda: string;
  referencia: string;
  decision: Decision;
  estado: Estado;
  origen: 'agente' | 'humano';
}

/** Todo lo que una regla puede leer. Nada mas: las reglas son funciones puras. */
export interface RuleContext {
  invoice: InvoiceInput;
  extraccion: InvoiceExtraction | null;
  verificacion: ExtractionCheck | null;
  config: RulesConfig;
  contratos: readonly Contract[];
  /** Pagos efectivamente registrados en el periodo relevante. */
  ledger: readonly LedgerEntry[];
  /** Decisiones previas del periodo (incluye pendientes y aprobadas por humano). */
  historial: readonly PriorDecision[];
}

/** Resultado de una regla individual. */
export interface RuleEvaluation {
  /** true = la condicion de la regla se cumple, no hay nada que reportar. */
  ok: boolean;
  motivo: string;
  /** Fuerza un resultado distinto a la severidad configurada (p. ej. casi-duplicado). */
  forzar?: RuleOutcome;
  detalle?: Record<string, unknown>;
}

export type Rule = (ctx: RuleContext) => RuleEvaluation;
