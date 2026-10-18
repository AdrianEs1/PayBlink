import {
  ESTADO_LABEL,
  QUEUE_STATE_LABEL,
  type InvoiceListItem,
} from '@blinka/shared';

export function formatearMonto(monto: number | null, moneda: string | null): string {
  if (monto === null || !moneda) return '—';
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: moneda,
      maximumFractionDigits: 2,
    }).format(monto);
  } catch {
    return `${moneda} ${monto}`;
  }
}

export function InvoicesTable({
  items,
  seleccion,
  onSeleccionar,
}: {
  items: InvoiceListItem[];
  seleccion: string | null;
  onSeleccionar: (id: string) => void;
}) {
  if (items.length === 0) {
    return <div className="vacio">No hay facturas cargadas.</div>;
  }

  return (
    <div className="tabla-hscroll">
    <table>
      <thead>
        <tr>
          <th>Factura</th>
          <th>Fuente</th>
          <th>Beneficiario</th>
          <th>Monto</th>
          <th>Estado</th>
          <th>Descripción del agente</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr
            key={item.id}
            className={seleccion === item.id ? 'seleccionada' : ''}
            onClick={() => onSeleccionar(item.id)}
          >
            <td className="mono">
              {item.id}
              {item.guardActuo && (
                <>
                  <br />
                  <span className="insignia neutra" title="El guard endureció la propuesta del LLM">
                    guard
                  </span>
                </>
              )}
            </td>
            <td className="motivo">
              {item.fuente?.conectorNombre ?? '—'}
              {item.fuente?.remitente && (
                <>
                  <br />
                  <span style={{ fontSize: 11 }}>{item.fuente.remitente}</span>
                </>
              )}
            </td>
            <td>
              {item.beneficiario ?? <span style={{ color: 'var(--texto-suave)' }}>sin extraer</span>}
              {item.inyecciones.length > 0 && (
                <>
                  <br />
                  <span className="insignia neutra" title={item.inyecciones.join(' · ')}>
                    texto sospechoso
                  </span>
                </>
              )}
            </td>
            <td className="mono">{formatearMonto(item.monto, item.moneda)}</td>
            <td>
              {item.estado ? (
                <span className={`insignia ${item.estado}`}>{ESTADO_LABEL[item.estado]}</span>
              ) : (
                <span className="insignia neutra">Sin procesar</span>
              )}
              <br />
              <span className={`insignia cola-${item.queueState}`} style={{ marginTop: 4 }}>
                {QUEUE_STATE_LABEL[item.queueState]}
              </span>
              {item.ultimoError && (
                <>
                  <br />
                  <span className="insignia bloquea" title={item.ultimoError}>
                    error
                  </span>
                </>
              )}
            </td>
            <td className="motivo" title={item.motivoResumen}>
              {item.descripcionLinea}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
