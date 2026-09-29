# Expedientes CRM — Instrucciones del agente

App de seguimiento de expedientes con plazos en días hábiles. PWA estática +
un Cloudflare Worker propio que sincroniza contra GitHub sin exponer ningún
token al navegador.

**Leé `.claude-state.json` al empezar.** Tiene el estado de la última sesión y
lo que quedó pendiente. Actualizalo al cerrar.

---

## Arquitectura (y por qué es así)

```
Navegador (public/index.html)
    │  fetch('/api/sync')          ← nunca ve el token
    ▼
Cloudflare Worker (worker.js)     ← acá vive GITHUB_TOKEN, como secret
    │  api.github.com
    ▼
expedientes.json en este mismo repo   ← la "base de datos"
```

- **El token nunca está en el navegador.** Antes la app se lo pedía al usuario
  y lo guardaba en `localStorage`. Se migró a Worker propio para que no circule.
- **`expedientes.json` es el estado compartido.** Cada POST lo reescribe; los
  commits `sync: expedientes <fecha>` los hace el Worker, no una persona.
- **`public/` se sirve vía el binding `ASSETS`** declarado en `wrangler.toml`.

### Endpoints

| Ruta | Qué hace |
|---|---|
| `GET /api/sync` | Devuelve `expedientes.json`. Si no existe aún, devuelve listas vacías (no es error). |
| `POST /api/sync` | Reescribe `expedientes.json`. Crea el archivo en el primer POST. |
| `GET /api/health` | Diagnóstico: `tiene_github_token`, `tiene_binding_assets`, `claves_env`. **Nunca expone el valor del secret.** |

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
  arriba de 1024px, dejando desktop sin forma de crear un expediente.
- **Una sola barra fija** (`.sticky-top`: header + pestañas). No volver a fijar
  paneles con `top: NNpx` hardcodeado: se desalinean apenas cambia un alto.
- **Modales:** abrir/cerrar con `abrirOverlay()`/`cerrarOverlay()` (foco inicial,
  trampa de Tab, Escape, retorno del foco). Inputs a 16px (iOS hace zoom con menos)
  y objetivos táctiles de 44px.
- **Acciones destructivas:** toast con Deshacer (`mostrarToast`), no `confirm()` ni
  popup bloqueante. Un área/responsable en uso por algún expediente no se borra.
- **Antes de agregar cualquier bloque de UI, verificá que no dupliques un `id`.**
  `npm run test:ids` lo chequea.

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
2. `GET /api/health` → `tiene_github_token: true`, `tiene_binding_assets: true`
3. `GET /api/sync` → JSON, no error

**No edites `public/` esperando que otra cosa lo regenere** — acá `public/` es la
fuente, a diferencia del repo del Boletín donde lo genera el scraper.

---

## Pendientes

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
