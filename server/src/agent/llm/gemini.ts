import type { ChatProposalDraft, Decision, ToolCall, Company, RulesConfig, Contract } from '@payblink/shared';
import { SETTINGS } from '../../config';
import type { InvoiceInput } from '../../core/types';
import {
  buildDecisionPrompt,
  buildExplainPrompt,
  buildExtractionPrompt,
  buildChatPrompt,
  SYSTEM_CHAT,
  SYSTEM_DECISION,
  SYSTEM_EXPLICACION,
  SYSTEM_EXTRACCION,
} from '../prompt';
import { executeTool, TOOL_DE_CIERRE, TOOL_DECLARATIONS } from '../tools';
import type {
  ExtractResponse,
  ChatContext,
  ExplainLlmInput,
  LlmClient,
  ChatLoopInput,
  ChatLoopResult,
  ProposalInput,
  ProposalResponse,
  ToolLoopInput,
  ToolLoopResult,
} from './types';

const TIMEOUT_MS = 25_000;

/** RF-4.5: cualquier fallo de red o de formato se convierte en un error controlado. */
async function conTimeout<T>(promesa: Promise<T>, etiqueta: string, ms = TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promesa,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${etiqueta}: excedio ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Esquema de la extraccion (RF-2.1: responseSchema + validacion Zod aguas abajo). */
const EXTRACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    beneficiario: { type: 'STRING', nullable: true },
    monto: { type: 'NUMBER', nullable: true },
    moneda: { type: 'STRING', nullable: true, enum: ['COP', 'USD', 'EUR'] },
    fechaVencimiento: { type: 'STRING', nullable: true },
    referencia: { type: 'STRING', nullable: true },
    concepto: { type: 'STRING', nullable: true },
    confianza: { type: 'NUMBER', nullable: true },
  },
  required: ['beneficiario', 'monto', 'moneda', 'fechaVencimiento', 'referencia', 'concepto', 'confianza'],
} as const;

const PROPOSAL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    decision: { type: 'STRING', enum: ['pagar', 'escalar', 'frenar'] },
    razones: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['decision', 'razones'],
} as const;

interface GoogleGenAiModule {
  GoogleGenAI?: new (opciones: { apiKey: string }) => unknown;
}

/** Import dinamico: si el SDK no esta instalado, el resto del sistema sigue funcionando. */
async function crearCliente(): Promise<any> {
  if (!SETTINGS.geminiApiKey) throw new Error('Falta GEMINI_API_KEY en el entorno.');
  const mod = (await import('@google/genai')) as unknown as GoogleGenAiModule;
  if (!mod.GoogleGenAI) throw new Error('El paquete @google/genai no expone GoogleGenAI.');
  return new mod.GoogleGenAI({ apiKey: SETTINGS.geminiApiKey });
}

function textoDeRespuesta(respuesta: any): string | null {
  const directo = respuesta?.text;
  if (typeof directo === 'string') return directo;
  if (typeof directo === 'function') {
    try {
      const valor = directo.call(respuesta);
      if (typeof valor === 'string') return valor;
    } catch {
      /* sigue con las partes */
    }
  }
  const parts = respuesta?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const unido = parts
      .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
      .join('')
      .trim();
    if (unido.length > 0) return unido;
  }
  return null;
}

function llamadasDeRespuesta(respuesta: any): Array<{ name: string; args: Record<string, unknown> }> {
  const resultado: Array<{ name: string; args: Record<string, unknown> }> = [];

  const directas = respuesta?.functionCalls;
  if (Array.isArray(directas)) {
    for (const llamada of directas) {
      if (llamada && typeof llamada.name === 'string') {
        resultado.push({ name: llamada.name, args: (llamada.args ?? {}) as Record<string, unknown> });
      }
    }
    if (resultado.length > 0) return resultado;
  }

  const parts = respuesta?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    for (const parte of parts) {
      const llamada = parte?.functionCall;
      if (llamada && typeof llamada.name === 'string') {
        resultado.push({ name: llamada.name, args: (llamada.args ?? {}) as Record<string, unknown> });
      }
    }
  }
  return resultado;
}

/** Los modelos a veces envuelven el JSON en ```json ... ```. */
function parsearJson(texto: string): unknown {
  const limpio = texto
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(limpio) as unknown;
  } catch {
    const inicio = limpio.indexOf('{');
    const fin = limpio.lastIndexOf('}');
    if (inicio >= 0 && fin > inicio) {
      try {
        return JSON.parse(limpio.slice(inicio, fin + 1)) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function esDecision(valor: unknown): valor is Decision {
  return valor === 'pagar' || valor === 'escalar' || valor === 'frenar';
}

export function createGeminiClient(): LlmClient {
  return {
    modo: 'gemini',
    descripcion: `Gemini (${SETTINGS.geminiModel})`,

    async extract(invoice: InvoiceInput): Promise<ExtractResponse> {
      try {
        const ai = await crearCliente();
        const respuesta = await conTimeout<any>(
          ai.models.generateContent({
            model: SETTINGS.geminiModel,
            contents: buildExtractionPrompt(invoice),
            config: {
              systemInstruction: SYSTEM_EXTRACCION,
              temperature: 0,
              responseMimeType: 'application/json',
              responseSchema: EXTRACTION_SCHEMA,
            },
          }),
          'extraccion',
        );
        const texto = textoDeRespuesta(respuesta);
        if (!texto) return { ok: false, error: 'Gemini devolvio una respuesta vacia.' };
        const json = parsearJson(texto);
        if (json === null) return { ok: false, error: 'Gemini devolvio un JSON invalido.' };
        return { ok: true, raw: json };
      } catch (error) {
        return { ok: false, error: mensajeDeError(error) };
      }
    },

    async propose(input: ProposalInput): Promise<ProposalResponse> {
      try {
        const ai = await crearCliente();
        const respuesta = await conTimeout<any>(
          ai.models.generateContent({
            model: SETTINGS.geminiModel,
            contents: buildDecisionPrompt(input.invoice, input.reglas),
            config: {
              systemInstruction: SYSTEM_DECISION,
              temperature: 0,
              responseMimeType: 'application/json',
              responseSchema: PROPOSAL_SCHEMA,
            },
          }),
          'propuesta',
        );
        const texto = textoDeRespuesta(respuesta);
        const json = texto ? parsearJson(texto) : null;
        const objeto = (json ?? {}) as { decision?: unknown; razones?: unknown };
        const decision = objeto.decision;
        if (!esDecision(decision)) {
          return { decision: 'escalar', razones: ['El modelo no devolvio una decision valida.'] };
        }
        const razones = Array.isArray(objeto.razones)
          ? objeto.razones.filter((r): r is string => typeof r === 'string')
          : [];
        return { decision, razones };
      } catch (error) {
        // RF-4.5: si el modelo falla, la propuesta mas segura es escalar.
        return { decision: 'escalar', razones: [`Fallo el modelo: ${mensajeDeError(error)}`] };
      }
    },

    async explain(input: ExplainLlmInput): Promise<string | null> {
      try {
        const ai = await crearCliente();
        const respuesta = await conTimeout<any>(
          ai.models.generateContent({
            model: SETTINGS.geminiModel,
            contents: buildExplainPrompt(input.invoice, input.reglas, input.decisionFinal),
            config: { systemInstruction: SYSTEM_EXPLICACION, temperature: 0.2 },
          }),
          'explicacion',
        );
        const texto = textoDeRespuesta(respuesta);
        return texto && texto.trim().length > 0 ? texto.trim() : null;
      } catch {
        return null; // el orquestador usa la plantilla de core/explain.ts
      }
    },

    /** RF-4.1: loop con tools declaradas por functionDeclarations y cierre con submit_decision. */
    async runToolLoop({ invoice, prompt, toolContext, maxSteps, traza }: ToolLoopInput): Promise<ToolLoopResult> {
      try {
        const ai = await crearCliente();
        const contents: any[] = [{ role: 'user', parts: [{ text: prompt }] }];

        for (let paso = 0; paso < maxSteps; paso += 1) {
          const respuesta = await conTimeout<any>(
            ai.models.generateContent({
              model: SETTINGS.geminiModel,
              contents,
              config: {
                systemInstruction: SYSTEM_DECISION,
                temperature: 0,
                tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
              },
            }),
            `loop paso ${paso + 1}`,
          );

          const llamadas = llamadasDeRespuesta(respuesta);
          if (llamadas.length === 0) {
            return {
              cerro: false,
              decision: null,
              razones: ['El modelo no cerro con submit_decision.'],
              agotoPasos: true,
            };
          }

          const respuestas: any[] = [];
          const contenidoModelo = respuesta?.candidates?.[0]?.content ?? { role: 'model', parts: [] };

          for (const llamada of llamadas) {
            if (llamada.name === TOOL_DE_CIERRE) {
              const decision = llamada.args.decision;
              const razones = Array.isArray(llamada.args.razones)
                ? (llamada.args.razones as unknown[]).filter((r): r is string => typeof r === 'string')
                : [];
              traza.push({
                paso: paso + 1,
                tool: TOOL_DE_CIERRE,
                args: llamada.args,
                resultado: esDecision(decision)
                  ? `Propuesta: ${decision}`
                  : 'Propuesta invalida (no es pagar/escalar/frenar).',
              });
              return {
                cerro: true,
                decision: esDecision(decision) ? decision : null,
                razones,
                agotoPasos: false,
              };
            }

            const ejecucion = executeTool(llamada.name, llamada.args, toolContext);
            traza.push({
              paso: paso + 1,
              tool: llamada.name,
              args: llamada.args,
              resultado: ejecucion.resumen,
            });
            respuestas.push({
              functionResponse: { name: llamada.name, response: ejecucion.contenido },
            });
          }

          contents.push(contenidoModelo);
          contents.push({ role: 'user', parts: respuestas });
        }

        // RF-4.4: se agoto MAX_STEPS -> escalar.
        return {
          cerro: false,
          decision: null,
          razones: [`El agente no cerro dentro de MAX_STEPS (${maxSteps}).`],
          agotoPasos: true,
        };
      } catch (error) {
        return {
          cerro: false,
          decision: null,
          razones: [`Fallo el loop del agente: ${mensajeDeError(error)}`],
          agotoPasos: true,
          error: mensajeDeError(error),
        };
      }
    },

    /** RF-10.2: chat con tools de lectura. Nunca ejecuta acciones. */
    async runChatLoop({ prompt, tools, maxSteps, ejecutar }: ChatLoopInput): Promise<ChatLoopResult> {
      const ai = await crearCliente();
      const contents: any[] = [{ role: 'user', parts: [{ text: prompt }] }];
      const propuestas: ChatProposalDraft[] = [];
      let ultimoTexto = '';

      for (let paso = 0; paso < maxSteps; paso += 1) {
        const respuesta = await conTimeout<any>(
          ai.models.generateContent({
            model: SETTINGS.geminiModel,
            contents,
            config: {
              systemInstruction: SYSTEM_CHAT,
              temperature: 0.2,
              tools: [{ functionDeclarations: tools }],
            },
          }),
          `chat paso ${paso + 1}`,
        );

        const llamadas = llamadasDeRespuesta(respuesta);
        if (llamadas.length === 0) {
          const texto = textoDeRespuesta(respuesta);
          if (texto) ultimoTexto = texto;
          break;
        }

        const contenidoModelo = respuesta?.candidates?.[0]?.content ?? { role: 'model', parts: [] };
        const respuestas: any[] = [];
        for (const llamada of llamadas) {
          const resultado = ejecutar(llamada.name, llamada.args);
          if (resultado.propuesta) propuestas.push(resultado.propuesta);
          respuestas.push({
            functionResponse: { name: llamada.name, response: resultado.contenido },
          });
        }
        contents.push(contenidoModelo);
        contents.push({ role: 'user', parts: respuestas });

        // Si ya hay una propuesta, no hace falta seguir consultando tools.
        if (propuestas.length > 0) {
          const cierre = await conTimeout<any>(
            ai.models.generateContent({
              model: SETTINGS.geminiModel,
              contents,
              config: { systemInstruction: SYSTEM_CHAT, temperature: 0.2 },
            }),
            'chat cierre',
          );
          const texto = textoDeRespuesta(cierre);
          if (texto) ultimoTexto = texto;
          break;
        }
      }

      if (!ultimoTexto) {
        ultimoTexto =
          propuestas.length > 0
            ? 'Preparé una propuesta. Debe confirmarla una persona en la interfaz; el chat no puede ejecutarla.'
            : 'No pude completar la respuesta con los datos disponibles. Te sugiero revisar la pantalla de Facturas o Auditoría.';
      }

      return { texto: ultimoTexto, propuestas };
    },

    /** Chat con el agente: responde preguntas sobre sus decisiones y el sistema. */
    async responderChat(input: ChatContext): Promise<string> {
      try {
        const ai = await crearCliente();
        const respuesta = await conTimeout<any>(
          ai.models.generateContent({
            model: SETTINGS.geminiModel,
            contents: buildChatPrompt(input),
            config: { systemInstruction: SYSTEM_CHAT, temperature: 0.7 },
          }),
          'chat',
        );
        const texto = textoDeRespuesta(respuesta);
        return texto && texto.trim().length > 0 ? texto.trim() : 'No pude generar una respuesta. Intenta de nuevo.';
      } catch (error) {
        return `Lo siento, ocurrio un error al procesar tu pregunta: ${mensajeDeError(error)}`;
      }
    },
  };
}

export function mensajeDeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Reexportado para el orquestador (usa el mismo prompt que el loop). */
export { buildDecisionPrompt };
