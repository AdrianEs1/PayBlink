import { useState, type ChangeEvent } from 'react';
import {
  QUEUE_STATE_LABEL,
  type IngestEntry,
  type IngestExample,
  type IngestMode,
  type QueueItem,
} from '@blinka/shared';
import { api, type IngestPreview } from '../api';

function leerArchivoComoBase64(archivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => {
      const resultado = String(lector.result ?? '');
      resolve(resultado.includes(',') ? resultado.split(',')[1] ?? '' : resultado);
    };
    lector.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    lector.readAsDataURL(archivo);
  });
}

export function Entradas({
  ejemplos,
  cola,
  modo,
  trabajando,
  onModo,
  onIngestar,
  onCargarSet,
  onProcesarTodas,
  onProcesar,
  onRefrescar,
}: {
  ejemplos: IngestExample[];
  cola: QueueItem[];
  modo: IngestMode;
  trabajando: boolean;
  onModo: (modo: IngestMode) => void;
  onIngestar: (entry: IngestEntry) => void;
  onCargarSet: () => void;
  onProcesarTodas: () => void;
  onProcesar: (id: string) => void;
  onRefrescar: () => void;
}) {
  const [tipo, setTipo] = useState<'pdf' | 'correo' | 'chat'>('correo');
  const [remitente, setRemitente] = useState('proveedor@ejemplo-ficticio.co');
  const [asunto, setAsunto] = useState('Factura de prueba');
  const [cuerpo, setCuerpo] = useState(
    'Beneficiario: Ferretería El Tornillo S.A.S.\nMonto: $ 2.450.000,00 COP\nFecha de vencimiento: 2026-10-25\nReferencia: OC-2026-0451\nConcepto: Tornillería y herramienta menor',
  );
  const [canal, setCanal] = useState<'slack' | 'whatsapp' | 'interno'>('slack');
  const [archivo, setArchivo] = useState<{ nombre: string; base64: string } | null>(null);
  const [vistaPrevia, setVistaPrevia] = useState<IngestPreview | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const pendientes = cola.filter((c) => !c.decisionFinal).length;
  const procesando = cola.filter((c) => c.queueState === 'procesando').length;
  const enCola = cola.filter((c) => c.queueState === 'en_cola').length;

  const probarLectura = async (nombre: string, base64: string) => {
    setLeyendo(true);
    setVistaPrevia(null);
    try {
      const resultado = await api.previsualizar({ tipo: 'pdf', archivoNombre: nombre, archivoBase64: base64 });
      setVistaPrevia(resultado);
      setError(null);
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : String(causa));
    } finally {
      setLeyendo(false);
    }
  };

  const seleccionarArchivo = async (evento: ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setVistaPrevia(null);
    const file = evento.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Por ahora solo se aceptan archivos PDF en esta pestaña.');
      return;
    }
    try {
      const base64 = await leerArchivoComoBase64(file);
      setArchivo({ nombre: file.name, base64 });
      await probarLectura(file.name, base64);
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : String(causa));
    }
  };

  const enviar = () => {
    setError(null);
    let entry: IngestEntry;
    if (tipo === 'pdf') {
      if (!archivo) {
        setError('Selecciona primero un PDF.');
        return;
      }
      entry = { tipo: 'pdf', archivoNombre: archivo.nombre, archivoBase64: archivo.base64 };
    } else if (tipo === 'correo') {
      entry = { tipo: 'correo', remitente, asunto, cuerpo };
    } else {
      entry = { tipo: 'chat', remitente, canal, cuerpo };
    }

    setEnviando(true);
    try {
      onIngestar(entry);
      if (tipo === 'pdf') {
        setArchivo(null);
        setVistaPrevia(null);
      }
    } finally {
      setEnviando(false);
    }
  };

  const pdfIlegible = vistaPrevia?.texto.startsWith('PDF ilegible') ?? false;

  return (
    <>
      <div className="panel">
        <h2>Simulador de entradas</h2>
        <div className="aviso info">
          Simulación: las facturas se crean como <strong>pendientes</strong>. Crear la entrada no ejecuta
          al agente; eso lo decide el interruptor de abajo o el botón Procesar.
        </div>

        <div className="subtab">
          <button className={tipo === 'pdf' ? 'activo' : ''} onClick={() => setTipo('pdf')}>
            Subir PDF
          </button>
          <button className={tipo === 'correo' ? 'activo' : ''} onClick={() => setTipo('correo')}>
            Redactar correo
          </button>
          <button className={tipo === 'chat' ? 'activo' : ''} onClick={() => setTipo('chat')}>
            Mensaje de chat
          </button>
        </div>

        {tipo === 'pdf' && (
          <>
            <div className="grid-2">
              <div className="campo">
                <label>Archivo PDF (opcional: imagen en una versión futura)</label>
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(e) => void seleccionarArchivo(e)}
                />
                {archivo && (
                  <span className="motivo">
                    {archivo.nombre} · {(archivo.base64.length * 0.75 / 1024).toFixed(1)} KB
                  </span>
                )}
              </div>
              <div className="aviso info">
                La lectura se prueba al elegir el archivo: verás el texto que el agente recibirá
                antes de crear la factura. Si el PDF es ilegible, el agente no inventa datos: la
                factura queda escalada con la descripción del fallo.
              </div>
            </div>

            {(leyendo || vistaPrevia) && (
              <div className="vista-previa-pdf">
                <div className="fila-entre">
                  <strong>
                    {leyendo
                      ? 'Leyendo PDF…'
                      : `Lectura del PDF · ${vistaPrevia?.caracteres ?? 0} caracteres extraídos`}
                  </strong>
                  {vistaPrevia && (
                    <span className={`insignia ${pdfIlegible ? 'bloquea' : 'pasa'}`}>
                      {pdfIlegible ? 'Ilegible' : 'Texto leído'}
                    </span>
                  )}
                </div>
                {vistaPrevia && (
                  <pre className="texto-factura">
                    {vistaPrevia.texto}
                    {vistaPrevia.truncado ? '\n… (texto recortado)' : ''}
                  </pre>
                )}
                {vistaPrevia && (
                  <div className="barra-acciones" style={{ marginBottom: 0 }}>
                    <button
                      className="secundario"
                      disabled={leyendo || !archivo}
                      onClick={() => archivo && void probarLectura(archivo.nombre, archivo.base64)}
                    >
                      Volver a leer
                    </button>
                    <span className="motivo">
                      {pdfIlegible
                        ? 'Sin texto legible: al procesarla, el agente la escalará. No se inventan datos.'
                        : 'Este es el texto exacto que usará la extracción del agente.'}
                    </span>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {tipo === 'correo' && (
          <div className="grid-2">
            <div>
              <div className="campo">
                <label>Remitente</label>
                <input type="text" value={remitente} onChange={(e) => setRemitente(e.target.value)} />
              </div>
              <div className="campo">
                <label>Asunto</label>
                <input type="text" value={asunto} onChange={(e) => setAsunto(e.target.value)} />
              </div>
            </div>
            <div className="campo">
              <label>Cuerpo del correo</label>
              <textarea value={cuerpo} onChange={(e) => setCuerpo(e.target.value)} />
            </div>
          </div>
        )}

        {tipo === 'chat' && (
          <div className="grid-2">
            <div>
              <div className="campo">
                <label>Remitente</label>
                <input type="text" value={remitente} onChange={(e) => setRemitente(e.target.value)} />
              </div>
              <div className="campo">
                <label>Canal simulado</label>
                <select value={canal} onChange={(e) => setCanal(e.target.value as typeof canal)}>
                  <option value="slack">Slack</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="interno">Chat interno</option>
                </select>
              </div>
            </div>
            <div className="campo">
              <label>Texto del mensaje</label>
              <textarea value={cuerpo} onChange={(e) => setCuerpo(e.target.value)} />
            </div>
          </div>
        )}

        {error && <div className="aviso error">{error}</div>}

        <div className="barra-acciones">
          <button className="primario" disabled={enviando || trabajando} onClick={enviar}>
            {enviando ? 'Creando…' : 'Crear factura pendiente'}
          </button>
          <button className="secundario" disabled={trabajando} onClick={onCargarSet}>
            Cargar set completo (carpeta demo)
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Galería de ejemplos</h2>
        <div className="galeria">
          {ejemplos.map((ejemplo) => (
            <div key={ejemplo.id} className={`tarjeta ejemplo ${ejemplo.caso}`}>
              <div className="fila-entre">
                <strong>{ejemplo.titulo}</strong>
                <span className={`insignia ${ejemplo.caso === 'trampa' ? 'escala' : 'pasa'}`}>
                  {ejemplo.caso}
                </span>
              </div>
              <div className="motivo" style={{ margin: '6px 0 10px' }}>
                {ejemplo.descripcion}
              </div>
              <button
                className="secundario"
                disabled={trabajando}
                onClick={() => onIngestar(ejemplo.entry)}
              >
                Cargar ejemplo
              </button>
            </div>
          ))}
          {ejemplos.length === 0 && <div className="vacio">No hay ejemplos configurados.</div>}
        </div>
      </div>

      <div className="panel">
        <div className="fila-entre">
          <h2>Cola y disparador del agente</h2>
          <button className="secundario" onClick={onRefrescar}>
            Actualizar
          </button>
        </div>

        <div className="trigger">
          <div>
            <strong>Modo de disparo</strong>
            <div className="motivo">
              En manual nada se procesa hasta pulsar el botón. En automático, cada entrada se encola sola
              (simula el webhook de producción).
            </div>
          </div>
          <div className="subtab">
            <button className={modo === 'manual' ? 'activo' : ''} onClick={() => onModo('manual')}>
              Manual
            </button>
            <button className={modo === 'automatico' ? 'activo' : ''} onClick={() => onModo('automatico')}>
              Automático
            </button>
          </div>
        </div>

        <div className="barra-acciones" style={{ marginTop: 12 }}>
          <button className="primario" disabled={trabajando || pendientes === 0} onClick={onProcesarTodas}>
            Procesar todas las pendientes ({pendientes})
          </button>
          <span className="motivo">
            {enCola} en cola · {procesando} procesando · la cola trabaja de una en una
          </span>
        </div>

        <div className="tabla-scroll">
          <table>
            <thead>
              <tr>
                <th>Factura</th>
                <th>Fuente</th>
                <th>Estado</th>
                <th>Intentos</th>
                <th>Error</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cola.map((item) => (
                <tr key={item.id} style={{ cursor: 'default' }}>
                  <td className="mono">{item.id}</td>
                  <td className="motivo">{item.fuente?.etiqueta ?? '—'}</td>
                  <td>
                    <span className={`insignia cola-${item.queueState}`}>
                      {QUEUE_STATE_LABEL[item.queueState]}
                    </span>
                  </td>
                  <td className="mono">{item.intentos}</td>
                  <td className="motivo">{item.ultimoError ?? '—'}</td>
                  <td>
                    {!item.decisionFinal && item.queueState !== 'procesando' && (
                      <button
                        className="secundario"
                        disabled={trabajando}
                        onClick={() => onProcesar(item.id)}
                      >
                        Procesar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {cola.length === 0 && (
                <tr>
                  <td colSpan={6} className="vacio">
                    No hay facturas en la cola.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
