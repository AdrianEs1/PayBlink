import { useState } from 'react';
import type { DecisionRecord } from '@blinka/shared';
import { formatearMonto } from './InvoicesTable';

export function Approvals({
  items,
  trabajando,
  onDecidir,
}: {
  items: DecisionRecord[];
  trabajando: boolean;
  onDecidir: (id: string, accion: 'aprobar' | 'rechazar', quien: string, comentario: string) => void;
}) {
  const [quien, setQuien] = useState('');
  const [comentarios, setComentarios] = useState<Record<string, string>>({});

  if (items.length === 0) {
    return <div className="vacio">No hay facturas escaladas pendientes de aprobación.</div>;
  }

  return (
    <>
      <div className="campo" style={{ maxWidth: 320 }}>
        <label htmlFor="quien">Quién decide (queda en la auditoría)</label>
        <input
          id="quien"
          type="text"
          value={quien}
          placeholder="Nombre de la persona"
          onChange={(evento) => setQuien(evento.target.value)}
        />
      </div>

      <table>
        <thead>
          <tr>
            <th>Factura</th>
            <th>Beneficiario</th>
            <th>Monto</th>
            <th>Motivo de la escalada</th>
            <th>Comentario y decisión</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const relevante = item.reglas.find((r) => r.resultado !== 'pasa');
            return (
              <tr key={item.invoiceId} style={{ cursor: 'default' }}>
                <td className="mono">{item.invoiceId}</td>
                <td>{item.extraccion?.beneficiario ?? '—'}</td>
                <td className="mono">
                  {formatearMonto(item.extraccion?.monto ?? null, item.extraccion?.moneda ?? null)}
                </td>
                <td className="motivo">{relevante?.motivo ?? 'Requiere revisión humana.'}</td>
                <td>
                  <textarea
                    value={comentarios[item.invoiceId] ?? ''}
                    placeholder="Comentario (opcional)"
                    style={{ minHeight: 56, width: '100%', marginBottom: 6 }}
                    onChange={(evento) =>
                      setComentarios((previo) => ({ ...previo, [item.invoiceId]: evento.target.value }))
                    }
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="ok"
                      disabled={trabajando}
                      onClick={() =>
                        onDecidir(item.invoiceId, 'aprobar', quien, comentarios[item.invoiceId] ?? '')
                      }
                    >
                      Aprobar pago
                    </button>
                    <button
                      className="peligro"
                      disabled={trabajando}
                      onClick={() =>
                        onDecidir(item.invoiceId, 'rechazar', quien, comentarios[item.invoiceId] ?? '')
                      }
                    >
                      Rechazar
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
