import { createLlmClient } from './llm';
import type { OrchestratorDeps } from './orchestrator';
import * as repo from '../storage/repositories';

/**
 * Las dependencias se reconstruyen en cada uso para que un cambio de reglas
 * en la pantalla se refleje de inmediato (CA-8).
 */
export function buildDeps(): OrchestratorDeps | null {
  const config = repo.getRulesConfig();
  const company = repo.getCompany();
  if (!config || !company) return null;
  return {
    llm: createLlmClient(),
    config,
    contratos: repo.getContracts(),
    company,
  };
}
