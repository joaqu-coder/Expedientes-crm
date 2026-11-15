/*
 * Logos entre dispositivos (Chromium real, service worker incluido).
 *
 * Síntoma: un logo reemplazado en el repo (mismo nombre de archivo, bytes
 * nuevos) se ve bien en un dispositivo y viejo en otro. Causa: sw.js sirve
 * public/logos/* con stale-while-revalidate. Un dispositivo que ya cacheó el
 * logo muestra la copia vieja en la visita siguiente al deploy, y recién en la
 * otra la actualiza. Un dispositivo sin caché lo ve al día de entrada.
 *
 * Escenarios (corren en móvil y en escritorio, cada uno con su propio caché):
 *  1. Con caché previa, el logo que se publicó hoy se ve en la primera
 *     visita después del deploy.
 *  2. Sin conexión, se muestra el último logo guardado (no una imagen rota).
 *
 * Qué se mide: las dimensiones del <img> ya pintado (naturalWidth/Height). Son
 * distintas entre los dos archivos, así que no depende de colores ni del
 * orden de carga.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(RAIZ, 'public');

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

const PUERTO = 8813;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

// Versión 1 del logo de KEN (la que ya está cacheada en los dispositivos) y
// versión 2 (la que se publica después). Mismo nombre de archivo, otros bytes.
const LOGO_V1 = fs.readFileSync(path.join(PUB, 'logos/ken.png'));
const LOGO_V2 = fs.readFileSync(path.join(PUB, 'logos/el-moro.png'));
const dimensiones = (buf) => `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
const DIM_V1 = dimensiones(LOGO_V1);
const DIM_V2 = dimensiones(LOGO_V2);
if (DIM_V1 === DIM_V2) {
  console.log('FALLA: las dos versiones de prueba tienen las mismas dimensiones; el test no distinguiría');
  process.exit(1);
}

let logoServido = LOGO_V1;
const DATOS = fs.readFileSync(path.join(RAIZ, 'parques.json'));

const servidor = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/sync-parques') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(DATOS);
  }
  if (u.pathname.startsWith('/api/')) {
    res.writeHead(404);
    return res.end('{}');
  }
  if (u.pathname === '/logos/ken.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(logoServido);
  }
  const p = u.pathname === '/' ? '/parques.html' : u.pathname;
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    return res.end('no encontrado');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

let fallas = 0;
const ok = (cond, msg) => {
  if (!cond) fallas++;
  console.log((cond ? '  OK   ' : '  FALLA') + ': ' + msg);
};

// Abre parques.html, elige Salta (ahí está KEN) y devuelve lo que quedó pintado.
async function abrirYMedir(page) {
  await page.goto(`http://localhost:${PUERTO}/parques.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const b = document.querySelector('[data-parque="salta"]');
    if (b) b.click();
  });
  await page.waitForTimeout(400);
  return page.evaluate(async () => {
    const img = [...document.querySelectorAll('img.emp-logo')].find((i) => i.getAttribute('src') === 'logos/ken.png');
    if (!img) return null;
    img.scrollIntoView({ block: 'center' });
    if (!(img.complete && img.naturalWidth)) {
      await new Promise((r) => { img.onload = r; img.onerror = r; setTimeout(r, 4000); });
    }
    return img.naturalWidth && img.naturalHeight ? `${img.naturalWidth}x${img.naturalHeight}` : 'SIN_IMAGEN';
  });
}

await new Promise((r) => servidor.listen(PUERTO, r));
const navegador = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

const dispositivos = [
  ['movil', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
  ['escritorio', { viewport: { width: 1280, height: 800 } }],
];

try {
  for (const [nombre, opciones] of dispositivos) {
    console.log(`\n== ${nombre} ==`);

    // Escenario 1: caché previa, deploy de un logo nuevo.
    logoServido = LOGO_V1;
    const ctx1 = await navegador.newContext(opciones);
    const p1 = await ctx1.newPage();
    await abrirYMedir(p1);                 // visita 1: instala el service worker
    const visita2 = await abrirYMedir(p1); // visita 2: el SW controla y cachea el logo
    ok(visita2 === DIM_V1, `${nombre}: antes del deploy se ve la versión 1 (${DIM_V1}); se vio ${visita2}`);

    logoServido = LOGO_V2;                 // se publica el deploy con el logo nuevo
    const visita3 = await abrirYMedir(p1);
    ok(visita3 === DIM_V2,
      `${nombre}: con caché previa, el logo publicado (${DIM_V2}) se ve en la primera visita; se vio ${visita3}`);

    // Escenario 2: sin conexión después de haber visto el logo nuevo.
    await ctx1.setOffline(true);
    const sinConexion = await abrirYMedir(p1);
    ok(sinConexion === DIM_V2,
      `${nombre}: sin conexión se muestra el último logo guardado (${DIM_V2}), no una imagen rota; se vio ${sinConexion}`);
    await ctx1.close();

    // Dispositivo sin caché: ve el logo vigente desde la primera carga.
    logoServido = LOGO_V2;
    const ctx2 = await navegador.newContext(opciones);
    const p2 = await ctx2.newPage();
    const primera = await abrirYMedir(p2);
    ok(primera === DIM_V2, `${nombre}: sin caché, el logo vigente (${DIM_V2}) se ve de entrada; se vio ${primera}`);
    await ctx2.close();
  }
} finally {
  await navegador.close();
  servidor.close();
}

if (fallas) {
  console.log(`\n${fallas} falla(s) en logos entre dispositivos`);
  process.exit(1);
}
console.log('\nOK logos entre dispositivos: el logo publicado llega en la primera visita, y sin conexión queda el último guardado');
