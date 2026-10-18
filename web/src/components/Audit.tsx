import { useState } from 'react';
import {
  AUDIT_EVENT_LABEL,
  AUDIT_EVENT_TYPES,
  type AuditEvent,
} from '@blinka/shared';
import { api } from '../api';

export interface AuditFiltros {
  invoiceId: string;
  actor: string;
  tipo: string;
}

export function Audit({
  items,
  cadena,
  trabajando,
  onFiltrar,
  onRefrescar,
}: {
  items: AuditEvent[];
  cadena: { ok: boolean; rotoEn: string | null } | null;
  trabajando: boolean;
  onFiltrar: (filtros: AuditFiltros) => void;
  onRefrescar: () => void;
}) {
  const [filtros, setFiltros] = useState<AuditFiltros>({ invoiceId: '', actor: '', tipo: '' });

  const aplicar = (parcial: Partial<AuditFiltros>) => {
    const nuevos = { ...filtros, ...parcial };
    setFiltros(nuevos);
    onFiltrar(nuevos);
  };

  const query = {
    invoiceId: filtros.invoiceId || undefined,
    actor: filtros.actor || undefined,
    tipo: filtros.tipo || undefined,
  };

  return (
    <>
      <div className="panel">
        <div className="fila-entre">
          <h2>Registro de auditoría (append-only)</h2>
          <div className="barra-acciones" style={{ margin: 0 }}>
            {cadena && (
              <span className={`insignia ${cadena.ok ? 'pasa' : 'bloquea'}`}>
                {cadena.ok ? 'cadena de hashes íntegra' : `cadena rota en ${cadena.rotoEn}`}
              </span>
            )}
            <button className="secundario" onClick={onRefrescar}>
              Actualizar
            </button>
          </div>
        </div>
        <div className="aviso info">
          Cada evento encadena el hash del anterior. No existen endpoints para editar ni borrar eventos.
        </div>

        <div className="filtros">
          <div className="campo">
            <label>Factura</label>
            <input
              type="text"
              placeholder="INV-016"
              value={filtros.invoiceId}
              onChange={(e) => aplicar({ invoiceId: e.target.value })}
            />
          </div>
          <div className="campo">
            <label>Actor</label>
            <select value={filtros.actor} onChange={(e) => aplicar({ actor: e.target.value })}>
              <option value="">Todos</option>
              <option value="agente">Agente</option>
              <option value="sistema">Sistema</option>
              <option value="persona">Persona</option>
              <option value="chat">Chat</option>
            </select>
          </div>
          <div className="campo">
            <label>Tipo de evento</label>
            <select value={filtros.tipo} onChange={(e) => aplicar({ tipo: e.target.value })}>
              <option value="">Todos</option>
              {AUDIT_EVENT_TYPES.map((tipo) => (
                <option key={tipo} value={tipo}>
                  {AUDIT_EVENT_LABEL[tipo]}
                </option>
              ))}
            </select>
          </div>
          <div className="campo">
            <label>Exportar</label>
            <div className="barra-acciones" style={{ margin: 0 }}>
              <a className="boton-enlace" href={api.urlExportAuditoria('csv', query)} download>
                CSV
              </a>
              <a className="boton-enlace" href={api.urlExportAuditoria('json', query)} download>
                JSON
              </a>
            </div>
          </div>
        </div>
        <div className="motivo">{items.length} evento(s) · {trabajando ? 'cargando…' : 'consulta actual'}</div>
      </div>

      <div className="panel">
        <div className="linea-tiempo">
          {items.length === 0 && <div className="vacio">No hay eventos con esos filtros.</div>}
          {items.map((evento) => (
            <div key={evento.id} className="evento">
              <div className="evento-hora">{new Date(evento.ts).toLocaleString('es-CO')}</div>
              <div className="evento-cuerpo">
                <div className="fila-entre">
                  <strong>{AUDIT_EVENT_LABEL[evento.tipo]}</strong>
                  <span className="insignia neutra">{evento.actor}</span>
                </div>
                {evento.invoiceId && (
                  <div className="motivo mono" style={{ marginTop: 2 }}>
                    {evento.invoiceId}
                  </div>
                )}
                <pre className="evento-detalle">{JSON.stringify(evento.detalle, null, 2)}</pre>
                <div className="motivo mono" style={{ fontSize: 10 }}>
                  hash {evento.hash.slice(0, 16)}… · prev{' '}
                  {evento.hashPrev ? `${evento.hashPrev.slice(0, 12)}…` : 'genesis'}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
