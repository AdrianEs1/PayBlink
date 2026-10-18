import type { EvaluationReport, Summary as SummaryType } from '@payblink/shared';

function porcentaje(valor: number): string {
  return `${valor.toFixed(1)}%`;
}

export function Summary({
  resumen,
  evaluacion,
  evaluacionError,
}: {
  resumen: SummaryType;
  evaluacion: EvaluationReport | null;
  evaluacionError: string | null;
}) {
  const p = resumen.presupuesto;

  return (
    <>
      <div className="tarjetas">
        <div className="tarjeta">
          <div className="valor">{resumen.total}</div>
          <div className="etiqueta">Facturas en el set</div>
        </div>
        <div className="tarjeta">
          <div className="valor" style={{ color: 'var(--verde)' }}>
            {resumen.pagados}
          </div>
          <div className="etiqueta">Pagos registrados</div>
        </div>
        <div className="tarjeta">
          <div className="valor" style={{ color: 'var(--ambar)' }}>
            {resumen.pendientes}
          </div>
          <div className="etiqueta">Pendientes de aprobación</div>
        </div>
        <div className="tarjeta">
          <div className="valor" style={{ color: 'var(--rojo)' }}>
            {resumen.frenados}
          </div>
          <div className="etiqueta">Frenados</div>
        </div>
        <div className="tarjeta">
          <div className="valor" style={{ color: 'var(--acento)' }}>
            {resumen.aprobadosHumanos}
          </div>
          <div className="etiqueta">Aprobados por persona</div>
        </div>
        <div className="tarjeta">
          <div className="valor">{resumen.porProcesar}</div>
          <div className="etiqueta">Sin procesar</div>
        </div>
      </div>

      <div className="panel">
        <h2>Presupuesto del periodo</h2>
        <div className="grid-2">
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
              <span>Comprometido</span>
              <span>
                {p.comprometido.toLocaleString('es-CO')} / {p.presupuestoPeriodo.toLocaleString('es-CO')}{' '}
                {p.monedaBase} ({porcentaje(p.utilizadoPct)})
              </span>
            </div>
            <div className="barra">
              <div style={{ width: `${Math.min(100, p.utilizadoPct)}%` }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--texto-suave)' }}>
              Disponible: {p.disponible.toLocaleString('es-CO')} {p.monedaBase}
            </div>
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
              <span>Límite por periodo (política)</span>
              <span>
                {p.comprometido.toLocaleString('es-CO')} / {p.limitePorPeriodo.toLocaleString('es-CO')}{' '}
                ({porcentaje(p.utilizacionLimitePct)})
              </span>
            </div>
            <div className="barra limite">
              <div style={{ width: `${Math.min(100, p.utilizacionLimitePct)}%` }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--texto-suave)' }}>
              Por encima del límite, las facturas se escalan aunque quede presupuesto.
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Última evaluación</h2>
        {evaluacion ? (
          <>
            <div className="tarjetas">
              <div className="tarjeta">
                <div className="valor" style={{ color: 'var(--verde)' }}>
                  {porcentaje(evaluacion.autonomia)}
                </div>
                <div className="etiqueta">
                  Autonomía ({evaluacion.correctas}/{evaluacion.total} correctas)
                </div>
              </div>
              <div className="tarjeta">
                <div
                  className="valor"
                  style={{ color: evaluacion.seguridad === 0 ? 'var(--verde)' : 'var(--rojo)' }}
                >
                  {evaluacion.seguridad}
                </div>
                <div className="etiqueta">Pagos indebidos (debe ser 0)</div>
              </div>
              <div className="tarjeta">
                <div className="valor">{porcentaje(evaluacion.explicabilidad)}</div>
                <div className="etiqueta">Explicabilidad</div>
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--texto-suave)' }}>
              Generado el {new Date(evaluacion.generadoEn).toLocaleString('es-CO')} · modo LLM:{' '}
              {evaluacion.modoLlm}
            </div>
          </>
        ) : (
          <div className="vacio">
            {evaluacionError ?? 'Todavía no hay reporte. Ejecuta `npm run eval` para generarlo.'}
          </div>
        )}
      </div>
    </>
  );
}
