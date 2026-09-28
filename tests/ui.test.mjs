/*
 * Test de UI contra un navegador real (Chromium vía Playwright).
 *
 * Levanta un server local que imita al Worker, así no toca producción ni la
 * red. Corre el mismo recorrido en desktop y en mobile porque los bugs del
 * 2026-09-28 eran específicos de un viewport.
 *
 * Los tests unitarios no encontraron ninguno de esos cuatro bugs: todos
 * aparecieron solo al abrir la página. Por eso este archivo existe.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Playwright viene como paquete global en el entorno de Claude Code on the web.
let chromium;
try {
  ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'));
} catch {
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.log('SKIP: Playwright no está disponible en este entorno.');
    console.log('      Los demás tests (test:ids, test:worker) no lo necesitan.');
    process.exit(0);
  }
}

const HTML = fs.readFileSync(path.join(RAIZ, 'public/index.html'), 'utf8');
const NUMERO = '363 – 1254/2026-01'; // guión medio a propósito: la app debe normalizarlo

let fallas = 0;
const ok = (cond, msg) => {
  if (!cond) fallas++;
  console.log((cond ? '  OK   ' : '  FALLA') + ': ' + msg);
};

function levantarServer(puerto) {
  let ultimoPost = null;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/sync')) {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          ultimoPost = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ expedientes: [], areas: [], responsables: [] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  return { server, getUltimoPost: () => ultimoPost };
}

async function recorrido(nombre, viewport, puerto) {
  console.log(`\n=== ${nombre} (${viewport.width}x${viewport.height}) ===`);

  const ctx = levantarServer(puerto);
  await new Promise((r) => ctx.server.listen(puerto, r));

  const problemas = [];
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  page.on('dialog', async (d) => { problemas.push('alert: ' + d.message()); await d.dismiss(); });

  await page.goto(`http://localhost:${puerto}/`, { waitUntil: 'networkidle' });

  // Un solo panel de configuración: el popup. El inline del sidebar se eliminó
  // porque duplicaba los id y dejaba al popup sin efecto.
  ok((await page.locator('text=Configuración').count()) === 1, 'hay un solo bloque "Configuración"');
  ok(!(await page.locator('#configOverlay').isVisible()), 'el popup arranca cerrado');

  await page.click('#btnConfig');
  await page.waitForTimeout(300);
  ok(await page.locator('#configOverlay').isVisible(), 'el popup abre con el engranaje');

  const areasAntes = await page.locator('#areasConfigList .config-item').count();
  ok(areasAntes > 0, `el popup lista las áreas (${areasAntes}) — quedaba vacío con los id duplicados`);

  await page.fill('#inputArea', 'Área de Prueba');
  await page.locator('#areasConfigList + .config-input-group button').click();
  await page.waitForTimeout(300);
  ok((await page.locator('#areasConfigList .config-item').count()) === areasAntes + 1,
     'agregar un área desde el popup funciona');

  await page.fill('#inputResponsable', 'Joaquín Pérez');
  await page.locator('#responsablesConfigList + .config-input-group button').click();
  await page.waitForTimeout(300);
  ok((await page.locator('#responsablesConfigList .config-item').count()) > 0,
     'agregar un responsable desde el popup funciona');

  await page.click('#configClose');
  await page.waitForTimeout(300);
  ok(!(await page.locator('#configOverlay').isVisible()), 'el popup cierra con la cruz');

  // El bug reportado: en desktop no se podía crear un expediente.
  ok(await page.locator('#fabNuevo').isVisible(), 'el botón + es visible (estaba oculto >=1024px)');
  await page.click('#fabNuevo');
  await page.waitForTimeout(300);
  ok(await page.locator('#modalOverlay').isVisible(), 'el modal de expediente abre');
  ok(await page.locator('#btnGuardar').isVisible(), 'el botón Guardar es visible');

  await page.fill('#numero', NUMERO);
  await page.fill('#tema', 'Expediente de prueba — Ñandú y café ☕');
  await page.fill('#fechaInicio', '2026-09-28');
  await page.fill('#diasPlazo', '10');
  await page.selectOption('#area', { index: 1 });
  await page.selectOption('#responsable', { index: 1 });
  await page.click('#btnGuardar');
  await page.waitForTimeout(800);

  ok((await page.locator('#expedientesList').textContent()).includes('1254/2026'),
     'el expediente aparece en la lista tras guardar');

  const post = ctx.getUltimoPost();
  ok(post !== null, 'la app hizo POST a /api/sync al guardar');
  if (post) {
    const exp = post.expedientes?.[0];
    ok(/^363\s*-\s*1254\/2026\s*-\s*01$/.test(exp?.numero || ''),
       `el número se normalizó al guión del teclado ("${exp?.numero}")`);
    ok(exp?.tema === 'Expediente de prueba — Ñandú y café ☕',
       'UTF-8 (ñ, tildes, emoji) viaja intacto');
    ok(post.areas?.includes('Área de Prueba'), 'el área agregada también se sincroniza');
  }

  ok(/Sincronizado/i.test(await page.locator('#syncIndicator').textContent()),
     'el indicador muestra estado sincronizado');

  // El MIME del sw.js es ruido del server de prueba, no un bug de la app.
  const reales = problemas.filter((p) => !p.includes('MIME'));
  ok(reales.length === 0, 'sin errores de JS ni alerts' + (reales.length ? ': ' + reales.join(' | ') : ''));

  await browser.close();
  ctx.server.close();
}

await recorrido('DESKTOP', { width: 1440, height: 900 }, 8799);
await recorrido('MOBILE', { width: 390, height: 844 }, 8798);

console.log(fallas === 0 ? '\nUI OK en desktop y mobile' : `\n${fallas} fallas`);
process.exit(fallas === 0 ? 0 : 1);
