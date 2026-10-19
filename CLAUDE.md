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
public/parques.html      ← lotes y empresas instaladas en los parques (Güemes + Salta)
public/header.js         ← compartido: header (título + ⋮), FAB, iconos y buscador
public/design-system.css ← compartido: TODOS los colores, radios y medidas (los valores)
public/ui-kit.css        ← compartido: botones de acción, barra de búsqueda y nav (los componentes)

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
| `GET /api/health` | Diagnóstico: `tiene_github_token`, `auth_activa`, `tiene_binding_assets`, `claves_env`, `archivos`. **Nunca expone el valor del secret.** Es el único `/api/` que no pide clave. |

**Todos los `/api/*` salvo `/api/health` piden la cabecera `X-Clave`** cuando el
secret `APP_CLAVE` está cargado. Ver "Clave compartida" más abajo.

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

## Clave compartida (2026-10-19)

Hasta esta fecha **cualquiera que supiera la URL podía leer los expedientes
—que tienen datos personales— y, con un POST, vaciar las cuatro bases.** El
`GITHUB_TOKEN` estaba bien guardado; la puerta que lo usa estaba abierta.

- **Worker**: secret `APP_CLAVE` + cabecera `X-Clave`. La puerta está en el
  router, no dentro de cada handler: un endpoint nuevo bajo `/api/` queda
  protegido por existir, sin que nadie tenga que acordarse. La comparación es
  de tiempo constante.
- **MODO TRANSICIÓN, a propósito**: si `APP_CLAVE` no está cargado, el Worker
  se comporta como antes y deja pasar todo, para que el deploy no deje afuera
  a quien usa la app todos los días. **Mientras `/api/health` diga
  `auth_activa: false`, el agujero sigue abierto** — no es un detalle de
  configuración, es la mitad del arreglo. El secret va en Settings →
  "Runtime variables and secrets" (ver la trampa 1 de este documento).
- **Cliente**: `HeaderGlobal.fetchApi()` en `header.js`. Las cuatro apps
  dejaron de llamar a `fetch()` directo. Agrega la cabecera, y ante un 401
  abre un diálogo propio (no `prompt()`), guarda la clave y reintenta.
- **La clave es por DISPOSITIVO, no por app**: las cinco páginas comparten
  origen, así que comparten el `localStorage`. Se escribe una vez.
- **El reintento es un `while`, no un solo intento.** Con un solo reintento,
  una clave mal tipeada dejaba la app sin forma de entrar: el diálogo no
  volvía hasta el siguiente pedido, que podía no llegar nunca. No se puede
  desbocar porque cada vuelta espera a que una persona escriba; cancelar sale
  devolviendo el 401 para que el llamador dispare su backoff.
  **Lo encontró el test del navegador, no la lectura del código.**
- **Los estáticos no piden clave**: son la cáscara, el dato está detrás de
  `/api/`. Pedirla ahí dejaría una pantalla en blanco.

---

## Validación de forma en el Worker (2026-10-19)

`manejarSyncCartas` validaba la forma desde siempre y su comentario lo decía
textual — *"sin esto, un POST con cualquier JSON sobreescribe el archivo
entero con basura"*—. `manejarSync`, que usan las **otras tres** apps, no.
Un `POST {"hola":"mundo"}` de cuatro bytes reemplazaba las 422 resoluciones y
devolvía 200. Es el mismo patrón que produjo los demás bugs de esta
auditoría: una defensa escrita una vez y aplicada en un solo lugar.

`validarFormaApp()` deriva las claves obligatorias del `vacio` de cada app, que
ya declara la forma. **Una app nueva con `vacio: { cosas: [] }` queda obligada
a traer `cosas` como array sin tocar esa función** — que es lo que evita que
la próxima app vuelva a quedarse afuera.

---

## El reintento de sync no se desboca (2026-10-19)

El bug más grave que encontró la auditoría. En **Resoluciones y Parques** el
`catch` de `subirCambios()` terminaba llamándose a sí mismo de inmediato,
porque al fallar no se borra la marca de pendiente:

```js
}catch(e){ setSyncStatus("offline"); }
syncEnProgreso = false;
if(haySyncPendiente()) subirCambios();   // ← otra vez, ya
```

Medido en Chromium con los datos reales y el server devolviendo 500:

| | Antes | Después |
|---|---|---|
| Pedidos | **62 POST/s**, para siempre | 0,3 POST/s, con techo |
| Subida | 170 MB en 10s (~60 GB/h) | 3 pedidos |
| API de GitHub | 124 llamadas/s → 5.000/h **en 40 segundos** | — |

Como el `GITHUB_TOKEN` es uno solo para las cuatro apps, un teléfono con mala
señal dejaba sin sincronizar a las otras tres. El disparador es lo más común
que hay: que el server no esté un rato — incluido el 500 que devuelve el
propio Worker cuando le falta el token.

**Seguimiento y Proyectos nunca lo tuvieron**: el primero corta el `while` al
fallar, el segundo ya tenía backoff exponencial. Se portó el de Proyectos tal
cual (2s → 4s → 8s, techo 60s, `errorPermanente` para los 4xx) en vez de
inventar un tercero.

**El test mide por los dos lados**: techo 10 pedidos (el bucle daba >3.000) y
**piso 2**. El piso no estaba en la primera versión y por eso una recreación
parcial del bug pasaba en verde — si alguien "arregla" el bucle dejando de
reintentar, los cambios se quedan en el teléfono y la pantalla dice guardado,
que es peor porque no se nota.

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

## Parques: lotes y empresas (Güemes y Parque Industrial Salta)

Pedido del usuario (2026-10-13): una cuarta tarjeta para gestionar lotes y
contactos de las empresas instaladas en los parques industriales. Arrancó
**solo con Güemes** ("Solo güemes", 2026-10-13) y el 2026-10-18 se sumó Parque
Industrial Salta. Rosario de la Frontera, Mosconi y los demás siguen afuera:
cada parque llega con su propio export y su propia normalización, así que no
asumir que lo que sigue generaliza a uno nuevo sin revisarlo con el usuario.

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
- **`reservas` sigue siendo de solo lectura** (la tabla existe en el schema y
  llega vacía). `ocupaciones` dejó de serlo el 2026-10-18: ver más abajo.
- **Test**: `testParques()` en `tests/ui.test.mjs` corre contra los datos
  reales (no son de ejemplo, igual que Resoluciones) — filtros, búsqueda
  cruzando a la empresa, ficha con titularidad y ocupación, edición con UTF-8
  intacto, y dashboard. Los conteos por parque (138/54 en Güemes, 135/151 en
  Salta) están hardcodeados a propósito: es el archivo de referencia real, no
  una cifra que cambie por una regla de negocio como el archivado de
  Proyectos.

### Dos parques en el mismo archivo (2026-10-18)

Se sumó **Parque Industrial Salta** desde un export propio del usuario
(`Sistema_Salta.json`, 195 filas → 135 lotes y 136 empresas, más 15 ocupantes;
ver abajo). Güemes dejó de ser el único parque:

- `parques.json` pasó de `parque: "Güemes"` (un string) a `parques: [{id,
  nombre}]` + `id_parque` en cada lote y cada empresa. `migrarParques()` corre
  **al leer**, no una sola vez: un celular con la versión vieja en
  `localStorage`, o un GET que todavía devuelva el formato anterior, entran
  igual y quedan atribuidos a Güemes en vez de aparecer sin parque.
- **Los ids llevan el prefijo del parque**: Güemes `E001`/`L001`, Salta
  `SE001`/`SL001`, y `siguienteId()` calcula el máximo **solo dentro del
  prefijo** — si no, un lote nuevo de Güemes arrancaría en L136 porque Salta
  ya llegó a SL135.
- **Nada se lista desde `state.lotes`/`state.empresas` directo**: todo pasa por
  `lotesDelParque()`/`empresasDelParque()`. Saltearse el filtro mezcla los 138
  de Güemes con los 135 de Salta y el total queda plausible, así que el bug no
  se nota. Lo mismo vale para detectar duplicados y matrículas compartidas:
  "PETIT PLAST" y "SALTA POR" existen en los dos parques y son empresas
  distintas, no una carga repetida.
- El selector de parque (`#parqueSwitch`) va arriba de las pestañas, no entre
  ellas: cambia el alcance de toda la pantalla. Al cambiar se limpian los
  filtros y se cierra la ficha abierta (las manzanas y los estados de un
  parque no existen en el otro). Con un solo parque cargado, la fila no se
  dibuja.
- `parqueActivo` es estado de pantalla: se guarda en `localStorage` para
  sobrevivir a un refresh, pero **no viaja en `datosParaSync()`**.

### Los exports normalizados: se fusionan, no reemplazan (2026-10-19)

El usuario subió `guemes_normalizado.json` (139 filas) y `salta_normalizado.json`
(194 filas), "con mejoras más prolijas sin tanto dato basura", y pidió sacar
`actividad` y `cuit` de las dos y `observaciones` de Salta.

**Son más limpios en columnas, pero no en todas.** Reemplazar habría borrado
trabajo que no está en ningún export: las 20 ocupaciones de alquiler, los 15
ocupantes sin registro, `disponible` (la cartera comercial), el `estado` de los
135 lotes de Salta (esa columna no existe en el archivo) y
`propietario_matricula`. Por eso la regla es **el export manda en lo que trae
limpio; producción manda en lo que el export no tiene**. Con decisión del
usuario, y vale para el próximo export también.

Qué pasa con cada cosa:

| Campo | Quién manda |
|---|---|
| matrícula, manzana, parcela, superficie (Güemes), escritura, titularidad | export |
| nombre, rubro, mail, teléfono, representante, cargo, ubicación, situación | export |
| `estado` del lote, `disponible`, `matriculas`, superficie (Salta) | producción; el export solo llena huecos |
| `ocupaciones` y los 15 ocupantes sin registro | producción, intactas |
| links (`pagweb`, `instagram`, `linkedin`, `facebook`) | producción; del export, solo si la URL nombra a la empresa |

**Las trampas que tiene este origen** —todas verificadas contra los datos, no
supuestas—, porque van a volver en el próximo export:

- **`L40` no es `L040`.** Al id le falta el relleno de ceros y es otro lote
  (CRAYÓN S.R.L, manzana 2, matrícula 11942; `L040` es CERÁMICA SALTEÑA,
  manzana 19, matrícula 15048). Entró como alta, con `id_lote_original`.
- **Los ids de empresa del origen colisionan**: `E066` es SEI INGENIERIA *y*
  CRAYÓN, `E054` es REFINOR, RIXOM y ADIONICS, más 16 casos en Salta. El match
  es **por nombre normalizado**, nunca por ese id, que solo se guarda como
  `id_empresa_original`.
- **Los lotes de Salta se mapean por id, no por matrícula.** `SL042` es el
  `Id_lote` 42 del origen (el rango va de 1 a 144 con 10 huecos) y la fila con
  `Id_lote: "x"` es `SLX1`. Por matrícula no sale: hay 8 repetidas.
- **`LIBRE`, `LIBRE: COOPERATIVA`, `LIBRE: GABRIEL SIÑARES` no son empresas.**
  Son las 15 filas de los lotes libres, el formato crudo que la base SQLite ya
  había resuelto como `disponible`. Si se cargan como empresa, la cartera
  comercial pasa de 19 lotes a 2 y la pestaña Comercial se vacía.
- **Hay tres columnas corridas.** `per` (Güemes) mezcla URLs de LinkedIn con el
  historial de desadjudicación; `PagWeb` trae cargos ("Socio - Gerente") y a
  veces cargo + URL en el mismo campo; y **`LinkedIn` está desplazado**:
  PETRASUD trae el de PETIT PLAST, PRONTO PACK el de POSCO, GRUPO CN el de
  TRANSCLOR. Cada pedazo se reparte por lo que **es** (URL, cargo conocido,
  dirección con número), y una URL solo se asigna si su slug nombra a la
  empresa o a su representante. Lo que no encaja queda en `observacion`, no se
  tira.
- **La superficie de Salta es la suma de sus matrículas**, no el valor de la
  primera fila, y este export perdió una fila respecto del anterior (a `SLX1`
  le falta la matrícula 159021, 14.759 m²). Tomarla del archivo borraba
  117.000 m² del total.
- **El export vuelve a mezclar al inquilino con el titular.** Las 16 empresas
  que hoy son titulares de un lote con ocupación vigente no reciben `mail`,
  `contacto_nombre`, `cargo` ni links del archivo: eso se desarmó con evidencia
  el 2026-10-18 y el export es anterior a ese trabajo. Sí reciben rubro,
  teléfono, ubicación y situación.
- **Una baja hecha a mano le gana a un export más viejo.** AGRO CONSTRUCCIONES
  LA POSTA la borró el usuario desde la app el 2026-10-17; el archivo se la
  vuelve a asignar a L115/L116. No se resucitó: los lotes quedan libres y la
  nota está en el lote (`BORRADAS_EN_LA_APP` en el importador).

Lo que se fue: `cuit` y `actividad` (pedido), más `cuit_valido_11dig` y
`metodo_match_contacto`, que solo hablaban del cuit. La `observacion` de las
empresas de Salta también (pedido): eran 151 de 151 diciendo "Importado del
Sistema Salta el 2026-10-18." **Se conservó en los 15 ocupantes de alquiler**,
donde dice qué datos se les reasignaron y desde qué titular — sin eso, ese dato
queda sin procedencia. El `rubro` va literal del archivo, sin la categoría
(" | Agroindustria y Alimentación") que traía la base anterior: decisión del
usuario. Las 46 que la tenían la perdieron; está en el historial de git.

Resultado: Güemes 139 lotes / 53 empresas (antes 138 / 53), Salta 135 / 151 sin
cambios, 19 lotes libres y 15 disponibles como antes, 20 ocupaciones intactas,
y 3.230.124 m² contra 3.159.513 (la diferencia es exactamente el lote nuevo).

### «Análisis» está en stand by (2026-10-19)

Pedido del usuario: *"lo dejamos en stand by hasta organizar los KPIs que
realmente necesito. Veo mucha información insignificante y con ello ruido"*.
La pestaña se oculta, **no se borró nada**: `renderDashboard()`, su marcado y
sus barras siguen enteros. El interruptor es la constante `DASH_STANDBY` en
`parques.html` — ponerla en `false` la devuelve tal como estaba. Un
`#dashboard` viejo (favorito, historial) cae en Empresas, no en una pantalla
en blanco. Ojo con `[hidden]` en una pestaña: `.tab` es `display:inline-flex`
y le gana, así que hizo falta `.tab[hidden]{display:none}`.

Lo que mostraba, para la conversación de KPIs: lotes, empresas, superficie
total, disponibles, alquilados a un tercero, alquilados sin ocupante cargado,
y barras de estado, escrituración, ranking de empresas por superficie y
rubros. `testParques()` ya no prueba el dashboard: verifica que la pestaña no
se vea y que el hash viejo no deje la pantalla vacía.

### «Alquilada»: titularidad y ocupación son dos vínculos distintos

Especificación del usuario (2026-10-18). El origen trae una fila por lote con
todo mezclado: datos registrales del lote, datos del titular y —en la columna
` Alquilada`— el nombre de quien lo ocupa. El modelo los separa y la UI
también.

- **El lote y su titularidad no se tocan nunca por un cambio de ocupante**:
  `id_lote`, `id_empresa` (titular), `matricula`, `propietario_matricula`,
  `escritura`, `superficie_m2` y la ubicación viven en el lote. La ocupación
  vive **solo** en `ocupaciones` (`id_lote`, `id_empresa_titular`,
  `id_empresa_ocupante`, `fecha_desde`, `fecha_hasta`, `vigente`). Cambiar de
  ocupante cierra la ocupación anterior (`vigente:false` + `fecha_hasta`, no
  se borra) y abre una nueva: el lote no se duplica y la titularidad queda
  igual. Está en `aplicarOcupante()`, y `testParques()` lo verifica campo por
  campo contra el POST.
- **Cada empresa conserva sus datos institucionales.** La ficha del lote
  muestra el bloque "Ocupación por alquiler" leído **entero** del registro del
  ocupante (representante, cargo, rubro, mail, web, Instagram, Facebook), sin
  copiar nada sobre el titular ni sobre el lote.
- **Qué se movió al importar, y con qué evidencia.** En 4 de las 16 filas
  alquiladas los datos institucionales cargados eran del ocupante, no del
  titular (TRADELOG sobre LABORATORIO TECNIMETER —mail, web, Instagram y
  representante—, LOGISCAR sobre FECOOVITA, WILKA TURISMO sobre ALEFCO y
  MANITO Snacks sobre AUTO ELEVADORES BELLO, los tres por el mail). Se
  reasignaron **solo cuando
  el propio valor nombra al ocupante** — dominio del mail, URL, usuario de
  Instagram: eso es evidencia del origen, no una suposición. El resto quedó
  donde estaba. Cada ocupante dice en su `observacion` qué se le reasignó y
  desde qué titular. Los 15 ocupantes creados desde la columna llevan
  `es_ocupante_sin_registro: true`; el origen no trae más que su nombre y no
  se les inventó nada — salvo `situacion: "Activa"`, que no sale del export
  sino de la definición del propio usuario ("la empresa que lo ocupa y
  desarrolla actividad productiva"). Es la única inferencia de la importación;
  si alguna no está operando, se corrige desde la ficha.
- **Alquilados sin ocupante declarado**: 34 lotes de Salta figuran `Alquilada`
  y solo 16 nombran al inquilino (en Güemes, 7 contra 4). No se completó a
  ojo: la ficha lo señala en "A revisar" y el análisis lo cuenta aparte
  ("Alquilados sin ocupante cargado"), para que el total de alquilados no
  parezca un dato completo.
- **`situacion` es de la EMPRESA, `estado` es del LOTE.** El origen mezclaba
  las dos cosas en una columna: "Alquila" describe al lote (pasó a
  `estado: "Alquilada"`), mientras que Activa/Sin actividad/En construcción
  describen a la empresa. Por eso `SITUACIONES` no incluye "Alquilada": que un
  lote esté alquilado no dice si su titular sigue operando, y titular y
  ocupante pueden estar activos los dos a la vez. El desplegable "Todos los
  estados" del listado de Empresas —que estuvo inerte desde el 2026-10-13
  esperando justamente esta definición— filtra por `situacion` desde ahora, y
  se deshabilita en el parque donde el dato no existe (Güemes).

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

## Lo compartido entre apps: `header.js` y `ui-kit.css`

Son las **tres únicas** excepciones a "cada app es un documento autónomo". Todo
lo demás sigue inline en su HTML. La regla para decidir si algo va acá: ¿tiene
que verse y comportarse idéntico en las cuatro pantallas? Si la respuesta es
"más o menos", no va.

| Archivo | Qué vive adentro |
|---|---|
| `public/header.js` | El header (título + ⋮), el FAB, el juego de iconos (`HeaderGlobal.icono`), el cableado de la barra de búsqueda y la vibración de la nav |
| `public/design-system.css` | **Los valores**: la paleta, los tokens semánticos (`--ds-accent`, `--ds-radius-button`…), los alias del vocabulario viejo de cada página y la base de `body` |
| `public/ui-kit.css` | **Los componentes**: `.btn` con sus variantes, la barra de búsqueda y los estados de `.bottom-nav .nav-item`. Sin un solo valor literal |

Los tres se sirven **network-first** en `sw.js`: una copia vieja deja la app sin
cabecera, con los botones sin estilo o —desde que las páginas no declaran sus
propios colores— con los tokens sin resolver, que es peor que esperar la red.

## Header global: el primer código compartido entre apps

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
- **El FAB va en `z-index:14`, por debajo del overlay de los modales.** Nació
  con 40 y eso lo dejaba flotando SOBRE la ficha abierta en parques,
  proyectos y resoluciones (que ponen su overlay en 20; seguimiento usa 200 y
  por eso se salvó), tapando contenido y abriendo un alta nueva encima de lo
  que se estaba mirando si alguien lo tocaba. `testUniformidad()` lo prueba
  por comportamiento —abre el modal y pregunta qué recibe el toque en el
  centro del botón—, no comparando z-index entre archivos.

## Sistema de diseño (`design-system.css` + `ui-kit.css`)

Pedido del usuario (2026-10-19): *"un sistema de diseño en cuanto a botones y
pantalla, compartido, con herencia controlada, clases comunes y variantes por
acción. Así, si modificás el radio de los botones o el color principal, el
cambio se aplica en todas las pantallas sin editar cada una por separado"*.

**Dónde se toca algo:**

| Querés cambiar… | Tocás | Archivos editados |
|---|---|---|
| El color principal de toda la app | `--ds-accent` | 1 |
| El radio de todos los botones | `--ds-radius-button` | 1 |
| El alto de todos los controles | `--ds-control-height` | 1 |
| El fondo de las cinco pantallas | `--ds-bg` | 1 |

Antes de esto eran **cinco** ediciones para cualquiera de esas cuatro filas, y
es exactamente lo que costó sacar el índigo y el ámbar: cada `.html` traía su
propia copia de la paleta.

### Las tres capas

1. **Primitivas** (`--ds-c-*`): la paleta cruda, sin significado. No se usan
   fuera de `design-system.css`. Si una página escribe `var(--ds-c-gray-200)`
   se saltó la capa semántica y el cambio deja de propagarse.
2. **Semánticas** (`--ds-accent`, `--ds-border`, `--ds-radius-button`…): qué
   significa cada valor. **Es la capa que se edita.**
3. **Alias** (`--accent`, `--fg`, `--primary`, `--gray-200`, `--c1`…): los
   nombres que las páginas ya usaban, apuntados a la capa semántica. Existen
   para no reescribir las ~900 llamadas a `var(--…)` que hay en los cinco
   documentos. Son nombres viejos con valores nuevos, **no** una segunda
   fuente de verdad: ni un `#hex` del lado derecho.

`ui-kit.css` consume la capa 2 y **no tiene ni un valor literal** — ni un
color, ni un radio. Es dependencia dura: sus `--ui-*` ya no llevan valor de
respaldo, así que el `<link>` de `design-system.css` tiene que ir **antes**.

### Herencia controlada

Una página puede desviarse, pero solo redeclarando **un token puntual** en su
`:root`, con un comentario que diga por qué (su `<style>` va después del
`<link>`, así que gana por cascada, no por `!important`). Nunca copiando la
paleta entera.

Hoy hay **una sola** desviación viva: `seguimiento.html` pisa `--orange` y
`--yellow` porque su naranja es el del semáforo de urgencia (`#f97316`, más
saturado) y no el de categorías (`#b05a1a`) que usan Proyectos y Parques. Está
anotada en la página **y** en la lista `DESVIOS_PERMITIDOS` de
`tests/ids.test.mjs`: una desviación que no esté en esa lista pone el test en
rojo. Para una app que algún día necesite su propio acento, el camino es el
gancho `[data-app="…"]` del final del bloque semántico, no un `--accent` suelto.

### Variantes por acción

Un solo componente `.btn` y una variante por tipo de acción. El tamaño nunca
cambia entre variantes: Eliminar mide exactamente lo mismo que Guardar.

| Acción | Variante | Icono | Se ve |
|---|---|---|---|
| Guardar | `.btn-primary` | `guardar` | Relleno con el acento |
| Resolver | `.btn-success` | `resolver` | Relleno con el acento (no verde: ver abajo) |
| Editar | `.btn-outline` | `editar` | Contorno, fondo transparente |
| Cancelar | `.btn-secondary` | `cancelar` | Contorno sobre `--ds-surface` |
| Eliminar | `.btn-danger` | `eliminar` | Contorno rojo, no rojo pleno |

Los modificadores de ancho (`.btn-grow`, `.btn-full`) no son variantes: no
cambian el botón, solo cómo se reparte la fila que lo contiene.

Las variantes se nombran por **rol** y no por la etiqueta del botón a
propósito: hay botones que no son ninguna de las cinco acciones ("Listo",
"Aceptar", "Mostrar 50 más") y necesitan un rol igual. Lo que garantiza el
"por acción" no es el nombre de la clase sino `testUniformidad()`, que compara
las cinco acciones entre las cuatro apps.

### Cómo se verifica (y por qué así)

- `tests/ids.test.mjs` (rápido, sin navegador): las cinco páginas cargan los
  dos archivos **y en ese orden**; `ui-kit.css` no tiene literales; ninguna
  página redeclara un token del sistema fuera de `DESVIOS_PERMITIDOS`.
- `tests/ui.test.mjs` → `testUniformidad()`: **pisa el token en caliente** y le
  pregunta al navegador qué pinta. No alcanza con leer el CSS —eso solo diría
  que el token existe—; lo que se prueba es que cambiar `--ds-accent`,
  `--ds-radius-button`, `--ds-control-height`, `--ds-bg` o `--ds-fg` mueva de
  verdad a las cinco pantallas. Si alguien vuelve a clavar un color en el
  `<style>` de una página, esa página deja de moverse y el test la nombra.

### Cambio de pantalla (transición entre documentos)

Esto es un MPA, así que pasar de Proyectos a Parques es cargar otro documento
y el navegador corta en seco. Lo resuelve la API de View Transitions entre
documentos, sin JavaScript y sin volverlo una SPA.

**El opt-in va INLINE en el `<head>` de cada página, y es la única excepción
del sistema de diseño.** No es una preferencia de estilo: el navegador decide
si anima en el primer render del documento que entra, y una hoja externa llega
tarde a esa decisión. Medido sobre las pantallas reales, con la regla en
`design-system.css` la transición salía en **5 de 8** navegaciones; inline, en
**8 de 8**. Una animación intermitente se lee como un error, así que esto es
correctitud. La preferencia de menos movimiento viaja en el mismo bloque
inline por el mismo motivo.

Lo que sí vive en `design-system.css` —y se regula desde ahí para las cinco—
es qué se anima, cuánto dura (`--ds-transition-pantalla`) y qué se queda
quieto: `.bottom-nav` tiene `view-transition-name`, así que la barra no se
desvanece con el contenido, solo cruza su propio cambio de app activa. El
header **no** se nombra a propósito: lo monta `header.js` en `DOMContentLoaded`
y puede no existir cuando el navegador saca la foto del documento nuevo.

> Dos elementos con el mismo `view-transition-name` en un documento hacen que
> el navegador descarte la transición **entera**, sin avisar. Por eso el test
> cuenta cuántas `.bottom-nav` hay, no solo que el nombre esté puesto.

**Cómo se prueba, y por qué así:** el modo de fallar de esto no es "la regla
no está", es "la regla está y el navegador la ignora". Un test que leyera el
CSS daría verde en los dos casos. `testTransiciones()` escucha el evento
`pagereveal` en navegaciones reales y pregunta si el documento entró con
transición. **No saques screenshots durante la navegación**: interfiere con la
transición y da falsos negativos — costó una vuelta entera de diagnóstico.

### La línea índigo al cambiar de pantalla (2026-10-19)

Reporte del usuario: al pasar de una pantalla a otra se veía, por unos
milisegundos, una línea fina índigo. No estaba en la página — se grabó la
navegación cuadro por cuadro, con el CSS retrasado 300ms a propósito, y no hay
**un solo pixel azulado** en el viewport.

Estaba en `manifest.json`, servido con la estrategia de assets
(stale-while-revalidate). De ahí salen `theme_color` y `background_color`, y
el navegador seguía leyendo el `theme_color` viejo —el índigo `#667eea`— de la
copia cacheada. Entre dos documentos hay un instante en que el `<meta
name="theme-color">` del que se va ya no aplica y el del que entra todavía no
se parseó: ahí el navegador cae al manifest. Esa era la línea.

`manifest.json` pasó a la lista de **network-first** junto al HTML,
`header.js`, `design-system.css` y `ui-kit.css`. Si agregás algo de lo que
dependa el aspecto de la app, va en esa lista: lo que se cachea como asset
puede quedar meses atrás.

En la misma pasada se corrigieron dos cosas más:

- **La rama network-first cacheaba respuestas de error.** `cache.put()` sin
  chequear `res.ok` —la rama de assets sí lo hacía— guardaba un 500 o un 404
  servido durante un deploy a medio terminar, y después lo devolvía como
  "fallback offline".
- **Los cinco iconos de atajo del manifest** tenían un color cada uno, entre
  ellos el índigo `#667eea` y el ámbar `#a8650f`. Eran el último lugar donde
  sobrevivían. Quedaron todos en el neutro; los distingue el emoji.

Lo que **sigue** teniendo esos valores, a propósito, es la paleta semántica:
`--ds-c-amber` (`--warn`: "vencido", "pendiente") y `--ds-c-periwinkle`
(`--c1`: uno de los seis colores de tema de Resoluciones y el círculo de
avatar de Parques). Codifican información. Si alguna vez se cambian, hay que
elegir un color que siga distinguiéndose de los otros cinco, no simplemente
sacarlo.

### Lo que el refactor destapó

Pasar los tokens a un archivo común no cambió ni un pixel en Proyectos,
Resoluciones, Parques ni la landing (comparación pixel a pixel antes/después:
diferencias de ±1 en menos del 0,02% de los pixeles, antialiasing). **Sí**
cambió una cosa en Seguimiento, y es un arreglo: sus chips (`.pestana-btn`,
`.area-btn`) declaraban `font-size` pero no `font-family`, así que eran los
únicos controles de la suite que se dibujaban con la fuente por defecto del
navegador en vez de la de la app. Al heredar `button{font-family:inherit}` del
sistema quedaron igual que la pestaña "Análisis" de Proyectos — que es lo que
el usuario había pedido el día anterior.

## Sistema visual compartido (`ui-kit.css`)

Especificación del usuario (2026-10-18): un solo componente de botón, una sola
barra de búsqueda y una sola barra de navegación para las cuatro apps, con
WhatsApp como referencia estética.

**Qué había antes**, y es lo que no hay que volver a dejar pasar: cinco
vocabularios de botón (`.btn-neutral`/`.btn-small` en Seguimiento,
`.btn-ghost`/`.btn-edit`/`.btn-view-action` en las otras tres), **tres alturas
distintas** (38, 41 y 44px), Eliminar en 13px contra 14px del resto y, en
Seguimiento, Eliminar dibujado como botón *chico* al lado de Guardar — la
acción más grave con la mitad del peso visual. `.btn-edit` ni siquiera era
Editar: era la clase de **Cancelar**.

- **Los colores no se redefinen en el kit.** Los tokens `--ui-*` se leen de lo
  que cada app ya declara (`--accent`, `--border`, `--surface`…). El verde
  `#00a884` de la especificación es el de WhatsApp: se dejó afuera a propósito
  — la propia especificación dice "si existen valores aprobados en el
  proyecto, conservarlos". Seguimiento e index declaran además unos alias
  (`--fg: var(--text)`, `--border: var(--gray-200)`…) porque nombran sus
  colores distinto; sin eso el kit caería en sus valores de respaldo.
- **No hay color de marca: ni índigo ni ámbar** (2026-10-19). Hasta esa fecha
  Proyectos iba en ámbar `#a8650f` y las otras tres en índigo `#667eea`, y eso
  pintaba la barra de estado del teléfono de un color distinto en cada
  pantalla. El usuario lo pidió al revés: *"se elimina el ámbar y el índigo
  […] pantalla blanca en su totalidad"*. Hoy:
  - `--accent` es `#1f2937` —la misma tinta del texto— en las cinco páginas,
    y `--accent-fg` es blanco. Lo que era un FAB de color es un FAB oscuro.
  - `--bg` y el fondo del `body` son `#ffffff`, no `#f9fafb`. Las tarjetas se
    separan del fondo por su `border`, que ya tenían todas.
  - `theme-color` es `#ffffff` en las cinco páginas **y** en `manifest.json`.
    Si agregás una página, ese meta va en blanco: es lo que pinta la franja de
    arriba en el teléfono y es lo que se veía mal.
  - Lo que **sí** sigue teniendo color son los estados y las categorías:
    `--danger`, `--ok`, `--warn`, los `--c1..--c6` de los temas y los
    `--s1..--s8` de los gráficos. Codifican información; sacarles el color
    sería borrar el dato, no normalizar la marca. (Quedan ahí un `--c1`
    índigo y un `--c3`/`--warn` ámbar: son badges, no identidad.)
- **Los cinco botones son una pastilla del mismo ancho** (2026-10-19). El
  usuario pidió "mismo radius, ancho, alto e icono" tomando como referencia la
  pestaña **Análisis** de Proyectos, que ya era `border-radius:999px`. Por eso
  `--ui-radius-button` es ahora `var(--ui-radius-pill)` y no 8px. El ancho
  igual lo da `.btn-grow`, que pasó de `flex:1 1 auto` a `flex:1 1 0`: con
  base `auto` el reparto arrancaba del largo del texto y "Eliminar" terminaba
  más ancho que "Editar" en la misma fila. A 390px una fila de tres botones da
  114px cada uno y ninguno desborda. Lo que falta para que la regla se cumpla
  es poner `btn-grow` en **todos** los botones de una fila, no solo en el
  principal — era el bug: Guardar lo tenía y Cancelar/Eliminar no.
- **Editar es siempre `btn-outline`.** Proyectos lo alternaba entre
  `btn-primary` y `btn-outline` según el expediente estuviera archivado: el
  mismo botón con dos pesos visuales dentro de la misma app, y un tercero
  respecto de Resoluciones y Parques.
- **Seguimiento ya no dibuja sus propios SVG en el HTML.** Cancelar y Eliminar
  traían un SVG a mano de 14px en el marcado *además* del icono que
  `HeaderGlobal.icono()` les pone al iniciar, y Guardar no traía ninguno: se
  veían tres cosas distintas hasta que corría el script. Ahora el HTML es solo
  el texto y el icono viene siempre del juego compartido, a 18px.
- **40px de botón y 44px de área táctil, las dos cosas.** La especificación
  pide controles de 40px y el proyecto exige 44px de objetivo táctil: el botón
  mide 40 y un `::after` estira el área a 44, igual que los chips de filtro
  (38 visuales / 44 táctiles). El test lo verifica por comportamiento
  (`elementFromPoint`), no midiendo el rectángulo.
- **Las medidas de escritorio de la barra de búsqueda no se tomaron
  literales** (alto 134px, texto 46px, lupa 50px): son píxeles de la captura
  de referencia, no de CSS — a esa escala la barra ocupa un quinto de la
  pantalla. Se usan las del bloque móvil de la misma especificación (48px,
  16px, 20px) en los dos anchos. Mismo caso que los "40px" del título del
  header en la especificación del 2026-10-14.
- **Resolver pasó de neutro a color de acento.** El 2026-10-13 el usuario
  había pedido que Resolver se viera como Editar ("sin verde/gris distintos");
  la especificación nueva le asigna la variante `success`, que en el kit es el
  acento de la app, no verde. Las dos cosas se respetan: no es verde, pero sí
  se distingue de Editar como acción principal.
- **Los iconos son Lucide dibujados a mano** (`HeaderGlobal.icono`): save, x,
  trash-2, pencil, check-circle-2, rotate-ccw y search, todos al mismo trazo y
  tamaño. No se sumó la librería: el proyecto no tiene build step ni
  dependencias y serían siete iconos. El emoji 🔍 que hacía de lupa en el
  buscador de Seguimiento se eliminó — se dibuja distinto en cada sistema.
- **La vibración al tocar la nav es opcional de verdad**: solo donde el
  navegador la soporta, nunca como única señal (el `:active` del kit siempre
  está) y apagada si el sistema pide menos movimiento.
- **Test**: `testUniformidad()` compara entre las cuatro apps el alto, el
  radio (que sea de pastilla), la tipografía, la alineación y el tamaño de
  icono de los botones, el ancho **dentro de cada fila de acciones**, y el
  alto, el radio, la fuente, la lupa y el botón de limpiar de las búsquedas.
  Es el test que hubiera cazado las tres alturas distintas. El ancho se
  compara por fila y no entre pantallas a propósito: una fila de dos botones
  y una de tres dan anchos distintos y las dos están bien.

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
- [ ] **Última escritura gana en 3 de las 4 apps** (Seguimiento, Resoluciones,
      Parques). Demostrado el 2026-10-19 contra el Worker real: dos
      dispositivos que abren la misma pantalla y guardan, y el trabajo del
      primero desaparece sin error ni aviso (Proyectos devuelve 409 y fusiona).
      La solución es generalizar `manejarSyncCartas`, no reescribirla: el
      `sha` que ya devuelve `githubGetFile` alcanza para detectar el choque.
- [ ] **Dos tablas de feriados distintas**, y las dos mal en Viernes Santo
      2026. Seguimiento y Proyectos calculan días hábiles con listas propias:
      el mismo vencimiento da semáforo distinto según la pantalla. Verificado
      calculando Pascua (Meeus/Jones/Butcher, contrastado con 2023-2025):
      Viernes Santo 2026 es el **03/04**; Proyectos dice 17/04 y Seguimiento
      10/04. Falta decidir los movibles por decreto (Soberanía, 25/07) con el
      usuario, y unificar en un `calendario.js` compartido.
- [ ] **33 funciones comparten nombre entre apps y 32 divergieron.** Es la
      causa raíz de los cuatro bugs P0 del 2026-10-19: una defensa escrita una
      vez y aplicada en un solo lugar. El camino es el mismo que resolvió el
      CSS con `design-system.css`: un `sync.js` compartido primero.
