/**
 * RF-9.3 / CA-10: la evaluacion debe ser reproducible y no depender de la API.
 * Este modulo se importa ANTES que `server/src/config` para que `SETTINGS` se
 * construya ya en modo offline. Usa `EVAL_LIVE=1` para evaluar contra Gemini.
 */
if (process.env.EVAL_LIVE === '1') {
  process.env.LLM_MODE = process.env.LLM_MODE ?? 'gemini';
} else {
  process.env.LLM_MODE = 'fixture';
}
