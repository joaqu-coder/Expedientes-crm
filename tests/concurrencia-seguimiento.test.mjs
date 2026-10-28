/*
 * Test de concurrencia entre dispositivos para seguimiento.html (Chromium real).
 *
 * Hasta el 2026-10-22 Seguimiento era "última escritura gana": dos
 * dispositivos que abrían la misma pantalla y guardaban, y el trabajo del
 * primero desaparecía sin error ni aviso. Ahora usa el mismo protocolo que
 * Proyectos y Parques (_baseSha + 409 con el contenido actual) y fusiona por
 * expediente contra la base que cada dispositivo guarda.
 *
 * Escenarios:
 *  1. Ediciones en expedientes distintos: las dos sobreviven.
 *  2. Una baja en un dispositivo y una edición en otro: la baja no resucita
 *     y la edición no se pierde.
 *  3. Áreas agregadas en los dos dispositivos: quedan las dos.
 *  4. Altas simultáneas con el mismo id: ninguna se pierde.
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
  '/seguimiento.html': ['text/html; charset=utf-8', 'public/seguimiento.html'],
  '/header.js': ['application/javascript; charset=utf-8', 'public/header.js'],
  '/plazos.js': ['application/javascript; charset=utf-8', 'public/plazos.js'],
  '/confirmar-cambios.js': ['application/javascript; charset=utf-8', 'public/confirmar-cambios.js'],
  '/design-system.css': ['text/css; charset=utf-8', 'public/design-system.css'],
  '/ui-kit.css': ['text/css; charset=utf-8', 'public/ui-kit.css']
};
const K = {
  exp: 'expedientes_crm_expedientes',
  areas: 'expedientes_crm_areas',
  pend: 'expedientes_crm_pendiente'
};

let fallas = 0;
const ok = (cond, msg) => {
  if (!cond) fallas++;
  console.log((cond ? '  OK   ' : '  FALLA') + ': ' + msg);
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const exp = (id, tema, extra = {}) => ({
  id, numero: '', tema, area: 'Jurídica', responsable: 'Ana', parque: 'Güemes',
  fechaInicio: '2099-01-05', diasPlazo: 30, estado: 'activo', intervenciones: [], ...extra
});
const inicial = () => ({
  expedientes: [exp('1', 'Uno'), exp('2', 'Dos'), exp('3', 'Tres')],
  areas: ['Jurídica', 'Obras'],
  responsables: ['Ana'],
  parques: ['Güemes', 'Rosario']
});

// Mock del Worker para /api/sync, con el protocolo real (conflictos: true).
function levantarServidor(datosIniciales) {
  const srv = { sha: 's1', n: 1, datos: datosIniciales, posts: 0, conflictos: 0 };
  const http_ = http.createServer((req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith('/api/sync')) {
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

async function abrir(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(e.message));
  return { ctx, page, errores };
}

// Este dispositivo no puede leer el servidor (GET 503) pero sí subir: su
// próximo POST lleva la base vieja y recibe el 409.
async function cortarLectura(ctx) {
  await ctx.route('**/api/sync', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 503, body: 'sin red' });
    return route.continue();
  });
}

// Aplica un cambio al estado guardado del dispositivo y lo marca pendiente.
async function escribirEstado(page, cuerpo, arg) {
  await page.evaluate(([k, src, a]) => {
    const s = {
      expedientes: JSON.parse(localStorage.getItem(k.exp)),
      areas: JSON.parse(localStorage.getItem(k.areas))
    };
    new Function('s', 'arg', src)(s, a);
    localStorage.setItem(k.exp, JSON.stringify(s.expedientes));
    localStorage.setItem(k.areas, JSON.stringify(s.areas));
    localStorage.setItem(k.pend, '1');
  }, [K, cuerpo, arg]);
}

async function cargar(page, puerto) {
  await page.goto(`http://localhost:${puerto}/seguimiento.html`, { waitUntil: 'networkidle' });
  await esperar(400);
}

// A y B abren la misma base; B pierde la lectura; A guarda primero; B guarda sobre su base vieja.
async function escenario(browser, puerto, titulo, cambioA, cambioB, verificar) {
  console.log('\n=== ' + titulo + ' ===');
  const { http: h, srv } = levantarServidor(inicial());
  await new Promise((r) => h.listen(puerto, r));
  try {
    const A = await abrir(browser);
    const B = await abrir(browser);
    await cargar(A.page, puerto);
    await cargar(B.page, puerto);
    await cortarLectura(B.ctx);

    await escribirEstado(A.page, cambioA[0], cambioA[1]);
    await A.page.reload({ waitUntil: 'networkidle' });
    await esperar(1500);

    await escribirEstado(B.page, cambioB[0], cambioB[1]);
    await B.page.reload({ waitUntil: 'networkidle' });
    await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await esperar(2500);

    verificar(srv);
    const errores = A.errores.concat(B.errores);
    ok(errores.length === 0, 'sin errores de página' + (errores.length ? ': ' + errores.join(' | ') : ''));
    await A.ctx.close();
    await B.ctx.close();
  } finally {
    h.close();
  }
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const tema = (srv, id) => (srv.datos.expedientes.find((e) => e.id === id) || {}).tema;

await escenario(browser, 8851, 'Expedientes distintos: las dos ediciones sobreviven',
  ['s.expedientes.find(e => e.id === "1").tema = "EDITADO POR A";', null],
  ['s.expedientes.find(e => e.id === "2").tema = "EDITADO POR B";', null],
  (srv) => {
    ok(srv.conflictos >= 1, 'el servidor respondió 409 al dispositivo B (' + srv.conflictos + ')');
    ok(tema(srv, '1') === 'EDITADO POR A', 'la edición de A sobrevive al guardado de B (' + tema(srv, '1') + ')');
    ok(tema(srv, '2') === 'EDITADO POR B', 'la edición de B llega al servidor (' + tema(srv, '2') + ')');
    ok(srv.datos.expedientes.length === 3, 'siguen los 3 expedientes (' + srv.datos.expedientes.length + ')');
  });

await escenario(browser, 8852, 'Baja en un dispositivo, edición en otro',
  ['s.expedientes = s.expedientes.filter(e => e.id !== "3");', null],
  ['s.expedientes.find(e => e.id === "1").tema = "EDITADO POR B";', null],
  (srv) => {
    ok(!srv.datos.expedientes.some((e) => e.id === '3'), 'la baja de A no se deshace con el guardado de B');
    ok(tema(srv, '1') === 'EDITADO POR B', 'la edición de B llega al servidor');
  });

await escenario(browser, 8853, 'Áreas agregadas en los dos dispositivos',
  ['s.areas.push("Área de A");', null],
  ['s.areas.push("Área de B");', null],
  (srv) => {
    ok(srv.datos.areas.includes('Área de A'), 'el área de A sobrevive');
    ok(srv.datos.areas.includes('Área de B'), 'el área de B llega');
    ok(new Set(srv.datos.areas).size === srv.datos.areas.length, 'sin áreas repetidas');
  });

await escenario(browser, 8854, 'Altas simultáneas con el mismo id: ninguna se pierde',
  ['s.expedientes.push(arg);', exp('900', 'ALTA DE A')],
  ['s.expedientes.push(arg);', exp('900', 'ALTA DE B')],
  (srv) => {
    const temas = srv.datos.expedientes.map((e) => e.tema);
    ok(temas.includes('ALTA DE A'), 'la alta de A está en el servidor');
    ok(temas.includes('ALTA DE B'), 'la alta de B está en el servidor');
    const ids = srv.datos.expedientes.map((e) => e.id);
    ok(new Set(ids).size === ids.length, 'no quedan ids repetidos');
  });

// Sin la marca de pendiente en localStorage (modo privado, almacenamiento
// bloqueado) lo local seguía siendo un cambio por subir: el 409 no puede
// tratarlo como "nada pendiente" y quedarse con lo del servidor.
console.log('\n=== Marca de pendiente ausente durante la subida: lo local no se descarta ===');
{
  const { http: h, srv } = levantarServidor(inicial());
  await new Promise((r) => h.listen(8855, r));
  try {
    const A = await abrir(browser);
    const B = await abrir(browser);
    await cargar(A.page, 8855);
    await cargar(B.page, 8855);
    await cortarLectura(B.ctx);
    await escribirEstado(A.page, 's.expedientes.find(e => e.id === "1").tema = "EDITADO POR A";', null);
    await A.page.reload({ waitUntil: 'networkidle' });
    await esperar(1500);
    await B.page.evaluate((pend) => {
      expedientes.find((e) => e.id === '2').tema = 'EDITADO POR B';
      guardarEnLS();                 // programa la subida (100 ms)
      localStorage.removeItem(pend); // el almacenamiento "pierde" la marca
    }, K.pend);
    await esperar(2500);
    ok(tema(srv, '1') === 'EDITADO POR A', 'la edición de A sobrevive (' + tema(srv, '1') + ')');
    ok(tema(srv, '2') === 'EDITADO POR B', 'la edición de B no se descarta (' + tema(srv, '2') + ')');
    await A.ctx.close();
    await B.ctx.close();
  } finally {
    h.close();
  }
}

// Un dispositivo que tenía la app ANTES de esta versión: cambios pendientes y
// ningún registro de base. No puede saber qué cambió el otro lado, pero tampoco
// debe pisarlo: lo del servidor se conserva y lo local se suma.
console.log('\n=== Dispositivo viejo sin base y con pendientes: se suma, no se pisa ===');
{
  const { http: h, srv } = levantarServidor(inicial());
  await new Promise((r) => h.listen(8856, r));
  try {
    const A = await abrir(browser);
    const B = await abrir(browser);
    await cargar(A.page, 8856);
    await cargar(B.page, 8856);
    await escribirEstado(A.page, 's.expedientes.find(e => e.id === "1").tema = "EDITADO POR A";', null);
    await A.page.reload({ waitUntil: 'networkidle' });
    await esperar(1500);
    await B.page.evaluate(() => localStorage.removeItem('expedientes_crm_base_v1')); // como antes del deploy
    await escribirEstado(B.page, 's.expedientes.find(e => e.id === "2").tema = "EDITADO POR B"; s.expedientes.push(arg);', exp('77', 'ALTA DE B'));
    await B.page.reload({ waitUntil: 'networkidle' });
    await esperar(2500);
    // Sin base no se puede saber quién editó qué: ante la duda se conservan las dos
    // copias (la local se renumera). Pueden quedar duplicados, pero nada se pierde.
    const temas = srv.datos.expedientes.map((e) => e.tema);
    ok(temas.includes('EDITADO POR A'), 'la edición de A sobrevive');
    ok(temas.includes('EDITADO POR B'), 'la edición de B llega');
    ok(temas.includes('ALTA DE B'), 'la alta de B llega');
    ok(temas.includes('Tres'), 'el expediente que nadie tocó sigue');
    const ids = srv.datos.expedientes.map((e) => e.id);
    ok(new Set(ids).size === ids.length, 'sin ids repetidos');
    await A.ctx.close();
    await B.ctx.close();
  } finally {
    h.close();
  }
}

await browser.close();
console.log(fallas === 0 ? '\nTodos los tests de concurrencia de Seguimiento pasaron.' : `\n${fallas} falla(s) en concurrencia de Seguimiento.`);
process.exit(fallas === 0 ? 0 : 1);
