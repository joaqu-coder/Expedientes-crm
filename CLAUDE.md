# Expedientes CRM — Instrucciones del agente

Cuatro apps (Seguimiento, Proyectos, Resoluciones y Parques) detrás de una
landing, con un único Cloudflare Worker propio que sincroniza contra GitHub
sin exponer ningún token al navegador.

**Leé `.claude-state.json` al empezar.** Tiene el estado de la última sesión y
lo que quedó pendiente. Actualizalo al cerrar.

---

## Arquitectura (y por qué es así)

Esto es un **MPA** (multi-page, documentos HTML separados), no una SPA con
hash-routing: cada página es un archivo `.html` independiente en `public/`,
con su propio `<head>`, CSS y `<script>` — así una app nueva no toca una sola
línea de la lógica ya auditada de otra: nada de mezclar los dos DOMs, los dos
espacios de `id`, ni los dos `localStorage`.

```
public/index.html        ← landing: cuatro tarjetas, Seguimiento / Proyectos / Resoluciones / Parques
public/seguimiento.html  ← la app de expedientes (la de siempre; antes era index.html)
public/proyectos.html    ← cartas de intención de parques industriales (EGPAIS)
public/resoluciones.html ← resoluciones del Directorio (archivo histórico 2012-2025)
public/parques.html      ← lotes y empresas instaladas en los parques (hoy: solo Güemes)
public/header.js         ← ÚNICO código compartido entre apps: el header (título + ⋮) y el FAB

Navegador (seguimiento)   Navegador (proyectos)      Navegador (resoluciones)  Navegador (parques)
    │  /api/sync              │  /api/sync-cartas         │  /api/sync-resoluciones  │  /api/sync-parques
    │                         │  /api/version-cartas (sondeo)                        │
    ▼                         ▼                            ▼                         ▼
              Cloudflare Worker (worker.js)      ← GITHUB_TOKEN, como secret, compartido
                      │  api.github.com
                      ▼
    expedientes.json   cartas-intencion.json   resoluciones.json   parques.json  ← mismo repo
```

- **El token nunca está en el navegador.** Un solo Worker, un solo
  `GITHUB_TOKEN`, usado por las cuatro apps — así se evita repetir todo el
  setup del secret si se suma una app nueva acá en vez de un Worker aparte.
- **Cada app tiene su propio archivo de datos.** `expedientes.json` para
  Seguimiento, `cartas-intencion.json` para Proyectos, `resoluciones.json`
  para Resoluciones, `parques.json` para Parques. Nunca se mezclan en un
  mismo POST.
- **Proyectos usa un protocolo distinto, más rico, que las otras dos.**
  Seguimiento y Resoluciones son "última escritura gana" vía el patrón
  `APPS`/`manejarSync` en `worker.js` (simple: un GET, un POST). Proyectos
  tiene sondeo de versión (`/api/version-cartas`, cada ~25s desde el
  cliente) y concurrencia optimista (`/api/sync-cartas` responde 409 con el
  contenido actual si otro dispositivo escribió en el medio, en vez de
  pisarlo). Está portado — código y protocolo — del repo
  `joaqu-coder/Parques-Industriales`, donde se armó y probó primero (ver
  `docs/PENDIENTES.md` de ese repo para el historial de bugs que motivaron
  cada pieza: el sha del commit vs. el del blob en el sondeo, last-writer-wins
  perdiendo trabajo entre dispositivos, etc.). Si algún día Seguimiento o
  Resoluciones necesitan lo mismo, es generalizar `manejarSyncCartas`, no
  reescribirlo de cero.
- **`public/` se sirve vía el binding `ASSETS`** declarado en `wrangler.toml`,
  para las tres páginas.
- **Si vas a sumar una app nueva** con el protocolo simple (como Seguimiento
  o Resoluciones), es otro archivo `.html` en `public/`, otra entrada en
  `APPS` (worker.js) con su propio `archivo`/`nombre`/`vacio`, un botón más
  en la landing, y una línea en `tests/ids.test.mjs` (lista de
  `chequearArchivo(...)`). No reuses el storage key de otra app ni su
  endpoint de sync.

### Endpoints

| Ruta | Qué hace |
|---|---|
| `GET /api/sync` | Devuelve `expedientes.json` (Seguimiento). Si no existe aún, devuelve listas vacías (no es error). |
| `POST /api/sync` | Reescribe `expedientes.json`. Crea el archivo en el primer POST. |
| `GET /api/version-cartas` | Sha del blob de `cartas-intencion.json` (sin su contenido), para el sondeo de Proyectos. |
| `GET /api/sync-cartas` | Devuelve `cartas-intencion.json` (Proyectos) + `_meta.sha`, para la concurrencia optimista. |
| `POST /api/sync-cartas` | Reescribe `cartas-intencion.json`. Si el cliente manda `_baseSha` y no coincide con el sha actual, responde **409** con el contenido real en vez de pisarlo. |
| `GET /api/sync-resoluciones` | Devuelve `resoluciones.json` (Resoluciones). Igual que arriba si no existe. |
| `POST /api/sync-resoluciones` | Reescribe `resoluciones.json` (~320 KB: el archivo histórico entero). |
| `GET /api/sync-parques` | Devuelve `parques.json` (Parques: lotes/empresas de Güemes). Si no existe, devuelve listas vacías. |
| `POST /api/sync-parques` | Reescribe `parques.json`. Protocolo simple (como Resoluciones), no el de Proyectos. |
| `GET /api/health` | Diagnóstico: `tiene_github_token`, `tiene_binding_assets`, `claves_env`, `archivos`. **Nunca expone el valor del secret.** |

Cuando algo falle, `/api/health` primero. Dice qué ve el runtime sin adivinar.

---

## Trampas que ya costaron una sesión entera

### 1. El secret va en "Runtime variables and secrets", NO en "Builds"

El dashboard de Cloudflare tiene **dos** secciones con nombres casi idénticos:

| Sección | Para qué sirve | ¿Llega a `env` del Worker? |
|---|---|---|
| Settings → **Runtime variables and secrets** | Lo que el Worker lee al atender requests | **SÍ** |
| Settings → Builds → Variables and secrets | Solo durante `npx wrangler deploy` | **NO** |

El 2026-09-28 se perdieron ~2 horas con `{"error":"GITHUB_TOKEN no configurado"}`
porque estaba cargado en la segunda. El código estaba bien todo el tiempo.

### 2. No agregues `[env.production]` al `wrangler.toml`

El Deploy command configurado en el dashboard es `npx wrangler deploy`, **sin
`--env`**, así que usa la config *top-level*. Si movés `[assets]` a
`[env.production.assets]`, el deploy queda **sin binding ASSETS** y la app
estática deja de servirse. Ya pasó; se revirtió.

### 3. Un secret nuevo no se aplica retroactivamente

Cloudflare aplica el secret a los deployments creados **después** de guardarlo.
Si lo agregás con un deployment ya activo, hace falta un push nuevo para que lo
tome. No es cache del navegador — no pierdas tiempo ahí.

### 4. `/api/*` no se puede cachear en el Service Worker

`public/sw.js` excluye explícitamente `/api/` (línea con
`if (url.pathname.startsWith('/api/')) return;`). Sin eso, la estrategia
stale-while-revalidate sirve datos viejos y la sync parece rota.

### 5. UTF-8 en base64

Los expedientes tienen tildes, ñ y a veces emoji. `atob`/`btoa` solos los rompen.
El Worker usa `decodeURIComponent(escape(atob(...)))` al leer y
`btoa(unescape(encodeURIComponent(...)))` al escribir. No simplificar.

### 6. Fechas: siempre locales, nunca `new Date('YYYY-MM-DD')`

`new Date('2026-10-02')` se interpreta como **UTC**; en Argentina (UTC-3) cae el
día anterior a las 21:00 y `getDay()` corría el fin de semana un día (viernes + 1
día hábil daba sábado). Usar `parsearFecha()` y `fechaISO()`. Tampoco
`toISOString()` para "hoy" ni para chequear feriados. `test:ui` corre el cálculo
en 4 zonas horarias.

### 7. HTML: todo dato va por `esc()`

`expedientes.json` es compartido, así que un `tema` con `<` o `"` es XSS
almacenado o un campo roto. Todo lo que viene de datos pasa por `esc()` en
plantillas y atributos, y los `onclick` leen `this.dataset.*` en vez de
interpolar strings (un área `D'Angelo` rompía el handler).

### 8. Sync: el indicador no miente y nada se pisa

- `syncPendiente` + `expedientes_crm_pendiente` (localStorage) marcan cambios sin
  subir. Al abrir, si hay pendientes se **suben primero**; la descarga nunca pisa
  cambios locales. Un edit durante un POST en vuelo se sube en la vuelta siguiente.
- El indicador refleja el resultado real del POST (antes lo pisaba con "Sincronizado").
- El campo número se sanea en el evento `input`, **no** en `keydown`: filtrar
  teclas bloqueaba Ctrl+V y el teclado de Android.

---

## Proyectos: archivado automático

Pedido explícito del usuario (2026-10-12), para el mismo problema que ya
había diagnosticado una sesión anterior en `docs/PENDIENTES.md` de
`Parques-Industriales`: con 90 días hábiles de plazo aplicados
retroactivamente a expedientes de hace años, el semáforo de Urgencias
quedaba saturado de rojo — no priorizaba nada. La salida que ese documento
proponía y el usuario pidió: una clasificación de archivo que saque del
semáforo lo que de hecho ya nadie va a tratar.

- **Qué archiva**: solo `Sin_tratamiento` sin ningún movimiento (nota,
  edición o cambio de situación — `fecha_ultimo_movimiento`) en
  `UMBRAL_ARCHIVO_DIAS_HABILES` (132, ≈ 6 meses hábiles) días hábiles.
  `En_tratamiento` **no entra, aunque pase el umbral** — corrección pedida
  por el usuario el 2026-10-13: "en tratamiento" significa que alguien lo
  está trabajando activamente (puede ser por teléfono o en persona, sin que
  quede una nota en la app), y archivarlo solo por falta de nota sería
  sacarle de encima algo que sigue en curso.
  `Adjudicada`/`Desestimada` tampoco: ya están resueltas y `urgenciaDe()` ya
  las excluye del semáforo, archivarlas no cambiaría nada visible.
  > El primer deploy (2026-10-12) sí incluía `En_tratamiento` y archivó 8 por
  > error. Se corrigieron a mano en `cartas-intencion.json` (desarchivados,
  > con nota de sistema explicando el porqué) el 2026-10-13, junto con el fix
  > de código — no quedó ninguno mal archivado.
- **Cuándo corre**: `aplicarArchivadoAutomatico()` se llama al cargar la app
  y cada vez que `bajarCambiosIniciales()` trae datos nuevos del servidor
  (carga inicial, sondeo de versión, volver a la pestaña). No hay cron en el
  Worker — si nadie abre la app en meses, el archivado se aplica igual la
  próxima vez que alguien entre, contado contra la fecha de ESE momento. Fue
  una decisión explícita del usuario (la alternativa, un Cloudflare Cron
  Trigger, se descartó por agregar infraestructura para esto solo).
- **Reversible, siempre**: un expediente archivado tiene `archivado:true` +
  `fecha_archivado`. "Rescatar" (pestaña Archivo, o el botón dedicado en la
  ficha) lo saca del archivo, actualiza `fecha_ultimo_movimiento` a ahora (si
  no, volvería a cumplir el umbral en el próximo chequeo) y deja una nota en
  `intervenciones`. **Editar un archivado también lo rescata solo** —
  `onSave` lo trata como "darle tratamiento" — así que no hace falta pasar
  primero por el botón si de todos modos se lo va a editar.
- **`worker.js` no sabe nada de esto.** `archivado`/`fecha_archivado` son
  campos de expediente como cualquier otro; `validarCartas()` no restringe
  qué campos puede tener un expediente, así que no hizo falta tocar el
  Worker.
- **Primer deploy**: con la base real (157 expedientes), ~87 quedan en
  Archivo (todos `Sin_tratamiento`, tras la corrección del 2026-10-13) — más
  de la mitad. Es el resultado esperado, no un bug: es justamente la
  acumulación de años que motivó el pedido. Verificado con Playwright contra
  los datos reales antes de confirmar con el usuario.
- **Test**: `testProyectos()` en `tests/ui.test.mjs` inyecta dos expedientes
  sintéticos con `fecha_ultimo_movimiento` de 2020 (bien por encima del
  umbral, sin depender de la fecha de hoy): uno `Sin_tratamiento` (debe
  archivarse) y uno `En_tratamiento` con la misma fecha vieja (NO debe
  archivarse — es justamente la regresión que motivó la corrección del
  2026-10-13). Verifica archivado automático + Rescatar de punta a punta. No
  asume un conteo fijo de cuántos de los 157 reales se archivan — esa cifra
  cambia día a día a propósito; solo verifica conservación (listado +
  archivo = total servido).

---

## Resoluciones: el archivo histórico

`resoluciones.json` trae el corpus real del Ente: **422 resoluciones de 2012 a
2025**, cargadas el 2026-10-10 desde un export del usuario. No son datos de
prueba: es el registro, y se muestra tal como vino.

- **Nada de inventar datos.** El export tiene 14 resoluciones cuyo documento
  falta en el archivo (número y año conocidos, todo lo demás dice "Falta"):
  entran igual, con tema `Falta`, porque documentan un hueco en la
  numeración. Hay además fechas que el original trae mal tipeadas
  (`09/09/0214`, `11/012021`) o ausentes; se muestran literales, no se corrigen
  a ojo. Y 4 pares comparten número+año con contenido distinto: son registros
  distintos, no duplicados.
- **`nro_resolucion` va con ceros a la izquierda** (`"031"`). El listado ordena
  por año desc y después por `localeCompare` sobre ese string: sin padding,
  `"9"` queda arriba de `"31"`. Si cargás una resolución a mano, respetá los 3
  dígitos.
- **`tema` es un enum** (`TEMAS` en `resoluciones.html`) y son **exactamente
  las 30 categorías del archivo, escritas como las escribe el archivo**: en
  singular (`Requerimiento`, no `Requerimientos`). Arrancó con 15 valores
  inventados cuando la app tenía 3 ejemplos; el 2026-10-10 se reemplazaron por
  los del archivo, que es la fuente de verdad. `test:ui` sostiene la
  correspondencia en los dos sentidos: ningún tema de los datos fuera del
  filtro, ninguna opción del filtro sin resoluciones. Si sumás un tema nuevo va
  a `TEMAS` **y** tiene que tener al menos una resolución, o el test falla.
  Dos salvedades, las únicas: el archivo trae la misma categoría escrita de
  varias formas (`requerimiento`/`Requerimiento`, `Des adjudicación`) y se
  unificó en una sola grafía; y `Prorroga` se corrigió a `Prórroga`, que es lo
  único que se tocó de ortografía.
- **Dos resoluciones venían sin tema** y se clasificaron por su contenido:
  la 023/2021 como `Adenda` (aprueba una adenda a un contrato de adjudicación)
  y la 034/2016 como `Falta` (su contenido en el archivo dice "CHAT GPT": no
  hay resolución ahí). Si aparece otra sin tema, clasificala: el test exige
  que ninguna quede afuera del filtro.
- **`contenido` es el texto resolutivo** y es el campo que justifica la app. Se
  busca por él, se muestra recortado a 2 líneas en la tarjeta y completo en la
  ficha. No lo mezcles con `observaciones` (28 resoluciones tienen observación
  propia, que es otra cosa).
- **El listado pagina de a 100.** 422 tarjetas de una sola vez es scroll
  infinito en el celular.
- **Peso:** cada POST reescribe los ~320 KB enteros, como las otras dos apps.
  Hoy funciona; si alguna vez molesta, el camino es paginar el archivo o
  separar el texto resolutivo, no borrar historia.

---

## Parques: lotes y empresas de Güemes

Pedido del usuario (2026-10-13): una cuarta tarjeta para gestionar lotes y
contactos de las empresas instaladas en los parques industriales. **Alcance
explícito de esta sesión: solo Güemes.** Rosario de la Frontera y los demás
parques quedaron afuera a pedido del usuario ("Solo güemes") — no asumir que
lo que sigue generaliza a otro parque sin volver a normalizar con él primero.

- **El dato no vino de las planillas de Google Drive.** Se exploraron
  ("Sistema güemes", "Contactos PI Salta", " Lotes ") y resultaron
  inconsistentes entre sí y dentro de la misma planilla (columnas corridas,
  dos tablas distintas pegadas una al lado de la otra en la misma hoja). El
  usuario las estaba normalizando aparte y subió el resultado como una base
  **SQLite** (`parques_industriales.db`), con un schema relacional ya
  limpio: `empresas`, `lotes` (con `id_empresa` opcional — `NULL` es lote
  libre o pendiente de revisión), `ocupaciones` (sublocación: titular ≠
  ocupante), `reservas` y `historial_cambios` (estas dos últimas, vacías por
  ahora). `parques.json` es el dump de esas tablas, no una reconstrucción a
  mano de las planillas.
- **Verificar la procedencia antes de cargar, no asumir.** El usuario dijo
  "aquí desplegaremos parque Salta" al subir la base, pero el contenido real
  (V8 Productos de Hormigón, AGSOF, Alimar, Alimentos Sofía — las mismas
  empresas de "Sistema güemes") es inequívocamente Güemes. Se confirmó con
  el usuario antes de tocar nada: "Parque Salta" es el nombre del
  despliegue/sistema, no un parque distinto. La base es de Güemes.
- **Normalización aplicada al importar** (único trabajo de transformación de
  esta sesión; el resto ya venía limpio de la base del usuario): la columna
  `estado` de `lotes` tenía mayúsculas y variantes inconsistentes
  (`Activa`/`activa`, `Alquilada`/`alquilada`/`Alquila`, `Sin actividad`/
  `Sin Actividad`/`sin actividad`, `Construccion`/`En construccion`) —
  colapsadas a 4 valores: `Activa`, `Sin actividad`, `Alquilada`,
  `En construcción`. Un valor `"No"` en el lote `L048` quedó en `null`: no
  es una categoría real, coincide con el valor de `escritura` de esa misma
  fila (parece un desplazamiento de columna en el origen, no un dato
  válido) — no se inventó un significado para no repetir el error de
  Resoluciones de clasificar a ojo.
- **`disponible` ya resuelve lo que en las planillas de Drive era
  `"LIBRE: BUSQUIN"` / `"LIBRE: FORTE"` / etc.** en la columna de empresa
  (lotes desadjudicados que vuelven a la cartera comercial, ver
  "Comercial Güemes" en las planillas originales). La base SQLite ya trae
  esto resuelto como `id_empresa: null` + `disponible: 1/0`, así que esa
  normalización no se reimplementó a mano — se importó tal cual.
- **Protocolo simple, no el de Proyectos.** `/api/sync-parques` es
  GET/POST última-escritura-gana, igual que Seguimiento/Resoluciones. Esto
  es inventario de baja frecuencia de edición (altas/bajas de empresas y
  lotes, no un flujo diario con dos dispositivos pisándose), así que no
  justifica el sondeo de versión + concurrencia optimista de Proyectos. Si
  algún día hace falta, es generalizar `manejarSyncCartas`, como ya dice la
  sección de arquitectura arriba.
- **UI**: pestañas Lotes (filtro por estado/manzana/disponible + búsqueda,
  ficha con la empresa titular y, si corresponde, la empresa que sublocó el
  lote vía `ocupaciones`), Empresas (directorio con contacto, lista de
  lotes de cada una) y Dashboard (totales, superficie, lotes por estado).
  Mismo patrón de modal/esc()/tabs por hash que las otras tres apps.
- **`ocupaciones` y `reservas` son de solo lectura en esta primera versión.**
  La ficha de un lote sublocado muestra quién lo ocupa, pero no hay UI
  todavía para crear o cerrar una ocupación, ni para `reservas` (la tabla
  existe en el schema, llega vacía). Agregar cuando el usuario lo pida.
- **Test**: `testParques()` en `tests/ui.test.mjs` corre contra los 138
  lotes y 55 empresas reales (no son datos de ejemplo, igual que
  Resoluciones) — filtros, búsqueda cruzando a la empresa, ficha con
  titularidad y sublocación, edición con UTF-8 intacto, y dashboard. Los
  conteos (138, 55) están hardcodeados a propósito: es el archivo de
  referencia real, no una cifra que cambie por una regla de negocio como el
  archivado de Proyectos.

## Formato del número de expediente

`XXX-XXXXX/YYYY-ZZ` — **sin paréntesis**.

- Mesa: 3 dígitos
- Número: 1-6 dígitos
- Año: 4 dígitos
- Sufijo: 1-2 dígitos

Ejemplos válidos: `363-1254/2025-01`, `363-125477/2026-0`.

**Una sola fuente de verdad: `validarNumeroExpediente()`.** Acepta guión normal,
medio o largo (`-`, `–`, `—`) porque el número suele pegarse desde Word o un PDF,
que reemplazan el guión automáticamente.

> Bug histórico (2026-09-28): `guardarExpediente` exigía guión **medio** mientras
> el campo lo convertía a guión **normal** en cada tecla. La app borraba el único
> carácter que su propio guardado aceptaba, y encima pintaba el campo de verde
> antes de rechazarlo. Era imposible cargar un expediente, en cualquier viewport.
> **Si tocás la validación del número, que siga habiendo una sola función.**

---

## UI: hay un solo panel de configuración, y es el popup

Decisión del usuario (2026-09-28). Antes convivían un panel inline en un sidebar
y el popup modal, **con los mismos `id`** (`areasConfigList`, `inputArea`,
`responsablesConfigList`, `inputResponsable`). Como `getElementById` devuelve el
primero del documento, todo el JS le pegaba al sidebar y el popup estaba muerto.

El sidebar se eliminó por completo. Reglas que quedan:

- **El formulario de expediente usa siempre el modal** (`#formularioModal`), en
  desktop también. Antes se bifurcaba por `window.innerWidth >= 1024` y dibujaba
  el form en el sidebar, pero Guardar/Cancelar viven en el footer del modal.
- **El FAB (`#fabNuevo`) es visible en todos los anchos.** Tenía `display: none`
  arriba de 1024px, dejando desktop sin forma de crear un expediente. Desde el
  2026-10-14 lo crea `header.js` y es el alta de las CUATRO apps.
- **No fijes paneles con `top: NNpx` hardcodeado**: se desalinean apenas cambia
  un alto.
- **Modales:** abrir/cerrar con `abrirOverlay()`/`cerrarOverlay()` (foco inicial,
  trampa de Tab, Escape, retorno del foco). Inputs a 16px (iOS hace zoom con menos)
  y objetivos táctiles de 44px.
- **Acciones destructivas:** toast con Deshacer (`mostrarToast`), no `confirm()` ni
  popup bloqueante. Un área/responsable en uso por algún expediente no se borra.
- **Antes de agregar cualquier bloque de UI, verificá que no dupliques un `id`.**
  `npm run test:ids` lo chequea.

---

## Header global: el único código compartido entre apps

Pedido del usuario (2026-10-14), con especificación propia: título de la sección
a la izquierda, menú ⋮ a la derecha, misma estructura y posición en las cuatro
pantallas, y **que no se reconstruya por separado en cada una**.

`public/header.js` es, por eso, la única excepción a "cada app es un documento
autónomo": todo lo demás sigue inline en su HTML. Vale la pena solo para lo que
tiene que verse idéntico en las cuatro — hoy el header y el FAB.

```js
HeaderGlobal.init({
  titulo: "Parques",
  accion: { etiqueta: "Nuevo lote", onClick: abrirAlta },   // crea el FAB
  menu:   [{ etiqueta: "Actualizar datos", onClick: bajar }]
});
HeaderGlobal.setSync("Al día", "ok");          // ok | pendiente | error
```

- **La alineación la resuelve el componente, no cada página.** `init()` lee el
  padding del contenedor donde se monta y lo compensa con margen negativo:
  seguimiento.html no tiene padding en el body y las otras tres sí, y sin eso el
  ⋮ quedaba pegado al borde en una pantalla y a 16px en las demás.
- **El menú ⋮ reemplazó a los botones sueltos del header viejo**: configuración
  (era un engranaje), "Actualizar datos" y el estado de sincronización.
- **El estado de sync ya no es un cartel permanente.** Cuando está al día vive
  dentro del menú; si falla, `setSync(..., "error")` muestra `#syncAviso` sobre
  el contenido. Proyectos es la excepción: tiene su propia alerta detallada, así
  que ahí el header solo informa en el menú (si no, aparecían dos avisos).
- **`testUniformidad()` verifica el criterio de aceptación del usuario**: que al
  cambiar de pantalla cambie el título pero el ⋮ conserve exactamente la misma
  posición (y=20, 16px del borde derecho, 48x48).

### No hay modo oscuro

Se eliminó entero el 2026-10-14 a pedido del usuario ("no sé qué hace,
insignificante la función"): el botón, el script pre-paint, el `localStorage`
del tema y **228 líneas** de CSS (`@media (prefers-color-scheme: dark)` y los
bloques `data-theme`). La app es siempre clara, sin importar el tema del
teléfono. Si alguna vez se repone, es un trabajo de cero, no de reactivar algo
que quedó comentado.

---

## Tests

```bash
npm run test          # todo
npm run test:ids      # ids duplicados + getElementById huérfanos (rápido, sin browser)
npm run test:worker   # worker.js contra una API de GitHub mockeada
npm run test:ui       # Playwright/Chromium, desktop y mobile
```

`test:ui` necesita Playwright y Chromium; en el entorno de Claude Code on the web
están en `/opt/node22/lib/node_modules/playwright` y `/opt/pw-browsers/chromium`.
Si no están, el test lo dice y sale sin fallar el resto.

**Disciplina: un fix de UI no se da por bueno sin abrirlo en un navegador real.**
Los cuatro bugs del 2026-09-28 pasaron los tests unitarios sin problema; solo
aparecieron al abrir la página con Playwright. `test:ui` levanta un server local
que imita al Worker, así que no toca producción ni la red.

---

## Deploy

Automático: push a `main` → Cloudflare Workers Builds → `npx wrangler deploy`.
No hay build step (`Build command: None`).

Verificar que salió bien:
1. Dashboard → Deployments → el deployment más reciente debe ser el de tu commit
2. `GET /api/health` → `tiene_github_token: true`, `tiene_binding_assets: true`, `archivos` lista los tres JSON
3. `GET /api/sync`, `GET /api/sync-cartas` y `GET /api/sync-resoluciones` → JSON, no error

**No edites `public/` esperando que otra cosa lo regenere** — acá `public/` es la
fuente, a diferencia del repo del Boletín donde lo genera el scraper.

---

## Pendientes

- [ ] `test:ui` (Playwright) cubre `seguimiento.html`, `resoluciones.html`
      (`testResoluciones()`) y, desde el 2026-10-12, `proyectos.html`
      (`testProyectos()`: listado de los 157 expedientes reales, las 5
      secciones del dashboard, y un POST con tildes/ñ/emoji, en desktop y
      mobile). Ojo si se la toca: esta app debounce la subida 1500ms
      (`DEBOUNCE_MS`), no 100ms como las otras — un test que espera poco
      después de guardar va a fallar en falso.
- [ ] **Rotar el token de GitHub.** Circuló por el chat de una sesión y quedó
      cargado también en Settings → Builds, donde no sirve para nada. Rotarlo en
      GitHub, actualizar **solo** el secret de runtime, y borrar el de Builds.
- [ ] Verificar sync entre dos dispositivos reales (cargar en la compu, abrir en
      el celular).
- [ ] `expedientes.json` se reescribe entero en cada POST. Con dos dispositivos
      editando a la vez, el último gana y el otro pierde sus cambios. Hoy es un
      usuario solo, así que no es un problema real; si alguna vez lo es, la
      solución es usar el `sha` que ya devuelve `githubGetFile` para detectar
      conflictos en vez de pisar.
