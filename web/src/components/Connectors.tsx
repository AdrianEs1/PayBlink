import { useState } from 'react';
import type { Connector } from '@payblink/shared';

export function Connectors({ items }: { items: Connector[] }) {
  const [seleccionado, setSeleccionado] = useState<string | null>(items[0]?.id ?? null);
  const actual = items.find((c) => c.id === seleccionado) ?? null;

  return (
    <>
      <div className="panel">
        <h2>Conectores de facturas</h2>
        <div className="aviso info">
          Solo <strong>Carpeta de demo</strong> y <strong>Subida manual</strong> están activos en este MVP.
          Los demás conectores son <strong>vista previa</strong>: no están conectados, no se pide ninguna
          credencial y no se simula una conexión exitosa.
        </div>
        <div className="galeria">
          {items.map((connector) => (
            <button
              key={connector.id}
              className={`tarjeta conector ${seleccionado === connector.id ? 'seleccionado' : ''}`}
              onClick={() => setSeleccionado(connector.id)}
            >
              <div className="fila-entre">
                <span className="conector-icono">{connector.icono}</span>
                <span
                  className={`insignia ${connector.estado === 'activo' ? 'pasa' : 'neutra'}`}
                >
                  {connector.estado === 'activo' ? 'Activo' : 'Vista previa'}
                </span>
              </div>
              <strong>{connector.nombre}</strong>
              <div className="motivo" style={{ marginTop: 4 }}>
                {connector.descripcion}
              </div>
            </button>
          ))}
        </div>
      </div>

      {actual && (
        <div className="panel">
          <h2>
            {actual.icono} {actual.nombre}{' '}
            <span className={`insignia ${actual.estado === 'activo' ? 'pasa' : 'neutra'}`}>
              {actual.estado === 'activo' ? 'Activo en el MVP' : 'No conectado en este MVP'}
            </span>
          </h2>
          <p className="motivo">{actual.nota}</p>

          <div className="grid-2">
            <div>
              <h3>Permisos que pediría</h3>
              <ul className="lista">
                {actual.permisos.map((permiso) => (
                  <li key={permiso}>{permiso}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Cómo fluiría la factura</h3>
              <ol className="lista">
                {actual.flujo.map((paso) => (
                  <li key={paso}>{paso}</li>
                ))}
              </ol>
            </div>
          </div>

          {actual.estado === 'vista_previa' && (
            <div className="aviso info" style={{ marginTop: 12 }}>
              Este conector no está conectado. En producción se implementaría detrás de la interfaz
              <span className="mono"> InvoiceSource </span> y pasaría por el mismo agente, guard y auditoría.
            </div>
          )}
        </div>
      )}
    </>
  );
}
