import type { QueueState } from '@blinka/shared';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SalaDatos, SalaId } from './tipos';

/**
 * Oficina 3D del agente: un diorama con mobiliario real y una persona encargada
 * por área. El flujo del agente corre por la banda central (recepción →
 * extracción → reglas → LLM → GUARD) y cada factura es una hoja que se mueve
 * según su estado real en la cola.
 *
 * La escena es imperativa a propósito: se construye una vez y recibe datos con
 * `setDatos`, sin que un re-render de React reconstruya geometría ni texturas.
 */

const PALETA = {
  fondo: 0x070d14,
  suelo: 0x151f2b,
  panel: 0x0a1420,
  borde: 0x1c3a55,
  acento: 0x3fa7ff,
  verde: 0x2fbf71,
  ambar: 0xe8a33d,
  rojo: 0xe2574c,
  violeta: 0x9a7dff,
  teal: 0x57e0c0,
  texto: '#e8eef5',
  suave: '#9fb0c3',
} as const;

const OFICINA = { ancho: 46, profundidad: 30, altoMuro: 6.5, grosorMuro: 0.3 };
const CANTIDAD_FLUJO = 34;
/** Los personajes se ven un poco más grandes que a escala 1:1. */
const ESCALA_TRABAJADOR = 1.16;
/** Desplazamiento con teclado: unidades por segundo (x2,6 con Mayús). */
const PASO_TECLADO = 13;
/** Teclas que mueven la vista por la oficina. */
const TECLAS_MOVIMIENTO = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
];
const ARRIBA = new THREE.Vector3(0, 1, 0);

interface EstacionDef {
  id: SalaId;
  nombre: string;
  x: number;
  z: number;
  color: number;
}

const ESTACIONES: EstacionDef[] = [
  { id: 'entradas', nombre: 'Entradas', x: -17, z: 9.5, color: PALETA.acento },
  { id: 'facturas', nombre: 'Facturas', x: -5.5, z: 9.5, color: PALETA.teal },
  { id: 'reglas', nombre: 'Reglas', x: 5.5, z: 9.5, color: PALETA.ambar },
  { id: 'chat', nombre: 'Chat', x: 16.5, z: 9.5, color: PALETA.violeta },
  { id: 'conectores', nombre: 'Conectores', x: -17, z: -9.5, color: PALETA.acento },
  { id: 'notificaciones', nombre: 'Notificaciones', x: -5.5, z: -9.5, color: PALETA.ambar },
  { id: 'aprobaciones', nombre: 'Aprobaciones', x: 5.5, z: -9.5, color: PALETA.ambar },
  { id: 'auditoria', nombre: 'Auditoría', x: 16.5, z: -9.5, color: PALETA.violeta },
];

/**
 * Personal de cada área. Marta Rincón y Carlos Peña provienen de
 * `data/approvers.json`; el resto es personal ficticio de la misma empresa.
 */
interface Persona {
  nombre: string;
  cargo: string;
  camisa: number;
  piel: number;
  pelo: number;
  sentado: boolean;
  lado: 1 | -1;
}

const PERSONAL: Record<SalaId, Persona> = {
  entradas: { nombre: 'Ana Rodríguez', cargo: 'Recepción de facturas', camisa: 0x4a6fa5, piel: 0xf0c8a8, pelo: 0x2f2119, sentado: true, lado: 1 },
  facturas: { nombre: 'Diego Salazar', cargo: 'Analista de facturas', camisa: 0x4f8f8c, piel: 0xd9a879, pelo: 0x1b1512, sentado: true, lado: -1 },
  aprobaciones: { nombre: 'Marta Rincón', cargo: 'Gerente Financiera', camisa: 0x8a6fb0, piel: 0xe6b48f, pelo: 0x3a2a20, sentado: false, lado: 1 },
  reglas: { nombre: 'Sofía Vargas', cargo: 'Control de reglas', camisa: 0x6f7a8c, piel: 0xf0c8a8, pelo: 0x53381f, sentado: true, lado: 1 },
  chat: { nombre: 'Luis Moreno', cargo: 'Mesa de ayuda', camisa: 0x5b8c7a, piel: 0xb07b52, pelo: 0x120f0d, sentado: true, lado: -1 },
  notificaciones: { nombre: 'Carlos Peña', cargo: 'Director de Finanzas', camisa: 0x9c7a56, piel: 0xc98a5e, pelo: 0x201812, sentado: false, lado: -1 },
  conectores: { nombre: 'Camila Rojas', cargo: 'Integraciones', camisa: 0x4f7ea8, piel: 0x8a5a3b, pelo: 0x0e0b09, sentado: true, lado: 1 },
  auditoria: { nombre: 'Elena Pardo', cargo: 'Auditoría', camisa: 0x8f7f9c, piel: 0xe6b48f, pelo: 0x6b4a2a, sentado: true, lado: -1 },
};

interface NodoEstacion {
  def: EstacionDef;
  grupo: THREE.Group;
  etiqueta: Etiqueta;
}

interface NodoFactura {
  grupo: THREE.Group;
  etiqueta: Etiqueta;
  papel: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  led: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  destino: THREE.Vector3;
  estado: QueueState;
  semilla: number;
  procesandoT: number;
}

interface Trabajador {
  grupo: THREE.Group;
  brazos: THREE.Group[];
  cabeza: THREE.Object3D;
  fase: number;
}

interface Etiqueta {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  textura: THREE.CanvasTexture;
}

interface SalidaDef {
  nombre: string;
  subtitulo: string;
  x: number;
  z: number;
  color: number;
}

const SALIDAS: SalidaDef[] = [
  { nombre: 'PAGAR', subtitulo: 'sale sin humano', x: 19, z: 5, color: PALETA.verde },
  { nombre: 'ESCALAR', subtitulo: 'decide una persona', x: 19, z: 0, color: PALETA.ambar },
  { nombre: 'FRENAR', subtitulo: 'regla de bloqueo', x: 19, z: -5, color: PALETA.rojo },
];

interface NodoProceso {
  nombre: string;
  subtitulo: string;
  x: number;
  color: number;
  estacion: SalaId;
  icono: 'inbox' | 'scan' | 'rules' | 'ai' | 'shield';
}

const PROCESO: NodoProceso[] = [
  { nombre: 'Recepción', subtitulo: 'PDF · correo · chat', x: -14, color: PALETA.acento, estacion: 'entradas', icono: 'inbox' },
  { nombre: 'Extracción', subtitulo: 'normaliza y verifica', x: -8, color: PALETA.violeta, estacion: 'entradas', icono: 'scan' },
  { nombre: 'Reglas', subtitulo: '8 verificaciones', x: -2, color: PALETA.ambar, estacion: 'reglas', icono: 'rules' },
  { nombre: 'LLM', subtitulo: 'propone, no decide', x: 4, color: PALETA.violeta, estacion: 'chat', icono: 'ai' },
  { nombre: 'GUARD', subtitulo: 'la decisión final', x: 9.5, color: PALETA.teal, estacion: 'facturas', icono: 'shield' },
];

/* ------------------------------------------------------------------ */
/* Utilidades de dibujo                                               */
/* ------------------------------------------------------------------ */

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Marca una geometría o material compartido para no liberarlo al desmontar. */
function compartido<T extends { userData: { [clave: string]: unknown } }>(recurso: T): T {
  recurso.userData.compartido = true;
  return recurso;
}

function malla(
  geometria: THREE.BufferGeometry,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const figura = new THREE.Mesh(geometria, material);
  figura.position.set(x, y, z);
  return figura;
}

function trazarRectanguloRedondeado(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ancho: number,
  alto: number,
  radio: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + radio, y);
  ctx.lineTo(x + ancho - radio, y);
  ctx.quadraticCurveTo(x + ancho, y, x + ancho, y + radio);
  ctx.lineTo(x + ancho, y + alto - radio);
  ctx.quadraticCurveTo(x + ancho, y + alto, x + ancho - radio, y + alto);
  ctx.lineTo(x + radio, y + alto);
  ctx.quadraticCurveTo(x, y + alto, x, y + alto - radio);
  ctx.lineTo(x, y + radio);
  ctx.quadraticCurveTo(x, y, x + radio, y);
  ctx.closePath();
}

function pintarEtiqueta(
  etiqueta: Etiqueta,
  titulo: string,
  subtitulo: string,
  color: number,
): void {
  const { ctx, canvas } = etiqueta;
  const ancho = canvas.width;
  const alto = canvas.height;
  ctx.clearRect(0, 0, ancho, alto);

  trazarRectanguloRedondeado(ctx, 3, 3, ancho - 6, alto - 6, 20);
  ctx.fillStyle = 'rgba(8, 16, 25, 0.9)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = hex(color);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETA.texto;
  let tamano = 46;
  ctx.font = `700 ${tamano}px "Segoe UI", Roboto, Helvetica, sans-serif`;
  while (ctx.measureText(titulo).width > ancho - 52 && tamano > 24) {
    tamano -= 2;
    ctx.font = `700 ${tamano}px "Segoe UI", Roboto, Helvetica, sans-serif`;
  }
  ctx.fillText(titulo, 26, 70);

  ctx.fillStyle = PALETA.suave;
  ctx.font = '400 26px "Segoe UI", Roboto, Helvetica, sans-serif';
  ctx.fillText(subtitulo, 26, 122, ancho - 52);
}

function crearEtiqueta(
  titulo: string,
  subtitulo: string,
  color: number,
  anchoMundo: number,
): Etiqueta {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo crear el contexto 2D para las etiquetas.');

  const textura = new THREE.CanvasTexture(canvas);
  textura.colorSpace = THREE.SRGBColorSpace;
  textura.anisotropy = 8;

  const material = new THREE.SpriteMaterial({
    map: textura,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(anchoMundo, anchoMundo * (canvas.height / canvas.width), 1);

  const etiqueta: Etiqueta = { sprite, canvas, ctx, textura };
  pintarEtiqueta(etiqueta, titulo, subtitulo, color);
  return etiqueta;
}

/** Placa de escritorio con el cargo de la persona. */
function crearPlaca(cargo: string, color: number): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    trazarRectanguloRedondeado(ctx, 4, 4, 504, 120, 16);
    ctx.fillStyle = 'rgba(10, 20, 30, 0.95)';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = hex(color);
    ctx.stroke();
    ctx.fillStyle = PALETA.texto;
    ctx.font = '700 50px "Segoe UI", Roboto, Helvetica, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(cargo, 26, 66, 462);
  }
  const textura = new THREE.CanvasTexture(canvas);
  textura.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshStandardMaterial({
    map: textura,
    roughness: 0.5,
    metalness: 0.2,
    emissive: color,
    emissiveIntensity: 0.08,
  });
  const placa = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.3, 0.05), material);
  placa.rotation.x = -0.22;
  return placa;
}

/** Hueco de vidrio: deja ver el jardín del exterior. */
function crearVentana(ancho: number, alto: number): THREE.Group {
  const grupo = new THREE.Group();

  const vidrio = new THREE.MeshPhysicalMaterial({
    color: 0xbfe6f5,
    roughness: 0.04,
    metalness: 0,
    transparent: true,
    opacity: 0.16,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    depthWrite: false,
  });
  grupo.add(malla(new THREE.PlaneGeometry(ancho, alto), vidrio));

  const marco = new THREE.MeshStandardMaterial({ color: 0x22303f, roughness: 0.6, metalness: 0.35 });
  const grosor = 0.12;
  grupo.add(malla(new THREE.BoxGeometry(ancho + 0.24, grosor, 0.14), marco, 0, alto / 2 + 0.06, 0));
  grupo.add(malla(new THREE.BoxGeometry(ancho + 0.24, grosor, 0.14), marco, 0, -alto / 2 - 0.06, 0));
  grupo.add(malla(new THREE.BoxGeometry(grosor, alto + 0.24, 0.14), marco, -ancho / 2 - 0.06, 0, 0));
  grupo.add(malla(new THREE.BoxGeometry(grosor, alto + 0.24, 0.14), marco, ancho / 2 + 0.06, 0, 0));
  grupo.add(malla(new THREE.BoxGeometry(0.07, alto, 0.1), marco, 0, 0, 0.02));
  return grupo;
}

/** Pizarra con el flujo del proceso. */
function crearPizarra(): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 220;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#eef2f6';
    ctx.fillRect(0, 0, 512, 220);
    ctx.strokeStyle = '#c3ced9';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 506, 214);
    ctx.fillStyle = '#12202e';
    ctx.font = '700 34px "Segoe UI", Roboto, Helvetica, sans-serif';
    ctx.fillText('Proceso de decisión', 24, 52);
    ctx.font = '400 25px "Segoe UI", Roboto, Helvetica, sans-serif';
    const lineas = [
      '1. Llega la factura (PDF, correo o chat)',
      '2. Se extrae y se verifica el texto',
      '3. Pasan las 8 reglas de la empresa',
      '4. El modelo propone; el código decide',
    ];
    lineas.forEach((linea, indice) => {
      ctx.fillStyle = '#2b465c';
      ctx.fillText(linea, 26, 96 + indice * 31);
    });
    ctx.strokeStyle = '#3fa7ff';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(452, 40);
    ctx.lineTo(452, 190);
    ctx.stroke();
  }
  const textura = new THREE.CanvasTexture(canvas);
  textura.colorSpace = THREE.SRGBColorSpace;
  return malla(
    new THREE.PlaneGeometry(7, 3),
    new THREE.MeshStandardMaterial({ map: textura, roughness: 0.85 }),
  );
}

/* ------------------------------------------------------------------ */
/* Personas y mobiliario                                              */
/* ------------------------------------------------------------------ */

const G = {
  cabeza: compartido(new THREE.SphereGeometry(0.15, 16, 12)),
  pelo: compartido(new THREE.SphereGeometry(0.156, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.6)),
  cuello: compartido(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 8)),
  torso: compartido(new THREE.BoxGeometry(0.42, 0.52, 0.24)),
  hombros: compartido(new THREE.BoxGeometry(0.5, 0.12, 0.24)),
  brazo: compartido(new THREE.BoxGeometry(0.095, 0.3, 0.095)),
  antebrazo: compartido(new THREE.BoxGeometry(0.085, 0.28, 0.085)),
  mano: compartido(new THREE.SphereGeometry(0.055, 8, 8)),
  cadera: compartido(new THREE.BoxGeometry(0.36, 0.18, 0.4)),
  muslo: compartido(new THREE.BoxGeometry(0.15, 0.15, 0.44)),
  pantorrilla: compartido(new THREE.BoxGeometry(0.15, 0.42, 0.15)),
  zapato: compartido(new THREE.BoxGeometry(0.16, 0.08, 0.26)),
  insignia: compartido(new THREE.BoxGeometry(0.11, 0.13, 0.02)),
  taza: compartido(new THREE.CylinderGeometry(0.06, 0.05, 0.11, 12)),
  hoja: compartido(new THREE.BoxGeometry(0.3, 0.02, 0.42)),
};

const MAT_PANTALON = compartido(
  new THREE.MeshStandardMaterial({ color: 0x2a3543, roughness: 0.85 }),
);
const MAT_ZAPATO = compartido(new THREE.MeshStandardMaterial({ color: 0x151d26, roughness: 0.7 }));

function crearTrabajador(persona: Persona, colorArea: number): Trabajador {
  const grupo = new THREE.Group();
  const matPiel = new THREE.MeshStandardMaterial({ color: persona.piel, roughness: 0.75 });
  const matCamisa = new THREE.MeshStandardMaterial({ color: persona.camisa, roughness: 0.8 });
  const matPelo = new THREE.MeshStandardMaterial({ color: persona.pelo, roughness: 0.85 });
  const matInsignia = new THREE.MeshStandardMaterial({
    color: colorArea,
    emissive: colorArea,
    emissiveIntensity: 0.35,
    roughness: 0.4,
  });

  const sentado = persona.sentado;
  const yCadera = sentado ? 0.56 : 0.82;
  const yTorso = sentado ? 0.86 : 1.12;
  const yHombros = sentado ? 1.12 : 1.38;
  const yCabeza = sentado ? 1.39 : 1.65;

  if (sentado) {
    for (const lado of [-1, 1]) {
      grupo.add(malla(G.muslo, MAT_PANTALON, lado * 0.09, 0.5, 0.16));
      grupo.add(malla(G.pantorrilla, MAT_PANTALON, lado * 0.09, 0.29, 0.38));
      grupo.add(malla(G.zapato, MAT_ZAPATO, lado * 0.09, 0.05, 0.5));
    }
  } else {
    for (const lado of [-1, 1]) {
      grupo.add(malla(G.pantorrilla, MAT_PANTALON, lado * 0.1, 0.42, 0));
      grupo.add(malla(G.zapato, MAT_ZAPATO, lado * 0.1, 0.05, 0.04));
    }
  }

  grupo.add(malla(G.cadera, MAT_PANTALON, 0, yCadera, 0));
  grupo.add(malla(G.torso, matCamisa, 0, yTorso, 0));
  grupo.add(malla(G.hombros, matCamisa, 0, yHombros, 0));
  grupo.add(malla(G.insignia, matInsignia, 0, yTorso + 0.08, 0.13));

  // Cabeza en un pivote propio para poder girarla al animar.
  const pivoteCuello = yHombros + 0.09;
  const cabeza = new THREE.Group();
  cabeza.position.set(0, pivoteCuello, 0);
  cabeza.add(malla(G.cuello, matPiel, 0, 0, 0));
  cabeza.add(malla(G.cabeza, matPiel, 0, yCabeza - pivoteCuello, 0));
  cabeza.add(malla(G.pelo, matPelo, 0, yCabeza - pivoteCuello + 0.03, -0.01));
  grupo.add(cabeza);

  const brazos: THREE.Group[] = [];
  for (const lado of [-1, 1]) {
    const brazo = new THREE.Group();
    brazo.position.set(lado * 0.28, yHombros - 0.02, 0.02);
    brazo.add(malla(G.brazo, matCamisa, 0, -0.14, 0));

    const antebrazo = new THREE.Group();
    antebrazo.position.y = -0.28;
    antebrazo.add(malla(G.antebrazo, matCamisa, 0, -0.13, 0));
    antebrazo.add(malla(G.mano, matPiel, 0, -0.28, 0));
    antebrazo.rotation.x = -0.7;
    brazo.add(antebrazo);

    brazo.rotation.x = -0.35;
    grupo.add(brazo);
    brazos.push(brazo);
  }

  return { grupo, brazos, cabeza, fase: Math.random() * Math.PI * 2 };
}

function crearSilla(): THREE.Group {
  const grupo = new THREE.Group();
  const matSilla = new THREE.MeshStandardMaterial({ color: 0x1f2b38, roughness: 0.7 });
  const matPatas = new THREE.MeshStandardMaterial({ color: 0x39485a, roughness: 0.4, metalness: 0.5 });
  grupo.add(malla(new THREE.BoxGeometry(0.5, 0.09, 0.5), matSilla, 0, 0.46, 0));
  grupo.add(malla(new THREE.BoxGeometry(0.5, 0.58, 0.09), matSilla, 0, 0.76, -0.22));
  grupo.add(malla(new THREE.CylinderGeometry(0.045, 0.045, 0.36, 10), matPatas, 0, 0.27, 0));
  grupo.add(malla(new THREE.CylinderGeometry(0.3, 0.32, 0.05, 16), matPatas, 0, 0.05, 0));
  return grupo;
}

function crearPlanta(): THREE.Group {
  const grupo = new THREE.Group();
  const maceta = new THREE.MeshStandardMaterial({ color: 0x8a5a3a, roughness: 0.8 });
  const hoja = new THREE.MeshStandardMaterial({ color: 0x2f7a4f, roughness: 0.85 });
  grupo.add(malla(new THREE.CylinderGeometry(0.24, 0.19, 0.36, 14), maceta, 0, 0.18, 0));
  grupo.add(malla(new THREE.SphereGeometry(0.34, 12, 10), hoja, 0, 0.68, 0));
  grupo.add(malla(new THREE.SphereGeometry(0.26, 12, 10), hoja, 0.2, 0.98, -0.08));
  grupo.add(malla(new THREE.SphereGeometry(0.22, 12, 10), hoja, -0.18, 1.02, 0.1));
  grupo.add(malla(new THREE.SphereGeometry(0.2, 12, 10), hoja, 0.02, 1.22, 0.04));
  return grupo;
}

function crearArchivador(): THREE.Group {
  const grupo = new THREE.Group();
  const cuerpo = new THREE.MeshStandardMaterial({ color: 0x38485a, roughness: 0.55, metalness: 0.35 });
  const tirador = new THREE.MeshStandardMaterial({ color: 0x9aa9b8, roughness: 0.4, metalness: 0.6 });
  grupo.add(malla(new THREE.BoxGeometry(1.1, 1.6, 0.55), cuerpo, 0, 0.8, 0));
  for (let i = 0; i < 3; i += 1) {
    grupo.add(malla(new THREE.BoxGeometry(0.92, 0.03, 0.06), tirador, 0, 0.5 + i * 0.5, 0.29));
  }
  return grupo;
}

/* ------------------------------------------------------------------ */
/* Naturaleza exterior                                                */
/* ------------------------------------------------------------------ */

const MAT_TRONCO = compartido(new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.95 }));
const MAT_HOJA_CLARA = compartido(new THREE.MeshStandardMaterial({ color: 0x337f51, roughness: 0.95 }));
const MAT_HOJA_OSCURA = compartido(new THREE.MeshStandardMaterial({ color: 0x1f5c39, roughness: 0.95 }));
const MAT_ARBUSTO = compartido(new THREE.MeshStandardMaterial({ color: 0x2a6440, roughness: 1 }));
const GEO_TRONCO = compartido(new THREE.CylinderGeometry(0.5, 0.68, 1, 7));
const GEO_COPA = compartido(new THREE.SphereGeometry(1, 10, 8));
const GEO_VERDE = compartido(new THREE.ConeGeometry(1, 1, 9));

/** Aleatorio determinista: el jardín queda igual en cada carga de la página. */
function aleatorio(semilla: number): () => number {
  let estado = semilla >>> 0;
  return () => {
    estado = (estado * 1664525 + 1013904223) >>> 0;
    return estado / 4294967296;
  };
}

/** Árbol del jardín: copa redonda, conífera o arbusto bajo. */
function crearArbol(tipo: 'redonda' | 'conifera' | 'arbusto', alto: number): THREE.Group {
  const grupo = new THREE.Group();

  if (tipo === 'arbusto') {
    const matas: { x: number; z: number; r: number }[] = [
      { x: 0, z: 0, r: alto * 0.5 },
      { x: alto * 0.42, z: alto * 0.2, r: alto * 0.36 },
      { x: -alto * 0.3, z: -alto * 0.3, r: alto * 0.3 },
    ];
    for (const mata of matas) {
      const copa = malla(GEO_COPA, MAT_ARBUSTO, mata.x, mata.r * 0.7, mata.z);
      copa.scale.set(mata.r, mata.r * 0.8, mata.r);
      grupo.add(copa);
    }
    return grupo;
  }

  const troncoAlto = tipo === 'conifera' ? alto * 0.3 : alto * 0.45;
  const grosor = alto * (tipo === 'conifera' ? 0.05 : 0.06);
  const tronco = malla(GEO_TRONCO, MAT_TRONCO, 0, troncoAlto / 2, 0);
  tronco.scale.set(grosor, troncoAlto, grosor);
  grupo.add(tronco);

  if (tipo === 'conifera') {
    for (let i = 0; i < 3; i += 1) {
      const nivel = i / 3;
      const copa = malla(
        GEO_VERDE,
        i % 2 === 0 ? MAT_HOJA_OSCURA : MAT_HOJA_CLARA,
        0,
        troncoAlto + alto * (0.2 + nivel * 0.22),
        0,
      );
      copa.scale.set(alto * (0.3 - nivel * 0.12), alto * 0.36, alto * (0.3 - nivel * 0.12));
      grupo.add(copa);
    }
    return grupo;
  }

  const copas: { y: number; r: number; mat: THREE.Material; dx?: number; dz?: number }[] = [
    { y: troncoAlto + alto * 0.26, r: alto * 0.34, mat: MAT_HOJA_CLARA },
    { y: troncoAlto + alto * 0.5, r: alto * 0.25, mat: MAT_HOJA_OSCURA },
    { y: troncoAlto + alto * 0.18, r: alto * 0.22, mat: MAT_HOJA_OSCURA, dx: alto * 0.24, dz: -alto * 0.16 },
  ];
  for (const copa of copas) {
    const bola = malla(GEO_COPA, copa.mat, copa.dx ?? 0, copa.y, copa.dz ?? 0);
    bola.scale.set(copa.r, copa.r * 0.9, copa.r);
    grupo.add(bola);
  }
  return grupo;
}

/* ------------------------------------------------------------------ */
/* Escena                                                             */
/* ------------------------------------------------------------------ */

function colorEstado(estado: QueueState): number {
  switch (estado) {
    case 'en_cola':
      return PALETA.acento;
    case 'procesando':
      return PALETA.teal;
    case 'pagada':
      return PALETA.verde;
    case 'escalada':
      return PALETA.ambar;
    case 'frenada':
    case 'error':
      return PALETA.rojo;
    default:
      return 0x6d8299;
  }
}

function colorDeDecision(decision: 'pagar' | 'escalar' | 'frenar' | null): number {
  if (decision === 'pagar') return PALETA.verde;
  if (decision === 'escalar') return PALETA.ambar;
  if (decision === 'frenar') return PALETA.rojo;
  return 0x6d8299;
}

export interface SalaCallbacks {
  onEstacion: (id: SalaId) => void;
  onFactura: (id: string) => void;
}

export class SalaEscena {
  private readonly escena = new THREE.Scene();
  private readonly camara: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controles: OrbitControls;
  private readonly reloj = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly puntero = new THREE.Vector2();
  private readonly estaciones = new Map<SalaId, NodoEstacion>();
  private readonly nodos = new Map<string, NodoFactura>();
  private readonly trabajadores: Trabajador[] = [];
  private readonly clicables: THREE.Object3D[] = [];
  private readonly anilloSeleccion: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  private readonly flujo: THREE.InstancedMesh;
  private readonly curva: THREE.CatmullRomCurve3;
  private readonly observador: ResizeObserver;
  private datos: SalaDatos = { facturas: [], resumen: null };
  private seleccion: string | null = null;
  private iconoLlm: THREE.Group | null = null;
  private iconoGuard: THREE.Group | null = null;
  private polvo: THREE.Points | null = null;
  private readonly camDestino = new THREE.Vector3(0, 20, 28);
  private readonly targetDestino = new THREE.Vector3(0, 1.4, 0);
  private volando = false;
  private raf = 0;
  private tiempo = 0;
  private abajoX = 0;
  private abajoY = 0;
  private destruida = false;
  private ultimoAncho = 0;
  private ultimoAlto = 0;
  private ultimoDpr = 0;
  private temporizadorTamano = 0;
  private readonly teclas = new Set<string>();

  constructor(
    private readonly contenedor: HTMLElement,
    private readonly callbacks: SalaCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.domElement.className = 'canvas-sala';
    this.contenedor.appendChild(this.renderer.domElement);

    this.escena.background = new THREE.Color(PALETA.fondo);
    this.escena.fog = new THREE.Fog(PALETA.fondo, 58, 120);

    this.camara = new THREE.PerspectiveCamera(45, 1, 0.1, 220);
    this.camara.position.copy(this.camDestino);

    this.controles = new OrbitControls(this.camara, this.renderer.domElement);
    this.controles.enableDamping = true;
    this.controles.dampingFactor = 0.09;
    this.controles.zoomSpeed = 0.85;
    this.controles.rotateSpeed = 0.55;
    this.controles.panSpeed = 0.85;
    // Desplazar arrastra la vista sobre el plano del suelo, como caminar por la oficina.
    this.controles.screenSpacePanning = false;
    this.controles.minDistance = 6;
    this.controles.maxDistance = 70;
    this.controles.minPolarAngle = 0.2;
    this.controles.maxPolarAngle = 1.35;
    // Órbita libre: se puede rodear la sala y ver el jardín tras el vidrio.
    this.controles.minAzimuthAngle = -Infinity;
    this.controles.maxAzimuthAngle = Infinity;
    this.controles.target.copy(this.targetDestino);
    this.controles.addEventListener('start', this.cancelarVuelo);

    this.curva = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-17, 0.55, 0),
      new THREE.Vector3(-12.5, 0.55, 0),
      new THREE.Vector3(-8, 0.55, 0),
      new THREE.Vector3(-2, 0.55, 0),
      new THREE.Vector3(4, 0.55, 0),
      new THREE.Vector3(9.5, 0.55, 0),
    ]);

    this.anilloSeleccion = new THREE.Mesh(
      new THREE.TorusGeometry(0.82, 0.035, 8, 40),
      new THREE.MeshBasicMaterial({ color: PALETA.acento, transparent: true, opacity: 0.9 }),
    );
    this.anilloSeleccion.rotation.x = -Math.PI / 2;
    this.anilloSeleccion.visible = false;
    this.escena.add(this.anilloSeleccion);

    this.construirOficina();
    this.construirExterior();
    this.construirCinta();
    this.construirEstaciones();
    this.construirProceso();
    this.construirSalidas();
    this.construirPolvo();
    this.construirLuces();

    this.flujo = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.075, 8, 8),
      new THREE.MeshBasicMaterial({ color: PALETA.teal, transparent: true, opacity: 0.9 }),
      CANTIDAD_FLUJO,
    );
    this.flujo.frustumCulled = false;
    this.escena.add(this.flujo);

    this.observador = new ResizeObserver(this.programarTamano);
    this.observador.observe(this.contenedor);
    this.aplicarTamano();

    this.renderer.domElement.addEventListener('pointerdown', this.alPresionar);
    this.renderer.domElement.addEventListener('pointerup', this.alSoltar);
    this.renderer.domElement.addEventListener('pointermove', this.alMover);
    this.renderer.domElement.addEventListener('pointerleave', this.alSalir);

    window.addEventListener('keydown', this.alPulsarTecla);
    window.addEventListener('keyup', this.alSoltarTecla);
    window.addEventListener('blur', this.olvidarTeclas);

    this.animar();
  }

  /* ------------------------------------------------------------------ */
  /* Construcción                                                      */
  /* ------------------------------------------------------------------ */

  private construirLuces(): void {
    this.escena.add(new THREE.HemisphereLight(0xc2dcff, 0x14202c, 1.55));

    const principal = new THREE.DirectionalLight(0xfff6e8, 2.5);
    principal.position.set(16, 26, 18);
    this.escena.add(principal);

    const relleno = new THREE.DirectionalLight(0x9fc7ff, 1.15);
    relleno.position.set(-18, 12, -14);
    this.escena.add(relleno);

    const centro = new THREE.PointLight(0x57e0c0, 30, 34, 2);
    centro.position.set(3, 6, 0);
    this.escena.add(centro);

    const salida = new THREE.PointLight(0xe8a33d, 16, 24, 2);
    salida.position.set(15, 4, 2);
    this.escena.add(salida);

    const entrada = new THREE.PointLight(0x3fa7ff, 15, 24, 2);
    entrada.position.set(-16, 4, 3);
    this.escena.add(entrada);
  }

  private construirOficina(): void {
    // Piso, pasillo y alfombras de cada fila de escritorios.
    const piso = malla(
      new THREE.PlaneGeometry(OFICINA.ancho, OFICINA.profundidad),
      new THREE.MeshStandardMaterial({ color: PALETA.suelo, roughness: 0.92, metalness: 0.06 }),
      0,
      0,
      0,
    );
    piso.rotation.x = -Math.PI / 2;
    this.escena.add(piso);

    const agregarPlano = (ancho: number, fondo: number, x: number, z: number, color: number) => {
      const plano = malla(
        new THREE.PlaneGeometry(ancho, fondo),
        new THREE.MeshStandardMaterial({ color, roughness: 0.98 }),
        x,
        0.015,
        z,
      );
      plano.rotation.x = -Math.PI / 2;
      this.escena.add(plano);
    };
    agregarPlano(OFICINA.ancho - 2, 3.4, 0, 0, 0x1b2b3c);
    agregarPlano(42, 6, 0, 9.2, 0x1a2a3a);
    agregarPlano(42, 6, 0, -9.2, 0x1a2a3a);

    // Muros: fondo y laterales, ahora en vidrio (el frente queda abierto).
    const muro = new THREE.MeshPhysicalMaterial({
      color: 0xa8dcf0,
      roughness: 0.05,
      metalness: 0,
      transparent: true,
      opacity: 0.2,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      depthWrite: false,
    });
    const zocalo = new THREE.MeshStandardMaterial({ color: 0x1a232d, roughness: 0.9 });
    this.escena.add(
      malla(new THREE.BoxGeometry(OFICINA.ancho, OFICINA.altoMuro, OFICINA.grosorMuro), muro, 0, OFICINA.altoMuro / 2, -OFICINA.profundidad / 2),
    );
    this.escena.add(
      malla(new THREE.BoxGeometry(OFICINA.grosorMuro, OFICINA.altoMuro, OFICINA.profundidad), muro, -OFICINA.ancho / 2, OFICINA.altoMuro / 2, 0),
    );
    this.escena.add(
      malla(new THREE.BoxGeometry(OFICINA.grosorMuro, OFICINA.altoMuro, OFICINA.profundidad), muro, OFICINA.ancho / 2, OFICINA.altoMuro / 2, 0),
    );
    this.escena.add(malla(new THREE.BoxGeometry(OFICINA.ancho, 0.28, 0.1), zocalo, 0, 0.14, -OFICINA.profundidad / 2 + 0.16));
    this.escena.add(malla(new THREE.BoxGeometry(0.1, 0.28, OFICINA.profundidad), zocalo, -OFICINA.ancho / 2 + 0.16, 0.14, 0));
    this.escena.add(malla(new THREE.BoxGeometry(0.1, 0.28, OFICINA.profundidad), zocalo, OFICINA.ancho / 2 - 0.16, 0.14, 0));

    // Perfilería de aluminio que enmarca los tabiques de vidrio.
    const perfil = new THREE.MeshStandardMaterial({ color: 0x1d2a36, roughness: 0.35, metalness: 0.7 });
    for (const x of [-23, -18, -11.5, 11.5, 18, 23]) {
      this.escena.add(
        malla(new THREE.BoxGeometry(0.12, OFICINA.altoMuro, 0.36), perfil, x, OFICINA.altoMuro / 2, -OFICINA.profundidad / 2),
      );
    }
    for (const z of [-15, -2, 2, 15]) {
      this.escena.add(malla(new THREE.BoxGeometry(0.36, OFICINA.altoMuro, 0.12), perfil, -OFICINA.ancho / 2, OFICINA.altoMuro / 2, z));
      this.escena.add(malla(new THREE.BoxGeometry(0.36, OFICINA.altoMuro, 0.12), perfil, OFICINA.ancho / 2, OFICINA.altoMuro / 2, z));
    }
    this.escena.add(malla(new THREE.BoxGeometry(OFICINA.ancho, 0.16, 0.4), perfil, 0, OFICINA.altoMuro - 0.08, -OFICINA.profundidad / 2));
    this.escena.add(malla(new THREE.BoxGeometry(0.4, 0.16, OFICINA.profundidad), perfil, -OFICINA.ancho / 2, OFICINA.altoMuro - 0.08, 0));
    this.escena.add(malla(new THREE.BoxGeometry(0.4, 0.16, OFICINA.profundidad), perfil, OFICINA.ancho / 2, OFICINA.altoMuro - 0.08, 0));

    // Ventanales: solo el marco y el vidrio, la vista ahora es el jardín.
    const zMuro = -OFICINA.profundidad / 2 + 0.05;
    for (const x of [-16, -8, 8, 16]) {
      const ventana = crearVentana(3.6, 2.4);
      ventana.position.set(x, 3.8, zMuro);
      this.escena.add(ventana);
    }
    for (const z of [-6, 6]) {
      const ventanaIzquierda = crearVentana(3.2, 2.2);
      ventanaIzquierda.position.set(-OFICINA.ancho / 2 + 0.05, 3.7, z);
      ventanaIzquierda.rotation.y = Math.PI / 2;
      this.escena.add(ventanaIzquierda);

      const ventanaDerecha = crearVentana(3.2, 2.2);
      ventanaDerecha.position.set(OFICINA.ancho / 2 - 0.05, 3.7, z);
      ventanaDerecha.rotation.y = -Math.PI / 2;
      this.escena.add(ventanaDerecha);
    }

    // Puerta en el muro derecho (delgada en X, ancha en Z).
    const puerta = malla(
      new THREE.BoxGeometry(0.16, 4.2, 3),
      new THREE.MeshStandardMaterial({ color: 0x33445a, roughness: 0.7, metalness: 0.25 }),
      OFICINA.ancho / 2 - 0.1,
      2.1,
      11,
    );
    this.escena.add(puerta);
    this.escena.add(
      malla(
        new THREE.CylinderGeometry(0.05, 0.05, 0.22, 8),
        new THREE.MeshStandardMaterial({ color: 0xc9d4de, metalness: 0.7, roughness: 0.3 }),
        OFICINA.ancho / 2 - 0.24,
        2.05,
        9.9,
      ),
    );

    // Pizarra del proceso.
    const pizarra = crearPizarra();
    pizarra.position.set(0, 4.15, -OFICINA.profundidad / 2 + 0.11);
    this.escena.add(pizarra);

    // Plantas y archivadores.
    for (const [x, z] of [
      [-20.6, -13.2],
      [20.6, -13.2],
      [-20.6, 12.6],
      [20.6, 5],
    ] as const) {
      const planta = crearPlanta();
      planta.position.set(x, 0, z);
      this.escena.add(planta);
    }
    for (const x of [-10.5, 0, 10.5]) {
      const archivador = crearArchivador();
      archivador.position.set(x, 0, -OFICINA.profundidad / 2 + 0.6);
      this.escena.add(archivador);
    }

    // Rincón del café.
    const mesaCafe = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.7 });
    this.escena.add(malla(new THREE.CylinderGeometry(0.62, 0.62, 0.07, 20), mesaCafe, 20.4, 0.92, 8.6));
    this.escena.add(malla(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 10), mesaCafe, 20.4, 0.46, 8.6));
    this.escena.add(malla(new THREE.CylinderGeometry(0.3, 0.34, 0.05, 16), mesaCafe, 20.4, 0.03, 8.6));
    const tazaMaterial = new THREE.MeshStandardMaterial({ color: 0xe8eef5, roughness: 0.4 });
    this.escena.add(malla(G.taza, tazaMaterial, 20.15, 0.99, 8.45));
    this.escena.add(malla(G.taza, tazaMaterial, 20.7, 0.99, 8.8));
  }

  /** Césped, árboles y arbustos del exterior, visibles a través de los muros. */
  private construirExterior(): void {
    const cesped = malla(new THREE.PlaneGeometry(260, 220), new THREE.MeshStandardMaterial({ color: 0x173a22, roughness: 1 }), 0, -0.05, 0);
    cesped.rotation.x = -Math.PI / 2;
    this.escena.add(cesped);

    // Colinas bajas alrededor para cerrar el horizonte.
    for (let i = 0; i < 7; i += 1) {
      const angulo = (i / 7) * Math.PI * 2 + 0.4;
      const colina = malla(GEO_COPA, MAT_HOJA_OSCURA, Math.cos(angulo) * 84, -5, Math.sin(angulo) * 72);
      colina.scale.set(30, 13, 26);
      this.escena.add(colina);
    }

    // Jardín determinista: siempre se planta igual en cada carga.
    const dado = aleatorio(20261017);
    let plantados = 0;
    for (let intento = 0; intento < 320 && plantados < 58; intento += 1) {
      const x = (dado() - 0.5) * 152;
      const z = (dado() - 0.5) * 132;
      const dentroOficina = Math.abs(x) < 27 && Math.abs(z) < 19;
      const corredorFrontal = z > 16 && Math.abs(x) < 13; // deja libre la fachada abierta
      if (dentroOficina || corredorFrontal) continue;

      const distancia = Math.hypot(x, z);
      const tiro = dado();
      const tipo: 'redonda' | 'conifera' | 'arbusto' =
        tiro < 0.22 ? 'arbusto' : tiro < 0.55 && distancia > 32 ? 'conifera' : 'redonda';
      const alto = tipo === 'arbusto' ? 1 + dado() * 0.9 : 4.4 + dado() * 3.6;
      const arbol = crearArbol(tipo, alto);
      arbol.position.set(x, 0, z);
      arbol.rotation.y = dado() * Math.PI * 2;
      arbol.scale.setScalar(0.85 + dado() * 0.4);
      this.escena.add(arbol);
      plantados += 1;
    }
  }

  private construirCinta(): void {
    const tubo = malla(
      new THREE.TubeGeometry(this.curva, 90, 0.3, 12, false),
      new THREE.MeshStandardMaterial({ color: 0x33485c, metalness: 0.7, roughness: 0.35 }),
      0,
      0,
      0,
    );
    this.escena.add(tubo);

    const puntos = this.curva.getPoints(90).map((punto) => punto.clone().setY(0.87));
    this.escena.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(puntos),
        new THREE.LineBasicMaterial({ color: PALETA.acento, transparent: true, opacity: 0.6 }),
      ),
    );

    // Rodillos de la banda.
    const rodillo = new THREE.MeshStandardMaterial({ color: 0x51687e, metalness: 0.65, roughness: 0.35 });
    for (let x = -16.4; x < 10; x += 1.4) {
      const cilindro = malla(new THREE.CylinderGeometry(0.12, 0.12, 0.66, 12), rodillo, x, 0.26, 0);
      // El eje del cilindro es Y: se gira para que cruce la banda (eje Z).
      cilindro.rotation.x = Math.PI / 2;
      this.escena.add(cilindro);
    }
  }

  private construirEstaciones(): void {
    for (const def of ESTACIONES) {
      const persona = PERSONAL[def.id];
      const grupo = new THREE.Group();
      grupo.position.set(def.x, 0, def.z);
      grupo.userData.estacion = def.id;

      this.construirPuesto(grupo, def, persona);

      const anillo = new THREE.Mesh(
        new THREE.TorusGeometry(2.8, 0.035, 8, 56),
        new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.5 }),
      );
      anillo.rotation.x = -Math.PI / 2;
      anillo.position.y = 0.04;
      grupo.add(anillo);

      const etiqueta = crearEtiqueta(
        def.nombre,
        `${persona.nombre} · ${this.metrica(def.id)}`,
        def.color,
        4.9,
      );
      etiqueta.sprite.position.set(0, 3.55, -1);
      grupo.add(etiqueta.sprite);

      this.escena.add(grupo);
      this.clicables.push(grupo);
      this.estaciones.set(def.id, { def, grupo, etiqueta });
    }
  }

  /** Escritorio, monitor, silla, persona y pantalla del área. */
  private construirPuesto(grupo: THREE.Group, def: EstacionDef, persona: Persona): void {
    const madera = new THREE.MeshStandardMaterial({ color: 0x6b4f37, roughness: 0.75 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x2c3a49, roughness: 0.45, metalness: 0.5 });
    const oscuro = new THREE.MeshStandardMaterial({ color: PALETA.panel, roughness: 0.6 });

    // Escritorio.
    grupo.add(malla(new THREE.BoxGeometry(4.2, 0.12, 1.5), madera, 0, 0.78, 0));
    grupo.add(malla(new THREE.BoxGeometry(0.12, 0.78, 1.4), metal, -1.98, 0.39, 0));
    grupo.add(malla(new THREE.BoxGeometry(0.12, 0.78, 1.4), metal, 1.98, 0.39, 0));

    // Pantalla del área sobre un soporte, detrás del puesto.
    const pantallaMaterial = new THREE.MeshStandardMaterial({
      color: PALETA.panel,
      emissive: def.color,
      emissiveIntensity: 0.42,
      metalness: 0.45,
      roughness: 0.3,
    });
    grupo.add(malla(new THREE.CylinderGeometry(0.05, 0.05, 1.25, 10), metal, 0, 0.95, -1.45));
    const pantalla = malla(new THREE.BoxGeometry(3, 1.55, 0.08), pantallaMaterial, 0, 2.1, -1.45);
    pantalla.rotation.x = -0.1;
    grupo.add(pantalla);
    const marco = malla(new THREE.BoxGeometry(3.2, 1.75, 0.05), oscuro, 0, 2.08, -1.51);
    marco.rotation.x = -0.1;
    grupo.add(marco);

    // Monitor sobre el escritorio, al lado opuesto de la persona.
    const ladoMonitor = persona.lado * -1;
    grupo.add(malla(new THREE.BoxGeometry(0.5, 0.04, 0.3), metal, ladoMonitor * 0.95, 0.86, -0.2));
    grupo.add(malla(new THREE.BoxGeometry(0.09, 0.3, 0.09), metal, ladoMonitor * 0.95, 1.0, -0.2));
    const monitor = malla(new THREE.BoxGeometry(1.5, 0.9, 0.07), oscuro, ladoMonitor * 0.95, 1.55, -0.18);
    monitor.rotation.y = -ladoMonitor * 0.35;
    monitor.rotation.x = -0.08;
    grupo.add(monitor);
    const brilloMonitor = malla(
      new THREE.PlaneGeometry(1.38, 0.78),
      new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.35 }),
      0,
      0,
      0.045,
    );
    brilloMonitor.position.copy(monitor.position);
    brilloMonitor.rotation.copy(monitor.rotation);
    grupo.add(brilloMonitor);

    // Teclado, papeles, taza y placa con el cargo.
    grupo.add(malla(new THREE.BoxGeometry(1.1, 0.05, 0.34), oscuro, ladoMonitor * 0.95, 0.86, 0.3));
    grupo.add(malla(G.hoja, new THREE.MeshStandardMaterial({ color: 0xf3f6fa, roughness: 0.9 }), -ladoMonitor * 1.1, 0.855, 0.1));
    grupo.add(malla(G.taza, new THREE.MeshStandardMaterial({ color: 0xd9e4ef, roughness: 0.4 }), -ladoMonitor * 1.5, 0.9, 0.45));

    const placa = crearPlaca(persona.cargo, def.color);
    placa.position.set(0, 0.9, 0.66);
    grupo.add(placa);

    // Silla y persona.
    const ladoTrabajador = persona.lado;
    const silla = crearSilla();
    silla.position.set(ladoTrabajador * 1.25, 0, persona.sentado ? -0.75 : -1.35);
    silla.rotation.y = ladoTrabajador * -0.45;
    // Al agrandar a la persona, la silla donde se sienta crece con ella.
    if (persona.sentado) silla.scale.setScalar(ESCALA_TRABAJADOR);
    grupo.add(silla);

    const trabajador = crearTrabajador(persona, def.color);
    trabajador.grupo.scale.setScalar(ESCALA_TRABAJADOR);
    trabajador.grupo.position.set(ladoTrabajador * 1.25, 0, persona.sentado ? -0.62 : 0.15);
    trabajador.grupo.rotation.y = ladoTrabajador * -0.5;
    grupo.add(trabajador.grupo);
    this.trabajadores.push(trabajador);
  }

  private construirProceso(): void {
    for (const def of PROCESO) {
      const grupo = new THREE.Group();
      grupo.position.set(def.x, 0, 0);
      grupo.userData.estacion = def.estacion;

      const anillo = malla(
        new THREE.TorusGeometry(0.7, 0.035, 8, 40),
        new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.85 }),
        0,
        0.9,
        0,
      );
      anillo.rotation.x = -Math.PI / 2;
      grupo.add(anillo);

      grupo.add(
        malla(
          new THREE.CylinderGeometry(0.4, 1.2, 2.6, 20, 1, true),
          new THREE.MeshBasicMaterial({
            color: def.color,
            transparent: true,
            opacity: 0.08,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
          0,
          2.15,
          0,
        ),
      );

      const icono = this.crearIcono(def.icono, def.color);
      icono.position.y = 2.25;
      grupo.add(icono);
      if (def.icono === 'ai') this.iconoLlm = icono;
      if (def.icono === 'shield') this.iconoGuard = icono;

      const etiqueta = crearEtiqueta(def.nombre, def.subtitulo, def.color, 3.5);
      etiqueta.sprite.position.set(0, 3.75, 0);
      grupo.add(etiqueta.sprite);

      this.escena.add(grupo);
      this.clicables.push(grupo);
    }
  }

  private crearIcono(tipo: NodoProceso['icono'], color: number): THREE.Group {
    const grupo = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.65,
      metalness: 0.3,
      roughness: 0.35,
    });

    if (tipo === 'inbox') {
      grupo.add(malla(new THREE.BoxGeometry(0.85, 0.34, 0.55), material, 0, -0.1, 0));
      const tapa = malla(new THREE.BoxGeometry(0.88, 0.05, 0.58), material, 0, 0.16, -0.06);
      tapa.rotation.x = 0.24;
      grupo.add(tapa);
    } else if (tipo === 'scan') {
      grupo.add(malla(new THREE.TorusGeometry(0.3, 0.07, 10, 24), material, 0, 0, 0));
      const mango = malla(new THREE.BoxGeometry(0.14, 0.48, 0.14), material, 0.32, -0.38, 0);
      mango.rotation.z = -0.6;
      grupo.add(mango);
    } else if (tipo === 'rules') {
      for (let i = 0; i < 3; i += 1) {
        grupo.add(malla(new THREE.BoxGeometry(0.62, 0.08, 0.2), material, i === 1 ? 0.08 : 0, 0.26 - i * 0.26, 0));
      }
    } else if (tipo === 'ai') {
      grupo.add(malla(new THREE.IcosahedronGeometry(0.42, 0), material));
      const satelite = malla(new THREE.TorusGeometry(0.62, 0.025, 8, 40), material);
      satelite.rotation.x = Math.PI / 2.4;
      grupo.add(satelite);
    } else {
      const escudo = malla(new THREE.OctahedronGeometry(0.46, 0), material);
      escudo.scale.set(0.85, 1.25, 0.5);
      grupo.add(escudo);
    }

    return grupo;
  }

  private construirSalidas(): void {
    for (const salida of SALIDAS) {
      this.escena.add(
        malla(
          new THREE.CylinderGeometry(2.7, 2.7, 0.14, 40),
          new THREE.MeshStandardMaterial({
            color: 0x0c1926,
            emissive: salida.color,
            emissiveIntensity: 0.14,
            metalness: 0.4,
            roughness: 0.5,
          }),
          salida.x,
          0.07,
          salida.z,
        ),
      );

      const borde = malla(
        new THREE.TorusGeometry(2.68, 0.04, 8, 56),
        new THREE.MeshBasicMaterial({ color: salida.color, transparent: true, opacity: 0.7 }),
        salida.x,
        0.15,
        salida.z,
      );
      borde.rotation.x = -Math.PI / 2;
      this.escena.add(borde);

      const etiqueta = crearEtiqueta(salida.nombre, salida.subtitulo, salida.color, 3.4);
      etiqueta.sprite.position.set(salida.x, 3.15, salida.z);
      this.escena.add(etiqueta.sprite);

      const curvaRamal = new THREE.CatmullRomCurve3([
        new THREE.Vector3(9.5, 0.55, 0),
        new THREE.Vector3(13.5, 0.8, salida.z * 0.4),
        new THREE.Vector3(salida.x - 2.6, 0.55, salida.z),
      ]);
      this.escena.add(
        malla(
          new THREE.TubeGeometry(curvaRamal, 40, 0.08, 8, false),
          new THREE.MeshBasicMaterial({ color: salida.color, transparent: true, opacity: 0.45 }),
        ),
      );
    }
  }

  private construirPolvo(): void {
    const cantidad = 220;
    const posiciones = new Float32Array(cantidad * 3);
    for (let i = 0; i < cantidad; i += 1) {
      posiciones[i * 3] = (Math.random() - 0.5) * 42;
      posiciones[i * 3 + 1] = 0.6 + Math.random() * 6;
      posiciones[i * 3 + 2] = (Math.random() - 0.5) * 28;
    }
    const geometria = new THREE.BufferGeometry();
    geometria.setAttribute('position', new THREE.BufferAttribute(posiciones, 3));
    this.polvo = new THREE.Points(
      geometria,
      new THREE.PointsMaterial({
        color: PALETA.acento,
        size: 0.05,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      }),
    );
    this.escena.add(this.polvo);
  }

  /* ------------------------------------------------------------------ */
  /* Datos en vivo                                                      */
  /* ------------------------------------------------------------------ */

  setDatos(datos: SalaDatos): void {
    this.datos = datos;
    this.actualizarEstaciones();
    this.sincronizarFacturas();
  }

  private metrica(id: SalaId): string {
    const facturas = this.datos.facturas;
    const resumen = this.datos.resumen;
    const porProcesar = resumen?.porProcesar ?? facturas.filter((f) => !f.procesada).length;
    const porAprobar =
      resumen?.pendientes ?? facturas.filter((f) => f.queueState === 'escalada').length;

    switch (id) {
      case 'entradas':
        return `${porProcesar} por procesar`;
      case 'facturas':
        return `${facturas.filter((f) => f.procesada).length}/${facturas.length} procesadas`;
      case 'aprobaciones':
        return `${porAprobar} por decidir`;
      case 'reglas':
        return 'guard activo';
      case 'chat':
        return 'consulta y propone';
      case 'notificaciones':
        return `${porAprobar} avisos`;
      case 'conectores':
        return '2 activos';
      case 'auditoria':
        return 'cadena de hashes';
      default:
        return '';
    }
  }

  private actualizarEstaciones(): void {
    for (const [id, estacion] of this.estaciones) {
      const persona = PERSONAL[id];
      pintarEtiqueta(
        estacion.etiqueta,
        estacion.def.nombre,
        `${persona.nombre} · ${this.metrica(id)}`,
        estacion.def.color,
      );
      estacion.etiqueta.textura.needsUpdate = true;
    }
  }

  private sincronizarFacturas(): void {
    const vistos = new Set<string>();
    const contadores: Record<string, number> = {
      pendiente: 0,
      en_cola: 0,
      procesando: 0,
      pagada: 0,
      escalada: 0,
      frenada: 0,
      error: 0,
    };

    for (const item of this.datos.facturas) {
      vistos.add(item.id);
      let nodo = this.nodos.get(item.id);
      const nuevo = !nodo;
      if (!nodo) {
        nodo = this.crearNodoFactura(item);
        this.nodos.set(item.id, nodo);
      }

      const clave = item.queueState;
      const indice = contadores[clave] ?? 0;
      contadores[clave] = indice + 1;
      const destino = this.destinoPara(item, indice);
      nodo.destino.copy(destino);
      if (nuevo) nodo.grupo.position.copy(destino);

      if (nodo.estado !== item.queueState) {
        nodo.estado = item.queueState;
        this.pintarFactura(nodo, item);
      }
    }

    for (const [id, nodo] of this.nodos) {
      if (vistos.has(id)) continue;
      this.escena.remove(nodo.grupo);
      this.destruirEtiqueta(nodo.etiqueta);
      nodo.papel.geometry.dispose();
      nodo.papel.material.dispose();
      nodo.led.geometry.dispose();
      nodo.led.material.dispose();
      this.nodos.delete(id);
    }

    if (this.seleccion && !vistos.has(this.seleccion)) this.seleccionar(null);
  }

  private destinoPara(item: SalaDatos['facturas'][number], indice: number): THREE.Vector3 {
    const estado = item.queueState;
    if (estado === 'en_cola') {
      return new THREE.Vector3(-16.4 + indice * 1.1, 1.05, 1.9);
    }
    if (estado === 'procesando') {
      return this.curva.getPointAt(0.45).setY(1.05);
    }
    if (estado === 'pagada') {
      return new THREE.Vector3(17.4 + (indice % 3) * 1.15, 1.05, 4 + Math.floor(indice / 3) * 1.1);
    }
    if (estado === 'escalada') {
      return new THREE.Vector3(17.4 + (indice % 3) * 1.15, 1.05, -1 + Math.floor(indice / 3) * 1.1);
    }
    if (estado === 'frenada') {
      return new THREE.Vector3(17.4 + (indice % 3) * 1.15, 1.05, -6 + Math.floor(indice / 3) * 1.1);
    }
    if (estado === 'error') {
      return new THREE.Vector3(-8 + (indice % 3) * 1.15 - 1.15, 1.05, 1.8 + Math.floor(indice / 3) * 1.1);
    }
    return new THREE.Vector3(-22 + (indice % 5) * 1.25, 1.05, 4.8 + Math.floor(indice / 5) * 1.35);
  }

  private crearNodoFactura(item: SalaDatos['facturas'][number]): NodoFactura {
    const grupo = new THREE.Group();
    grupo.userData.facturaId = item.id;
    const color = item.decisionFinal
      ? colorDeDecision(item.decisionFinal)
      : colorEstado(item.queueState);

    const papel = new THREE.Mesh(
      new THREE.BoxGeometry(0.86, 0.045, 1.15),
      new THREE.MeshStandardMaterial({
        color: 0xf1f5fa,
        roughness: 0.65,
        metalness: 0.05,
        emissive: color,
        emissiveIntensity: 0.16,
      }),
    );
    grupo.add(papel);

    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 10, 10),
      new THREE.MeshBasicMaterial({ color }),
    );
    led.position.set(0, 0.09, 0.63);
    grupo.add(led);

    const etiqueta = crearEtiqueta(item.id, this.textoMonto(item), color, 2.05);
    etiqueta.sprite.position.set(0, 0.95, 0);
    grupo.add(etiqueta.sprite);

    this.escena.add(grupo);
    this.clicables.push(grupo);

    return {
      grupo,
      etiqueta,
      papel,
      led,
      destino: new THREE.Vector3(),
      estado: item.queueState,
      semilla: Math.random() * Math.PI * 2,
      procesandoT: 0.16 + Math.random() * 0.16,
    };
  }

  private textoMonto(item: SalaDatos['facturas'][number]): string {
    if (item.monto === null) return item.procesada ? 'sin monto' : 'sin procesar';
    const compacto = new Intl.NumberFormat('es-CO', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(item.monto);
    return `${item.moneda ?? ''} ${compacto}`.trim();
  }

  private pintarFactura(nodo: NodoFactura, item: SalaDatos['facturas'][number]): void {
    const color = colorDeDecision(item.decisionFinal ?? null);
    const colorCola = colorEstado(item.queueState);
    const final = item.decisionFinal ? color : colorCola;
    nodo.papel.material.emissive.setHex(final);
    nodo.led.material.color.setHex(final);
    pintarEtiqueta(nodo.etiqueta, item.id, this.textoMonto(item), final);
    nodo.etiqueta.textura.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ */
  /* Interacción y cámara                                               */
  /* ------------------------------------------------------------------ */

  seleccionar(id: string | null): void {
    this.seleccion = id;
    if (!id) {
      this.anilloSeleccion.visible = false;
      return;
    }
    const nodo = this.nodos.get(id);
    if (!nodo) {
      this.anilloSeleccion.visible = false;
      return;
    }
    this.anilloSeleccion.visible = true;
    this.anilloSeleccion.position.copy(nodo.grupo.position);
    this.anilloSeleccion.position.y = 0.98;
  }

  enfocar(id: SalaId): void {
    const def = ESTACIONES.find((estacion) => estacion.id === id);
    if (!def) return;
    this.targetDestino.set(def.x * 0.82, 1.6, def.z * 0.82);
    this.camDestino.set(def.x * 0.82, 12.5, def.z * 0.82 + (def.z > 0 ? 14 : 11));
    this.volando = true;
  }

  resetVista(): void {
    this.targetDestino.set(0, 1.4, 0);
    this.camDestino.set(0, 20, 28);
    this.volando = true;
  }

  private cancelarVuelo = (): void => {
    this.volando = false;
  };

  private programarTamano = (): void => {
    window.clearTimeout(this.temporizadorTamano);
    this.temporizadorTamano = window.setTimeout(this.aplicarTamano, 140);
  };

  /**
   * Redimensiona el búfer una sola vez, cuando el tamaño ya se estabilizó.
   * Durante el arrastre o el zoom, el navegador estira el último cuadro
   * (sin reasignar el búfer en cada evento), que es lo que producía el parpadeo.
   */
  private aplicarTamano = (): void => {
    const ancho = this.contenedor.clientWidth;
    const alto = this.contenedor.clientHeight;
    if (ancho === 0 || alto === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (ancho === this.ultimoAncho && alto === this.ultimoAlto && dpr === this.ultimoDpr) return;
    this.ultimoAncho = ancho;
    this.ultimoAlto = alto;
    this.ultimoDpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(ancho, alto, false);
    this.camara.aspect = ancho / alto;
    this.camara.updateProjectionMatrix();
  };

  private alPresionar = (evento: PointerEvent): void => {
    this.abajoX = evento.clientX;
    this.abajoY = evento.clientY;
  };

  private alSoltar = (evento: PointerEvent): void => {
    const movido = Math.hypot(evento.clientX - this.abajoX, evento.clientY - this.abajoY);
    if (movido > 6) return;
    const hallazgo = this.buscar(evento.clientX, evento.clientY);
    if (!hallazgo) return;
    if (hallazgo.factura) this.callbacks.onFactura(hallazgo.factura);
    else if (hallazgo.estacion) this.callbacks.onEstacion(hallazgo.estacion);
  };

  private alMover = (evento: PointerEvent): void => {
    if (evento.buttons !== 0) return;
    const hallazgo = this.buscar(evento.clientX, evento.clientY);
    this.renderer.domElement.style.cursor = hallazgo ? 'pointer' : 'grab';
  };

  private alSalir = (): void => {
    this.renderer.domElement.style.cursor = 'grab';
  };

  /** No roba las teclas cuando el usuario está escribiendo en un campo. */
  private enEditable(objetivo: EventTarget | null): boolean {
    const nodo = objetivo as HTMLElement | null;
    if (!nodo || typeof nodo.tagName !== 'string') return false;
    return (
      nodo.tagName === 'INPUT' ||
      nodo.tagName === 'TEXTAREA' ||
      nodo.tagName === 'SELECT' ||
      nodo.isContentEditable === true
    );
  }

  private alPulsarTecla = (evento: KeyboardEvent): void => {
    if (this.destruida) return;
    if (evento.ctrlKey || evento.metaKey || evento.altKey) return;
    if (!TECLAS_MOVIMIENTO.includes(evento.code)) return;
    if (this.enEditable(evento.target)) return;
    this.teclas.add(evento.code);
    this.cancelarVuelo();
    evento.preventDefault(); // las flechas no deben desplazar la página
  };

  private alSoltarTecla = (evento: KeyboardEvent): void => {
    this.teclas.delete(evento.code);
    if (evento.code === 'ShiftLeft' || evento.code === 'ShiftRight') {
      this.teclas.delete('ShiftLeft');
      this.teclas.delete('ShiftRight');
    }
  };

  private olvidarTeclas = (): void => {
    this.teclas.clear();
  };

  private buscar(clienteX: number, clienteY: number): { estacion?: SalaId; factura?: string } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.puntero.set(
      ((clienteX - rect.left) / rect.width) * 2 - 1,
      -((clienteY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.puntero, this.camara);
    const impactos = this.raycaster.intersectObjects(this.clicables, true);
    for (const impacto of impactos) {
      let actual: THREE.Object3D | null = impacto.object;
      while (actual) {
        const factura = actual.userData.facturaId as string | undefined;
        if (factura) return { factura };
        const estacion = actual.userData.estacion as SalaId | undefined;
        if (estacion) return { estacion };
        actual = actual.parent;
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Bucle de animación                                                 */
  /* ------------------------------------------------------------------ */

  private animar = (): void => {
    if (this.destruida) return;
    this.raf = requestAnimationFrame(this.animar);

    const dt = Math.min(this.reloj.getDelta(), 0.05);
    this.tiempo += dt;
    const tiempo = this.tiempo;

    const matriz = new THREE.Matrix4();
    for (let i = 0; i < CANTIDAD_FLUJO; i += 1) {
      const punto = this.curva.getPointAt((tiempo * 0.055 + i / CANTIDAD_FLUJO) % 1);
      punto.y = 0.93;
      matriz.makeTranslation(punto.x, punto.y, punto.z);
      this.flujo.setMatrixAt(i, matriz);
    }
    this.flujo.instanceMatrix.needsUpdate = true;

    if (this.iconoLlm) {
      this.iconoLlm.rotation.y += dt * 0.6;
      this.iconoLlm.position.y = 2.25 + Math.sin(tiempo * 1.4) * 0.08;
    }
    if (this.iconoGuard) {
      this.iconoGuard.scale.setScalar(1 + Math.sin(tiempo * 2.2) * 0.07);
    }
    if (this.polvo) this.polvo.rotation.y += dt * 0.02;

    // Personas: respiración, tecleo suave y cabeceo.
    for (const trabajador of this.trabajadores) {
      trabajador.grupo.position.y = Math.sin(tiempo * 1.8 + trabajador.fase) * 0.012;
      trabajador.brazos.forEach((brazo, indice) => {
        brazo.rotation.x = -0.35 + Math.sin(tiempo * 5 + trabajador.fase + indice * 1.7) * 0.12;
      });
      trabajador.cabeza.rotation.y = Math.sin(tiempo * 0.7 + trabajador.fase) * 0.16;
    }

    const factor = 1 - Math.exp(-4.5 * dt);
    for (const nodo of this.nodos.values()) {
      if (nodo.estado === 'procesando') {
        nodo.procesandoT += dt * 0.11;
        if (nodo.procesandoT > 0.84) nodo.procesandoT = 0.12;
        const punto = this.curva.getPointAt(nodo.procesandoT);
        nodo.destino.set(punto.x, 1.05, punto.z);
      }
      nodo.grupo.position.lerp(nodo.destino, factor);
      nodo.grupo.position.y = 1.05 + Math.sin(tiempo * 2 + nodo.semilla) * 0.05;
      nodo.grupo.rotation.y = Math.sin(tiempo * 1.3 + nodo.semilla) * 0.22;
      nodo.grupo.rotation.z = Math.sin(tiempo * 1.7 + nodo.semilla) * 0.04;
    }

    if (this.seleccion) {
      const nodo = this.nodos.get(this.seleccion);
      if (nodo) {
        this.anilloSeleccion.visible = true;
        this.anilloSeleccion.position.copy(nodo.grupo.position);
        this.anilloSeleccion.position.y = 0.98;
        this.anilloSeleccion.rotation.z += dt * 1.6;
      }
    }

    // Desplazamiento con teclado: mueve cámara y objetivo por el plano del suelo.
    if (this.teclas.size > 0) {
      const direccion = new THREE.Vector3();
      this.camara.getWorldDirection(direccion);
      direccion.y = 0;
      if (direccion.lengthSq() < 1e-6) direccion.set(0, 0, -1);
      direccion.normalize();
      const lateral = new THREE.Vector3().crossVectors(direccion, ARRIBA).normalize();
      const paso = new THREE.Vector3();
      if (this.teclas.has('KeyW') || this.teclas.has('ArrowUp')) paso.add(direccion);
      if (this.teclas.has('KeyS') || this.teclas.has('ArrowDown')) paso.sub(direccion);
      if (this.teclas.has('KeyD') || this.teclas.has('ArrowRight')) paso.add(lateral);
      if (this.teclas.has('KeyA') || this.teclas.has('ArrowLeft')) paso.sub(lateral);
      if (paso.lengthSq() > 0) {
        const rapido = this.teclas.has('ShiftLeft') || this.teclas.has('ShiftRight');
        paso.normalize().multiplyScalar(PASO_TECLADO * (rapido ? 2.6 : 1) * dt);
        const objetivo = this.controles.target.clone().add(paso);
        objetivo.x = THREE.MathUtils.clamp(objetivo.x, -44, 44);
        objetivo.z = THREE.MathUtils.clamp(objetivo.z, -34, 46);
        const correccion = objetivo.sub(this.controles.target);
        this.controles.target.add(correccion);
        this.camara.position.add(correccion);
      }
    }

    if (this.volando) {
      const suavizado = 1 - Math.exp(-4 * dt);
      this.camara.position.lerp(this.camDestino, suavizado);
      this.controles.target.lerp(this.targetDestino, suavizado);
      if (this.camara.position.distanceTo(this.camDestino) < 0.08) this.volando = false;
    }

    this.controles.update();
    this.renderer.render(this.escena, this.camara);
  };

  /* ------------------------------------------------------------------ */
  /* Limpieza                                                           */
  /* ------------------------------------------------------------------ */

  private destruirEtiqueta(etiqueta: Etiqueta): void {
    etiqueta.sprite.removeFromParent();
    etiqueta.sprite.material.dispose();
    etiqueta.textura.dispose();
  }

  dispose(): void {
    this.destruida = true;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.temporizadorTamano);
    this.observador.disconnect();

    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.alPresionar);
    canvas.removeEventListener('pointerup', this.alSoltar);
    canvas.removeEventListener('pointermove', this.alMover);
    canvas.removeEventListener('pointerleave', this.alSalir);
    window.removeEventListener('keydown', this.alPulsarTecla);
    window.removeEventListener('keyup', this.alSoltarTecla);
    window.removeEventListener('blur', this.olvidarTeclas);
    this.controles.removeEventListener('start', this.cancelarVuelo);
    this.controles.dispose();

    this.escena.traverse((objeto) => {
      const figura = objeto as THREE.Mesh;
      const geometria = figura.geometry as THREE.BufferGeometry | undefined;
      if (geometria && geometria.userData.compartido !== true) geometria.dispose();
      const material = figura.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) {
        for (const uno of material) this.destruirMaterial(uno);
      } else if (material) {
        this.destruirMaterial(material);
      }
    });

    this.escena.clear();
    this.renderer.dispose();
    canvas.remove();
  }

  private destruirMaterial(material: THREE.Material): void {
    if (material.userData.compartido === true) return;
    const conMapa = material as THREE.Material & { map?: THREE.Texture | null };
    conMapa.map?.dispose();
    material.dispose();
  }
}
