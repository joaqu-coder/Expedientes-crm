/*
 * Test de concurrencia entre dispositivos para proyectos.html (Chromium real).
 *
 * Simula dos dispositivos contra un mock del Worker que implementa el mismo
 * protocolo que worker.js (sha base, 409 con el contenido actual). Cubre dos
 * bugs de la auditoría del 2026-10-20:
 *
 *  1. Carrera en la descarga: una respuesta GET que llega DESPUÉS de una
 *     edición local pisaba el estado en memoria y en localStorage, mientras la
 *     bandera de pendiente seguía puesta: la edición se perdía sin aviso.
 *  2. Configuración revertida: un dispositivo con cambios pendientes y el
 *     plazo viejo subía ese plazo en su POST y pisaba el que otro dispositivo
 *     acababa de cambiar.
 *
 * Como ui.test.mjs: no toca producción ni la red.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const archivos = {
  '/proyectos.html': ['text/html; charset=utf-8', 'public/proyectos.html'],
  '/header.js': ['application/javascript; charset=utf-8', 'public/header.js'],
  '/plazos.js': ['application/javascript; charset=utf-8', 'public/plazos.js'],
  '/confirmar-cambios.js': ['application/javascript; charset=utf-8', 'public/confirmar-cambios.js'],
  '/design-system.css': ['text/css; charset=utf-8', 'public/design-system.css'],
  '/ui-kit.css': ['text/css; charset=utf-8', 'public/ui-kit.css']
};

const KEY_PENDIENTE = 'cartas_intencion_sync_pendiente_v2';
const KEY_PLAZO = 'cartas_intencion_plazo_v1';

let fallas = 0;
const ok = (cond, msg) => {
  if (!cond) fallas++;
  console.log((cond ? '  OK   ' : '  FALLA') + ': ' + msg);
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Mock del Worker para /api/sync-cartas y /api/version-cartas. `servidor.datos`
// es el archivo remoto; `servidor.posts` guarda cada POST recibido.
function levantarServidor(puerto) {
  const servidor = {
    sha: 's1',
    n: 1,
    datos: { expedientes: [], plazoDias: 20, umbrales: { alerta: 30, critico: 15 }, eliminados: [] },
    posts: [],
    demoraGetMs: 0
  };
  const http_ = http.createServer((req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith('/api/version-cartas')) return json(200, { version: servidor.sha });
    if (req.url.startsWith('/api/sync-cartas')) {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const datos = JSON.parse(body);
          const base = datos._baseSha;
          if (base && base !== servidor.sha) {
            return json(409, {
              error: 'conflicto',
              actual: Object.assign({}, servidor.datos, { _meta: { existe: true, sha: servidor.sha } })
            });
          }
          servidor.posts.push(datos);
          const aEscribir = Object.assign({}, datos);
          delete aEscribir._baseSha;
          servidor.datos = aEscribir;
          servidor.n++;
          servidor.sha = 's' + servidor.n;
          json(200, { ok: true, sha: servidor.sha });
        });
        return;
      }
      const responder = () =>
        json(200, Object.assign({}, servidor.datos, { _meta: { existe: true, sha: servidor.sha } }));
      if (servidor.demoraGetMs) {
        const d = servidor.demoraGetMs;
        servidor.demoraGetMs = 0; // solo la próxima lectura se demora
        return setTimeout(responder, d);
      }
      return responder();
    }
    const entrada = archivos[req.url.split('?')[0]];
    if (entrada) {
      res.writeHead(200, { 'Content-Type': entrada[0] });
      return res.end(fs.readFileSync(path.join(RAIZ, entrada[1])));
    }
    res.writeHead(404);
    res.end();
  });
  return { http: http_, servidor, puerto };
}

async function abrirPagina(browser, puerto) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errores = [];
  page.on('pageerror', (e) => errores.push(e.message));
  await page.goto(`http://localhost:${puerto}/proyectos.html`, { waitUntil: 'networkidle' });
  return { page, errores };
}

// Cambia el plazo como lo haría el usuario: Análisis → Urgencias → Guardar.
// El plazo ya no está en el listado; vive en la configuración del semáforo.
async function cambiarPlazo(page, dias) {
  await page.click('#tabDash');
  await page.click('[data-sec="urgencias"]');
  await page.fill('#uPlazo', String(dias));
  await page.click('#cfgGuardar');
  await page.click('#tabList');
}

async function escenarioCarrera(browser, puerto) {
  console.log('\n=== Carrera: edición mientras llega una descarga ===');
  const { http: srv, servidor } = levantarServidor(puerto);
  await new Promise((r) => srv.listen(puerto, r));
  try {
    const { page, errores } = await abrirPagina(browser, puerto);
    // Una lectura lenta: la próxima descarga tarda 1,5 s en responder.
    servidor.demoraGetMs = 1500;
    await page.click('#btnMenu');
    await esperar(150);
    await page.locator('.app-menu__item', { hasText: 'Actualizar datos' }).click();
    // Mientras la descarga vuela, el usuario cambia el plazo.
    await esperar(300);
    await cambiarPlazo(page, 45);
    await esperar(2500); // la descarga vieja llega y el POST se envía

    const local = await page.evaluate((k) => localStorage.getItem(k), KEY_PLAZO);
    ok(local === '45', 'el plazo editado sobrevive en localStorage (quedó ' + local + ')');
    const ultimo = servidor.posts[servidor.posts.length - 1];
    ok(ultimo && ultimo.plazoDias === 45, 'el POST lleva el plazo editado (lleva ' + (ultimo ? ultimo.plazoDias : 'ninguno') + ')');
    ok(servidor.datos.plazoDias === 45, 'el servidor guarda 45 (guarda ' + servidor.datos.plazoDias + ')');
    ok(errores.length === 0, 'sin errores de página' + (errores.length ? ': ' + errores.join(' | ') : ''));
    await page.close();
  } finally {
    srv.close();
  }
}

async function escenarioConfigRevertida(browser, puerto) {
  console.log('\n=== Configuración: un POST con plazo viejo no debe pisar el plazo remoto ===');
  const { http: srv, servidor } = levantarServidor(puerto);
  await new Promise((r) => srv.listen(puerto, r));
  try {
    const { page, errores } = await abrirPagina(browser, puerto);
    // Otro dispositivo (A) cambia el plazo a 30 y sube. Este dispositivo (B)
    // todavía tiene 20 en localStorage y quedó con cambios sin subir.
    servidor.datos = Object.assign({}, servidor.datos, { plazoDias: 30 });
    servidor.n++;
    servidor.sha = 's' + servidor.n;
    await page.evaluate(([k, p]) => {
      localStorage.setItem('cartas_intencion_plazo_v1', '20');
      localStorage.setItem(p, '1');
    }, [KEY_PLAZO, KEY_PENDIENTE]);
    await page.reload({ waitUntil: 'networkidle' });
    await esperar(1500);

    const ultimo = servidor.posts[servidor.posts.length - 1];
    ok(ultimo !== undefined, 'el dispositivo con cambios pendientes sube');
    ok(ultimo && ultimo.plazoDias === 30,
      'el POST conserva el plazo remoto 30 (mandó ' + (ultimo ? ultimo.plazoDias : 'nada') + ')');
    ok(servidor.datos.plazoDias === 30, 'el servidor queda en 30 (queda ' + servidor.datos.plazoDias + ')');
    ok(errores.length === 0, 'sin errores de página' + (errores.length ? ': ' + errores.join(' | ') : ''));
    await page.close();
  } finally {
    srv.close();
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    await escenarioCarrera(browser, 4601);
    await escenarioConfigRevertida(browser, 4602);
  } finally {
    await browser.close();
  }
  console.log(fallas === 0 ? '\nTodos los tests de concurrencia pasaron.' : `\n${fallas} falla(s).`);
  process.exit(fallas === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
