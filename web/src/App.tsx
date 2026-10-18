import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DECISION_LABEL,
  type AuditEvent,
  type Connector,
  type DecisionRecord,
  type EvaluationReport,
  type IngestEntry,
  type IngestExample,
  type IngestMode,
  type InvoiceDetail as InvoiceDetailType,
  type InvoiceListItem,
  type Notification,
  type QueueItem,
  type RulesConfig,
  type Summary as SummaryType,
} from '@payblink/shared';
import { api, type AuditResponse, type ConfigResponse } from './api';
import { Approvals } from './components/Approvals';
import { Audit, type AuditFiltros } from './components/Audit';
import { Chat } from './components/Chat';
import { Connectors } from './components/Connectors';
import { Entradas } from './components/Entradas';
import { InvoiceDetail } from './components/InvoiceDetail';
import { InvoicesTable } from './components/InvoicesTable';
import { Notifications } from './components/Notifications';
import { RulesForm } from './components/RulesForm';
import { Summary as SummaryPanel } from './components/Summary';
import { Scene3D } from './scene3d/Scene3D';
import { SALA_LABEL, type SalaId } from './scene3d/tipos';

type Tab = SalaId;
type Vista = 'sala' | 'clasica';

const ORDEN: Tab[] = [
  'entradas',
  'facturas',
  'aprobaciones',
  'reglas',
  'chat',
  'notificaciones',
  'conectores',
  'auditoria',
];

const TABS = ORDEN.map((id) => ({ id, label: SALA_LABEL[id] }));

function dinero(valor: number): string {
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(valor);
}

export function App() {
  const [vista, setVista] = useState<Vista>('sala');
  const [tab, setTab] = useState<Tab>('entradas');
  const [panelAbierto, setPanelAbierto] = useState(false);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [resumen, setResumen] = useState<SummaryType | null>(null);
  const [facturas, setFacturas] = useState<InvoiceListItem[]>([]);
  const [aprobaciones, setAprobaciones] = useState<DecisionRecord[]>([]);
  const [evaluacion, setEvaluacion] = useState<EvaluationReport | null>(null);
  const [evaluacionError, setEvaluacionError] = useState<string | null>(null);
  const [cola, setCola] = useState<QueueItem[]>([]);
  const [modo, setModo] = useState<IngestMode>('manual');
  const [ejemplos, setEjemplos] = useState<IngestExample[]>([]);
  const [conectores, setConectores] = useState<Connector[]>([]);
  const [notificaciones, setNotificaciones] = useState<Notification[]>([]);
  const [auditoria, setAuditoria] = useState<AuditEvent[]>([]);
  const [cadena, setCadena] = useState<AuditResponse['cadena'] | null>(null);
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<InvoiceDetailType | null>(null);
  const [detalleAviso, setDetalleAviso] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const cargando = useRef(false);

  // Los avisos de pantalla son breves: se ocultan solos a los pocos segundos.
  useEffect(() => {
    if (!aviso) return;
    const temporizador = setTimeout(() => setAviso(null), 3000);
    return () => clearTimeout(temporizador);
  }, [aviso]);

  // Los errores tambien son momentaneos: nunca deben quedarse fijos en pantalla.
  useEffect(() => {
    if (!error) return;
    const temporizador = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(temporizador);
  }, [error]);

  const cargarDetalle = useCallback(async (id: string) => {
    try {
      setDetalle(await api.detalle(id));
      setDetalleAviso(null);
    } catch {
      setDetalle(null);
      setDetalleAviso(
        `${id} todavía no tiene decisión registrada. Procesa la factura desde Entradas o con el botón Procesar para ver su descripción, bitácora y orden de pago.`,
      );
    }
  }, []);

  const recargar = useCallback(
    async (silencioso = false) => {
      if (cargando.current) return;
      cargando.current = true;
      try {
        const [configResp, resumenResp, facturasResp, aprobacionesResp, colaResp, notifResp, conResp, ejResp] =
          await Promise.all([
            api.config(),
            api.resumen(),
            api.facturas(),
            api.aprobaciones(),
            api.cola(),
            api.notificaciones(),
            api.conectores(),
            api.ejemplos(),
          ]);
        setConfig(configResp);
        setResumen(resumenResp);
        setFacturas(facturasResp.items);
        setAprobaciones(aprobacionesResp.items);
        setCola(colaResp.items);
        setModo(colaResp.modo);
        setNotificaciones(notifResp.items);
        setConectores(conResp.items);
        setEjemplos(ejResp.items);
        if (!silencioso) setError(null);

        if (seleccion) {
          try {
            setDetalle(await api.detalle(seleccion));
          } catch {
            setDetalle(null);
          }
        }

        try {
          setEvaluacion(await api.evaluacion());
          setEvaluacionError(null);
        } catch (causa) {
          setEvaluacion(null);
          setEvaluacionError(causa instanceof Error ? causa.message : String(causa));
        }
      } catch (causa) {
        if (!silencioso) setError(causa instanceof Error ? causa.message : String(causa));
      } finally {
        cargando.current = false;
      }
    },
    [seleccion],
  );

  useEffect(() => {
    void recargar();
  }, [recargar]);

  useEffect(() => {
    const intervalo = setInterval(() => {
      void recargar(true);
    }, 3000);
    return () => clearInterval(intervalo);
  }, [recargar]);

  useEffect(() => {
    setAviso(null);
    setError(null);
  }, [tab, vista]);

  useEffect(() => {
    if (vista !== 'sala' || !panelAbierto) return;
    const alTeclear = (evento: KeyboardEvent) => {
      if (evento.key === 'Escape') setPanelAbierto(false);
    };
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [vista, panelAbierto]);

  const ejecutar = useCallback(
    async (accion: () => Promise<string | void>) => {
      setTrabajando(true);
      setError(null);
      setAviso(null);
      try {
        const mensaje = await accion();
        if (typeof mensaje === 'string') {
          setAviso(mensaje);
        }
        await recargar(true);
        if (seleccion) await cargarDetalle(seleccion);
      } catch (causa) {
        setError(causa instanceof Error ? causa.message : String(causa));
      } finally {
        setTrabajando(false);
      }
    },
    [cargarDetalle, recargar, seleccion],
  );

  const refrescarSinMensaje = useCallback(
    () => {
      setAviso(null);
      void recargar(true);
      if (seleccion) void cargarDetalle(seleccion);
    },
    [cargarDetalle, recargar, seleccion],
  );

  const refrescarDetalle = useCallback(async () => {
    await recargar(true);
    if (seleccion) await cargarDetalle(seleccion);
  }, [cargarDetalle, recargar, seleccion]);

  const ocultarAviso = () => {
    setAviso(null);
  };

  const abrirDetalle = useCallback(
    async (id: string) => {
      setTab('facturas');
      setPanelAbierto(true);
      setSeleccion(id);
      setDetalle(null);
      setDetalleAviso(null);
      await cargarDetalle(id);
    },
    [cargarDetalle],
  );

  const abrirEstacion = useCallback((id: Tab) => {
    setTab(id);
    setPanelAbierto(true);
  }, []);

  const cargarAuditoria = useCallback(async (filtros: AuditFiltros) => {
    try {
      const r = await api.auditoria({
        invoiceId: filtros.invoiceId || undefined,
        actor: filtros.actor || undefined,
        tipo: filtros.tipo || undefined,
      });
      setAuditoria(r.items);
      setCadena(r.cadena);
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : String(causa));
    }
  }, []);

  useEffect(() => {
    if (tab === 'auditoria') {
      void cargarAuditoria({ invoiceId: '', actor: '', tipo: '' });
    }
  }, [tab, cargarAuditoria]);

  const procesarTodas = () =>
    ejecutar(async () => {
      const r = await api.procesar();
      return r.mensaje;
    });

  const procesarUna = (id: string) =>
    ejecutar(async () => {
      await api.procesarFactura(id);
      return `${id} en cola. El estado se actualiza en vivo.`;
    });

  const cambiarModo = (nuevo: IngestMode) =>
    ejecutar(async () => {
      await api.modoIngreso(nuevo);
      return nuevo === 'automatico'
        ? 'Modo automático: cada entrada nueva se encola sola.'
        : 'Modo manual: nada se procesa hasta pulsar Procesar.';
    });

  const ingestar = (entry: IngestEntry) =>
    ejecutar(async () => {
      const r = await api.ingestar(entry);
      return r.duplicada
        ? `Entrada duplicada: ya existía como ${r.invoiceId}. No se reprocesa.`
        : `Factura ${r.invoiceId} creada en estado ${r.queueState}${r.enCola ? ' y encolada.' : '. Pulsa Procesar para correr el agente.'}`;
    });

  const cargarSet = () =>
    ejecutar(async () => {
      const r = await api.cargarSet();
      return `Set completo: ${r.insertadas} nueva(s), ${r.duplicadas} ya existentes, ${r.enCola} en cola.`;
    });

  const decidir = (id: string, accion: 'aprobar' | 'rechazar', quien: string, comentario: string) =>
    ejecutar(async () => {
      await api.decidir(id, accion, quien, comentario);
      return `Decisión humana registrada sobre ${id} (${accion}).`;
    });

  const guardarReglas = (rules: RulesConfig) =>
    ejecutar(async () => {
      await api.guardarReglas(rules);
      return 'Reglas actualizadas. La pantalla de facturas se refresca con la configuración guardada.';
    });

  const reiniciar = () =>
    ejecutar(async () => {
      const r = await api.reiniciar();
      setSeleccion(null);
      setDetalle(null);
      setDetalleAviso(null);
      return `Demo reiniciada: ${r.facturas} facturas cargadas sin decisiones.`;
    });

  const responderNotificacion = (
    id: string,
    accion: 'aprobar' | 'rechazar',
    quien: string,
    comentario: string,
  ) =>
    ejecutar(async () => {
      await api.responderNotificacion(id, accion, quien, comentario);
      return `Respuesta registrada desde la notificación simulada (${accion}).`;
    });

  const mensajeNotificacion = async (id: string, mensaje: string, quien: string) => {
    await api.mensajeNotificacion(id, mensaje, quien);
    await recargar(true);
  };

  const responsable = config?.company.responsable ?? 'Marta Rincón';

  const contenido = (t: Tab) => {
    if (t === 'entradas') {
      return (
        <Entradas
          ejemplos={ejemplos}
          cola={cola}
          modo={modo}
          trabajando={trabajando}
          onModo={(m) => void cambiarModo(m)}
          onIngestar={(entry) => void ingestar(entry)}
          onCargarSet={() => void cargarSet()}
          onProcesarTodas={() => void procesarTodas()}
          onProcesar={(id) => void procesarUna(id)}
          onRefrescar={() => void recargar()}
        />
      );
    }

    if (t === 'facturas') {
      return (
        <>
          {resumen && (
            <SummaryPanel
              resumen={resumen}
              evaluacion={evaluacion}
              evaluacionError={evaluacionError}
            />
          )}

          <div className="barra-acciones">
            <button className="primario" disabled={trabajando} onClick={() => void procesarTodas()}>
              {trabajando ? 'Procesando…' : 'Procesar facturas pendientes'}
            </button>
            <button className="secundario" disabled={trabajando} onClick={() => void refrescarSinMensaje()}>
              Actualizar
            </button>
            <a className="boton-enlace" href={api.urlExportFacturas()} download>
              Exportar CSV
            </a>
            <button className="secundario" disabled={trabajando} onClick={() => void reiniciar()}>
              Reiniciar demo
            </button>
            <span className="motivo">
              La cola procesa de una en una; los estados se actualizan en vivo.
            </span>
          </div>

          <div className="panel">
            <h2>Facturas y decisiones</h2>
            <InvoicesTable
              items={facturas}
              seleccion={seleccion}
              onSeleccionar={(id) => void abrirDetalle(id)}
            />
          </div>

          {detalleAviso && <div className="aviso info">{detalleAviso}</div>}
          {detalle && (
            <InvoiceDetail detalle={detalle} onActualizar={() => void refrescarDetalle()} />
          )}
        </>
      );
    }

    if (t === 'aprobaciones') {
      return (
        <div className="panel">
          <h2>Escaladas pendientes de aprobación</h2>
          <Approvals items={aprobaciones} trabajando={trabajando} onDecidir={decidir} />
        </div>
      );
    }

    if (t === 'reglas' && config) {
      return (
        <RulesForm
          config={config}
          trabajando={trabajando}
          onGuardar={(rules) => {
            void guardarReglas(rules);
          }}
        />
      );
    }

    if (t === 'chat') {
      return (
        <Chat
          facturas={facturas}
          responsable={responsable}
          onCambio={() => void recargar(true)}
        />
      );
    }

    if (t === 'notificaciones') {
      return (
        <Notifications
          items={notificaciones}
          trabajando={trabajando}
          onResponder={(id, accion, quien, comentario) =>
            void responderNotificacion(id, accion, quien, comentario)
          }
          onMensaje={mensajeNotificacion}
          onAbrirFactura={(id) => void abrirDetalle(id)}
        />
      );
    }

    if (t === 'conectores') {
      return <Connectors items={conectores} />;
    }

    if (t === 'auditoria') {
      return (
        <Audit
          items={auditoria}
          cadena={cadena}
          trabajando={trabajando}
          onFiltrar={(filtros) => void cargarAuditoria(filtros)}
          onRefrescar={() => void cargarAuditoria({ invoiceId: '', actor: '', tipo: '' })}
        />
      );
    }

    return null;
  };

  const datosSala = useMemo(() => ({ facturas, resumen }), [facturas, resumen]);
  const procesadas = resumen ? resumen.total - resumen.porProcesar : facturas.filter((f) => f.procesada).length;
  const porProcesar = resumen?.porProcesar ?? Math.max(0, facturas.length - procesadas);
  const pagadas = resumen?.pagados ?? 0;
  const escaladas = resumen?.pendientes ?? aprobaciones.length;
  const frenadas = resumen?.frenados ?? 0;
  const presupuesto = resumen?.presupuesto;
  const movimientos = facturas
    .filter((f) => f.procesada && f.decisionFinal)
    .sort((a, b) => (b.actualizadoEn ?? '').localeCompare(a.actualizadoEn ?? ''))
    .slice(0, 4);

  if (vista === 'clasica') {
    return (
      <div className="app">
        <header className="cabecera">
          <div>
            <h1>PayBlink · agente de pagos</h1>              <div className="lema">
                El modelo propone, el código decide: nada se paga si alguna regla se escala o bloquea.
              </div>
          </div>
          <div className="llm">
            {config ? (
              <>
                LLM: {config.llm.modo}
                <br />
                Estrategia: {config.llm.estrategia} · pasos máx.: {config.llm.maxSteps}
                <br />
                {config.company.nombre} · disparo: {modo}
              </>
            ) : (
              'Cargando configuración…'
            )}
            <div style={{ marginTop: 8 }}>
              <button className="secundario" onClick={() => setVista('sala')}>
                Abrir sala 3D
              </button>
            </div>
          </div>
        </header>

        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'activo' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'aprobaciones' && aprobaciones.length > 0 ? ` (${aprobaciones.length})` : ''}
              {t.id === 'notificaciones' && notificaciones.some((n) => n.estado !== 'respondido')
                ? ' •'
                : ''}
            </button>
          ))}
        </div>

        {error && (
          <div className="aviso error" style={{ cursor: 'pointer' }} onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {aviso && !error && (
          <div className="aviso info" style={{ cursor: 'pointer' }} onClick={() => ocultarAviso()}>
            {aviso}
          </div>
        )}

        {contenido(tab)}

        <div className="pie">
          Datos ficticios. El agente no mueve dinero ni se conecta a plataformas de pago. Cada
          decisión queda registrada con su rastro de reglas, su descripción y su bitácora de
          auditoría.
        </div>
      </div>
    );
  }

  return (
    <div className={`sala3d-shell ${panelAbierto ? 'con-panel' : ''}`}>
      <Scene3D
        datos={datosSala}
        seleccion={seleccion}
        estacion={tab}
        panelAbierto={panelAbierto}
        onEstacion={abrirEstacion}
        onFactura={(id) => void abrirDetalle(id)}
        onClasica={() => setVista('clasica')}
      />

      <header className="barra-sala">
        <div className="marca-sala">
          <span className="estrella-sala" />
          <div>
            <h1>PayBlink</h1>
            <span>sala de decisiones · el LLM propone, el código decide</span>
          </div>
        </div>

        <div className="estado-sala">
          <span>{config ? `LLM: ${config.llm.modo}` : 'cargando…'}</span>
          <span>disparo: {modo}</span>
          <span className={aprobaciones.length > 0 ? 'chip-sala alerta' : 'chip-sala'}>
            {aprobaciones.length} escaladas
          </span>
        </div>

        <div className="acciones-sala">
          <button
            className="primario"
            disabled={trabajando || porProcesar === 0}
            onClick={() => void procesarTodas()}
          >
            {trabajando ? 'Procesando…' : `Procesar pendientes (${porProcesar})`}
          </button>            <button className="secundario" disabled={trabajando} onClick={() => void refrescarSinMensaje()}>
              Actualizar
            </button>
          <button className="secundario" onClick={() => setVista('clasica')}>
            Vista clásica
          </button>
        </div>
      </header>        {error && (
          <div className="aviso error toast-sala" style={{ cursor: 'pointer' }} onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {aviso && !error && (
          <div className="aviso info toast-sala" style={{ cursor: 'pointer' }} onClick={() => ocultarAviso()}>
            {aviso}
          </div>
        )}

      <aside className="panel-sala">
        <h2>Operación en vivo</h2>
        <div className="mini-tarjetas">
          <div>
            <strong>{procesadas}</strong>
            <span>procesadas</span>
          </div>
          <div>
            <strong className="verde">{pagadas}</strong>
            <span>pagadas</span>
          </div>
          <div>
            <strong className="ambar">{escaladas}</strong>
            <span>escaladas</span>
          </div>
          <div>
            <strong className="rojo">{frenadas}</strong>
            <span>frenadas</span>
          </div>
          <div>
            <strong>{porProcesar}</strong>
            <span>por procesar</span>
          </div>
        </div>

        {presupuesto && (
          <div className="presupuesto-sala">
            <div className="fila-entre">
              <span>Presupuesto</span>
              <span className="mono">{presupuesto.utilizadoPct.toFixed(1)}%</span>
            </div>
            <div className="barra">
              <div style={{ width: `${Math.min(100, presupuesto.utilizadoPct)}%` }} />
            </div>
            <div className="motivo">
              {dinero(presupuesto.disponible)} disponibles de{' '}
              {dinero(presupuesto.presupuestoPeriodo)} {presupuesto.monedaBase}
            </div>
          </div>
        )}

        <h3>Últimas decisiones</h3>
        <div className="movimientos-sala">
          {movimientos.map((m) => (
            <button key={m.id} className="movimiento" onClick={() => void abrirDetalle(m.id)}>
              <span className={`punto-estado ${m.decisionFinal ?? ''}`} />
              <span className="movimiento-texto">
                <strong>{m.id}</strong>
                <span>
                  {m.decisionFinal ? DECISION_LABEL[m.decisionFinal] : 'sin decisión'}
                  {m.beneficiario ? ` · ${m.beneficiario}` : ''}
                </span>
              </span>
            </button>
          ))}
          {movimientos.length === 0 && (
            <div className="vacio">Todavía no hay decisiones. Procesa una factura para ver el flujo.</div>
          )}
        </div>

        <div className="leyenda-sala">
          <span>
            <i className="verde" /> Pagar
          </span>
          <span>
            <i className="ambar" /> Escalar
          </span>
          <span>
            <i className="rojo" /> Frenar
          </span>
        </div>

        <p className="pie-sala">
          Haz clic en una estación para abrir su pantalla. Haz clic en una factura de la cinta para
          ver su detalle.
        </p>
      </aside>

      <nav className="dock-sala" aria-label="Estaciones de la sala">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id && panelAbierto ? 'activo' : ''}
            onClick={() => abrirEstacion(t.id)}
          >
            {t.label}
            {t.id === 'aprobaciones' && aprobaciones.length > 0 ? ` (${aprobaciones.length})` : ''}
            {t.id === 'notificaciones' && notificaciones.some((n) => n.estado !== 'respondido')
              ? ' •'
              : ''}
          </button>
        ))}
      </nav>

      {panelAbierto && (
        <aside className="drawer-sala" aria-label={`Panel de ${SALA_LABEL[tab]}`}>
          <div className="drawer-cabecera">
            <div>
              <span className="sobre-sala">Estación</span>
              <h2>{SALA_LABEL[tab]}</h2>
              <span className="motivo-sala">Datos en vivo · Esc para cerrar</span>
            </div>
            <button
              className="cerrar-sala"
              aria-label="Cerrar panel"
              onClick={() => setPanelAbierto(false)}
            >
              ✕
            </button>
          </div>
          <div className="drawer-cuerpo">{contenido(tab)}</div>
        </aside>
      )}
    </div>
  );
}
