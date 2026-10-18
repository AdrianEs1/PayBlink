# Arquitectura

## La idea en una frase

**El LLM propone, el código decide.** El modelo de lenguaje lee, extrae y propone; un
motor de reglas determinista fija la decisión final. El modelo nunca puede *relajar* una
decisión, solo *endurecerla*. Ante cualquier duda, fallo o timeout, el resultado es **escalar**.

## Flujo de una factura

```
carpeta (data/invoices) ─┐
subir PDF / correo / chat├─► InvoiceSource ─► invoice normalizado (hash + fuente, estado pendiente)
conector (vista previa) ─┘                          │
                                                    ▼
                                          ┌───────────────────┐
                                          │ cola + worker     │  manual / automático
                                          │ jobs/queue.ts     │  reintentos + idempotencia
                                          └───────────────────┘
                                                    │  una factura a la vez
                                                    ▼
   ┌─────────────┐   JSON validado con Zod + normalización tolerante (LLM)
   │ extracción  │   extraction/normalize.ts
   └─────────────┘
         │
         ▼
   ┌─────────────┐   ¿el monto y el beneficiario aparecen en el texto?  (código puro)
   │verificación │   extraction/verify.ts
   └─────────────┘
         │
         ▼
   ┌─────────────┐   R1..R8, todas, sin cortar en la primera
   │   motor     │   core/engine.ts + core/rules/*
   └─────────────┘
         │
         ▼
   ┌─────────────┐   loop con tools  o  pipeline fijo (plan B)
   │  agente     │   agent/orchestrator.ts (LlmClient)
   └─────────────┘
         │
         ▼
   ┌─────────────┐   mostRestrictive(propuesta, veredictoMotor)
   │   GUARD     │   core/guard.ts   ← único punto de decisión
   └─────────────┘
         │
         ├─► descripción obligatoria (RF-6)  core/explain.ts
         ├─► ledger + orden de pago preparada  payments/orders.ts
         ├─► bitácora append-only encadenada  audit/audit.ts
         └─► si escala: notificación simulada + mensaje en el hilo  notifications/service.ts
```

## Reglas de dependencia

```
shared/   ← tipos y esquemas Zod. Solo depende de Zod.
core/     ← código puro. NO importa agent/, storage/ ni api/.
             Sin red, sin base de datos, sin LLM. Mismas entradas ⇒ mismo veredicto.
agent/    ← orquestador, prompts, tools, clientes LLM y cache.
chat/     ← chat con tools de solo lectura y propuestas que exigen confirmación.
ingestion/← InvoiceSource, FolderSource, SimulatedSource, conectores y extracción de PDF.
jobs/     ← cola y worker (manual/automático, reintentos, idempotencia).
notifications/ ← canales simulados, directorio de aprobadores y outbox.
payments/ ← directorio ficticio de beneficiarios y órdenes de pago preparadas.
audit/    ← log append-only con hash encadenado y exportación.
storage/  ← SQLite, repositorios, seed.
api/      ← Express. Solo habla con los módulos anteriores.
```

Las **tools del agente son de solo lectura** (`agent/tools.ts`): `get_invoice_text`,
`lookup_beneficiary` (devuelve la ficha ficticia del beneficiario), `find_duplicates`,
`get_contract_terms`, `get_budget_status`. La única tool de cierre, `submit_decision`,
no ejecuta nada: pasa por el guard.

Solo el orquestador escribe decisiones, y siempre a través de `applyGuard`.

## Ingesta y cola

- **RF-1.4 / RF-1.5:** toda fuente implementa `InvoiceSource` (`ingestion/sources.ts`).
  `FolderSource` lee `data/invoices/` (set corto de demo: 10 facturas) y `SimulatedSource` normaliza las entradas creadas en la
  pantalla Entradas. Cualquier fuente se convierte en un registro `invoice` con estado
  `pendiente`, fuente de origen (`SourceInfo`) y **hash del contenido** para no reprocesar dos
  veces el mismo mensaje o archivo.
- **RF-1.8:** crear la entrada no ejecuta al agente. En modo **manual** nada se procesa hasta
  pulsar Procesar; en **automático** cada entrada se encola sola (simula el webhook de producción).
- **RF-1.9:** el worker procesa de una en una, en el orden determinista de las facturas, con
  reintentos y backoff (`QUEUE_BACKOFF_MS`). Los estados visibles son
  `pendiente → en cola → procesando → pagada / frenada / escalada / error`, y la UI los refresca
  por polling. La toma de trabajo es atómica (`claimNextInvoice`), así que una factura nunca se
  procesa dos veces; además, si ya existe una decisión, el worker la omite.
- **RF-1.10 / CA-6:** si el procesamiento falla de forma irrecuperable (LLM caído, timeout, PDF
  ilegible), se registra una decisión **escalada** con la descripción del fallo. Nunca queda una
  factura sin descripción.

## El guard en detalle

`core/guard.ts` es la bisagra del sistema:

```ts
decisionFinal = mostRestrictive(propuestaLLM, veredictoMotor)   // pagar < escalar < frenar
```

- Si **alguna** regla bloquea ⇒ `frenar`, sin excepción (ni siquiera con aprobación humana).
- Si el motor escala y el modelo propone pagar ⇒ `escalar`.
- Si el modelo es más estricto ⇒ se conserva su propuesta.
- La **única** forma de convertir una escalada en pago es una aprobación humana explícita,
  registrada con quién, cuándo y por qué (RF-7.3, RF-8.3).

## Las ocho reglas

| ID | Regla | Al incumplirse | Archivo |
|----|-------|----------------|---------|
| R1 | Cobro duplicado (exacto ⇒ severidad configurada; casi duplicado ⇒ escala) | bloquea | `core/rules/r1-duplicado.ts` |
| R2 | Beneficiario en lista permitida | escala | `core/rules/r2-beneficiario.ts` |
| R3 | Límite por pago (en moneda base) | escala | `core/rules/r3-limite-pago.ts` |
| R4 | Límite por periodo (ledger + esta factura) | escala | `core/rules/r4-limite-periodo.ts` |
| R5 | Presupuesto del periodo | escala | `core/rules/r5-presupuesto.ts` |
| R6 | Coincide con contrato u orden de compra | escala | `core/rules/r6-contrato.ts` |
| R7 | Umbral de aprobación humana | escala | `core/rules/r7-umbral.ts` |
| R8 | Datos completos, extracción verificada y fechas coherentes | escala | `core/rules/r8-datos.ts` |

Cada regla es una función pura `(ctx) => { ok, motivo, forzar?, detalle? }`. El motor aplica
la severidad configurada, salvo que la regla fuerce un resultado (el casi-duplicado de R1).
Todas son configurables desde `data/rules.json` o desde la pantalla de reglas (RF-3.1).

## Descripción obligatoria (RF-6)

`core/explain.ts` construye una `AgentDescription` con cinco componentes: resumen, qué hizo
(tools consultadas y qué encontró), decisión final y reglas que la determinaron, si el guard
cambió la propuesta y el siguiente paso. La **parte determinista siempre existe**; la narrativa
opcional del LLM solo puede ocupar el resumen, y se descarta si contradice la decisión final
(CA-18). La decisión y los motivos se insertan desde el veredicto del motor, nunca desde el texto
del modelo, y la plantilla también cubre los fallos (`recordFailure`).

Cada factura guarda además una **bitácora cronológica** que es una vista filtrada del log global:
llegó (fuente) → se procesó → decisión del agente → acción humana (si hubo).

## Auditoría (RF-13)

`audit/audit.ts` escribe en una tabla append-only: no hay endpoints ni funciones para editar o
borrar eventos. Cada evento guarda id, marca de tiempo, actor (`agente`, `sistema`, `persona`,
`chat`), tipo, factura y detalle estructurado. Los detalles sensibles se redactan (RF-13.8) y
cada evento encadena el **hash del anterior** (RF-13.5), de modo que `verifyChain()` evidencia
cualquier manipulación. Los eventos de decisión registran versión del modelo, del prompt y de las
reglas (RF-13.4).

Se instrumenta desde el orquestador, el guard, las tools, la API, el chat, la cola y las
notificaciones. `tests/audit.test.ts` comprueba que un procesamiento completo deja la secuencia
esperada de eventos y que la cadena sigue íntegra.

## Notificaciones simuladas (RF-12)

`notifications/` implementa la interfaz `NotificationSender` con `SimulatedWhatsApp` y
`SimulatedEmail`. **Ninguna envía mensajes reales**: se imprimen en consola y se guardan en el
outbox para la pantalla Notificaciones. Al escalar, se elige el aprobador por monto, se compone
el mensaje (beneficiario, monto, motivo, resumen y acciones) y los botones Aprobar/Rechazar
llaman al **mismo camino de aprobación humana** que la pantalla Aprobaciones, con la identidad del
aprobador. El texto libre del aprobador va al chat del agente, que solo consulta y propone.

## Chat con el agente (RF-10)

`chat/agent.ts` mantiene hilos (`global` o por factura) y usa las mismas tools de lectura más
`propose_action`. El chat **nunca ejecuta**: puede proponer aprobar, rechazar, agregar un
beneficiario o ajustar un límite, y esas tarjetas solo se ejecutan cuando una persona pulsa
**Confirmar** (endpoints normales, con registro de quién y cuándo). Si una acción confirmada
cambia una regla, la factura abierta se **reevalúa con el motor**. Cuando el agente escala una
factura, deja un mensaje en su hilo explicando qué regla se activó y qué necesita de la persona.
Las respuestas deterministas de `chat/fallback.ts` garantizan que el chat funcione con datos
reales incluso sin red (CA-10, CA-11).

## Órdenes de pago y CSV (RF-14)

Toda decisión de pagar (del agente o aprobada por una persona) genera una **orden de pago
preparada** con la ficha ficticia del beneficiario (`payments/beneficiaries.ts`). No se ejecuta
ni se envía a ninguna plataforma: alimenta la vista de detalle y el CSV de conciliación de la
pantalla Facturas. La exportación también deja su evento de auditoría.

## Manejo de formatos y del texto no confiable

- **Verificación literal (RF-2.2):** el monto y el beneficiario extraídos deben aparecer en el
  texto original. Se comparan normalizando acentos, mayúsculas y puntuación, y se aceptan
  variantes razonables (`1.500,00`, `1,500.00`, `1500`).
- **Ambigüedad real (RF-2.4):** `1.500` (un solo separador y tres dígitos) admite dos lecturas
  y por eso se marca como ambigua ⇒ escala. Cuando aparecen los dos separadores (`1.500,00` vs
  `1,500.00`) el último es el decimal y no hay ambigüedad.
- **Prompt injection (RF-2.5):** el texto de la factura se delimita y se declara como dato no
  confiable en el prompt. Las frases dirigidas al agente se **detectan y se registran** en la
  auditoría, pero **no cambian la decisión**: el veredicto lo fija el código.

## Resiliencia con el plan gratuito de Gemini

- `MAX_STEPS` acota el loop del agente; agotarlo ⇒ escalar.
- Timeout de 25 s por llamada; cualquier error de red o JSON inválido ⇒ escalar.
- Cache en disco por factura (`eval/cache/`): la evaluación y la demo se repiten sin tocar la API.
- `data/llm-fixtures.json` reproduce las respuestas del modelo: sin `GEMINI_API_KEY` todo el
  sistema sigue funcionando en modo simulado (`LLM_MODE=auto` cae a `fixture`). `eval/offline.ts`
  fuerza ese modo para la evaluación salvo `EVAL_LIVE=1` (CA-10).
- Plan B: un **pipeline fijo** (`AGENT_STRATEGY=pipeline`, por defecto) detrás de la misma
  interfaz del orquestador que el loop con tools (`AGENT_STRATEGY=loop`).

## Determinismo

- Toda fecha de referencia viene de `rules.json` (`fechaReferencia`), nunca de `new Date()`.
- El ledger se fecha con la fecha de referencia del periodo, de modo que la evaluación sea
  reproducible en cualquier momento.
- Las facturas se cargan ordenadas por id y el ledger se consume en ese orden: la segunda
  factura repetida es siempre la duplicada (RF-7.2).
- La cola reclama trabajo en orden de factura, así que la repetición de una demo da el mismo
  resultado.
