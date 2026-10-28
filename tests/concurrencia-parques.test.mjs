/*
 * Test de concurrencia entre dispositivos para parques.html (Chromium real).
 *
 * Dos dispositivos (dos contextos de navegador, cada uno con su localStorage)
 * abren la misma base. Uno guarda primero; el otro editó lo mismo sin haber
 * visto esa escritura. El servidor (mock del Worker, mismo protocolo que
 * worker.js: _baseSha + 409 con el contenido actual) tiene que quedar con los
 * dos cambios, sin pérdida silenciosa.
 *
 * Escenarios:
 *  1. Ediciones en registros distintos: los dos cambios sobreviven.
 *  2. Altas independientes con el mismo id: el segundo en llegar renumera la
 *     suya; ninguna de las dos se pierde.
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

const ESTATICOS = {
  '/parques.html': ['text/html; charset=utf-8', 'public/parques.html'],
  '/header.js': ['application/javascript; charset=utf-8', 'public/header.js'],
  '/confirmar-cambios.js': ['application/javascript; charset=utf-8', 'public/confirmar-cambios.js'],
  '/design-system.css': ['text/css; charset=utf-8', 'public/design-system.css'],
  '/ui-kit.css': ['text/css; charset=utf-8', 'public/ui-kit.css']
};
const KEY_STATE = 'parques_crm_v1';
const KEY_PENDIENTE = 'parques_crm_sync_pendiente_v1';

let fallas = 0;
const ok = (cond, msg) => {
  if (!cond) fallas++;
  console.log((cond ? '  OK   ' : '  FALLA') + ': ' + msg);
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Mock del Worker para /api/sync-parques, con el protocolo real.
function levantarServidor(puerto, datosIniciales) {
  const srv = {
    sha: 's1',
    n: 1,
    datos: datosIniciales,
    posts: 0,
    conflictos: 0
  };
  const http_ = http.createServer((req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith('/api/sync-parques')) {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const datos = JSON.parse(body);
          const base = datos._baseSha;
          delete datos._baseSha;
          if (base && base !== srv.sha) {
            srv.conflictos++;
            return json(409, {
              error: 'conflicto',
              actual: Object.assign({}, srv.datos, { _meta: { existe: true, sha: srv.sha } })
            });
          }
          srv.posts++;
          srv.datos = datos;
          srv.n++;
          srv.sha = 's' + srv.n;
          json(200, { ok: true, sha: srv.sha });
        });
        return;
      }
      return json(200, Object.assign({}, srv.datos, { _meta: { existe: true, sha: srv.sha } }));
    }
    const entrada = ESTATICOS[req.url.split('?')[0]];
    if (entrada) {
      res.writeHead(200, { 'Content-Type': entrada[0] });
      return res.end(fs.readFileSync(path.join(RAIZ, entrada[1])));
    }
    res.writeHead(404);
    res.end();
  });
  return { http: http_, srv };
}

// Un dispositivo: su propio contexto (localStorage aparte).
async function abrir(browser, puerto) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(e.message));
  return { ctx, page, errores };
}

// Simula que este dispositivo no puede leer el servidor (GET 503) pero sí
// puede subir: su próximo POST lleva la base vieja y recibe el 409.
async function cortarLectura(ctx) {
  await ctx.route('**/api/sync-parques', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 503, body: 'sin red' });
    return route.continue();
  });
}

// Aplica un cambio al estado guardado del dispositivo y lo marca como pendiente.
// No recarga: el llamador decide cuándo.
async function escribirEstado(page, cuerpo, arg) {
  await page.evaluate(([k, pend, src, a]) => {
    const s = JSON.parse(localStorage.getItem(k));
    new Function('s', 'arg', src)(s, a);
    localStorage.setItem(k, JSON.stringify(s));
    localStorage.setItem(pend, '1');
  }, [KEY_STATE, KEY_PENDIENTE, cuerpo, arg]);
}

async function cargarPagina(page, puerto) {
  await page.goto(`http://localhost:${puerto}/parques.html`, { waitUntil: 'networkidle' });
  await esperar(400);
}

async function escenario1(browser, puerto, datos) {
  console.log('\n=== Registros distintos: los dos cambios sobreviven ===');
  const { http: h, srv } = levantarServidor(puerto, datos);
  await new Promise((r) => h.listen(puerto, r));
  try {
    const lote = datos.lotes.find((l) => l.id_parque !== 'salta') || datos.lotes[0];
    const empresa = datos.empresas.find((e) => e.id_empresa !== (datos.empresas[0] || {}).id_empresa) || datos.empresas[1];

    const A = await abrir(browser, puerto);
    const B = await abrir(browser, puerto);
    await cargarPagina(A.page, puerto);
    await cargarPagina(B.page, puerto);
    await cortarLectura(B.ctx); // a partir de acá, B no puede leer el servidor

    // A guarda primero (su lectura funciona, así que ve su propia base).
    await escribirEstado(A.page, 'const l = s.lotes.find(x => x.id_lote === arg.id); l.matricula = arg.mat;',
                         { id: lote.id_lote, mat: 'MAT-DE-A' });
    await A.page.reload({ waitUntil: 'networkidle' });
    await esperar(1500);
    ok(srv.datos.lotes.find((l) => l.id_lote === lote.id_lote).matricula === 'MAT-DE-A',
       'el dispositivo A guarda su cambio en el servidor');

    // B editó otra empresa sin haber visto la escritura de A: su base es la vieja.
    await escribirEstado(B.page, 'const e = s.empresas.find(x => x.id_empresa === arg.id); e.nombre_empresa = arg.nombre;',
                         { id: empresa.id_empresa, nombre: 'NOMBRE DE B' });
    await B.page.reload({ waitUntil: 'networkidle' });
    await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await esperar(2500);

    const finalLote = srv.datos.lotes.find((l) => l.id_lote === lote.id_lote);
    const finalEmp = srv.datos.empresas.find((e) => e.id_empresa === empresa.id_empresa);
    ok(srv.conflictos >= 1, 'el servidor respondió 409 al dispositivo B (' + srv.conflictos + ')');
    ok(finalLote && finalLote.matricula === 'MAT-DE-A', 'el cambio de A (lote) sobrevive al guardado de B');
    ok(finalEmp && finalEmp.nombre_empresa === 'NOMBRE DE B', 'el cambio de B (empresa) llega al servidor');
    ok(A.errores.length + B.errores.length === 0,
       'sin errores de página' + (A.errores.concat(B.errores).length ? ': ' + A.errores.concat(B.errores).join(' | ') : ''));
    await A.ctx.close();
    await B.ctx.close();
  } finally {
    h.close();
  }
}

async function escenario2(browser, puerto, datos) {
  console.log('\n=== Altas independientes con el mismo id: ninguna se pierde ===');
  const base = JSON.parse(JSON.stringify(datos));
  const { http: h, srv } = levantarServidor(puerto, base);
  await new Promise((r) => h.listen(puerto, r));
  try {
    const A = await abrir(browser, puerto);
    const B = await abrir(browser, puerto);
    await cargarPagina(A.page, puerto);
    await cargarPagina(B.page, puerto);
    await cortarLectura(B.ctx);

    const alta = (nombre) => ({
      id_empresa: 'E900', id_parque: 'guemes', nombre_empresa: nombre,
      rubro: '', actividad: '', cuit: '', mail: '', telefono: '', contacto_nombre: '',
      cargo: '', pagweb: '', instagram: '', linkedin: '', ubicacion: '', observacion: '',
      situacion: null, id_empresa_original: null, propietario_matricula: ''
    });

    await escribirEstado(A.page, 's.empresas.push(arg);', alta('ALTA DE A'));
    await A.page.reload({ waitUntil: 'networkidle' });
    await esperar(1500);

    await escribirEstado(B.page, 's.empresas.push(arg);', alta('ALTA DE B'));
    await B.page.reload({ waitUntil: 'networkidle' });
    await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await esperar(2500);

    const nombres = srv.datos.empresas.filter((e) => e.nombre_empresa.startsWith('ALTA DE')).map((e) => e.nombre_empresa + ' (' + e.id_empresa + ')');
    ok(nombres.some((n) => n.startsWith('ALTA DE A')), 'la alta de A está en el servidor: ' + nombres.join(', '));
    ok(nombres.some((n) => n.startsWith('ALTA DE B')), 'la alta de B está en el servidor (renumerada si chocó): ' + nombres.join(', '));
    const ids = srv.datos.empresas.map((e) => e.id_empresa);
    ok(new Set(ids).size === ids.length, 'no quedan ids repetidos en el servidor');
    await A.ctx.close();
    await B.ctx.close();
  } finally {
    h.close();
  }
}

async function main() {
  const datos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'parques.json'), 'utf8'));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    await escenario1(browser, 4701, datos);
    await escenario2(browser, 4702, datos);
  } finally {
    await browser.close();
  }
  console.log(fallas === 0 ? '\nTodos los tests de concurrencia de Parques pasaron.' : `\n${fallas} falla(s).`);
  process.exit(fallas === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
