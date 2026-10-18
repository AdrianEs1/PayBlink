import { config as loadEnv } from 'dotenv';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** Raiz del repositorio (server/src -> ../..). */
export const ROOT = resolve(here, '..', '..');

loadEnv({ path: resolve(ROOT, '.env') });

export type LlmMode = 'auto' | 'gemini' | 'mock' | 'fixture' | 'cache';
export type AgentStrategy = 'pipeline' | 'loop';

function env(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function flag(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

export const PATHS = {
  root: ROOT,
  data: resolve(ROOT, 'data'),
  invoices: resolve(ROOT, 'data', 'invoices'),
  pdfSources: resolve(ROOT, 'data', 'invoices', 'pdf'),
  company: resolve(ROOT, 'data', 'company.json'),
  rules: resolve(ROOT, 'data', 'rules.json'),
  contracts: resolve(ROOT, 'data', 'contracts.json'),
  fixtures: resolve(ROOT, 'data', 'llm-fixtures.json'),
  // BLINKA_DB_PATH permite aislar la base (los tests usan una propia para no
  // chocar con el servidor de desarrollo, que mantiene el archivo abierto).
  db: resolve(ROOT, env('BLINKA_DB_PATH', 'data/blinka.sqlite')),
  webDist: resolve(ROOT, 'web', 'dist'),
  expected: resolve(ROOT, 'eval', 'expected.json'),
};

/** Réplica en Turso (opcional): se activa solo con credenciales completas. */
export const TURSO = {
  url: env('TURSO_DATABASE_URL'),
  authToken: env('TURSO_AUTH_TOKEN'),
  /** `TURSO_SYNC=0` desactiva la replicación sin borrar credenciales. */
  sync: flag('TURSO_SYNC', true),
  /** Cadencia del espejo en segundo plano (ms). */
  intervaloMs: Math.max(1000, Number(env('TURSO_SYNC_INTERVAL_MS', '5000')) || 5000),
  /** Espera máxima al crear esquema/restaurar al arrancar: nunca bloquea el servidor. */
  timeoutMs: Math.max(1000, Number(env('TURSO_TIMEOUT_MS', '8000')) || 8000),
};

export const SETTINGS = {
  port: Number(env('PORT', '3000')) || 3000,
  geminiApiKey: env('GEMINI_API_KEY'),
  geminiModel: env('GEMINI_MODEL', 'gemini-3.5-flash-lite'),
  llmMode: (env('LLM_MODE', 'auto') || 'auto') as LlmMode,
  agentStrategy: (env('AGENT_STRATEGY', 'pipeline') || 'pipeline') as AgentStrategy,
  maxSteps: Number(env('MAX_STEPS', '6')) || 6,
  offlineFirst: flag('OFFLINE_FIRST', true),
  cacheDir: resolve(ROOT, env('LLM_CACHE_DIR', 'eval/cache')),
};

/** Modo efectivo del LLM: resuelve `auto` segun la disponibilidad de la API key. */
export function effectiveLlmMode(): 'gemini' | 'fixture' | 'mock' | 'cache' {
  const mode = SETTINGS.llmMode;
  if (mode === 'auto') return SETTINGS.geminiApiKey ? 'gemini' : 'fixture';
  if (mode === 'gemini' && !SETTINGS.geminiApiKey) return 'fixture';
  return mode;
}

/** El motor de reglas nunca depende del LLM; esto solo se usa para el registro. */
export function llmModeLabel(): string {
  const mode = effectiveLlmMode();
  const labels: Record<string, string> = {
    gemini: `Gemini (${SETTINGS.geminiModel})`,
    fixture: 'Simulado (fixtures locales, sin red)',
    mock: 'Simulado (respuestas fijas)',
    cache: 'Cache en disco',
  };
  return labels[mode] ?? mode;
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Lee y parsea un JSON del repositorio, con un error legible si falta. */
export function readJson<T>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(`No se encontro el archivo requerido: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
