/**
 * Tipos y esquemas compartidos entre server, web y eval.
 *
 * Este paquete NO tiene dependencias del resto del proyecto: solo Zod.
 * Es la fuente de verdad de las formas de datos que viajan por la API.
 */
export * from './decision';
export * from './invoice';
export * from './rules';
export * from './company';
export * from './agent';
export * from './audit';
export * from './ingestion';
export * from './payments';
export * from './notifications';
export * from './chat';
export * from './connectors';
export * from './api';
