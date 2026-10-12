# Expedientes CRM

Tres aplicaciones web progresivas (PWA) detrás de una misma landing, con un
único Cloudflare Worker que sincroniza contra GitHub ("GitHub como base de
datos"): el navegador nunca ve el token de GitHub, solo habla con el Worker.

| App | Página | Qué es |
|---|---|---|
| **Seguimiento** | `public/seguimiento.html` | Expedientes administrativos/legales, con semáforo automático de vencimiento basado en días hábiles. |
| **Proyectos** | `public/proyectos.html` | Cartas de intención de parques industriales (EGPAIS) — listado filtrable, dashboard de 5 secciones, sondeo de cambios en tiempo real y fusión sin pérdidas cuando dos dispositivos editan a la vez. Portada el 2026-10-12 desde el repo `joaqu-coder/Parques-Industriales` (archivado, ver su propio README), donde se armó y probó primero. |
| **Resoluciones** | `public/resoluciones.html` | Resoluciones del Directorio — archivo histórico real: 422 resoluciones de 2012 a 2025, con filtros por tema y año, búsqueda en el texto resolutivo y ficha por resolución. |

**Para la arquitectura completa, las trampas ya pisadas y las decisiones de
diseño de cada app, el documento vivo es [`CLAUDE.md`](CLAUDE.md).** Este
README es el resumen operativo; si algo acá contradice a `CLAUDE.md`,
`CLAUDE.md` tiene la razón (y hay que corregir este archivo).

## Cómo está armado

Es un **MPA** (multi-page), no una SPA: cada app es un `.html` independiente
en `public/`, con su propio `<head>`, CSS, `<script>` y claves de
`localStorage` — nada se mezcla entre apps. Un único `worker.js` sirve los
estáticos (binding `ASSETS`, declarado en `wrangler.toml`) y expone los
endpoints de sync, usando un solo secret `GITHUB_TOKEN` compartido por las
tres apps.

```
Navegador (seguimiento)      Navegador (proyectos)         Navegador (resoluciones)
    │  /api/sync                 │  /api/sync-cartas            │  /api/sync-resoluciones
    │                            │  /api/version-cartas (sondeo)│
    ▼                            ▼                               ▼
            Cloudflare Worker (worker.js)      ← GITHUB_TOKEN, como secret, compartido
                    │  api.github.com
                    ▼
    expedientes.json      cartas-intencion.json      resoluciones.json  ← mismo repo, rama main
```

Cada app escribe su propio archivo JSON en este mismo repo, rama `main`.
Seguimiento y Resoluciones usan un protocolo simple (GET trae el archivo,
POST lo reescribe entero — "última escritura gana"). Proyectos usa uno más
rico, con sondeo de versión y concurrencia optimista (ver `CLAUDE.md`).

## Deploy

**Automático**: push a `main` → Cloudflare Workers Builds → `npx wrangler
deploy` (sin build step). No hace falta tocar nada en Cloudflare para que un
cambio de código llegue a producción, salvo la configuración inicial del
Worker (una sola vez):

1. En Cloudflare → tu Worker → **Settings → Runtime variables and secrets**
   (⚠️ no en "Builds → Variables and secrets", esas no llegan al runtime):
   cargar `GITHUB_TOKEN`, un Personal Access Token de GitHub con permiso
   `repo` (o fine-grained con Contents: Read & write) sobre este repo.
2. Verificar con `GET /api/health` → `tiene_github_token: true`,
   `tiene_binding_assets: true`, `archivos` lista los tres JSON.
3. `GET /api/sync`, `GET /api/sync-cartas` y `GET /api/sync-resoluciones` →
   JSON, no error.

**No edites `public/` esperando que otra cosa lo regenere** — acá `public/`
es la fuente directa, no se genera desde ningún otro lado.

## Dónde está el dato

- `expedientes.json`, `cartas-intencion.json`, `resoluciones.json`: en la
  raíz de este mismo repo, en `main`. El Worker es lo único que los escribe
  (vía la API de GitHub); no se editan a mano salvo para corregir algo
  puntual con cuidado.
- No hay base de datos aparte, ni D1, ni KV: el historial de commits de este
  repo **es** el respaldo.

## Tests

```bash
npm run test          # todo: ids + worker + ui
npm run test:ids      # ids duplicados/huérfanos en cada HTML (rápido, sin navegador)
npm run test:worker   # worker.js contra una API de GitHub mockeada
npm run test:ui       # Playwright/Chromium real, desktop y mobile
```

Antes de dar por buena cualquier cambio de UI, abrilo en un navegador real
(`test:ui` lo hace solo, contra un server local que imita al Worker — no
toca producción). Ver `CLAUDE.md` para el detalle de qué cubre cada test.

## Licencia

MIT License — ver [LICENSE](LICENSE).

---

**¿Preguntas o sugerencias?** Abrí un [Issue](../../issues) en GitHub.
