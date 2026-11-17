/*
 * Test de la clave cancelada (Chromium real) para resoluciones y parques.
 * Proyectos tiene la misma regla de 4xx en su subida, pero este test todavía
 * no llega a su POST (su subida necesita un disparo que aquí no se simula).
 *
 * Caso: el usuario cancela el diálogo de «Clave de acceso» con una subida
 * pendiente. header.js devuelve el 401 tal cual para que el llamador lo trate
 * como un fallo normal y dispare su backoff. Antes, las tres apps marcaban
 * cualquier 4xx (salvo 429) como permanente: la sincronización quedaba parada
 * hasta recargar y la pantalla decía «rechazado», como si el servidor hubiera
 * rechazado los datos.
 *
 * Qué se verifica, por app:
 *  1. Tras cancelar, la app vuelve a intentar subir (hay más de un POST).
 *  2. Control: un 422 real sigue siendo permanente (un solo POST). Así el
 *     arreglo no afloja la regla para errores de contenido.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(RAIZ, 'public');
const PUERTO = 8793;

let chromium;
try {
  ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'));
} catch {
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.log('SKIP: Playwright no está disponible en este entorno.');
    process.exit(0);
  }
}

let fallas = 0;
const ok = (cond, msg) => {
  if (!cond) fallas++;
  console.log((cond ? '  OK   ' : '  FALLA') + ': ' + msg);
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

function servirEstaticos() {
  return http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const archivo = path.join(PUBLIC, rel);
    if (!archivo.startsWith(PUBLIC) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream' });
    res.end(fs.readFileSync(archivo));
  });
}

// Casos. `pendiente` es la clave de «hay cambios sin subir» de cada página.
const APPS = [
  {
    nombre: 'resoluciones',
    pagina: '/resoluciones.html',
    pendiente: 'resoluciones_crm_sync_pendiente_v1',
    endpoint: '/api/sync-resoluciones',
    get: { resoluciones: [] }
  },
  {
    nombre: 'parques',
    pagina: '/parques.html',
    pendiente: 'parques_crm_sync_pendiente_v1',
    endpoint: '/api/sync-parques',
    // GET válido para que la subida llegue al POST.
    get: { parque: 'Güemes', empresas: [], lotes: [], ocupaciones: [], reservas: [], _meta: { existe: true, sha: 's1' } },
    localExtra: { clave: 'parques_crm_v1', valor: { parque: 'Güemes', empresas: [{ id_empresa: 'E900', nombre: 'TEST LOCAL', id_parque: 'guemes' }], lotes: [], ocupaciones: [], reservas: [] } }
  },
];

// Abre la página con una subida pendiente. La respuesta del endpoint depende
// del caso: 401 (clave cancelada) o 422 (contenido rechazado, el control).
async function correr(browser, app, status) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.addInitScript(([k, extra]) => {
    try {
      localStorage.setItem(k, '1');
      // Un cambio local que el servidor no tiene: sin él, la fusión ve que no
      // hay nada que subir y limpia la marca sin hacer el POST.
      if (extra) localStorage.setItem(extra.clave, JSON.stringify(extra.valor));
    } catch (e) { /* sin localStorage */ }
  }, [app.pendiente, app.localExtra || null]);

  let intentos = 0;
  await ctx.route('**/api/**', (route) => {
    const req = route.request();
    // Se cuentan solo los POST: el GET de bajar no es un reintento de subida.
    if (req.method() === 'POST' && req.url().includes(app.endpoint)) intentos++;
    if (req.method() === 'GET' && app.get && req.url().includes(app.endpoint)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(app.get) });
    }
    const cuerpo = status === 401
      ? { error: 'clave_invalida', detalle: 'Esta app necesita una clave.' }
      : { error: 'Datos rechazados', detalle: 'control' };
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(cuerpo) });
  });

  await page.goto(`http://localhost:${PUERTO}${app.pagina}`, { waitUntil: 'domcontentloaded' });

  // Cancela cada diálogo de clave que aparezca durante la ventana de observación.
  const hasta = Date.now() + 7000;
  while (Date.now() < hasta) {
    const cancelar = page.locator('[data-cancelar]');
    if (await cancelar.count()) {
      await cancelar.first().click({ timeout: 500 }).catch(() => {});
    }
    await esperar(150);
  }
  await ctx.close();
  return intentos;
}

async function main() {
  const srv = servirEstaticos();
  await new Promise((r) => srv.listen(PUERTO, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    console.log('\n=== Clave cancelada: la sincronización vuelve a intentar ===');
    for (const app of APPS) {
      const intentos = await correr(browser, app, 401);
      ok(intentos >= 2, `${app.nombre}: tras cancelar la clave hay reintento (POST=${intentos}, se esperan >= 2)`);
    }

    console.log('\n=== Control: un 422 sigue siendo permanente ===');
    const control = APPS[0];
    const intentosControl = await correr(browser, control, 422);
    ok(intentosControl === 1, `${control.nombre}: un 422 no se reintenta (POST=${intentosControl}, se esperan 1)`);
  } finally {
    await browser.close();
    srv.close();
  }
  if (fallas) {
    console.log(`\n${fallas} FALLA(S)`);
    process.exit(1);
  }
  console.log('\nTodo OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
