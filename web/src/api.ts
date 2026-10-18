import type {
  ApiError,
  AuditEvent,
  ChatMessage,
  Company,
  Connector,
  Contract,
  DecisionRecord,
  EvaluationReport,
  IngestEntry,
  IngestExample,
  IngestMode,
  IngestResult,
  InvoiceDetail,
  SourceInfo,
  InvoiceListItem,
  Notification,
  QueueItem,
  RulesConfig,
  Summary,
} from '@blinka/shared';

export interface ConfigResponse {
  company: Company;
  rules: RulesConfig;
  contratos: Contract[];
  ingestMode: IngestMode;
  llm: {
    modo: string;
    estrategia: string;
    maxSteps: number;
    apiKeyConfigurada: boolean;
  };
}

export interface AuditResponse {
  items: AuditEvent[];
  total: number;
  cadena: { ok: boolean; rotoEn: string | null };
}

export interface IngestPreview {
  source: SourceInfo;
  invoiceId: string;
  archivo: string;
  formato: string;
  caracteres: number;
  texto: string;
  truncado: boolean;
}

export interface NotificationResponse {
  items: Notification[];
  aprobadores: Array<{
    id: string;
    nombre: string;
    cargo: string;
    telefono: string;
    email: string;
    canalPreferido: 'whatsapp' | 'email';
    montoMaximo: number | null;
  }>;
}

async function pedir<T>(ruta: string, init?: RequestInit): Promise<T> {
  const respuesta = await fetch(`/api${ruta}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const texto = await respuesta.text();
  const datos = texto ? (JSON.parse(texto) as unknown) : null;
  if (!respuesta.ok) {
    const mensaje = (datos as ApiError | null)?.error ?? `Error ${respuesta.status}`;
    throw new Error(mensaje);
  }
  return datos as T;
}

export const api = {
  config: () => pedir<ConfigResponse>('/config'),
  guardarReglas: (rules: RulesConfig) =>
    pedir<{ ok: boolean; rules: RulesConfig }>('/rules', {
      method: 'PUT',
      body: JSON.stringify(rules),
    }),
  facturas: () => pedir<{ items: InvoiceListItem[]; total: number }>('/invoices'),
  detalle: (id: string) => pedir<InvoiceDetail>(`/invoices/${encodeURIComponent(id)}`),
  procesar: () =>
    pedir<{ encoladas: number; mensaje: string }>('/invoices/process', { method: 'POST' }),
  procesarFactura: (id: string) =>
    pedir<{ ok: boolean; invoiceId: string }>(`/invoices/${encodeURIComponent(id)}/process`, {
      method: 'POST',
    }),
  aprobaciones: () => pedir<{ items: DecisionRecord[]; total: number }>('/approvals'),
  decidir: (id: string, accion: 'aprobar' | 'rechazar', quien: string, comentario: string) =>
    pedir<DecisionRecord>(`/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ accion, quien, comentario }),
    }),
  resumen: () => pedir<Summary>('/summary'),
  evaluacion: () => pedir<EvaluationReport>('/evaluation'),
  reiniciar: () => pedir<{ ok: boolean; facturas: number }>('/reset', { method: 'POST' }),

  modoIngreso: (modo: IngestMode) =>
    pedir<{ ok: boolean; modo: IngestMode }>('/ingest-mode', {
      method: 'PUT',
      body: JSON.stringify({ modo }),
    }),
  ejemplos: () => pedir<{ items: IngestExample[] }>('/ingest/examples'),
  ingestar: (entry: IngestEntry) =>
    pedir<IngestResult>('/ingest', { method: 'POST', body: JSON.stringify(entry) }),
  previsualizar: (entry: IngestEntry) =>
    pedir<IngestPreview>('/ingest/preview', { method: 'POST', body: JSON.stringify(entry) }),
  cargarSet: () =>
    pedir<{ total: number; insertadas: number; duplicadas: number; enCola: number }>('/ingest/load-all', {
      method: 'POST',
    }),
  cola: () => pedir<{ items: QueueItem[]; modo: IngestMode }>('/queue'),

  conectores: () => pedir<{ items: Connector[] }>('/connectors'),

  notificaciones: () => pedir<NotificationResponse>('/notifications'),
  responderNotificacion: (
    id: string,
    accion: 'aprobar' | 'rechazar',
    quien: string,
    comentario: string,
  ) =>
    pedir<{ record: DecisionRecord; notification: Notification }>(
      `/notifications/${encodeURIComponent(id)}/respond`,
      { method: 'POST', body: JSON.stringify({ accion, quien, comentario }) },
    ),
  mensajeNotificacion: (id: string, mensaje: string, quien: string) =>
    pedir<{ mensaje: ChatMessage }>(`/notifications/${encodeURIComponent(id)}/message`, {
      method: 'POST',
      body: JSON.stringify({ mensaje, quien }),
    }),

  auditoria: (filtros: { invoiceId?: string; actor?: string; tipo?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [clave, valor] of Object.entries(filtros)) {
      if (valor) params.set(clave, valor);
    }
    const query = params.toString();
    return pedir<AuditResponse>(`/audit${query ? `?${query}` : ''}`);
  },
  verificarAuditoria: () => pedir<{ ok: boolean; rotoEn: string | null }>('/audit/verify'),

  chat: (threadId: string) =>
    pedir<{ threadId: string; mensajes: ChatMessage[] }>(
      `/chat?threadId=${encodeURIComponent(threadId)}`,
    ),
  enviarChat: (threadId: string, mensaje: string, autor = 'Persona') =>
    pedir<{ threadId: string; mensaje: ChatMessage }>('/chat', {
      method: 'POST',
      body: JSON.stringify({ threadId, mensaje, autor }),
    }),
  confirmarPropuesta: (id: string, quien: string) =>
    pedir<{ ok: boolean; proposal: unknown }>(`/chat/proposals/${encodeURIComponent(id)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ quien }),
    }),

  urlExportFacturas: () => '/api/invoices/export.csv',
  urlExportAuditoria: (formato: 'csv' | 'json', filtros: { invoiceId?: string; actor?: string; tipo?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [clave, valor] of Object.entries(filtros)) {
      if (valor) params.set(clave, valor);
    }
    const query = params.toString();
    return `/api/audit/export.${formato}${query ? `?${query}` : ''}`;
  },
};
