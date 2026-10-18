import { z } from 'zod';

/** RF-10.4: propuestas que el chat puede mostrar, nunca ejecutar por si mismo. */
export const ChatProposalTypeSchema = z.enum([
  'aprobar',
  'rechazar',
  'agregar_beneficiario',
  'ajustar_limite',
]);
export type ChatProposalType = z.infer<typeof ChatProposalTypeSchema>;

export const ChatProposalStatusSchema = z.enum(['pendiente', 'confirmada', 'descartada']);
export type ChatProposalStatus = z.infer<typeof ChatProposalStatusSchema>;

/** Borrador que devuelve el agente antes de guardarse como tarjeta. */
export const ChatProposalDraftSchema = z.object({
  tipo: ChatProposalTypeSchema,
  facturaId: z.string().nullable(),
  titulo: z.string().min(1),
  descripcion: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type ChatProposalDraft = z.infer<typeof ChatProposalDraftSchema>;

export const ChatProposalSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  tipo: ChatProposalTypeSchema,
  facturaId: z.string().nullable(),
  titulo: z.string(),
  descripcion: z.string(),
  payload: z.record(z.string(), z.unknown()),
  estado: ChatProposalStatusSchema,
  createdAt: z.string(),
  confirmadaPor: z.string().nullable(),
  confirmadaEn: z.string().nullable(),
});
export type ChatProposal = z.infer<typeof ChatProposalSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  rol: z.enum(['persona', 'agente', 'sistema']),
  contenido: z.string(),
  propuestas: z.array(ChatProposalSchema),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatThreadSchema = z.object({
  id: z.string(),
  titulo: z.string(),
  facturaId: z.string().nullable(),
  mensajes: z.array(ChatMessageSchema),
});
export type ChatThread = z.infer<typeof ChatThreadSchema>;
