import { useEffect, useState } from 'react';
import type { ChatMessage, Notification } from '@blinka/shared';
import { api } from '../api';
import { formatearMonto } from './InvoicesTable';

export function Notifications({
  items,
  trabajando,
  onResponder,
  onMensaje,
  onAbrirFactura,
}: {
  items: Notification[];
  trabajando: boolean;
  onResponder: (
    id: string,
    accion: 'aprobar' | 'rechazar',
    quien: string,
    comentario: string,
  ) => void;
  onMensaje: (id: string, mensaje: string, quien: string) => Promise<void>;
  onAbrirFactura: (id: string) => void;
}) {
  const [seleccionada, setSeleccionada] = useState<string | null>(items[0]?.id ?? null);
  const [mensajes, setMensajes] = useState<ChatMessage[]>([]);
  const [comentario, setComentario] = useState('');
  const [texto, setTexto] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (items.length === 0) {
      setSeleccionada(null);
      return;
    }
    if (!seleccionada || !items.some((n) => n.id === seleccionada)) {
      setSeleccionada(items[0]?.id ?? null);
    }
  }, [items, seleccionada]);

  const actual = items.find((n) => n.id === seleccionada) ?? null;

  useEffect(() => {
    if (!actual) {
      setMensajes([]);
      return;
    }
    let activo = true;
    api
      .chat(actual.invoiceId)
      .then((r) => {
        if (activo) setMensajes(r.mensajes);
      })
      .catch(() => {
        if (activo) setMensajes([]);
      });
    return () => {
      activo = false;
    };
  }, [actual]);

  const enviar = async () => {
    if (!actual || !texto.trim()) return;
    setEnviando(true);
    setError(null);
    try {
      await onMensaje(actual.id, texto.trim(), actual.approverNombre);
      setTexto('');
      const r = await api.chat(actual.invoiceId);
      setMensajes(r.mensajes);
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : String(causa));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <>
      <div className="panel">
        <h2>Notificaciones a aprobadores</h2>
        <div className="aviso error" style={{ fontWeight: 600 }}>
          Simulación: no se envía nada real. Los mensajes se guardan en un outbox y quedan en la
          auditoría.
        </div>
        <div className="notificaciones-layout">
          <div className="outbox">
            {items.length === 0 && <div className="vacio">No hay notificaciones. Escala una factura para verlas.</div>}
            {items.map((n) => (
              <button
                key={n.id}
                className={`tarjeta notificacion ${seleccionada === n.id ? 'seleccionado' : ''}`}
                onClick={() => setSeleccionada(n.id)}
              >
                <div className="fila-entre">
                  <strong>{n.approverNombre}</strong>
                  <span className={`insignia ${n.estado === 'respondido' ? 'pasa' : 'escala'}`}>
                    {n.estado}
                  </span>
                </div>
                <div className="motivo">
                  {n.invoiceId} · {n.contenido.beneficiario} ·{' '}
                  {formatearMonto(n.contenido.monto, n.contenido.moneda)}
                </div>
                <div className="motivo" style={{ marginTop: 4 }}>
                  {new Date(n.createdAt).toLocaleString('es-CO')} · {n.canal}
                </div>
              </button>
            ))}
          </div>

          {actual ? (
            <div className="telefono">
              <div className="telefono-cabecera">
                <div>
                  <strong>{actual.approverNombre}</strong>
                  <div className="motivo">{actual.destinatario}</div>
                </div>
                <span className="insignia neutra">{actual.canal}</span>
              </div>

              <div className="telefono-hilo">
                <div className="mensaje agente">
                  <div className="mensaje-burbuja">{actual.cuerpo}</div>
                </div>
                {mensajes.map((m) => (
                  <div key={m.id} className={`mensaje ${m.rol === 'persona' ? 'persona' : 'agente'}`}>
                    <div className="mensaje-burbuja">{m.contenido}</div>
                    {m.propuestas.map((p) => (
                      <div key={p.id} className="propuesta compacta">
                        <div>
                          <strong>{p.titulo}</strong>
                          <div className="motivo">{p.descripcion}</div>
                        </div>
                        <span className="insignia neutra">{p.estado}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {actual.estado !== 'respondido' ? (
                <div className="telefono-acciones">
                  <input
                    type="text"
                    placeholder="Comentario de la decisión (opcional)"
                    value={comentario}
                    onChange={(e) => setComentario(e.target.value)}
                  />
                  <div className="barra-acciones" style={{ margin: '8px 0' }}>
                    <button
                      className="ok"
                      disabled={trabajando}
                      onClick={() => onResponder(actual.id, 'aprobar', actual.approverNombre, comentario)}
                    >
                      Aprobar
                    </button>
                    <button
                      className="peligro"
                      disabled={trabajando}
                      onClick={() => onResponder(actual.id, 'rechazar', actual.approverNombre, comentario)}
                    >
                      Rechazar
                    </button>
                    <button className="secundario" onClick={() => onAbrirFactura(actual.invoiceId)}>
                      Ver detalle
                    </button>
                  </div>
                  <div className="chat-composer">
                    <input
                      type="text"
                      placeholder="Preguntar al agente…"
                      value={texto}
                      onChange={(e) => setTexto(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void enviar();
                      }}
                    />
                    <button className="secundario" disabled={enviando || !texto.trim()} onClick={() => void enviar()}>
                      Enviar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="telefono-acciones">
                  <div className="aviso info">
                    Respondida con <strong>{actual.respuesta?.accion}</strong> por{' '}
                    {actual.respuesta?.quien} el{' '}
                    {actual.respuesta ? new Date(actual.respuesta.fecha).toLocaleString('es-CO') : ''}.
                    {actual.respuesta?.comentario ? ` Comentario: ${actual.respuesta.comentario}` : ''}
                  </div>
                </div>
              )}
              {error && <div className="aviso error">{error}</div>}
            </div>
          ) : (
            <div className="vacio">Selecciona una notificación para ver el hilo.</div>
          )}
        </div>
      </div>
    </>
  );
}
