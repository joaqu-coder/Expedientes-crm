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
  const ctl = { fallar: false, demoraMs: 0, posts: 0 };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/sync')) {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const responder = () => {
            if (ctl.fallar) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'simulado' }));
            }
            ultimoPost = JSON.parse(body);
            ctl.posts++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          };
          ctl.demoraMs ? setTimeout(responder, ctl.demoraMs) : responder();
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ultimoPost || { expedientes: [], areas: [], responsables: [] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  return { server, ctl, getUltimoPost: () => ultimoPost };
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


// ---------- Paquete 1: correctness ----------

// Fechas: el plazo debe calcularse igual en cualquier zona horaria. Antes, en UTC-3,
// viernes + 1 día hábil daba sábado porque 'YYYY-MM-DD' se parseaba como UTC.
async function testFechas() {
  console.log('\n=== FECHAS (zonas horarias) ===');
  const ctx = levantarServer(8797);
  await new Promise((r) => ctx.server.listen(8797, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const tz of ['America/Argentina/Buenos_Aires', 'UTC', 'Pacific/Auckland', 'America/Los_Angeles']) {
    const context = await browser.newContext({ timezoneId: tz });
    const page = await context.newPage();
    await page.goto('http://localhost:8797/', { waitUntil: 'networkidle' });
    const r = await page.evaluate(() => {
      const f = (ini, n) => fechaISO(calcularFechaFin(ini, n));
      return {
        vieSig: f('2026-10-02', 1),      // vie + 1 hábil = lun 5/10
        finde: f('2026-10-03', 1),       // sáb + 1 hábil = lun 5/10
        feriado: f('2026-10-09', 1),     // vie + 1 hábil, lun 12/10 es feriado = mar 13/10
        cinco: f('2026-09-28', 5),       // lun + 5 hábiles = lun 5/10
      };
    });
    ok(r.vieSig === '2026-10-05', `[${tz}] viernes + 1 día hábil = lunes (${r.vieSig})`);
    ok(r.finde === '2026-10-05', `[${tz}] sábado + 1 día hábil = lunes (${r.finde})`);
    ok(r.feriado === '2026-10-13', `[${tz}] salta el feriado del 12/10 (${r.feriado})`);
    ok(r.cinco === '2026-10-05', `[${tz}] lunes + 5 días hábiles = lunes siguiente (${r.cinco})`);
    await context.close();
  }
  await browser.close();
  ctx.server.close();
}

// Sync y HTML: cada caso corresponde a un bug real de la auditoría del 2026-09-29.
async function testSyncYEscape() {
  console.log('\n=== SYNC Y ESCAPE DE HTML ===');
  const ctx = levantarServer(8796);
  await new Promise((r) => ctx.server.listen(8796, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problemas = [];
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  page.on('dialog', async (d) => { problemas.push('dialog: ' + d.message()); await d.dismiss(); });
  await page.goto('http://localhost:8796/', { waitUntil: 'networkidle' });
  const indicador = async () => (await page.locator('#syncIndicator').textContent()).trim();

  // --- XSS / comillas ---
  const tema = `<img src=x onerror="window.__xss=1"> "comillas" & 'simples'`;
  await page.click('#btnConfig');
  await page.fill('#inputArea', "D'Angelo <b>");
  await page.locator('#areasConfigList + .config-input-group button').click();
  await page.click('#configClose');
  await page.click('#fabNuevo');
  await page.fill('#tema', tema);
  await page.fill('#diasPlazo', '10');
  await page.selectOption('#area', "D'Angelo <b>");
  await page.selectOption('#responsable', { index: 1 });
  await page.click('#btnGuardar');
  await page.waitForTimeout(500);
  ok(await page.evaluate(() => window.__xss === undefined), 'un tema con HTML no ejecuta código (XSS)');
  ok((await page.locator('#expedientesList').textContent()).includes(tema), 'el tema con HTML/comillas se muestra literal');
  ok((await page.locator('#expedientesList').textContent()).includes('Sin número'), 'expediente sin número muestra "Sin número"');
  await page.locator('.expediente-card').first().click();
  ok((await page.inputValue('#tema')) === tema, 'al editar, el tema con comillas vuelve intacto');
  ok((await page.inputValue('#area')) === "D'Angelo <b>", 'al editar, el área con apóstrofe queda seleccionada');
  await page.click('#btnCancelar');
  await page.click('#btnConfig');
  const antes = await page.locator('#areasConfigList .config-item').count();
  await page.locator('#areasConfigList .config-item', { hasText: "D'Angelo" }).locator('button').click();
  ok((await page.locator('#areasConfigList .config-item').count()) === antes - 1, "eliminar un área con apóstrofe funciona");
  await page.click('#configClose');
  ok(await page.evaluate(() => AREAS.every(a => !a.includes("D'Angelo"))), "el área con apóstrofe se eliminó del estado");

  // --- indicador honesto cuando el POST falla ---
  await page.waitForTimeout(400);
  ctx.ctl.fallar = true;
  await page.evaluate(() => { expedientes[0].tema = 'cambio con red caída'; guardarEnLS(); });
  await page.waitForTimeout(600);
  ok(!/Sincronizado/i.test(await indicador()), `si el POST falla el indicador NO dice "Sincronizado" ("${await indicador()}")`);
  ok(await page.evaluate(() => hayPendiente()), 'el cambio queda marcado como pendiente');

  // --- reintento al volver la red ---
  ctx.ctl.fallar = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(600);
  ok(/Sincronizado/i.test(await indicador()), 'al volver la red se reintenta y queda Sincronizado');
  ok(ctx.getUltimoPost()?.expedientes?.[0]?.tema === 'cambio con red caída', 'el cambio pendiente llegó al servidor');
  ok(!(await page.evaluate(() => hayPendiente())), 'ya no queda pendiente');

  // --- edit durante un POST en vuelo ---
  ctx.ctl.demoraMs = 500;
  await page.evaluate(() => { expedientes[0].tema = 'edit A'; guardarEnLS(); });
  await page.waitForTimeout(250); // el POST de A está en vuelo
  await page.evaluate(() => { expedientes[0].tema = 'edit B'; guardarEnLS(); });
  await page.waitForTimeout(1500);
  ok(ctx.getUltimoPost()?.expedientes?.[0]?.tema === 'edit B',
     `el edit hecho durante un sync en vuelo también se sube ("${ctx.getUltimoPost()?.expedientes?.[0]?.tema}")`);
  ctx.ctl.demoraMs = 0;

  const reales = problemas.filter((p) => !p.includes('MIME'));
  ok(reales.length === 0, 'sin errores de JS ni dialogs' + (reales.length ? ': ' + reales.join(' | ') : ''));
  await browser.close();
  ctx.server.close();
}

// Cambios hechos sin conexión no se pierden al reabrir: la descarga inicial no debe pisarlos.
async function testPendienteAlAbrir() {
  console.log('\n=== CAMBIOS OFFLINE AL REABRIR ===');
  const ctx = levantarServer(8795);
  await new Promise((r) => ctx.server.listen(8795, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('expedientes_crm_expedientes', JSON.stringify([{
      id: '1', numero: '', tema: 'hecho sin conexión', area: 'Jurídica', responsable: 'Ana',
      fechaInicio: '2026-09-28', diasPlazo: 10, estado: 'activo', intervenciones: [],
    }]));
    localStorage.setItem('expedientes_crm_pendiente', '1');
  });
  await page.goto('http://localhost:8795/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  ok((await page.locator('#expedientesList').textContent()).includes('hecho sin conexión'),
     'el expediente cargado sin conexión sigue en pantalla (el servidor estaba vacío)');
  ok(ctx.getUltimoPost()?.expedientes?.[0]?.tema === 'hecho sin conexión', 'se subió al servidor en vez de perderse');
  await browser.close();
  ctx.server.close();
}

// Pegar un número desde Word/PDF (guiones largos, texto extra) y usar Ctrl+V/Backspace.
async function testCampoNumero() {
  console.log('\n=== CAMPO NÚMERO (pegado y teclas) ===');
  const ctx = levantarServer(8794);
  await new Promise((r) => ctx.server.listen(8794, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8794' });
  const page = await context.newPage();
  await page.goto('http://localhost:8794/', { waitUntil: 'networkidle' });
  await page.click('#fabNuevo');
  await page.click('#numero');

  await page.evaluate(() => navigator.clipboard.writeText('Expte. 363—1254/2025–01'));
  await page.keyboard.press('Control+V');
  ok((await page.inputValue('#numero')) === '363-1254/2025-01', `Ctrl+V pega y normaliza guiones/letras ("${await page.inputValue('#numero')}")`);
  ok(await page.locator('#numero.valid').count() === 1, 'el número pegado queda válido (verde)');

  await page.keyboard.press('Backspace');
  ok((await page.inputValue('#numero')) === '363-1254/2025-0', 'Backspace funciona');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('36a3');
  ok((await page.inputValue('#numero')) === '363', 'las letras tipeadas se descartan');

  // El cursor no salta al final al corregir un carácter en el medio.
  await page.fill('#numero', '363-1254/2025-01');
  await page.evaluate(() => { const i = document.getElementById('numero'); i.setSelectionRange(3, 3); });
  await page.keyboard.type('x');
  const pos = await page.evaluate(() => document.getElementById('numero').selectionStart);
  ok(pos === 3, `el cursor se queda donde estaba al descartar un carácter (pos=${pos})`);

  await browser.close();
  ctx.server.close();
}

// ---------- Paquete 2: tarjeta y estados ----------
async function testPlazosYTarjetas() {
  console.log('\n=== PLAZOS Y TARJETAS ===');
  const ctx = levantarServer(8793);
  await new Promise((r) => ctx.server.listen(8793, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const problemas = [];
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  await page.goto('http://localhost:8793/', { waitUntil: 'networkidle' });

  // Lógica pura con "hoy" fijo: vence hoy != vencido (antes ambos daban 0 días).
  const r = await page.evaluate(() => {
    const local = (s) => parsearFecha(s);
    const p = (hoy) => { const x = calcularPlazo('2026-09-28', 5, local(hoy)); return { v: x.vencido, h: x.venceHoy, d: x.diasRestantes, a: x.diasVencido, t: textoPlazo(x), c: obtenerSemaforo(x).color }; };
    return {
      antes: p('2026-10-02'),      // vence lun 5/10, hoy vie 2/10 → 1 hábil
      hoy: p('2026-10-05'),
      ayer: p('2026-10-06'),       // vencido hace 1 hábil
      finde: (() => { const x = calcularPlazo('2026-09-25', 5, local('2026-10-03')); return { v: x.vencido, t: textoPlazo(x) }; })(), // fin vie 2/10, hoy sáb
    };
  });
  ok(r.antes.d === 1 && !r.antes.v && r.antes.c === 'naranja' && r.antes.t === '1 d háb.', `1 día hábil restante: naranja (${r.antes.t})`);
  ok(r.hoy.h && !r.hoy.v && r.hoy.t === 'Vence hoy' && r.hoy.c === 'rojo', `vence hoy se distingue de vencido (${r.hoy.t})`);
  ok(r.ayer.v && r.ayer.a === 1 && r.ayer.t === 'Vencido hace 1 d háb.' && r.ayer.c === 'rojo', `vencido dice hace cuánto (${r.ayer.t})`);
  ok(r.finde.v && r.finde.t === 'Vencido', `vencido un sábado sin días hábiles de atraso dice "Vencido" (${r.finde.t})`);

  // Tarjetas reales
  await page.evaluate(() => {
    const base = { area: 'Jurídica', responsable: 'Ana', estado: 'activo', intervenciones: [] };
    expedientes = [
      { ...base, id: 'lejos', numero: '363-1/2026-01', tema: 'Plazo lejano', fechaInicio: '2099-01-05', diasPlazo: 30 },
      { ...base, id: 'viejo', numero: '363-2/2026-01', tema: 'Muy vencido', fechaInicio: '2020-01-06', diasPlazo: 5 },
      { ...base, id: 'arch', numero: '363-3/2026-01', tema: 'Ya resuelto', fechaInicio: '2020-01-06', diasPlazo: 5, estado: 'archivado', fechaResolucion: '2026-09-20' },
      { ...base, id: 'otra', area: 'Obras', numero: '363-4/2026-01', tema: 'Otra área', fechaInicio: '2099-01-05', diasPlazo: 10 },
    ];
    renderizar();
  });
  const cards = page.locator('.expediente-card');
  ok((await cards.count()) === 3, 'la pestaña Activos lista solo los activos (3)');
  ok((await cards.first().textContent()).includes('Muy vencido'), 'el vencido va primero');
  ok(/Vencido hace \d+ d háb\./.test(await cards.first().locator('.plazo-badge').textContent()), 'el badge del vencido lleva texto, no solo color');
  ok(await cards.first().locator('.plazo-badge.rojo').count() === 1, 'el vencido es rojo');
  ok(/Vence \w+ \d\d\/\d\d\/2099/.test(await cards.nth(1).textContent()), 'la tarjeta muestra la fecha de vencimiento');
  ok(/^Total \(3\)/.test((await page.locator('.area-btn').first().textContent()).trim()), 'Total cuenta solo los activos (3), no el archivado');
  ok(/Jurídica \(2\)/.test(await page.locator('#areaBotones').textContent()), 'el contador de área respeta la pestaña (Jurídica = 2)');
  ok(/Activos \(3\)/.test(await page.locator('.pestana-btn.active').textContent()), 'la pestaña Activos muestra su cantidad');
  ok(/Archivados \(1\)/.test(await page.locator('.pestana-btn').nth(1).textContent()), 'la pestaña Archivados muestra su cantidad');

  await page.locator('.pestana-btn', { hasText: 'Archivados' }).click();
  ok((await cards.count()) === 1, 'la pestaña Archivados lista 1');
  const arch = cards.first();
  ok(/Resuelto el .*20\/09\/2026/.test(await arch.locator('.plazo-badge').textContent()), 'la archivada dice "Resuelto el …"');
  ok(await arch.locator('.plazo-badge.archivado').count() === 1 && !(await arch.textContent()).includes('Vencido'), 'la archivada va en gris, sin semáforo ni "Vencido"');
  ok(/^Total \(1\)/.test((await page.locator('.area-btn').first().textContent()).trim()), 'en Archivados, Total = 1');
  ok(/Archivados/.test(await page.locator('.pestana-btn.active').textContent()), 'la pestaña activa se marca sin depender del evento global');

  await page.fill('#searchInput', 'zzz');
  ok((await page.locator('#expedientesList').textContent()).includes('Sin resultados para «zzz»'), 'búsqueda sin resultados tiene su propio mensaje');
  await page.fill('#searchInput', '');
  await page.locator('.pestana-btn', { hasText: 'Activos' }).click();
  await page.evaluate(() => { expedientes = []; renderizar(); });
  ok((await page.locator('#expedientesList').textContent()).includes('Tocá + para cargar uno'), 'estado vacío invita a crear el primero');

  ok(problemas.length === 0, 'sin errores de JS' + (problemas.length ? ': ' + problemas.join(' | ') : ''));
  await browser.close();
  ctx.server.close();
}

await recorrido('DESKTOP', { width: 1440, height: 900 }, 8799);
await recorrido('MOBILE', { width: 390, height: 844 }, 8798);
await testFechas();
await testSyncYEscape();
await testPendienteAlAbrir();
await testCampoNumero();
await testPlazosYTarjetas();

console.log(fallas === 0 ? '\nUI OK en desktop y mobile' : `\n${fallas} fallas`);
process.exit(fallas === 0 ? 0 : 1);
