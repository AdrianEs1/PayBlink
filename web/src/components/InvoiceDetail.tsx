import { useState, type ReactNode } from 'react';
import {
  AUDIT_EVENT_LABEL,
  ESTADO_LABEL,
  OUTCOME_LABEL,
  QUEUE_STATE_LABEL,
  RULE_META,
  type InvoiceDetail as InvoiceDetailType,
} from '@payblink/shared';
import { api } from '../api';
import { formatearMonto } from './InvoicesTable';

function Dato({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 11.5, color: 'var(--texto-suave)' }}>{etiqueta}</div>
      <div>{children}</div>
    </div>
  );
}

export function InvoiceDetail({
  detalle,
  onActualizar,
}: {
  detalle: InvoiceDetailType;
  onActualizar: () => void;
}) {
  const record = detalle.record;
  const e = record.extraccion;
  const v = record.verificacion;
  const [mensaje, setMensaje] = useState('');
  const [preguntando, setPreguntando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enviar = async () => {
    const texto = mensaje.trim();
    if (!texto) return;
    setPreguntando(true);
    setError(null);
    try {
      await api.enviarChat(record.invoiceId, texto, 'Persona (detalle)');
      setMensaje('');
      onActualizar();
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : String(causa));
    } finally {
      setPreguntando(false);
    }
  };

  const confirmar = async (id: string) => {
    setError(null);
    try {
      await api.confirmarPropuesta(id, 'Persona (detalle)');
      onActualizar();
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : String(causa));
    }
  };

  return (
    <div className="panel">
      <h2>
        {record.invoiceId} · {record.archivo}{' '}
        <span className={`insignia ${record.estado}`}>{ESTADO_LABEL[record.estado]}</span>{' '}
        <span className={`insignia cola-${record.queueState}`}>{QUEUE_STATE_LABEL[record.queueState]}</span>
      </h2>

      <h3>Descripción del agente (RF-6)</h3>
      <div className="descripcion-agente">
        <div className="descripcion-resumen">{record.descripcion.resumen}</div>
        <div className="descripcion-bloque">
          <strong>Qué hizo</strong>
          <ul>
            {record.descripcion.queHizo.map((linea, i) => (
              <li key={i}>{linea}</li>
            ))}
          </ul>
        </div>
        <div className="descripcion-bloque">
          <strong>Decisión y reglas</strong>
          <div>{record.descripcion.decisionYReglas}</div>
        </div>
        {record.descripcion.cambioGuard && (
          <div className="descripcion-bloque guard">
            <strong>El guard cambió la propuesta</strong>
            <div>{record.descripcion.cambioGuard}</div>
          </div>
        )}
        <div className="descripcion-bloque">
          <strong>Siguiente paso</strong>
          <div>{record.descripcion.siguientePaso}</div>
        </div>
      </div>

      {v && v.inyeccionesDetectadas.length > 0 && (
        <div className="aviso inyeccion" style={{ marginTop: 12 }}>
          <strong>Intento de instrucción dentro de la factura (ignorado).</strong> Frases detectadas:{' '}
          {v.inyeccionesDetectadas.map((i) => `"${i}"`).join(', ')}. El contenido de la factura se trata
          como dato no confiable (RF-2.5).
        </div>
      )}

      <div className="grid-2" style={{ marginTop: 14 }}>
        <div>
          <h3>Datos extraídos</h3>
          {e ? (
            <>
              <Dato etiqueta="Beneficiario">{e.beneficiario}</Dato>
              <Dato etiqueta="Monto">
                <span className="mono">{formatearMonto(e.monto, e.moneda)}</span>
              </Dato>
              <Dato etiqueta="Vencimiento">{e.fechaVencimiento}</Dato>
              <Dato etiqueta="Referencia">{e.referencia}</Dato>
              <Dato etiqueta="Concepto">{e.concepto}</Dato>
              <Dato etiqueta="Confianza del modelo">{e.confianza.toFixed(2)}</Dato>
            </>
          ) : (
            <div className="vacio">No hubo una extracción válida; el sistema escaló.</div>
          )}
        </div>

        <div>
          <h3>Verificación en código (RF-2.2)</h3>
          {v ? (
            <>
              <Dato etiqueta="Beneficiario aparece en el texto">
                {v.beneficiarioPresente ? 'sí' : 'no'}
              </Dato>
              <Dato etiqueta="Monto aparece en el texto">{v.montoPresente ? 'sí' : 'no'}</Dato>
              <Dato etiqueta="Formato numérico ambiguo">{v.montoAmbiguo ? 'sí' : 'no'}</Dato>
              <Dato etiqueta="Resultado">
                {v.ok ? (
                  <span className="insignia pasa">verificado</span>
                ) : (
                  <span className="insignia escala">no verificado</span>
                )}
              </Dato>
              {v.motivos.length > 0 && (
                <div className="motivo" style={{ marginTop: 6 }}>
                  {v.motivos.join(' ')}
                </div>
              )}
            </>
          ) : (
            <div className="vacio">Sin datos de verificación.</div>
          )}
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 14 }}>
        <div>
          <h3>Propuesta del modelo y decisión final</h3>
          <Dato etiqueta="Propuesta del LLM (no vinculante)">
            <span className="insignia neutra">{record.propuestaLlm.decision}</span>{' '}
            <span style={{ fontSize: 12, color: 'var(--texto-suave)' }}>
              vía {record.propuestaLlm.origen}
            </span>
          </Dato>
          {record.propuestaLlm.razones.length > 0 && (
            <ul style={{ margin: '4px 0 8px 18px', color: 'var(--texto-suave)', fontSize: 12.5 }}>
              {record.propuestaLlm.razones.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          <Dato etiqueta="Decisión final del guard">
            <span
              className={`insignia ${
                record.decisionFinal === 'pagar'
                  ? 'pagado'
                  : record.decisionFinal === 'frenar'
                    ? 'frenado'
                    : 'escala'
              }`}
            >
              {record.decisionFinal}
            </span>{' '}
            {record.guardActuo && (
              <span style={{ fontSize: 12, color: 'var(--ambar)' }}>
                el guard endureció la propuesta
              </span>
            )}
          </Dato>
          <Dato etiqueta="Descripción generada por">
            {record.origenExplicacion === 'llm' ? 'el modelo + plantilla determinista' : 'plantilla determinista'}
          </Dato>
        </div>

        <div>
          <h3>Decisión humana</h3>
          {record.humano ? (
            <>
              <Dato etiqueta="Acción">
                <span className={`insignia ${record.estado}`}>{record.humano.accion}</span>
              </Dato>
              <Dato etiqueta="Quién">{record.humano.quien}</Dato>
              <Dato etiqueta="Cuándo">{new Date(record.humano.fecha).toLocaleString('es-CO')}</Dato>
              <Dato etiqueta="Comentario">{record.humano.comentario || '—'}</Dato>
            </>
          ) : (
            <div className="vacio">Sin intervención humana.</div>
          )}

          <h3>Herramientas llamadas por el agente</h3>
          {record.toolCalls.length === 0 ? (
            <div className="vacio">
              Ninguna: esta factura se resolvió con el pipeline fijo (plan B, RF-4.6).
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Paso</th>
                  <th>Herramienta</th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {record.toolCalls.map((t, i) => (
                  <tr key={i} style={{ cursor: 'default' }}>
                    <td className="mono">{t.paso}</td>
                    <td className="mono">{t.tool}</td>
                    <td className="motivo">{t.resultado}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <h3>Rastro de reglas (se evaluaron todas)</h3>
      <table>
        <thead>
          <tr>
            <th>Regla</th>
            <th>Resultado</th>
            <th>Motivo</th>
          </tr>
        </thead>
        <tbody>
          {record.reglas.map((r) => (
            <tr key={r.id} style={{ cursor: 'default' }}>
              <td className="mono" title={RULE_META[r.id]?.descripcion}>
                {r.nombre}
              </td>
              <td>
                <span className={`insignia ${r.resultado}`}>{OUTCOME_LABEL[r.resultado]}</span>
              </td>
              <td className="motivo">{r.motivo}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Orden de pago preparada (RF-14)</h3>
      {detalle.paymentOrder ? (
        <div className="orden-pago">
          <div>
            <Dato etiqueta="Beneficiario">{detalle.paymentOrder.beneficiario}</Dato>
            <Dato etiqueta="País / banco ficticio">
              {detalle.paymentOrder.pais} · {detalle.paymentOrder.bancoFicticio}
            </Dato>
            <Dato etiqueta="Cuenta ficticia">
              <span className="mono">{detalle.paymentOrder.cuentaFicticia}</span>
            </Dato>
          </div>
          <div>
            <Dato etiqueta="Monto original">
              {formatearMonto(detalle.paymentOrder.monto, detalle.paymentOrder.moneda)}
            </Dato>
            <Dato etiqueta="Monto convertido">
              {formatearMonto(detalle.paymentOrder.montoConvertido, detalle.paymentOrder.monedaBase)}
            </Dato>
            <Dato etiqueta="Fecha sugerida / referencia">
              {detalle.paymentOrder.fechaSugerida} · {detalle.paymentOrder.referencia}
            </Dato>
          </div>
          <div className="aviso info" style={{ marginBottom: 0 }}>
            Estado: preparada. No se ejecuta ni se envía a ninguna plataforma de pago.
          </div>
        </div>
      ) : (
        <div className="vacio">Todavía no hay una orden de pago para esta factura.</div>
      )}

      <h3>Bitácora de la factura (RF-6.5)</h3>
      <div className="bitacora">
        {detalle.bitacora.length === 0 && <div className="vacio">Sin eventos registrados.</div>}
        {detalle.bitacora.map((evento) => (
          <div key={evento.id} className="bitacora-item">
            <div className="bitacora-punto" />
            <div>
              <div className="bitacora-cabecera">
                <span className="insignia neutra">{evento.actor}</span>{' '}
                <strong>{AUDIT_EVENT_LABEL[evento.tipo]}</strong>{' '}
                <span style={{ color: 'var(--texto-suave)' }}>
                  {new Date(evento.ts).toLocaleString('es-CO')}
                </span>
              </div>
              <div className="motivo mono" style={{ marginTop: 3 }}>
                {JSON.stringify(evento.detalle).slice(0, 240)}
              </div>
            </div>
          </div>
        ))}
      </div>

      <h3>Conversación de esta factura (RF-10.1)</h3>
      <div className="hilo-chat">
        {detalle.chat.length === 0 && (
          <div className="vacio">Aún no hay mensajes. Pregúntale al agente por esta factura.</div>
        )}
        {detalle.chat.map((msg) => (
          <div key={msg.id} className={`mensaje ${msg.rol}`}>
            <div className="mensaje-burbuja">{msg.contenido}</div>
            {msg.propuestas.map((p) => (
              <div key={p.id} className="propuesta">
                <div>
                  <strong>{p.titulo}</strong>
                  <div className="motivo">{p.descripcion}</div>
                </div>
                {p.estado === 'pendiente' ? (
                  <button className="primario" onClick={() => void confirmar(p.id)}>
                    Confirmar
                  </button>
                ) : (
                  <span className="insignia neutra">{p.estado}</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      {error && <div className="aviso error">{error}</div>}
      <div className="chat-composer">
        <textarea
          placeholder="Pregunta por esta factura o pide una propuesta…"
          value={mensaje}
          onChange={(e) => setMensaje(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void enviar();
            }
          }}
        />
        <button className="primario" disabled={preguntando || !mensaje.trim()} onClick={() => void enviar()}>
          {preguntando ? 'Enviando…' : 'Enviar'}
        </button>
      </div>

      <h3>Texto original de la factura</h3>
      <pre className="texto-factura">{record.texto}</pre>
      <div style={{ fontSize: 11.5, color: 'var(--texto-suave)' }}>
        Registrado el {new Date(record.createdAt).toLocaleString('es-CO')} · última actualización{' '}
        {new Date(record.updatedAt).toLocaleString('es-CO')}
      </div>
    </div>
  );
}
