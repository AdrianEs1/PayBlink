import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, SETTINGS } from '../../config';
import type {
  ExtractResponse,
  LlmClient,
  ProposalInput,
  ProposalResponse,
  ExplainLlmInput,
  ToolLoopInput,
  ToolLoopResult,
} from './types';

function clave(id: string, tipo: string): string {
  return `${tipo}-${id}`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function leer<T>(id: string, tipo: string): T | null {
  const ruta = join(SETTINGS.cacheDir, `${clave(id, tipo)}.json`);
  if (!existsSync(ruta)) return null;
  try {
    return JSON.parse(readFileSync(ruta, 'utf8')) as T;
  } catch {
    return null;
  }
}

function escribir(id: string, tipo: string, valor: unknown): void {
  ensureDir(SETTINGS.cacheDir);
  writeFileSync(join(SETTINGS.cacheDir, `${clave(id, tipo)}.json`), JSON.stringify(valor, null, 2), 'utf8');
}

/**
 * RF-9.3: las respuestas del LLM se cachean por factura.
 * La demo y la evaluacion funcionan con cache frio y no dependen de la API.
 */
export function withPersistentCache(inner: LlmClient): LlmClient {
  return {
    ...inner,
    modo: 'cache',
    descripcion: `${inner.descripcion} + cache en disco`,

    async extract(invoice): Promise<ExtractResponse> {
      const guardado = leer<ExtractResponse>(invoice.id, 'extract');
      if (guardado) return guardado;
      const resultado = await inner.extract(invoice);
      if (resultado.ok) escribir(invoice.id, 'extract', resultado);
      return resultado;
    },

    async propose(input: ProposalInput): Promise<ProposalResponse> {
      const guardado = leer<ProposalResponse>(input.invoice.id, 'propose');
      if (guardado) return guardado;
      const resultado = await inner.propose(input);
      escribir(input.invoice.id, 'propose', resultado);
      return resultado;
    },

    async explain(input: ExplainLlmInput): Promise<string | null> {
      const guardado = leer<{ texto: string | null }>(input.invoice.id, 'explain');
      if (guardado) return guardado.texto;
      const resultado = await inner.explain(input);
      escribir(input.invoice.id, 'explain', { texto: resultado });
      return resultado;
    },

    ...(inner.runToolLoop
      ? {
          async runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
            const fn = inner.runToolLoop;
            if (!fn) {
              return { cerro: false, decision: null, razones: [], agotoPasos: true, error: 'Sin loop.' };
            }
            return fn(input);
          },
        }
      : {}),
  };
}
