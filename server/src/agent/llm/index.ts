import { effectiveLlmMode, SETTINGS } from '../../config';
import { withPersistentCache } from './cache';
import { createFixtureClient } from './fixtures';
import { createGeminiClient } from './gemini';
import type { LlmClient } from './types';

/**
 * Crea el cliente del LLM segun `LLM_MODE` (RNF-4):
 *  - gemini  -> Gemini real, con cache en disco (RF-9.3)
 *  - auto    -> Gemini si hay GEMINI_API_KEY; si no, simulado
 *  - fixture -> respuestas simuladas locales (sin red)
 *  - mock    -> alias de fixture
 *  - cache   -> cache en disco; si falta entrada, delega
 */
export function createLlmClient(): LlmClient {
  const modo = effectiveLlmMode();
  if (modo === 'gemini' || (modo === 'cache' && SETTINGS.geminiApiKey)) {
    return withPersistentCache(createGeminiClient());
  }
  return createFixtureClient();
}

export type { LlmClient } from './types';
export { createFixtureClient } from './fixtures';
export { createGeminiClient } from './gemini';
