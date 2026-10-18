import { z } from 'zod';
import { BeneficiarySchema, type Beneficiary } from '@blinka/shared';
import { PATHS, readJson } from '../config';

/** RF-14.1: ficha ficticia del beneficiario. No contiene datos reales. */
let cache: Beneficiary[] | null = null;

function directorio(): Beneficiary[] {
  if (cache) return cache;
  try {
    cache = z.array(BeneficiarySchema).parse(readJson<unknown>(`${PATHS.data}/beneficiaries.json`));
  } catch {
    cache = [];
  }
  return cache;
}

function normalizar(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function findBeneficiary(nombre: string): Beneficiary | null {
  const buscado = normalizar(nombre);
  return directorio().find((b) => normalizar(b.nombre) === buscado) ?? null;
}

/** Ficha generica para un beneficiario que no esta en el directorio ficticio. */
export function genericBeneficiary(nombre: string): Beneficiary {
  return {
    nombre,
    pais: 'Colombia',
    monedaPreferida: 'COP',
    bancoFicticio: 'Banco Ficticio Andino',
    cuentaFicticia: 'CO00-0000-0000-0000',
  };
}

export function beneficiaryRecord(nombre: string): Beneficiary {
  return findBeneficiary(nombre) ?? genericBeneficiary(nombre);
}
