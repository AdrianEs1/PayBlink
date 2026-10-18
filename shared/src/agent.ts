import { z } from 'zod';

/**
 * RF-6.2: descripcion obligatoria de lo que hizo el agente.
 *
 * La parte determinista se construye siempre en `core/explain.ts` a partir del
 * rastro y del veredicto. La narrativa del LLM solo puede aportar el `resumen`
 * y jamas puede cambiar la decision ni los motivos (RF-6.4).
 */
export const AgentDescriptionSchema = z.object({
  /** Resumen en 2 a 4 frases, en lenguaje natural. */
  resumen: z.string().min(1),
  /** Que hizo: tools consultadas y que encontro en cada una. */
  queHizo: z.array(z.string().min(1)).min(1),
  /** Decision final y reglas que la determinaron (insertado desde el veredicto). */
  decisionYReglas: z.string().min(1),
  /** Si el guard cambio la propuesta del LLM, lo dice explicitamente. */
  cambioGuard: z.string().nullable(),
  /** Siguiente paso; si se escalo, que debe decidir la persona. */
  siguientePaso: z.string().min(1),
  /** Texto unico listo para mostrar en la tabla y el detalle. */
  texto: z.string().min(1),
});
export type AgentDescription = z.infer<typeof AgentDescriptionSchema>;
