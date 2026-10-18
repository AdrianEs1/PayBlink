import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, InvoiceListItem } from '@blinka/shared';
import { api } from '../api';

const SUGERENCIAS = [
  '¿Qué facturas están pendientes de aprobación?',
  '¿Cuánto llevamos gastado del presupuesto?',
  '¿Por qué se escaló INV-016?',
  '¿Puedes aprobar INV-016?',
];

export function Chat({
  facturas,
  responsable,
  onCambio,
}: {
  facturas: InvoiceListItem[];
  responsable: string;
  onCambio: () => void;
}) {
  const [threadId, setThreadId] = useState('global');
  const [mensajes, setMensajes] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const cargar = useCallback(async (hilo: string) => {
    try {
      const r = await api.chat(hilo);
      setMensajes(r.mensajes);
      setError(null);
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : String(causa));
    }
  }, []);

  useEffect(() => {
    void cargar(threadId);
  }, [threadId, cargar]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [mensajes]);

  const enviar = async (textoFijo?: string) => {
    const texto = (textoFijo ?? input).trim();
    if (!texto || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      const r = await api.enviarChat(threadId, texto, 'Persona');
      setMensajes((prev) => [...prev, r.mensaje]);
      setInput('');
      onCambio();
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : String(causa));
    } finally {
      setEnviando(false);
    }
  };

  const confirmar = async (id: string) => {
    setConfirmando(id);
    setError(null);
    try {
      await api.confirmarPropuesta(id, responsable);
      await cargar(threadId);
      onCambio();
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : String(causa));
    } finally {
      setConfirmando(null);
    }
  };

  return (
    <div className="panel chat-panel">
      <div className="fila-entre">
        <h2>Chat con el agente</h2>
        <select value={threadId} onChange={(e) => setThreadId(e.target.value)}>
          <option value="global">Conversación general</option>
          {facturas.map((f) => (
            <option key={f.id} value={f.id}>
              Hilo de {f.id}
            </option>
          ))}
        </select>
      </div>

      <div className="aviso info">
        El chat solo consulta y propone. No ejecuta pagos ni cambia reglas: las propuestas se ejecutan
        cuando una persona pulsa <strong>Confirmar</strong>, y quedan registradas con quién y cuándo.
      </div>

      <div className="chat-hilo" ref={scrollRef}>
        {mensajes.length === 0 && (
          <div className="chat-vacio">
            <p>Pregúntame por decisiones, pendientes, presupuesto o duplicados.</p>
            <div className="sugerencias">
              {SUGERENCIAS.map((s) => (
                <button key={s} className="chip" onClick={() => void enviar(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {mensajes.map((m) => (
          <div key={m.id} className={`mensaje ${m.rol === 'persona' ? 'persona' : m.rol}`}>
            <div className="mensaje-etiqueta">
              {m.rol === 'persona' ? 'Tú' : m.rol === 'agente' ? 'Blinka Agent' : 'Sistema'}
            </div>
            <div className="mensaje-burbuja">{m.contenido}</div>
            {m.propuestas.map((p) => (
              <div key={p.id} className="propuesta">
                <div>
                  <div className="fila-entre">
                    <strong>{p.titulo}</strong>
                    <span className={`insignia ${p.estado === 'confirmada' ? 'pasa' : 'neutra'}`}>
                      {p.estado}
                    </span>
                  </div>
                  <div className="motivo">{p.descripcion}</div>
                </div>
                {p.estado === 'pendiente' && (
                  <button
                    className="primario"
                    disabled={confirmando === p.id}
                    onClick={() => void confirmar(p.id)}
                  >
                    {confirmando === p.id ? 'Confirmando…' : 'Confirmar'}
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {error && <div className="aviso error">{error}</div>}

      <div className="chat-composer">
        <textarea
          placeholder="Escribe tu pregunta… (Enter para enviar, Shift+Enter para salto de línea)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void enviar();
            }
          }}
        />
        <button className="primario" disabled={enviando || !input.trim()} onClick={() => void enviar()}>
          {enviando ? 'Pensando…' : 'Enviar'}
        </button>
      </div>

      <div className="sugerencias" style={{ marginTop: 10 }}>
        {SUGERENCIAS.map((s) => (
          <button key={s} className="chip" disabled={enviando} onClick={() => void enviar(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
