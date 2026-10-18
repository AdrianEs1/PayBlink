import { useEffect, useRef, useState } from 'react';
import { SalaEscena } from './SalaEscena';
import type { SalaDatos, SalaId } from './tipos';

export function Scene3D({
  datos,
  seleccion,
  estacion,
  panelAbierto,
  onEstacion,
  onFactura,
  onClasica,
}: {
  datos: SalaDatos;
  seleccion: string | null;
  estacion: SalaId;
  panelAbierto: boolean;
  onEstacion: (id: SalaId) => void;
  onFactura: (id: string) => void;
  onClasica: () => void;
}) {
  const contenedor = useRef<HTMLDivElement>(null);
  const escena = useRef<SalaEscena | null>(null);
  const callbacks = useRef({ onEstacion, onFactura });
  const [fallo, setFallo] = useState<string | null>(null);
  callbacks.current = { onEstacion, onFactura };

  useEffect(() => {
    const nodo = contenedor.current;
    if (!nodo) return;

    try {
      escena.current = new SalaEscena(nodo, {
        onEstacion: (id) => callbacks.current.onEstacion(id),
        onFactura: (id) => callbacks.current.onFactura(id),
      });
      setFallo(null);
    } catch (causa) {
      setFallo(
        causa instanceof Error
          ? causa.message
          : 'No se pudo iniciar WebGL en este navegador.',
      );
    }

    return () => {
      escena.current?.dispose();
      escena.current = null;
    };
  }, []);

  useEffect(() => {
    escena.current?.setDatos(datos);
  }, [datos]);

  useEffect(() => {
    escena.current?.seleccionar(seleccion);
  }, [seleccion]);

  useEffect(() => {
    if (panelAbierto) escena.current?.enfocar(estacion);
  }, [estacion, panelAbierto]);

  return (
    <div className="lienzo3d" ref={contenedor}>
      {fallo && (
        <div className="fallo-3d">
          <strong>No se pudo abrir la sala 3D</strong>
          <p>{fallo}</p>
          <p>La vista clásica conserva todas las pantallas y acciones.</p>
          <button className="primario" onClick={onClasica}>
            Usar vista clásica
          </button>
        </div>
      )}
      {!fallo && (
        <div className="ayuda-3d">
          <span>Arrastra para orbitar · rueda para acercar · botón derecho para desplazar · WASD o flechas para caminar</span>
          <button className="secundario" onClick={() => escena.current?.resetVista()}>
            Centrar vista
          </button>
        </div>
      )}
    </div>
  );
}
