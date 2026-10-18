import { z } from 'zod';
import { ApproverSchema, type Approver } from '@payblink/shared';
import { PATHS, readJson } from '../config';

let cache: Approver[] | null = null;

export function listApprovers(): Approver[] {
  if (cache) return cache;
  try {
    cache = z.array(ApproverSchema).parse(readJson<unknown>(`${PATHS.data}/approvers.json`));
  } catch {
    cache = [];
  }
  return cache;
}

/**
 * RF-12.3: si hay varios aprobadores, se elige por monto.
 * Se prefiere el aprobador con el limite mas ajustado que alcance para el pago;
 * si ninguno alcanza, se usa el de mayor alcance (o el primero).
 */
export function chooseApprover(montoBase: number): Approver | null {
  const aprobadores = listApprovers();
  if (aprobadores.length === 0) return null;

  const alcanzan = aprobadores
    .filter((a) => a.montoMaximo !== null && a.montoMaximo >= montoBase)
    .sort((a, b) => (a.montoMaximo ?? 0) - (b.montoMaximo ?? 0));
  if (alcanzan.length > 0) return alcanzan[0] ?? null;

  const sinLimite = aprobadores.find((a) => a.montoMaximo === null);
  return sinLimite ?? aprobadores[aprobadores.length - 1] ?? null;
}
