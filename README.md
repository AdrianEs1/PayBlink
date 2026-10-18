# PayBlink — agentes que pagan por la empresa

Agente que revisa las facturas y cuentas de cobro de una empresa ficticia y decide, para cada
una, si **paga**, **frena** o **escala a una persona**. Cada decisión queda registrada, explicada
en lenguaje natural y con bitácora de auditoría.

> **Principio de diseño:** el LLM nunca tiene la última palabra sobre un pago.
> La decisión final la fija código determinista y, ante cualquier duda o fallo, el resultado
> es **escalar**.

Construido para el Hackatón 30X (Andrés Bilbao), Colombia.

---

## Requisitos

- Node.js 20 o superior
- pnpm (o npm: ambos funcionan)
- Git — necesario además para el control de versiones y para la terminal del agente en Windows (aporta `bash`)

## Puesta en marcha

```bash
# 1. Dependencias (workspaces: shared, server, web)
pnpm install
# En pnpm 10, si te pide aprobar el script de compilación de better-sqlite3:
pnpm approve-builds

# 2. Variables de entorno
cp .env.example .env        # deja GEMINI_API_KEY vacío para trabajar sin red

# 3. Datos simulados (empresa, reglas, contratos y 10 facturas de demo)
pnpm seed

# 4. Desarrollo (API en :3000 + interfaz en :5173)
pnpm dev
```

Para producción, una sola app con una URL pública (RNF-8):

```bash
pnpm build     # compila la interfaz (web/dist)
pnpm start     # Express sirve la API y el build de React en :3000
```

> **npm también funciona** (`npm install`, `npm run seed`, `npm run dev`, …): el proyecto
> declara `workspaces` en `package.json` y `pnpm-workspace.yaml` para pnpm.

## Variables de entorno

| Variable | Por defecto | Para qué sirve |
|---|---|---|
| `GEMINI_API_KEY` | vacío | Clave de Google AI Studio. Si está vacía, el sistema corre en modo simulado. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Modelo Flash vigente (confirmar el nombre en AI Studio). |
| `LLM_MODE` | `auto` | `auto` \| `gemini` \| `fixture` \| `mock` \| `cache`. |
| `AGENT_STRATEGY` | `pipeline` | `pipeline` (plan B determinista) o `loop` (loop con tools). |
| `MAX_STEPS` | `6` | Pasos máximos del loop por factura. Al agotarlos: escalar. |
| `PORT` | `3000` | Puerto del servidor Express. |
| `LLM_CACHE_DIR` | `eval/cache` | Cache de respuestas del LLM por factura. |
| `QUEUE_BACKOFF_MS` | `500` | Espera base entre reintentos de la cola. |
| `EVAL_LIVE` | — | `1` evalúa contra Gemini; sin ella `pnpm eval` corre con fixtures (CA-10). |
| `PAYBLINK_DB_PATH` | `data/payblink.sqlite` | Permite aislar la base (los tests usan una temporal). |
| `TURSO_DATABASE_URL` | vacío | URL `libsql://…` de la base en Turso. Sin ella, la app solo usa SQLite local. |
| `TURSO_AUTH_TOKEN` | vacío | Token de Turso para esa base (nunca se escribe en la nube ni en el repo). |
| `TURSO_SYNC` | `1` | `0` apaga la réplica sin borrar las credenciales. |
| `TURSO_SYNC_INTERVAL_MS` | `5000` | Cada cuánto se revisa si hay cambios que empujar. |
| `TURSO_TIMEOUT_MS` | `8000` | Espera máxima al crear el esquema o restaurar al arrancar. |

## Comandos

| Comando | Qué hace |
|---|---|
| `dev` | API + interfaz en modo desarrollo. |
| `build` | Compila la interfaz de React → `web/dist`. |
| `start` | Sirve la app completa (API + interfaz) desde Express. |
| `seed` | Recrea la base local y carga los datos simulados. |
| `reset` | Borra decisiones y ledger, y vuelve a sembrar (útil antes del pitch). |
| `agent` | Corre el agente sobre las facturas pendientes desde la terminal. |
| `eval` | Evalúa el set completo y escribe `eval/report.json` (offline por defecto). |
| `test` | Tests de Vitest (reglas, guard, moneda, extracción, seguridad, cola, chat, auditoría). |
| `typecheck` | TypeScript estricto sobre `shared`, `server`, `eval`, `scripts` y `web`. |
| `generate:invoices` | Regenera los PDF simulados a partir de sus fuentes de texto. |
| `turso:check` | Comprueba conexión, esquema y filas de Turso contra el archivo local. |
| `gemini:check` | Comprueba la clave y el modelo de Gemini con una llamada real y muestra la huella de la clave. |

## Cómo se decide

```
recibir → normalizar y encolar → extraer → verificar → evaluar las 8 reglas
        → propuesta del LLM → GUARD → describir → registrar → notificar si escala
```

| Decisión | Significado | ¿Puede cambiarla una persona? |
|---|---|---|
| **Pagar** | Cumple todas las reglas; el agente registra la decisión de pago | No aplica |
| **Frenar** | Incumple una regla de bloqueo (por ejemplo, un duplicado exacto) | Solo confirmar el rechazo |
| **Escalar** | Se sale de una regla que exige humano, o hay dudas o fallos | Sí: aprobar o rechazar, queda registrado |

La decisión final es la **más restrictiva** entre la propuesta del LLM y el veredicto del motor
(`pagar < escalar < frenar`). Detalle completo en [`docs/architecture.md`](docs/architecture.md).

### Las ocho reglas

| ID | Regla | Al incumplirse |
|----|-------|----------------|
| R1 | Cobro duplicado (mismo beneficiario, monto y referencia) | Bloquea (casi duplicado: escala) |
| R2 | Beneficiario en la lista permitida | Escala |
| R3 | Límite por pago | Escala |
| R4 | Límite por periodo (lo ya aprobado más esta factura) | Escala |
| R5 | Presupuesto disponible del periodo | Escala |
| R6 | Coincide con lo contratado (beneficiario, monto y moneda) | Escala |
| R7 | Monto sobre el umbral de aprobación humana | Escala |
| R8 | Datos completos, extracción verificada y fechas coherentes | Escala |

Todas son configurables desde `data/rules.json` o desde la pantalla **Reglas**.

## Interfaz: sala 3D y 8 pantallas

La vista principal es una **oficina 3D** (Three.js) con un trabajador encargado por área y el
flujo real del agente: recepción → extracción → reglas → LLM → GUARD → pagar/escalar/frenar.
Cada factura es una hoja que avanza por la banda según su estado de cola y termina en la salida
de su decisión. Las ocho pantallas siguen intactas: cada puesto de la oficina abre su pantalla en
un **panel lateral**, y el botón **Vista clásica** devuelve la interfaz anterior sin perder
funciones.

- **Entradas:** simulador de facturas (subir PDF, redactar correo, mensaje de chat), galería de
  ejemplos normales y trampa, botón “Cargar set completo” y la cola con el estado en vivo.
  Al elegir un PDF se muestra la **vista previa del texto extraído** antes de crear la factura.
  Un interruptor define el disparo: **manual** (botón Procesar) o **automático** (como el webhook
  de producción).
- **Facturas:** tabla con fuente, estado de cola, estado de la decisión y la descripción del
  agente. El detalle muestra los 5 componentes de la descripción, el rastro de reglas, la
  verificación, la bitácora cronológica, la orden de pago preparada y el hilo de chat de la
  factura. Incluye **Exportar CSV**.
- **Aprobaciones:** las escaladas pendientes, con botones de aprobar y rechazar y un comentario.
- **Reglas:** límites, beneficiarios permitidos, umbral, presupuesto, tasas y severidad de cada regla.
- **Chat:** conversación general o por factura. Solo consulta y **propone**; las acciones
  (aprobar, rechazar, agregar beneficiario, ajustar un límite) son tarjetas que exigen **Confirmar**.
- **Notificaciones:** mockup de teléfono con el WhatsApp/correo simulado del aprobador, botones
  Aprobar/Rechazar, “Ver detalle” y “Preguntar al agente”. Banner: *Simulación: no se envía nada real*.
- **Conectores:** tarjetas de Gmail, Outlook, Slack, WhatsApp, Google Drive y ERP. Solo
  **Carpeta de demo** y **Subida manual** están activos; el resto se muestra como **vista previa
  (no conectado en este MVP)**, sin pedir credenciales.
- **Auditoría:** línea de tiempo global filtrable por factura, actor y tipo, con verificación de
  la cadena de hashes y exportación a CSV/JSON. El log es *append-only*.

## Evaluación

```bash
pnpm eval            # offline (fixtures), reproducible
EVAL_LIVE=1 pnpm eval  # contra Gemini en vivo, con cache en disco
```

Reporta sobre el set corto de 10 facturas (`eval/expected.json`): 4 válidas y 6 trampas
(duplicado exacto, casi duplicado, beneficiario nuevo, monto que no cuadra, aprobación por
monto, datos faltantes con prompt injection). El set largo de 30 facturas queda en
`data/invoices-full/` (no lo carga la ingesta) por si quieres medir volumen: cópialo a
`data/invoices/` y ajusta `eval/expected.json`.

- **Autonomía:** decisiones correctas sin intervención humana (meta ≥ 80 %).
- **Seguridad:** pagos indebidos. Debe ser **0**; el script sale con código 1 si no lo es.
- **Explicabilidad:** decisiones con explicación y motivos.
- **Descripción completa (CA-17/CA-18):** facturas con descripción no vacía, sus 5 componentes y
  decisión consistente.

Resultado con el set actual:

```
Total de facturas:      10
Decisiones correctas:   10
Autonomia:              100%  (meta: >= 80%)
Pagos indebidos:        0
Explicabilidad:         100%
Descripcion completa:   100%
```

## Estructura

```
payblink-agent/
├─ shared/        tipos y esquemas Zod (fuente de verdad de los datos)
├─ server/src/
│  ├─ core/           reglas, guard, moneda, texto, periodos, explain  (código puro)
│  ├─ agent/          orchestrator, prompt, tools, llm (gemini, cache, fixtures)
│  ├─ chat/           chatAgent, tools de lectura, propuestas de acción
│  ├─ extraction/     normalización y verificación de la extracción
│  ├─ ingestion/      InvoiceSource, FolderSource, SimulatedSource, conectores, PDF
│  ├─ jobs/           cola y worker (manual/automático, reintentos, idempotencia)
│  ├─ notifications/  canales simulados, aprobadores, outbox
│  ├─ payments/       beneficiarios ficticios y órdenes de pago preparadas
│  ├─ audit/          audit.log() append-only con hash encadenado y exportación
│  ├─ storage/        SQLite, repositorios, seed, cargador de facturas, generador de PDF
│  └─ api/            rutas Express
├─ web/           React + Vite (oficina 3D con Three.js; Entradas, Facturas, Aprobaciones,
│                 Reglas, Chat, Notificaciones, Conectores, Auditoría en panel lateral)
├─ data/          company.json, rules.json, contracts.json, invoices/ (10 de demo),
│                 invoices-full/ (set largo de 30, fuera de la ingesta),
│                 examples.json, approvers.json, beneficiaries.json, llm-fixtures.json
├─ eval/          expected.json, run.ts, offline.ts, report.json (generado)
├─ scripts/       seed, reset, run-agent, generate-invoices
├─ tests/         Vitest (reglas, guard, moneda, texto, extracción, seguridad,
│                 descripción, cola, chat, auditoría)
└─ docs/          architecture.md
```

## Modo sin red

Sin `GEMINI_API_KEY`, `LLM_MODE=auto` cae a `fixture`: las respuestas del modelo se leen de
`data/llm-fixtures.json` y las descripciones se generan con la plantilla determinista de
`core/explain.ts`. El set completo se procesa igual, sin tocar la API, que es justamente lo que
exige la evaluación reproducible (`pnpm eval` fuerza ese modo salvo `EVAL_LIVE=1`).

Con clave configurada, Gemini hace la extracción real con `responseSchema` y function calling;
las respuestas se guardan en `eval/cache/` para que la demo no dependa de la red (CA-10).

El arranque registra qué modelo y qué clave se aplicaron (nunca la clave completa):

```text
LLM: Gemini (gemini-3.5-flash-lite) · modo=gemini (LLM_MODE=auto)
Modelo: gemini-3.5-flash-lite (desde .env / entorno)
GEMINI_API_KEY: presente (AQ.A…lM9g, 53 caracteres)
```

Cada llamada al modelo añade una línea `[gemini] modelo=… operacion=… ok|error … ms tokens=…`, y
`pnpm gemini:check` hace una llamada real mínima para confirmar qué modelo responde y diagnosticar
clave inválida, modelo inexistente o cuota agotada.

## Réplica en la nube (Turso)

La app sigue trabajando contra SQLite local (`data/payblink.sqlite`): las decisiones se leen y se
escriben sin red, y ningún test depende de Internet. Con `TURSO_DATABASE_URL` y
`TURSO_AUTH_TOKEN` definidas, además se mantiene una **réplica en la nube**:

- Al arrancar se crea el esquema en Turso si falta (mismo DDL que el local, sin `PRAGMA`).
- Si el archivo local está vacío y la nube tiene datos, se **restaura el local** antes del seed
  (así una máquina nueva recupera las decisiones sin volver a sembrar encima).
- Cada 5 s (y ~0,8 s después de cualquier escritura de la API) se comparan huellas por tabla y se
  suben solo las tablas que cambiaron.
- Si Turso no responde, el servidor arranca igual (espera acotada), sigue operando en local y
  reintenta en el siguiente ciclo; el error queda visible en `GET /api/health`.

```bash
# comprobar credenciales, esquema y cuántas filas hay en cada lado
pnpm turso:check

# estado de la réplica con el servidor en marcha
curl -s localhost:3000/api/health | jq .turso
```

El espejo no es la fuente de verdad: la nube recibe las escrituras con unos segundos de retardo.
Si en algún momento se quiere que las consultas vayan directo a Turso, hay que migrar el driver
(`better-sqlite3` es síncrono; libSQL es asíncrono) y volver `async` toda la capa de repositorios.

## Alcance y límites

Este proyecto **no** ejecuta pagos reales, no mueve dinero, no se conecta a plataformas de pago,
no abre cuentas ni verifica identidades. Las notificaciones a aprobadores son simuladas y los
conectores de vista previa no establecen ninguna conexión. Trabaja únicamente con datos ficticios.
No incluye decisiones de cumplimiento ni detección de fraude.

Los `tests/security.test.ts` reinician la base local (`data/payblink.sqlite`), igual que
`pnpm reset`: si tienes la demo abierta con decisiones cargadas, vuelve a ejecutar
`pnpm seed` o pulsa **Reiniciar demo**.
