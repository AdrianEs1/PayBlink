import {
  DECISION_LABEL,
  type AgentDescription,
  type Decision,
  type ExtractionCheck,
  type Moneda,
  type RuleResult,
} from '@payblink/shared';
import { formatMoney } from './money';

/**
 * RF-6 / RNF-2: explicacion en lenguaje natural.
 * Esta plantilla es el respaldo determinista de `core/explain.ts`: siempre existe,
 * aunque el LLM no responda (RF-4.6, CA-10).
 */
export interface ExplainInput {
  beneficiario: string | null;
  monto: number | null;
  moneda: Moneda | null;
  referencia: string | null;
  decision: Decision;
  propuesta: Decision;
  guardActuo: boolean;
  reglas: readonly RuleResult[];
  inyecciones?: readonly string[];
  aprobacionHumana?: boolean;
}

function sujeto(input: ExplainInput): string {
  const quien = input.beneficiario ?? 'un beneficiario no identificado';
  const monto =
    input.monto !== null && input.moneda
      ? formatMoney(input.monto, input.moneda)
      : 'un monto no identificado';
  const ref = input.referencia ? ` (referencia ${input.referencia})` : '';
  return `la factura de ${quien} por ${monto}${ref}`;
}

function lista(motivos: readonly string[]): string {
  if (motivos.length === 1) return motivos[0] ?? '';
  return motivos.map((m, i) => `${i + 1}) ${m}`).join(' ');
}

export function buildExplanation(input: ExplainInput): string {
  const partes: string[] = [];
  const bloqueos = input.reglas.filter((r) => r.resultado === 'bloquea');
  const escalamientos = input.reglas.filter((r) => r.resultado === 'escala');
  const totalReglas = input.reglas.length;
  const pasan = input.reglas.filter((r) => r.resultado === 'pasa');

  if (input.decision === 'pagar') {
    partes.push(
      `Registre el pago de ${sujeto(input)} porque cumple las ${totalReglas} reglas de la empresa.`,
    );
    const destacados = pasan
      .filter((r) => ['R2', 'R3', 'R4', 'R5', 'R6', 'R7'].includes(r.id))
      .map((r) => r.motivo);
    if (destacados.length > 0) partes.push(`Verificaciones clave: ${lista(destacados)}`);
  } else if (input.decision === 'frenar') {
    partes.push(`Frene el pago de ${sujeto(input)} y no lo envie a aprobacion.`);
    if (bloqueos.length > 0) {
      partes.push(`Motivos de bloqueo: ${lista(bloqueos.map((r) => `${r.nombre}: ${r.motivo}`))}`);
    }
  } else {
    partes.push(
      `No registre el pago de ${sujeto(input)}: quedo pendiente de aprobacion de una persona.`,
    );
    const motivosEscala = escalamientos.map((r) => `${r.nombre}: ${r.motivo}`);
    if (motivosEscala.length > 0) {
      partes.push(`Motivos: ${lista(motivosEscala)}`);
    } else {
      partes.push('Motivo: el motor de reglas no pudo confirmar que la factura cumple todas las reglas.');
    }
  }

  if (input.guardActuo && input.decision !== input.propuesta) {
    partes.push(
      `Nota de seguridad: el modelo propuso "${input.propuesta}" y el guard la endurecio a "${input.decision}". La decision final la fija el codigo, no el modelo.`,
    );
  }

  if (input.aprobacionHumana) {
    partes.push('Esta factura habia sido escalada y una persona autorizo el pago explicitamente.');
  }

  if (input.inyecciones && input.inyecciones.length > 0) {
    partes.push(
      `Aviso: la factura contiene texto que intenta dar instrucciones al agente (${input.inyecciones
        .map((i) => `"${i}"`)
        .join(', ')}). Se trato como dato no confiable y no afecto la decision.`,
    );
  }

  return partes.join(' ');
}

/* ------------------------------------------------------------------ */
/* RF-6: descripcion obligatoria con sus 5 componentes                 */
/* ------------------------------------------------------------------ */

export interface DescriptionInput extends ExplainInput {
  verificacion?: ExtractionCheck | null;
  toolCalls?: ReadonlyArray<{ tool: string; resultado: string }>;
  /** Narrativa opcional del LLM; solo se usa si no contradice la decision final. */
  narrativaLlm?: string | null;
  /** RF-1.10: fallo irrecuperable que obligo a escalar. */
  errorFatal?: string | null;
  /** RF-6.5: una persona rechazo la escalada. */
  rechazoHumano?: { quien: string; comentario: string } | null;
}

function narrativaCompatible(narrativa: string, decision: Decision): boolean {
  const texto = narrativa.toLowerCase();
  if (decision === 'pagar') {
    return !/(no (se )?(pago|registr)|fren[eé]|escal[eé]|rechac[eé])/.test(texto);
  }
  if (decision === 'frenar') {
    return !/(registr[eé] el pago|pagu[eé]|pago registrado|escal[eé])/.test(texto);
  }
  return !/(registr[eé] el pago|pagu[eé]|pago registrado|fren[eé])/.test(texto);
}

/** El motor ya incluye el id en `nombre`; el respaldo de pruebas puede no incluirlo. */
export function etiquetaRegla(r: { id: string; nombre: string }): string {
  return r.nombre.startsWith(`${r.id} -`) || r.nombre.startsWith(`${r.id} `)
    ? r.nombre
    : `${r.id} ${r.nombre}`;
}

function resumenDeterminista(input: DescriptionInput): string {
  const quien = input.beneficiario ?? 'un beneficiario no identificado';
  const monto =
    input.monto !== null && input.moneda
      ? formatMoney(input.monto, input.moneda)
      : 'un monto no identificado';
  const ref = input.referencia ? ` con referencia ${input.referencia}` : '';
  const sujeto = `la factura de ${quien} por ${monto}${ref}`;

  if (input.errorFatal) {
    return `Recibí ${sujeto}, pero no pude completar el análisis: ${input.errorFatal}. Para no arriesgar un pago indebido, la dejé escalada a una persona. No se registró ningún pago.`;
  }

  const noPasan = input.reglas.filter((r) => r.resultado !== 'pasa');
  const detalle = noPasan
    .slice(0, 3)
    .map((r) => `${etiquetaRegla(r)}: ${r.motivo}`)
    .join('; ');

  if (input.rechazoHumano) {
    return `Revisé ${sujeto} y la escalé porque ${detalle || 'el motor no pudo confirmar que cumple todas las reglas'}. Una persona (${input.rechazoHumano.quien}) revisó el caso y rechazó el pago${
      input.rechazoHumano.comentario ? `: ${input.rechazoHumano.comentario}` : '.'
    } No se registró ningún pago.`;
  }

  if (input.decision === 'pagar') {
    const extra = input.inyecciones && input.inyecciones.length > 0
      ? ' La factura traía instrucciones dirigidas al agente; las traté como texto y no cambiaron la decisión.'
      : '';
    return `Revisé ${sujeto} y verifiqué los datos contra el texto original. Cumple las ${input.reglas.length} reglas de la empresa, así que registré el pago.${extra}`;
  }

  if (input.decision === 'frenar') {
    return `Revisé ${sujeto} y encontré un bloqueo que impide pagarla: ${detalle || 'una regla de bloqueo se activó'}. Frené el pago y no lo envié a aprobación; una persona solo puede confirmar el rechazo.`;
  }

  return `Revisé ${sujeto} y no registré el pago. Quedó escalada a una persona porque ${detalle || 'el motor no pudo confirmar que cumple todas las reglas'}. La decisión final la fija el código, no el modelo.`;
}

/**
 * RF-6.2: construye la descripcion completa a partir del rastro y el veredicto.
 * La decision y los motivos SIEMPRE salen del veredicto, nunca del texto del LLM.
 */
export function buildDescription(input: DescriptionInput): AgentDescription {
  const noPasan = input.reglas.filter((r) => r.resultado !== 'pasa');
  const pasan = input.reglas.filter((r) => r.resultado === 'pasa');
  const decisionLabel = DECISION_LABEL[input.decision];

  const resumenBase = resumenDeterminista(input);
  const narrativa =
    input.narrativaLlm && input.narrativaLlm.trim().length >= 20 && narrativaCompatible(input.narrativaLlm, input.decision)
      ? input.narrativaLlm.trim()
      : null;
  const resumen = narrativa ?? resumenBase;

  const queHizo: string[] = [];
  if (input.errorFatal) {
    queHizo.push(`Intento de procesamiento fallido: ${input.errorFatal}`);
  }
  if (input.toolCalls && input.toolCalls.length > 0) {
    for (const llamada of input.toolCalls) {
      queHizo.push(`${llamada.tool}: ${llamada.resultado}`);
    }
  } else {
    queHizo.push(
      'Pipeline fijo: extraje los datos con el modelo, verifiqué el monto y el beneficiario contra el texto y evalué las 8 reglas en código.',
    );
  }
  if (input.verificacion) {
    queHizo.push(
      input.verificacion.ok
        ? 'Verificación literal: el monto y el beneficiario aparecen en el texto de la factura.'
        : `Verificación literal fallida: ${input.verificacion.motivos.join(' ')}`,
    );
  }

  const reglasTexto =
    noPasan.length === 0
      ? `Decisión final: ${decisionLabel}. Las ${input.reglas.length} reglas pasaron.`
      : `Decisión final: ${decisionLabel}. Reglas que no pasaron: ${noPasan
          .map((r) => `${etiquetaRegla(r)} (${r.resultado}: ${r.motivo})`)
          .join('; ')}. Pasaron ${pasan.length} de ${input.reglas.length}.`;

  const cambioGuard =
    input.guardActuo && input.propuesta !== input.decision
      ? `Propuse "${input.propuesta}", pero el motor ${
          input.decision === 'frenar' ? 'bloqueó' : 'escaló'
        } por ${noPasan.map((r) => r.id).join(', ') || 'las reglas vigentes'}. La decisión final la fija el código, no el modelo.`
      : null;

  let siguientePaso: string;
  if (input.errorFatal) {
    siguientePaso =
      'Una persona debe revisar el error, corregir la causa y volver a procesar la factura; mientras tanto no se paga.';
  } else if (input.decision === 'pagar') {
    siguientePaso = input.aprobacionHumana
      ? 'Una persona aprobó esta escalada: preparé la orden de pago. No se ejecuta ni se envía a ninguna plataforma; queda lista para conciliación.'
      : 'Preparé la orden de pago para revisión y conciliación. No se ejecuta ni se envía a ninguna plataforma.';
  } else if (input.decision === 'frenar') {
    siguientePaso = 'No se paga y no se puede aprobar: una persona solo puede confirmar el rechazo en la pantalla de Aprobaciones.';
  } else if (input.rechazoHumano) {
    siguientePaso = 'La factura quedó rechazada por una persona; no se paga y no queda nada pendiente.';
  } else {
    siguientePaso = `Una persona debe aprobar o rechazar el pago${
      noPasan.length > 0 ? ` (regla ${noPasan[0]?.id})` : ''
    } en la pantalla de Aprobaciones o desde la notificación simulada. También puede preguntarle al agente qué falta.`;
  }

  const texto = [resumen, ...queHizo.map((h) => `- ${h}`), reglasTexto, cambioGuard, siguientePaso]
    .filter((parte): parte is string => Boolean(parte))
    .join(' ');

  return {
    resumen,
    queHizo,
    decisionYReglas: reglasTexto,
    cambioGuard,
    siguientePaso,
    texto,
  };
}
