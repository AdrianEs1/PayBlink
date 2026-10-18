import { existsSync } from 'node:fs';
import { PATHS, readJson } from '../../config';
import type { ExtractResponse, LlmClient, ProposalInput, ProposalResponse, ChatContext } from './types';
import type { InvoiceInput } from '../../core/types';

interface FixtureEntry {
  extraccion?: unknown;
  propuesta?: { decision?: string; razones?: unknown };
}

type Fixtures = Record<string, FixtureEntry>;

let cacheFixtures: Fixtures | null = null;

function fixtures(): Fixtures {
  if (cacheFixtures) return cacheFixtures;
  if (!existsSync(PATHS.fixtures)) {
    cacheFixtures = {};
    return cacheFixtures;
  }
  const raw = readJson<Fixtures>(PATHS.fixtures);
  const limpio: Fixtures = {};
  for (const [clave, valor] of Object.entries(raw)) {
    if (clave.startsWith('_')) continue;
    if (valor && typeof valor === 'object') limpio[clave] = valor;
  }
  cacheFixtures = limpio;
  return cacheFixtures;
}

/**
 * Cliente simulado (RNF-4, CA-10): reproduce lo que devolveria el LLM sin tocar la red.
 *
 * - La extraccion sale de `data/llm-fixtures.json` (RF-9.3: cache por factura).
 * - Si la factura no tiene fixture, el modelo "falla" y el sistema escala.
 * - La propuesta por defecto es `pagar`: asi se ve que el guard endurece la decision
 *   con el motor de reglas, y que el modelo nunca tiene la ultima palabra.
 */
export function createFixtureClient(): LlmClient {
  return {
    modo: 'fixture',
    descripcion: 'Simulado (fixtures locales, sin red)',

    async extract(invoice: InvoiceInput): Promise<ExtractResponse> {
      const entrada = fixtures()[invoice.id];
      if (!entrada || entrada.extraccion === undefined) {
        return {
          ok: false,
          error: `No hay respuesta simulada para la factura ${invoice.id} (modo sin red).`,
        };
      }
      return { ok: true, raw: entrada.extraccion };
    },

    async propose(input: ProposalInput): Promise<ProposalResponse> {
      const entrada = fixtures()[input.invoice.id];
      const propuesta = entrada?.propuesta;
      const decision = propuesta?.decision;

      if (decision === 'pagar' || decision === 'escalar' || decision === 'frenar') {
        const razones = Array.isArray(propuesta?.razones)
          ? propuesta.razones.filter((r): r is string => typeof r === 'string')
          : [];
        return { decision, razones };
      }

      return {
        decision: 'pagar',
        razones: [
          'El modelo simulado no encontro motivos para frenar el pago; el motor de reglas decide.',
        ],
      };
    },

    async explain(): Promise<string | null> {
      // Sin red no hay explicacion generada: se usa la plantilla de core/explain.ts.
      return null;
    },

    async responderChat(input: ChatContext): Promise<string> {
      // Cliente simulado sin red: responde de forma limitada sobre el sistema.
      const company = input.company as any;
      const nombre = company?.nombre ?? 'la empresa';
      const responsable = company?.responsable ?? 'el responsable';
      const presupuesto = company?.presupuestoPeriodo as number | undefined;
      const monedaBase = company?.monedaBase as string | undefined;

      const mensaje = input.mensaje.toLowerCase();

      // Respuestas predefinidas para preguntas comunes
      if (mensaje.includes('como funciona') || mensaje.includes('cómo funciona')) {
        return `El agente de pagos de ${nombre} funciona así:\n\n1. **Extracción**: Lee la factura y extrae los datos clave (beneficiario, monto, referencia).\n2. **Verificación**: Comprueba que los datos sean coherentes.\n3. **Evaluación de reglas**: Aplica 8 reglas de seguridad (cobro duplicado, beneficiario permitido, límites, presupuesto, etc.).\n4. **Propuesta del LLM**: El modelo sugiere pagar, escalar o frenar.\n5. **Guard de seguridad**: El motor de reglas puede endurecer la decisión del LLM.\n6. **Registro**: Queda registro de auditoría con todo el rastro.\n\nEl principio es: "El modelo propone, el código decide".`;
      }

      if (mensaje.includes('reglas') || mensaje.includes('que reglas')) {
        return `El agente tiene **8 reglas activas** que verifican:\n- Cobro duplicado\n- Beneficiario permitido\n- Límite por pago\n- Límite por periodo\n- Presupuesto disponible\n- Coincidencia con contratos\n- Aprobación humana por montos grandes\n- Datos completos y verificados\n\n${responsable} puede editar estas reglas en la pantalla de Reglas.`;
      }

      if (mensaje.includes('presupuesto') || mensaje.includes('cuanto') || mensaje.includes('dinero')) {
        if (presupuesto) {
          return `El presupuesto del periodo es **$${presupuesto.toLocaleString('es-CO')} ${monedaBase ?? 'COP'}**. El agente verifica que cada pago esté dentro de este límite antes de aprobar.`;
        }
        return `No tengo información sobre el presupuesto actual.`;
      }

      if (mensaje.includes('quien') || mensaje.includes('responsable') || mensaje.includes('persona')) {
        return `El responsable de ${nombre} es **${responsable}**. Las facturas que requieren aprobación humana quedan pendientes de ${responsable}.`;
      }

      if (mensaje.includes('decision') || mensaje.includes('porque') || mensaje.includes('por que')) {
        return `Puedo explicarte las decisiones del agente si me indicas qué factura te interesa. Por ejemplo:\n- "¿Por qué la factura INV-001 fue escalada?"\n- "¿Qué reglas se activaron en INV-005?"\n\nTambién puedes ver el detalle completo en la tabla de facturas.`;
      }

      if (mensaje.includes('hola') || mensaje.includes(' Buenos') || mensaje.includes('hi') || mensaje.includes('hey')) {
        return `¡Hola! Soy el asistente del agente de pagos de ${nombre}. Puedo ayudarte a entender:\n\n- Cómo funcionan las reglas\n- Por qué se tomaron ciertas decisiones\n- Qué es lo que hace el agente paso a paso\n- Información sobre presupuestos y contratos\n\n¿Qué te gustaría saber?`;
      }

      // Respuesta genérica
      return `Gracias por tu pregunta. Como estoy en modo simulado (sin conexión a la API), mi capacidad de responder es limitada. Puedo ayudarte con:\n\n- Explicar cómo funciona el agente\n- Describir las reglas de pago\n- Información general sobre el sistema\n\nPara una respuesta más completa, contacta a ${responsable}.`;
    },
  };
}
