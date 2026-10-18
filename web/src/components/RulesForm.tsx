import { useEffect, useState } from 'react';
import { MONEDAS, RULE_IDS, RULE_META, type Moneda, type RulesConfig } from '@payblink/shared';
import type { ConfigResponse } from '../api';

function Numero({
  etiqueta,
  valor,
  onChange,
  paso = 1,
}: {
  etiqueta: string;
  valor: number;
  onChange: (valor: number) => void;
  paso?: number;
}) {
  return (
    <div className="campo">
      <label>{etiqueta}</label>
      <input
        type="number"
        step={paso}
        value={Number.isFinite(valor) ? valor : 0}
        onChange={(evento) => onChange(Number(evento.target.value))}
      />
    </div>
  );
}

export function RulesForm({
  config,
  trabajando,
  onGuardar,
}: {
  config: ConfigResponse;
  trabajando: boolean;
  onGuardar: (rules: RulesConfig) => void;
}) {
  const [borrador, setBorrador] = useState<RulesConfig>(config.rules);

  useEffect(() => {
    setBorrador(config.rules);
  }, [config.rules]);

  const cambiar = (parcial: Partial<RulesConfig>) => setBorrador((previo) => ({ ...previo, ...parcial }));

  return (
    <div className="panel panel-reglas">
      <h2>Reglas y límites</h2>
      <div className="aviso info">
        Los cambios se aplican a las próximas facturas que se procesen. Las decisiones ya registradas
        conservan el rastro con el que se tomaron. Al guardar, la pantalla de facturas se actualiza y
        muestra un aviso breve en pantalla.
      </div>

      <div className="grid-2">
        <div>
          <h3>Parámetros generales</h3>
          <div className="campo">
            <label>Fecha de referencia del periodo (YYYY-MM-DD)</label>
            <input
              type="date"
              value={borrador.fechaReferencia}
              onChange={(evento) => cambiar({ fechaReferencia: evento.target.value })}
            />
          </div>
          <div className="campo">
            <label>Moneda base</label>
            <select
              value={borrador.monedaBase}
              onChange={(evento) => cambiar({ monedaBase: evento.target.value as Moneda })}
            >
              {MONEDAS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <Numero
            etiqueta="Límite por pago (moneda base)"
            valor={borrador.limitePorPago}
            onChange={(v) => cambiar({ limitePorPago: v })}
          />
          <Numero
            etiqueta="Límite por periodo (moneda base)"
            valor={borrador.limitePorPeriodo}
            onChange={(v) => cambiar({ limitePorPeriodo: v })}
          />
          <Numero
            etiqueta="Presupuesto del periodo"
            valor={borrador.presupuestoPeriodo}
            onChange={(v) => cambiar({ presupuestoPeriodo: v })}
          />
          <Numero
            etiqueta="Umbral de aprobación humana"
            valor={borrador.umbralAprobacionHumana}
            onChange={(v) => cambiar({ umbralAprobacionHumana: v })}
          />
          <Numero
            etiqueta="Confianza mínima de la extracción (0 a 1)"
            valor={borrador.confianzaMinima}
            paso={0.05}
            onChange={(v) => cambiar({ confianzaMinima: v })}
          />
          <div className="campo">
            <label>
              <input
                type="checkbox"
                checked={borrador.exigirContrato}
                onChange={(evento) => cambiar({ exigirContrato: evento.target.checked })}
              />{' '}
              Exigir contrato u orden de compra para pagar
            </label>
          </div>
        </div>

        <div>
          <h3>Beneficiarios permitidos</h3>
          <div className="campo">
            <label>Uno por línea</label>
            <textarea
              value={borrador.beneficiariosPermitidos.join('\n')}
              onChange={(evento) =>
                cambiar({
                  beneficiariosPermitidos: evento.target.value
                    .split('\n')
                    .map((linea) => linea.trim())
                    .filter((linea) => linea.length > 0),
                })
              }
            />
          </div>

          <h3>Tasas de cambio (RF-3.3)</h3>
          {MONEDAS.map((m) => (
            <Numero
              key={m}
              etiqueta={`1 ${m} = ? ${borrador.monedaBase}`}
              valor={borrador.tasas[m] ?? 1}
              paso={0.01}
              onChange={(v) =>
                cambiar({ tasas: { ...borrador.tasas, [m]: v } as RulesConfig['tasas'] })
              }
            />
          ))}
        </div>
      </div>

      <h3>Reglas activas y severidad al incumplirse</h3>
      <div className="tabla-reglas-wrap">
        <table className="tabla-reglas">
          <thead>
            <tr>
              <th>Regla</th>
              <th>Activa</th>
              <th>Al incumplirse</th>
              <th>Qué verifica</th>
            </tr>
          </thead>
          <tbody>
            {RULE_IDS.map((id) => (
              <tr key={id} style={{ cursor: 'default' }}>
                <td className="mono" data-etiqueta="Regla">
                  {id} · {RULE_META[id].nombre}
                </td>
                <td data-etiqueta="Activa">
                  <input
                    type="checkbox"
                    checked={borrador.reglas[id]?.activa ?? true}
                    onChange={(evento) =>
                      cambiar({
                        reglas: {
                          ...borrador.reglas,
                          [id]: {
                            activa: evento.target.checked,
                            severidad: borrador.reglas[id]?.severidad ?? 'escala',
                          },
                        } as RulesConfig['reglas'],
                      })
                    }
                  />
                </td>
                <td data-etiqueta="Al incumplirse">
                  <select
                    value={borrador.reglas[id]?.severidad ?? 'escala'}
                    onChange={(evento) =>
                      cambiar({
                        reglas: {
                          ...borrador.reglas,
                          [id]: {
                            activa: borrador.reglas[id]?.activa ?? true,
                            severidad: evento.target.value === 'bloquea' ? 'bloquea' : 'escala',
                          },
                        } as RulesConfig['reglas'],
                      })
                    }
                  >
                    <option value="escala">Escalar a una persona</option>
                    <option value="bloquea">Frenar (bloquea)</option>
                  </select>
                </td>
                <td className="motivo" data-etiqueta="Qué verifica">
                  {RULE_META[id].descripcion}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="acciones-reglas">
        <button className="primario" disabled={trabajando} onClick={() => onGuardar(borrador)}>
          Guardar reglas
        </button>
      </div>
    </div>
  );
}
