/**
 * `core/` es codigo puro y determinista (RNF-3).
 * No importa de agent/, storage/ ni api/; no usa red, ni base de datos, ni LLM.
 */
export * from './types';
export * from './money';
export * from './text';
export * from './period';
export * from './engine';
export * from './guard';
export * from './explain';
export { RULES } from './rules';
