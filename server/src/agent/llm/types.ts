import type {
  Decision,
  ExtractionCheck,
  InvoiceExtraction,
  RuleResult,
  ToolCall,
  Company,
  RulesConfig,
  Contract,
  ChatProposalDraft,
} from '@blinka/shared';
import type { InvoiceInput } from '../../core/types';
import type { ToolContext } from '../tools';

export type ExtractResponse = { ok: true; raw: unknown } | { ok: false; error: string };

export interface ChatContext {
  mensaje: string;
  context?: {
    facturaId?: string;
    decisionId?: string;
  };
  config: RulesConfig;
  company: Company;
  contratos: readonly Contract[];
}

export interface ProposalInput {
  invoice: InvoiceInput;
  extraccion: InvoiceExtraction | null;
  verificacion: ExtractionCheck;
  reglas: readonly RuleResult[];
  toolCalls: readonly ToolCall[];
}

export interface ProposalResponse {
  decision: Decision;
  razones: string[];
}

export interface ExplainLlmInput {
  invoice: InvoiceInput;
  reglas: readonly RuleResult[];
  decisionFinal: Decision;
}

export interface ToolLoopInput {
  invoice: InvoiceInput;
  /** Prompt de decision ya construido por el orquestador. */
  prompt: string;
  toolContext: ToolContext;
  maxSteps: number;
  /** Traza de tools, para el registro de auditoria (RF-6). */
  traza: ToolCall[];
}

export interface ToolLoopResult {
  /** true si el modelo cerro con submit_decision. */
  cerro: boolean;
  decision: Decision | null;
  razones: string[];
  /** true si se agoto MAX_STEPS o hubo un error (RF-4.4, RF-4.5). */
  agotoPasos: boolean;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Chat con tools de lectura (RF-10.2)                                 */
/* ------------------------------------------------------------------ */

export interface ChatToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatToolResult {
  contenido: Record<string, unknown>;
  resumen: string;
  /** Solo para `propose_action`: nunca ejecuta nada por si mismo. */
  propuesta?: ChatProposalDraft;
}

export interface ChatLoopInput {
  prompt: string;
  tools: readonly ChatToolDeclaration[];
  maxSteps: number;
  ejecutar: (name: string, args: Record<string, unknown>) => ChatToolResult;
}

export interface ChatLoopResult {
  texto: string;
  propuestas: ChatProposalDraft[];
}

export interface LlmClient {
  readonly modo: 'gemini' | 'fixture' | 'mock' | 'cache';
  readonly descripcion: string;
  /** RF-2.1: extraccion estructurada. Nunca lanza: devuelve { ok: false }. */
  extract(invoice: InvoiceInput): Promise<ExtractResponse>;
  /** RF-4: propuesta de decision. Nunca lanza. */
  propose(input: ProposalInput): Promise<ProposalResponse>;
  /** RF-6: explicacion en lenguaje natural. `null` significa "usa la plantilla". */
  explain(input: ExplainLlmInput): Promise<string | null>;
  /** RF-4.1: loop con function calling. Solo el cliente real de Gemini lo implementa. */
  runToolLoop?(input: ToolLoopInput): Promise<ToolLoopResult>;
  /** Chat simple (compatibilidad): responde preguntas sobre sus decisiones y el sistema. */
  responderChat(input: ChatContext): Promise<string>;
  /** RF-10.2: chat con tools de solo lectura y propuestas que requieren confirmacion. */
  runChatLoop?(input: ChatLoopInput): Promise<ChatLoopResult>;
}
