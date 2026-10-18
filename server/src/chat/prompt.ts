import { formatMoney, round2 } from '../core/money';
import { samePeriod } from '../core/period';
import * as repo from '../storage/repositories';
import type { ChatToolContext } from './tools';

/**
 * RF-10: el chat recibe el contexto real del registro. Aun asi, toda accion
 * pasa por una propuesta que una persona debe confirmar.
 */
export function buildChatAgentPrompt(mensaje: string, ctx: ChatToolContext): string {
  const lineas: string[] = [];
  lineas.push(`Empresa: ${ctx.company.nombre}`);
  lineas.push(`Responsable: ${ctx.company.responsable}`);
  lineas.push(`Fecha de referencia del periodo: ${ctx.config.fechaReferencia}`);

  if (ctx.invoiceId) {
    const record = repo.getDecisionByInvoice(ctx.invoiceId);
    lineas.push('');
    lineas.push(`Hilo de la factura ${ctx.invoiceId}:`);
    if (record) {
      lineas.push(`- Estado: ${record.estado}; decision final: ${record.decisionFinal}`);
      lineas.push(`- Beneficiario: ${record.extraccion?.beneficiario ?? 'sin extraer'}`);
      if (record.extraccion) {
        lineas.push(`- Monto: ${formatMoney(record.extraccion.monto, record.extraccion.moneda)}`);
      }
      lineas.push(`- Reglas que no pasaron: ${record.reglas.filter((r) => r.resultado !== 'pasa').map((r) => `${r.id} ${r.resultado}`).join(', ') || 'ninguna'}`);
      lineas.push(`- Descripcion: ${record.descripcion.resumen}`);
    } else {
      lineas.push('- La factura todavia no tiene una decision registrada.');
    }
  }

  const pendientes = repo.listDecisions().filter((d) => d.estado === 'pendiente_aprobacion');
  lineas.push('');
  lineas.push(`Facturas pendientes de aprobacion: ${pendientes.length}`);
  for (const d of pendientes.slice(0, 5)) {
    lineas.push(
      `- ${d.invoiceId}: ${d.extraccion?.beneficiario ?? 'sin beneficiario'}${
        d.extraccion ? `, ${formatMoney(d.extraccion.monto, d.extraccion.moneda)}` : ''
      }, reglas ${d.reglas.filter((r) => r.resultado !== 'pasa').map((r) => r.id).join(', ') || 'ninguna'}`,
    );
  }

  const ledger = repo
    .listLedger()
    .filter((e) => samePeriod(e.fecha, ctx.config.fechaReferencia, ctx.company.periodo.tipo));
  const comprometido = round2(ledger.reduce((total, e) => total + e.montoBase, 0));
  lineas.push('');
  lineas.push(`Presupuesto: ${ctx.config.presupuestoPeriodo} ${ctx.config.monedaBase}; comprometido ${comprometido}.`);

  lineas.push('');
  lineas.push(`Pregunta de la persona: ${mensaje}`);
  lineas.push('');
  lineas.push(
    'Usa las herramientas de lectura para consultar datos reales. Si necesitas proponer una accion, usa propose_action:',
    'eso solo crea una tarjeta que una persona debe confirmar en la UI. Nunca digas que ejecutaste un pago,',
    'una aprobacion o un cambio de reglas. Si no sabes algo, dilo y remite a la pantalla correspondiente.',
  );

  return lineas.join('\n');
}
