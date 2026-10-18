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

const HTML = fs.readFileSync(path.join(RAIZ, 'public/seguimiento.html'), 'utf8');
// Las 4 apps cargan el header común con <script src="/header.js">, así que los
// servidores de prueba tienen que servirlo o la página queda sin cabecera.
const HEADER_JS = fs.readFileSync(path.join(RAIZ, 'public/header.js'), 'utf8');
function servirHeaderJs(req, res) {
  if (!req.url.startsWith('/header.js')) return false;
  res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
  res.end(HEADER_JS);
  return true;
}
const NUMERO = '363 – 1254/2026-01'; // guión medio a propósito: la app debe normalizarlo

let fallas = 0;
// La configuración y "Actualizar datos" viven ahora en el menú ⋮ del header
// común (header.js), no en botones sueltos de cada pantalla.
async function abrirDesdeMenu(page, etiqueta) {
  await page.click('#btnMenu');
  await page.waitForTimeout(150);
  await page.locator('.app-menu__item', { hasText: etiqueta }).click();
  await page.waitForTimeout(250);
}

const ok = (cond, msg) => {
  if (!cond) fallas++;
  console.log((cond ? '  OK   ' : '  FALLA') + ': ' + msg);
};

function levantarServer(puerto) {
  let ultimoPost = null;
  const ctl = { fallar: false, demoraMs: 0, posts: 0, datos: null };
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
      res.end(JSON.stringify(ctl.datos || ultimoPost || { expedientes: [], areas: [], responsables: [] }));
      return;
    }
    if (servirHeaderJs(req, res)) return;
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

  await abrirDesdeMenu(page, 'Áreas y responsables');
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

  // Con todo en orden el estado NO ocupa lugar en pantalla: el aviso está
  // oculto y el detalle se consulta en el menú ⋮.
  ok(await page.locator('#syncAviso').isHidden(), 'con la sync al día no hay cartel ocupando pantalla');
  await page.click('#btnMenu');
  await page.waitForTimeout(150);
  ok(/Al día/.test(await page.locator('.app-menu__estado').textContent()),
     'el menú ⋮ informa que la sincronización está al día');
  await page.keyboard.press('Escape');

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
  // El estado de sync ya no es un cartel permanente: el aviso aparece solo si
  // algo falla. "visible" es, entonces, la señal de problema.
  const avisoVisible = async () => await page.locator('#syncAviso').isVisible();
  const avisoTexto = async () => (await page.locator('#syncAviso').textContent()).trim();

  // --- XSS / comillas ---
  const tema = `<img src=x onerror="window.__xss=1"> "comillas" & 'simples'`;
  await abrirDesdeMenu(page, 'Áreas y responsables');
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
  ok((await page.locator('#expedientesList').textContent()).includes('Sin expediente'), 'expediente sin número muestra "Sin expediente"');
  await page.locator('.expediente-header-urgencia').first().click();
  await page.locator('.expediente-actions button', { hasText: 'Editar' }).first().click();
  ok((await page.inputValue('#tema')) === tema, 'al editar, el tema con comillas vuelve intacto');
  ok((await page.inputValue('#area')) === "D'Angelo <b>", 'al editar, el área con apóstrofe queda seleccionada');
  await page.click('#btnCancelar');
  await abrirDesdeMenu(page, 'Áreas y responsables');
  // Un área en uso no se puede borrar: se avisa en vez de dejar expedientes huérfanos.
  await page.locator('#areasConfigList .config-item', { hasText: "D'Angelo" }).locator('button').click();
  ok(await page.locator('#alertOverlay').isVisible() && /1 expediente/.test(await page.locator('#alertMessage').textContent()),
     'borrar un área en uso avisa cuántos expedientes la usan');
  await page.click('#alertBtn');
  ok(await page.evaluate(() => AREAS.includes("D'Angelo <b>")), 'el área en uso NO se borró');
  // Un área sin uso con apóstrofe sí se borra (el onclick viejo se rompía con el apóstrofe).
  await page.fill('#inputArea', "L'Étoile");
  await page.locator('#areasConfigList + .config-input-group button').click();
  const antes = await page.locator('#areasConfigList .config-item').count();
  await page.locator('#areasConfigList .config-item', { hasText: "L'Étoile" }).locator('button').click();
  ok((await page.locator('#areasConfigList .config-item').count()) === antes - 1, "eliminar un área sin uso con apóstrofe funciona");
  await page.click('#configClose');
  ok(await page.evaluate(() => AREAS.every(a => !a.includes("L'Étoile"))), "el área con apóstrofe se eliminó del estado");

  // --- indicador honesto cuando el POST falla ---
  await page.waitForTimeout(400);
  ctx.ctl.fallar = true;
  await page.evaluate(() => { expedientes[0].tema = 'cambio con red caída'; guardarEnLS(); });
  await page.waitForTimeout(600);
  ok(await avisoVisible(), 'si el POST falla, el aviso de sincronización se hace visible');
  ok(/Sin conexión/i.test(await avisoTexto()), `el aviso explica qué pasó ("${(await avisoTexto()).slice(0, 40)}…")`);
  ok(await page.evaluate(() => hayPendiente()), 'el cambio queda marcado como pendiente');

  // --- reintento al volver la red ---
  ctx.ctl.fallar = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(600);
  ok(!(await avisoVisible()), 'al volver la red se reintenta y el aviso desaparece solo');
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
  const cards = page.locator('.expediente-card-new');
  ok((await cards.count()) === 3, 'la pestaña Activos lista solo los activos (3)');
  ok((await cards.first().textContent()).includes('Muy vencido'), 'el vencido va primero');
  ok(/Vencido hace \d+ d háb\./.test(await cards.first().locator('.expediente-urgencia-dias').textContent()), 'el badge del vencido lleva texto, no solo color');
  ok(await cards.first().locator('.expediente-header-urgencia.rojo').count() === 1, 'el vencido es rojo');
  ok(/Vence:\s*\w+ \d\d\/\d\d\/2099/.test(await cards.nth(1).textContent()), 'la tarjeta muestra la fecha de vencimiento');
  // El contador va pegado al nombre y SIN paréntesis ("Total 3"), igual que
  // en Parques y Proyectos — el paréntesis se sacó a pedido del usuario.
  ok(/^Total\s*3$/.test((await page.locator('.area-btn').first().textContent()).trim()), 'Total cuenta solo los activos (3), no el archivado, y sin paréntesis');
  ok(/Jurídica\s*2/.test(await page.locator('#areaBotones').textContent()), 'el contador de área respeta la pestaña (Jurídica = 2)');
  ok(/^Activos\s*3$/.test((await page.locator('.pestana-btn.active').textContent()).trim()), 'la pestaña Activos muestra su cantidad, sin paréntesis');
  ok(/^Archivados\s*1$/.test((await page.locator('.pestana-btn').nth(1).textContent()).trim()), 'la pestaña Archivados muestra su cantidad, sin paréntesis');
  ok(await page.locator('.pestana-btn.active .count').count() === 1, 'el contador de la pestaña va en su propio <span class="count"> (seminegrita)');
  ok(await page.locator('.area-btn .count').first().evaluate((el) => getComputedStyle(el).fontWeight) === '600', 'el contador se pinta en seminegrita');

  await page.locator('.pestana-btn', { hasText: 'Archivados' }).click();
  ok((await cards.count()) === 1, 'la pestaña Archivados lista 1');
  const arch = cards.first();
  ok(/Resuelto el .*20\/09\/2026/.test(await arch.locator('.expediente-urgencia-dias').textContent()), 'la archivada dice "Resuelto el …"');
  ok(await arch.locator('.expediente-header-urgencia.archivado').count() === 1 && !(await arch.textContent()).includes('Vencido'), 'la archivada va en gris, sin semáforo ni "Vencido"');
  const fondo = await arch.locator('.expediente-header-urgencia').evaluate((el) => getComputedStyle(el).backgroundColor);
  const [cr, cg, cb] = fondo.match(/\d+/g).map(Number);
  ok(Math.max(cr, cg, cb) - Math.min(cr, cg, cb) < 20, `el encabezado de la archivada es gris neutro (${fondo})`);
  ok(/^Total\s*1$/.test((await page.locator('.area-btn').first().textContent()).trim()), 'en Archivados, Total = 1');
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

// ---------- Paquete 3: móvil y accesibilidad ----------
// Expande la tarjeta si está cerrada (el estado abierto se conserva al redibujar).
async function expandir(page, texto) {
  const h = page.locator('.expediente-card-new', { hasText: texto }).locator('.expediente-header-urgencia');
  if ((await h.getAttribute('aria-expanded')) !== 'true') await h.click();
}

const SEMBRAR = () => {
  const base = { area: 'Jurídica', responsable: 'Ana', estado: 'activo', intervenciones: [] };
  expedientes = Array.from({ length: 14 }, (_, i) => ({
    ...base, id: 'e' + i, numero: `363-${100 + i}/2026-01`, tema: `Expediente número ${i}`,
    fechaInicio: '2099-01-05', diasPlazo: 30 + i,
  }));
  renderizar();
};

async function testMovilTactil() {
  console.log('\n=== MÓVIL TÁCTIL (390x844, touch) ===');
  const ctx = levantarServer(8792);
  await new Promise((r) => ctx.server.listen(8792, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const problemas = [];
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  await page.goto('http://localhost:8792/', { waitUntil: 'networkidle' });
  await page.evaluate(SEMBRAR);

  // iOS Safari hace zoom al enfocar un campo con fuente < 16px.
  const fuente = (sel) => page.evaluate((s) => parseFloat(getComputedStyle(document.querySelector(s)).fontSize), sel);
  ok((await fuente('#searchInput')) >= 16, `el buscador tiene fuente ≥16px (${await fuente('#searchInput')}px)`);

  // Objetivos táctiles de 44px.
  await page.locator('.expediente-header-urgencia').first().click();
  const alto = async (sel) => (await page.locator(sel).first().boundingBox()).height;
  for (const [sel, nombre] of [['.expediente-actions .btn', 'Resolver'], ['#btnMenu', 'menú ⋮']]) {
    const h = await alto(sel);
    ok(h >= 44, `${nombre} mide ≥44px de alto (${Math.round(h)}px)`);
  }
  // Los chips de filtro son la excepción: miden 38px a la vista (para quedar
  // iguales a los de Parques/Proyectos) y extienden el objetivo táctil a 44px
  // con un pseudo-elemento. Por eso no se mide el alto del rect sino lo que
  // importa de verdad: que un dedo que cae en esa franja active el chip.
  for (const [sel, nombre] of [['.area-btn', 'chip de área'], ['.pestana-btn', 'pestaña']]) {
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s);
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2;
      const centro = b.top + b.height / 2;
      // Borde del objetivo de 44px: 22px arriba y abajo del centro (1px adentro).
      const arriba = document.elementFromPoint(x, centro - 21);
      const abajo = document.elementFromPoint(x, centro + 21);
      return { alto: b.height, arriba: el.contains(arriba), abajo: el.contains(abajo) };
    }, sel);
    ok(Math.round(r.alto) === 38, `${nombre} mide 38px a la vista, igual que en Parques/Proyectos (${Math.round(r.alto)}px)`);
    ok(r.arriba && r.abajo, `${nombre} responde al toque en los 44px completos (arriba=${r.arriba}, abajo=${r.abajo})`);
  }

  // Los chips de área van en una sola fila con scroll horizontal.
  const chips = await page.evaluate(() => {
    const c = document.getElementById('areaBotones');
    const tops = new Set([...c.children].map((b) => Math.round(b.getBoundingClientRect().top)));
    return { filas: tops.size, scroll: c.scrollWidth > c.clientWidth };
  });
  ok(chips.filas === 1 && chips.scroll, `los chips de área ocupan 1 fila con scroll horizontal (filas=${chips.filas})`);

  // Barra fija: al hacer scroll, header + pestañas quedan arriba y nada se superpone.
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(100);
  const fija = await page.evaluate(() => {
    const r = document.querySelector('.sticky-top').getBoundingClientRect();
    return { top: r.top, alto: r.height };
  });
  ok(fija.top === 0, `header + pestañas siguen fijos arriba tras scrollear (top=${fija.top})`);
  const tapado = await page.evaluate(() => {
    const primera = document.querySelector('.expediente-card-new');
    const r = primera.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, Math.max(r.y, 100) + 10);
    return el ? !!el.closest('.sticky-top') : false;
  });
  ok(!tapado, 'ningún panel fijo tapa el contenido al scrollear');
  await page.evaluate(() => window.scrollTo(0, 0));

  // El formulario ocupa toda la pantalla.
  await page.click('#fabNuevo');
  const caja = await page.locator('.modal-form').boundingBox();
  ok(Math.round(caja.width) === 390 && Math.round(caja.height) === 844, `el formulario es pantalla completa (${Math.round(caja.width)}x${Math.round(caja.height)})`);
  ok((await fuente('#tema')) >= 16, 'los campos del formulario tienen fuente ≥16px');
  ok(await page.evaluate(() => document.activeElement.getAttribute('role') === 'dialog'),
     'en táctil el foco va al diálogo (no abre el teclado de golpe)');
  ok(await page.evaluate(() => document.getElementById('btnGuardar').getBoundingClientRect().bottom <= innerHeight),
     'Guardar queda visible sin scrollear');

  ok(problemas.length === 0, 'sin errores de JS' + (problemas.length ? ': ' + problemas.join(' | ') : ''));
  await browser.close();
  ctx.server.close();
}

async function testTecladoYFoco() {
  console.log('\n=== TECLADO, FOCO Y ERRORES EN LÍNEA (desktop) ===');
  const ctx = levantarServer(8791);
  await new Promise((r) => ctx.server.listen(8791, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problemas = [];
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  page.on('dialog', async (d) => { problemas.push('dialog: ' + d.message()); await d.dismiss(); });
  await page.goto('http://localhost:8791/', { waitUntil: 'networkidle' });
  await page.evaluate(SEMBRAR);

  // Desktop: el contenido no se estira a 1440px.
  const ancho = (await page.locator('.expediente-card-new').first().boundingBox()).width;
  ok(ancho <= 960, `las tarjetas no se estiran en pantallas anchas (${Math.round(ancho)}px)`);

  // Semántica
  ok((await page.locator('[role="tab"][aria-selected="true"]').count()) === 1, 'una sola pestaña con aria-selected="true"');
  await page.locator('.pestana-btn').nth(1).click();
  ok(/Archivados/.test(await page.locator('[role="tab"][aria-selected="true"]').textContent()), 'aria-selected sigue a la pestaña activa');
  await page.locator('.pestana-btn').nth(0).click();
  for (const sel of ['#btnMenu', '#fabNuevo', '#modalClose', '#configClose']) {
    ok(!!(await page.locator(sel).getAttribute('aria-label')), `${sel} tiene aria-label`);
  }
  ok((await page.locator('[role="dialog"], [role="alertdialog"]').count()) === 3, 'los 3 modales tienen role dialog/alertdialog');

  // Abrir con teclado: la tarjeta es un botón real
  const boton = page.locator('.expediente-header-urgencia').first();
  await boton.focus();
  await page.keyboard.press('Enter');
  ok((await boton.getAttribute('aria-expanded')) === 'true', 'Enter sobre la tarjeta la expande (aria-expanded)');
  await page.locator('.expediente-actions button', { hasText: 'Editar' }).first().focus();
  await page.keyboard.press('Enter');
  ok(await page.locator('#modalOverlay').isVisible(), 'Enter sobre Editar abre el expediente');
  ok(await page.evaluate(() => document.activeElement.id === 'tema'), 'al abrir, el foco va al primer campo (Tema)');
  ok(await page.evaluate(() => document.querySelector('label[for="tema"]') !== null && document.querySelector('label[for="area"]') !== null), 'los labels están asociados a sus campos');

  // Trampa de foco: 40 Tab no sacan el foco del modal
  let afuera = 0;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    if (!(await page.evaluate(() => !!document.activeElement.closest('#modalOverlay')))) afuera++;
  }
  ok(afuera === 0, `Tab no saca el foco del modal (${afuera} escapes en 40 Tab)`);
  await page.keyboard.press('Shift+Tab');
  ok(await page.evaluate(() => !!document.activeElement.closest('#modalOverlay')), 'Shift+Tab tampoco escapa');

  // Escape cierra y devuelve el foco a la tarjeta
  await page.keyboard.press('Escape');
  ok(!(await page.locator('#modalOverlay').isVisible()), 'Escape cierra el modal');
  ok(await page.evaluate(() => document.activeElement.textContent.includes('Editar')), 'el foco vuelve al botón Editar de la tarjeta');

  // Errores en línea (sin popup): formulario vacío
  await page.click('#fabNuevo');
  await page.fill('#numero', '363-12');
  await page.fill('#diasPlazo', '');
  await page.click('#btnGuardar');
  ok(!(await page.locator('#alertOverlay').isVisible()), 'los errores del formulario no abren un popup');
  ok((await page.locator('.form-error').count()) >= 5, `se marcan todos los campos con problema (${await page.locator('.form-error').count()})`);
  ok(await page.evaluate(() => document.activeElement.id === 'numero'), 'el foco va al primer campo con error (Nro Expediente)');
  ok(/formato/i.test(await page.locator('#error-numero').textContent()), 'el error del número explica el formato');
  ok((await page.locator('#tema').getAttribute('aria-invalid')) === 'true', 'el campo inválido tiene aria-invalid');
  await page.fill('#tema', 'algo');
  ok((await page.locator('#error-tema').count()) === 0 && (await page.locator('#tema.invalid').count()) === 0, 'el error se limpia al corregir el campo');

  // Enter guarda desde un input
  await page.fill('#numero', '363-1254/2026-01');
  await page.fill('#diasPlazo', '10');
  await page.selectOption('#area', { index: 1 });
  await page.selectOption('#responsable', { index: 1 });
  await page.focus('#tema');
  await page.keyboard.press('Enter');
  ok(!(await page.locator('#modalOverlay').isVisible()), 'Enter en un campo guarda y cierra');
  ok((await page.locator('#expedientesList').textContent()).includes('363-1254/2026-01'), 'el expediente guardado con Enter aparece en la lista');

  // Configuración: Escape cierra y devuelve el foco al engranaje
  await abrirDesdeMenu(page, 'Áreas y responsables');
  ok(await page.evaluate(() => document.activeElement.id === 'inputArea'), 'al abrir configuración el foco va al campo de área');
  await page.keyboard.press('Escape');
  ok(!(await page.locator('#configOverlay').isVisible()), 'Escape cierra configuración');
  ok(await page.evaluate(() => document.activeElement.id === 'btnMenu'), 'el foco vuelve al botón ⋮ que abrió la configuración');

  ok(problemas.length === 0, 'sin errores de JS ni dialogs' + (problemas.length ? ': ' + problemas.join(' | ') : ''));
  await browser.close();
  ctx.server.close();
}

// ---------- Paquete 4: flujo ----------
async function testFlujo() {
  console.log('\n=== FLUJO: TOAST, DESHACER, REFRESCO ===');
  const ctx = levantarServer(8786);
  await new Promise((r) => ctx.server.listen(8786, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const problemas = [];
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  page.on('dialog', async (d) => { problemas.push('dialog nativo: ' + d.message()); await d.dismiss(); });
  await page.goto('http://localhost:8786/', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const base = { area: 'Jurídica', responsable: 'Ana', estado: 'activo', intervenciones: [], fechaInicio: '2099-01-05', diasPlazo: 30 };
    expedientes = [{ ...base, id: 'a', numero: '363-1/2026-01', tema: 'Primero' }, { ...base, id: 'b', numero: '363-2/2026-01', tema: 'Segundo' }];
    guardarEnLS(false); renderizar();
  });
  const toast = page.locator('#toast');

  // Resolver: toast con Deshacer, sin popup bloqueante
  await expandir(page, 'Primero');
  await page.locator('.expediente-card-new', { hasText: 'Primero' }).locator('button', { hasText: 'Resolver' }).click();
  ok(await toast.isVisible() && /archivado/.test(await toast.textContent()), 'Resolver muestra un toast "archivado"');
  ok(!(await page.locator('#alertOverlay').isVisible()), 'Resolver ya no abre un popup bloqueante');
  ok((await page.locator('.expediente-card-new').count()) === 1, 'el expediente salió de Activos');
  await page.click('#toastAccion');
  ok((await page.locator('.expediente-card-new').count()) === 2, 'Deshacer lo devuelve a Activos');
  ok(await page.evaluate(() => expedientes.find(e => e.id === 'a').fechaResolucion === undefined && expedientes.find(e => e.id === 'a').estado === 'activo'), 'Deshacer restaura estado y quita fechaResolucion');
  ok(!(await toast.isVisible()), 'el toast se cierra al deshacer');
  await page.waitForTimeout(400);
  ok(ctx.getUltimoPost()?.expedientes?.find(e => e.id === 'a')?.estado === 'activo', 'el deshacer también se sincroniza');

  // El toast se cierra solo
  await page.evaluate(() => mostrarToast('temporal', { accion: () => {}, duracion: 200 }));
  await page.waitForTimeout(400);
  ok(!(await toast.isVisible()), 'el toast desaparece solo');

  // Eliminar: sin confirm() nativo, con Deshacer y misma posición
  await expandir(page, '363-1/2026-01');
  await page.locator('.expediente-card-new', { hasText: '363-1/2026-01' }).locator('button', { hasText: 'Editar' }).click();
  await page.click('#btnEliminar');
  ok(!(await page.locator('#modalOverlay').isVisible()) && /eliminado/.test(await toast.textContent()), 'Eliminar cierra el modal y muestra un toast (sin confirm nativo)');
  ok((await page.locator('.expediente-card-new').count()) === 1, 'el expediente se eliminó');
  await page.click('#toastAccion');
  ok(await page.evaluate(() => expedientes.map(e => e.id).join() === 'a,b'), 'Deshacer restaura el expediente en su posición original');

  // Área sin uso: se borra con Deshacer
  await abrirDesdeMenu(page, 'Áreas y responsables');
  await page.fill('#inputArea', 'Temporal');
  await page.locator('#areasConfigList + .config-input-group button').click();
  await page.locator('#areasConfigList .config-item', { hasText: 'Temporal' }).locator('button').click();
  ok(!(await page.evaluate(() => AREAS.includes('Temporal'))) && /eliminada/.test(await toast.textContent()), 'un área sin uso se elimina con toast');
  await page.click('#toastAccion');
  ok(await page.evaluate(() => AREAS.includes('Temporal')), 'Deshacer restaura el área');
  ok((await page.locator('#configOverlay button', { hasText: 'Guardar cambios' }).count()) === 0, 'la config ya no tiene el botón "Guardar cambios" redundante');
  ok((await page.locator('#configOverlay button', { hasText: 'Listo' }).count()) === 1, 'la config cierra con "Listo"');
  await page.keyboard.press('Escape');

  // Refresco al volver a la app (otro dispositivo cambió los datos)
  ctx.ctl.datos = { expedientes: [{ id: 'z', numero: '363-9/2026-01', tema: 'Creado en el celular', area: 'Jurídica', responsable: 'Ana', estado: 'activo', intervenciones: [], fechaInicio: '2099-01-05', diasPlazo: 30 }], areas: ['Jurídica'], responsables: ['Ana'] };
  await page.waitForTimeout(600); // deja terminar los sync de los pasos anteriores
  await page.evaluate(() => { ultimaDescarga = 0; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(500);
  ok((await page.locator('#expedientesList').textContent()).includes('Creado en el celular'), 'al volver a la app se traen los cambios del otro dispositivo');

  // Reintento manual tocando el aviso de sincronización
  ctx.ctl.datos = null;
  ctx.ctl.fallar = true;
  await page.evaluate(() => { expedientes[0].tema = 'editado sin red'; guardarEnLS(); });
  await page.waitForTimeout(500);
  ok(await page.locator('#syncAviso').isVisible(), 'sin red aparece el aviso de sincronización');
  ok(/Sin conexión/.test(await page.locator('#syncAviso').textContent()), 'el aviso explica que no hay conexión');
  ctx.ctl.fallar = false;
  await page.click('#syncAviso');
  await page.waitForTimeout(600);
  ok(await page.locator('#syncAviso').isHidden(), 'tocar el aviso reintenta, sincroniza y el aviso se va');
  ok(ctx.getUltimoPost()?.expedientes?.[0]?.tema === 'editado sin red', 'el cambio pendiente llegó al servidor');

  ok(problemas.length === 0, 'sin errores de JS ni diálogos nativos' + (problemas.length ? ': ' + problemas.join(' | ') : ''));
  await browser.close();
  ctx.server.close();
}

/*
 * Resoluciones: la página carga el archivo histórico real (resoluciones.json,
 * 422 registros) desde un server local que imita al Worker. Existe porque esta
 * página pasó de 3 ejemplos a 422 registros reales con texto resolutivo, y los
 * tests estáticos no ven ni el paginado, ni los filtros, ni la ficha.
 */
async function testResoluciones(viewport, puerto) {
  console.log(`\n=== RESOLUCIONES (${viewport.width}x${viewport.height}) ===`);
  const html = fs.readFileSync(path.join(RAIZ, 'public/resoluciones.html'), 'utf8');
  const datos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'resoluciones.json'), 'utf8'));
  let ultimoPost = null;

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
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
      res.end(JSON.stringify(datos));
      return;
    }
    if (servirHeaderJs(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(puerto, r));

  const problemas = [];
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  page.on('dialog', async (d) => { problemas.push('alert: ' + d.message()); await d.dismiss(); });
  await page.goto(`http://localhost:${puerto}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.res-card').length > 0);

  const total = datos.resoluciones.length;
  ok(total === 422, `el archivo trae las ${total} resoluciones`);
  ok(!datos.resoluciones.some((r) => r.ejemplo), 'no quedó ninguna resolución de ejemplo');
  ok((await page.locator('#resCount').textContent()).includes(String(total)),
     'el contador muestra el total');

  // Paginado: 422 tarjetas de una sola vez es una lista infinita en el celular.
  const primeraTanda = await page.locator('.res-card').count();
  ok(primeraTanda === 100, `la primera tanda pinta 100 tarjetas (pintó ${primeraTanda})`);
  await page.click('#btnMas');
  await page.waitForTimeout(200);
  ok((await page.locator('.res-card').count()) === 200, '"Mostrar más" suma otra tanda');

  // Orden: más nueva primero. El N° va con ceros a la izquierda justamente
  // para que el sort por string no ponga "031" arriba de "100".
  const primera = await page.locator('.res-card-title').first().textContent();
  ok(/\/2025$/.test(primera), `la primera tarjeta es del año más nuevo (${primera})`);

  // Filtros
  await page.selectOption('#filterAnio', '2016');
  await page.waitForTimeout(150);
  const esperado2016 = datos.resoluciones.filter((r) => r.anio === '2016').length;
  ok((await page.locator('#resCount').textContent()).startsWith(esperado2016 + ' de '),
     `el filtro por año deja ${esperado2016} resoluciones de 2016`);
  await page.selectOption('#filterTema', 'Intimación');
  await page.waitForTimeout(150);
  const esperadoTema = datos.resoluciones.filter((r) => r.anio === '2016' && r.tema === 'Intimación').length;
  ok((await page.locator('#resCount').textContent()).startsWith(esperadoTema + ' de '),
     `año + tema combinan (${esperadoTema})`);

  // El enum de temas tiene que ser exactamente el del archivo: ni un tema de
  // los datos fuera del filtro, ni una opción del filtro que no filtre nada.
  const enum_ = await page.$$eval('#filterTema option', (o) => o.map((x) => x.value).filter(Boolean));
  const enDatos = [...new Set(datos.resoluciones.map((r) => r.tema))];
  ok(enDatos.every((t) => t && enum_.includes(t)),
     'todos los temas de los datos están en el filtro');
  ok(enum_.every((t) => enDatos.includes(t)),
     'ninguna opción del filtro queda sin resoluciones');
  ok(enum_.length === 30, `el filtro ofrece las 30 clasificaciones (ofrece ${enum_.length})`);
  await page.selectOption('#filterAnio', '');
  await page.selectOption('#filterTema', '');

  // La búsqueda tiene que entrar al texto resolutivo, no solo a los metadatos.
  await page.fill('#search', 'petroandina');
  await page.waitForTimeout(150);
  ok((await page.locator('.res-card').count()) === 1, 'la búsqueda encuentra texto del contenido');
  await page.fill('#search', '');
  await page.waitForTimeout(150);

  // Ficha: el contenido es el dato principal de una resolución.
  await page.locator('.res-card').first().click();
  await page.waitForSelector('.view-texto');
  const ficha = await page.locator('#modal').textContent();
  ok(ficha.includes('Contenido'), 'la ficha muestra la sección Contenido');
  ok((await page.locator('.view-texto').first().textContent()).length > 40,
     'la ficha trae el texto resolutivo completo');

  // Editar: el contenido tiene que ir y volver por el POST.
  await page.click('#btnEdit');
  await page.waitForSelector('#f_contenido');
  ok((await page.inputValue('#f_contenido')).length > 40, 'el formulario precarga el contenido');
  await page.fill('#f_contenido', 'Texto editado — ñandú ☕');
  await page.click('#resForm button[type=submit]');
  await page.waitForTimeout(600);
  ok(ultimoPost?.resoluciones?.length === total, 'el POST sube las 422 resoluciones');
  ok(ultimoPost.resoluciones.some((r) => r.contenido === 'Texto editado — ñandú ☕'),
     'el contenido editado llega al servidor con tildes y emoji intactos');

  ok(problemas.length === 0, 'sin errores de JS ni diálogos nativos' + (problemas.length ? ': ' + problemas.join(' | ') : ''));
  await browser.close();
  server.close();
}

async function testProyectos(viewport, puerto) {
  console.log(`\n=== PROYECTOS (${viewport.width}x${viewport.height}) ===`);
  const html = fs.readFileSync(path.join(RAIZ, 'public/proyectos.html'), 'utf8');
  const datos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'cartas-intencion.json'), 'utf8'));
  let ultimoPost = null;
  const SHA = 'sha-fijo-de-prueba';

  // Expedientes sintéticos, bien por encima del umbral de archivado
  // automático (132 días hábiles ≈ 6 meses hábiles): sirven para probar el
  // archivado sin tocar el archivo real. Uno Sin_tratamiento (debe
  // archivarse) y uno En_tratamiento con la misma fecha vieja (NO debe
  // archivarse — "en tratamiento" significa que alguien lo está trabajando,
  // aunque no haya quedado nota en la app).
  const expedienteViejo = {
    id: 'exp_archivo_test', nro_expediente: '999-00000/2020-0',
    nombre_empresa: 'Archivable De Prueba S.A.', fecha_inicio: '01/01/2020',
    parque_industrial: 'Salta', rubro: 'Manufactura', situacion: 'Sin_tratamiento',
    fecha_ultimo_movimiento: '01/01/2020 00:00', intervenciones: []
  };
  const expedienteEnTratamientoViejo = {
    id: 'exp_no_archivo_test', nro_expediente: '999-00001/2020-0',
    nombre_empresa: 'No Archivable En Tratamiento S.A.', fecha_inicio: '01/01/2020',
    parque_industrial: 'Salta', rubro: 'Manufactura', situacion: 'En_tratamiento',
    fecha_ultimo_movimiento: '01/01/2020 00:00', intervenciones: []
  };
  const datosConViejo = Object.assign({}, datos, {
    expedientes: [expedienteViejo, expedienteEnTratamientoViejo, ...datos.expedientes]
  });

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/version-cartas')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: SHA }));
      return;
    }
    if (req.url.startsWith('/api/sync-cartas')) {
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
      res.end(JSON.stringify(Object.assign({}, ultimoPost || datosConViejo, { _meta: { existe: true, sha: SHA } })));
      return;
    }
    if (servirHeaderJs(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(puerto, r));

  const problemas = [];
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  page.on('dialog', async (d) => { problemas.push('alert: ' + d.message()); await d.dismiss(); });
  await page.goto(`http://localhost:${puerto}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.exp-card').length > 0);

  const total = datos.expedientes.length; // el archivo real, sin el sintético
  const totalServido = datosConViejo.expedientes.length; // + el sintético que agrega este test
  ok(total === 157, `el archivo trae los ${total} expedientes reales`);
  // No asume que el listado pinta los 157 tarjetas: con el archivado
  // automático, cuántas quedan activas depende de la fecha de hoy contra
  // fecha_ultimo_movimiento de cada una — es una propiedad real de los
  // datos, no una constante. Lo que SÍ tiene que valer siempre es la
  // conservación: nadie desaparece, cada expediente servido está en el
  // listado o en Archivo, nunca en ningún otro lado ni en los dos.
  const activosInicial = await page.locator('.exp-card').count();
  await page.click('#tabArchivo');
  await page.waitForSelector('#archivoList');
  const archivadosInicial = await page.locator('#archivoList .exp-card').count();
  ok(activosInicial + archivadosInicial === totalServido,
     `listado (${activosInicial}) + archivo (${archivadosInicial}) suman los ${totalServido} expedientes servidos`);
  ok((await page.locator('#archivoList').textContent()).includes('Archivable De Prueba'),
     'el expediente sintético Sin_tratamiento (último movimiento en 2020) está en Archivo');
  ok(!(await page.locator('#archivoList').textContent()).includes('No Archivable En Tratamiento'),
     'el expediente sintético En_tratamiento NO entra a Archivo aunque tenga la misma fecha vieja');
  ok((await page.locator('#archivoList').textContent()).includes('Archivado el'),
     'las tarjetas en Archivo muestran la fecha de archivado');
  await page.click('#tabList');
  await page.waitForSelector('#expList');
  ok((await page.locator('.exp-card', { hasText: 'No Archivable En Tratamiento' }).count()) === 1,
     'el expediente En_tratamiento sigue en el listado normal');

  // Dashboard: las 5 secciones que reemplazaron a las tarjetas sueltas.
  await page.click('#tabDash');
  await page.waitForSelector('.dash-section');
  for (const sec of ['Resumen', 'Situación', 'Parques', 'Rubros', 'Urgencias']) {
    await page.click(`[data-sec="${sec === 'Resumen' ? 'resumen' : sec === 'Situación' ? 'situacion' : sec === 'Parques' ? 'parques' : sec === 'Rubros' ? 'rubros' : 'urgencias'}"]`);
    await page.waitForTimeout(100);
    ok((await page.locator('.dash-section-head h2').first().textContent()).length > 0,
       `la sección "${sec}" del dashboard renderiza`);
  }
  await page.click('#tabList');
  await page.waitForSelector('#expList');

  // Ficha + edición: el POST tiene que llegar con tildes/ñ intactas.
  await page.locator('.exp-card').first().click();
  await page.waitForSelector('#btnEdit');
  await page.click('#btnEdit');
  await page.waitForSelector('#f_nombre_empresa');
  await page.fill('#f_nombre_empresa', 'Editado — Güemes ñandú ☕ S.A.');
  await page.click('#expForm button[type=submit]');
  // Esta app debounce la subida 1500ms (DEBOUNCE_MS), a diferencia de
  // Seguimiento/Resoluciones que suben casi al instante.
  await page.waitForTimeout(2000);
  ok(ultimoPost?.expedientes?.length === totalServido, `el POST sube los ${totalServido} expedientes`);
  ok(ultimoPost.expedientes.some((e) => e.nombre_empresa === 'Editado — Güemes ñandú ☕ S.A.'),
     'el nombre editado llega al servidor con tildes, ñ y emoji intactos');

  // Rescatar: el expediente sintético vuelve del Archivo al listado.
  await page.click('#tabArchivo');
  await page.waitForSelector('#archivoList');
  await page.locator('#archivoList .exp-card', { hasText: 'Archivable De Prueba' }).first().click();
  await page.waitForSelector('#btnRescatar');
  ok((await page.locator('#modal').textContent()).includes('Archivado el'),
     'la ficha del expediente archivado muestra cuándo se archivó');
  await page.click('#btnRescatar');
  await page.waitForTimeout(2000); // debounce de la subida
  ok(ultimoPost?.expedientes?.find((e) => e.id === 'exp_archivo_test' && e.archivado === false) != null,
     'rescatarlo sube archivado:false al servidor');
  await page.click('#tabList');
  await page.waitForSelector('#expList');
  ok((await page.locator('.exp-card', { hasText: 'Archivable De Prueba' }).count()) === 1,
     'el expediente rescatado vuelve a aparecer en el listado');

  ok(problemas.length === 0, 'sin errores de JS ni diálogos nativos' + (problemas.length ? ': ' + problemas.join(' | ') : ''));
  await browser.close();
  server.close();
}

/*
 * Parques: lotes y empresas de Güemes, importados de la base SQLite
 * normalizada que pasó el usuario (no de las planillas de Drive). Protocolo
 * simple, como Resoluciones. Existe porque los tests estáticos no ven el
 * cruce lote<->empresa (titularidad, sublocación vía ocupaciones) ni el
 * guardado por el modal.
 */
async function testParques(viewport, puerto) {
  console.log(`\n=== PARQUES (${viewport.width}x${viewport.height}) ===`);
  const html = fs.readFileSync(path.join(RAIZ, 'public/parques.html'), 'utf8');
  const datos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'parques.json'), 'utf8'));
  let ultimoPost = null;

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
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
      res.end(JSON.stringify(ultimoPost || datos));
      return;
    }
    if (servirHeaderJs(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(puerto, r));

  const problemas = [];
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  page.on('dialog', async (d) => { problemas.push('alert: ' + d.message()); await d.dismiss(); });
  await page.goto(`http://localhost:${puerto}/`, { waitUntil: 'networkidle' });
  // Empresas es la vista por defecto — ya no hay una pestaña "Lotes" suelta.
  await page.waitForFunction(() => document.querySelectorAll('#empresasList .tarjeta').length > 0);

  const totalLotes = datos.lotes.length;
  const totalEmpresas = datos.empresas.length;
  // Hay dos parques en el mismo archivo y la pantalla muestra uno a la vez
  // (Güemes por default, que es parques[0]). Los conteos de pantalla son del
  // parque activo; los del POST, de todo el archivo. Confundirlos es el bug
  // que buscan estas aserciones: los totales mezclados quedan plausibles.
  const delParque = (x, p) => (x.id_parque || 'guemes') === p;
  const lotesGuemes = datos.lotes.filter((l) => delParque(l, 'guemes'));
  const empresasGuemes = datos.empresas.filter((e) => delParque(e, 'guemes'));
  const lotesSalta = datos.lotes.filter((l) => delParque(l, 'salta'));
  const empresasSalta = datos.empresas.filter((e) => delParque(e, 'salta'));
  const sinEmpresa = lotesGuemes.filter((l) => !l.id_empresa);
  ok(lotesGuemes.length === 138, `el archivo trae los ${lotesGuemes.length} lotes reales de Güemes`);
  // 55 originales - AGSOF S.A. fusionada (2026-10-13) - AGROCONSTRUCCIONES LA
  // POSTA, que el usuario borró desde la app el 2026-10-17 (L115 y L116
  // quedaron libres).
  ok(empresasGuemes.length === 53, `el archivo trae las ${empresasGuemes.length} empresas reales de Güemes`);
  ok(lotesSalta.length === 135, `el archivo trae los ${lotesSalta.length} lotes reales del Parque Industrial Salta`);
  ok(empresasSalta.length === 151,
     `el archivo trae las ${empresasSalta.length} empresas de Salta (136 del origen + 15 ocupantes de la columna «Alquilada»)`);
  ok(totalLotes === lotesGuemes.length + lotesSalta.length && totalEmpresas === empresasGuemes.length + empresasSalta.length,
     'todos los lotes y empresas están atribuidos a uno de los dos parques (ninguno quedó sin id_parque)');
  ok((await page.locator('#empresasCount').textContent()).includes(String(empresasGuemes.length)),
     'el contador de empresas muestra el total del parque activo, no la suma de los dos');
  ok((await page.locator('#parqueSwitch .parque-chip').count()) === 2,
     'el selector de parque ofrece los dos parques');
  ok((await page.locator('#parqueSwitch .parque-chip.active').textContent()).includes('Güemes'),
     'arranca en Güemes, con el chip activo marcado');
  ok(await page.locator('#filterEstadoEmpresas option', { hasText: 'Todos los estados' }).count() === 1,
     'el listado de Empresas tiene el filtro "Todos los estados"');

  // Búsqueda por empresa — AGSOF S.A. ya no debe aparecer duplicada.
  await page.fill('#searchEmpresas', 'AGSOF');
  await page.waitForTimeout(150);
  const esperadoAgsof = datos.empresas.filter((e) => e.nombre_empresa.toUpperCase().includes('AGSOF')).length;
  ok(esperadoAgsof === 1, 'AGSOF S.A. quedó fusionada en un solo registro en los datos');
  ok((await page.locator('#empresasList .tarjeta').count()) === esperadoAgsof,
     `la búsqueda encuentra ${esperadoAgsof} tarjeta de AGSOF (sin duplicado)`);
  await page.fill('#searchEmpresas', '');
  await page.waitForTimeout(150);

  // Ficha de empresa: tab Empresa — Representante, Cargo, Rubro, Actividad,
  // CUIT, en ese orden, con el contacto real de la empresa instalada.
  await page.locator('#empresasList .tarjeta', { hasText: 'AGSOF S.A' }).first().click();
  await page.waitForSelector('#btnEditEmp');
  const fichaEmpresa = await page.locator('#modal').textContent();
  ok(fichaEmpresa.includes('Guillermo Frisch'), 'la ficha de la empresa muestra su contacto (Representante)');
  ok(fichaEmpresa.includes('Encargado'), 'la ficha de la empresa muestra el Cargo');
  const ordenCampos = ['Representante', 'Cargo', 'Rubro', 'Actividad', 'CUIT']
    .map((campo) => fichaEmpresa.indexOf(campo));
  ok(ordenCampos.every((i, idx) => idx === 0 || i > ordenCampos[idx - 1]),
     'el tab Empresa respeta el orden Representante/Cargo/Rubro/Actividad/CUIT');
  ok(fichaEmpresa.includes('Lotes (3)'), 'la ficha fusionada de AGSOF lista sus 3 lotes (L005+L006+L007)');
  ok(fichaEmpresa.includes('20.394'), 'el total de superficie suma los m² de los 3 lotes fusionados');

  // Tab Contacto: Web, Instagram y LinkedIn deben ser links reales (con
  // esquema), no el valor crudo como texto — si no navegan, no cumplen "no
  // debe perder la funcionalidad". Título en negrita, valor en gris.
  await page.click('[data-subtab="contacto"]');
  const hrefWeb = await page.locator('#empSubpanel a', { hasText: 'agsofsa.com.ar' }).getAttribute('href');
  ok(/^https?:\/\//.test(hrefWeb || ''), 'el link de Web navega a una URL real');
  const hrefIg = await page.locator('#empSubpanel a', { hasText: 'instagram.com/agsof' }).getAttribute('href');
  ok(/^https?:\/\/.*instagram\.com/.test(hrefIg || ''), 'el link de Instagram navega a una URL real');
  const hrefMail = await page.locator('#empSubpanel a', { hasText: 'guillermo@grupomm.com.ar' }).getAttribute('href');
  ok((hrefMail || '').startsWith('mailto:'), 'el email abre el cliente de mail (mailto:)');
  const hrefLinkedin = await page.locator('#empSubpanel a', { hasText: 'linkedin.com/in/elianacabrera88' }).getAttribute('href');
  ok(/^https?:\/\/.*linkedin\.com/.test(hrefLinkedin || ''), 'LinkedIn se renderiza y navega a una URL real (antes no aparecía)');
  const contactoHTML = await page.locator('#empSubpanel').innerHTML();
  ok(/class="contact-label"[^>]*>Email/.test(contactoHTML) || contactoHTML.includes('contact-label">Email'),
     'en Contacto el título va con la clase que lo pone en negrita');

  // Tab Lotes de la ficha: solo Mza/Superficie/Parcela/Matrícula/Propiedad/
  // Escritura — nada de "Titular" (viejo nombre) ni badge de estado/color,
  // con la etiqueta en negrita y el dato en gris.
  await page.click('[data-subtab="lote"]');
  const panelLotes = await page.locator('#empSubpanel').innerHTML();
  ok(panelLotes.includes('Propiedad: '), 'el tab Lotes usa la etiqueta "Propiedad" (no "Titular")');
  ok(!panelLotes.includes('Titular:'), 'el tab Lotes ya no muestra "Titular"');
  ok(!/class="lot-si"|class="lot-no"/.test(panelLotes), 'el tab Lotes no colorea Escritura (sobrio, sin color)');
  ok(panelLotes.includes('lot-field-label'), 'el tab Lotes marca Propiedad/Escritura en negrita (lot-field-label)');
  await page.click('#xCloseViewEmp');

  // Sublocación: L038 tiene una ocupación vigente (titular E008/ALISAN,
  // ocupante E028) — se revisa entrando por la ficha de la empresa titular,
  // ya que el lote en sí no tiene una pestaña propia fuera de "Comercial".
  const alisan = datos.empresas.find((e) => e.id_empresa === 'E008');
  await page.fill('#searchEmpresas', alisan.nombre_empresa);
  await page.waitForTimeout(150);
  await page.locator('#empresasList .tarjeta', { hasText: alisan.nombre_empresa }).first().click();
  await page.waitForSelector('#btnEditEmp');
  await page.click('[data-subtab="lote"]');
  await page.click('[data-goto-lote="L038"]');
  await page.waitForSelector('#btnEditLote');
  ok((await page.locator('#modal').textContent()).includes('Ocupación por alquiler'),
     'la ficha de un lote alquilado muestra la sección Ocupación por alquiler');

  // Editar lote (desde la ficha de empresa): el cambio llega al servidor
  // con tildes, ñ y emoji intactos.
  await page.click('#btnEditLote');
  await page.waitForSelector('#f_matricula');
  await page.fill('#f_matricula', 'Editado — ñandú ☕');
  await page.click('#loteForm button[type=submit]');
  await page.waitForTimeout(300);
  ok(ultimoPost?.lotes?.length === totalLotes, `el POST sube los ${totalLotes} lotes`);
  ok(ultimoPost.lotes.some((l) => l.matricula === 'Editado — ñandú ☕'),
     'la matrícula editada llega al servidor con tildes, ñ y emoji intactos');
  // Lo que se publica en el repo son datos, no el estado de la pantalla: el
  // POST mandaba `state` entero y dejó commiteado en parques.json hasta lo que
  // había tipeado alguien en el buscador (searchEmpresas: "b").
  const camposPermitidos = ['parques', 'empresas', 'lotes', 'ocupaciones', 'reservas'];
  const colados = Object.keys(ultimoPost).filter((k) => !camposPermitidos.includes(k));
  ok(colados.length === 0,
     `el POST manda solo datos, sin estado de UI (filtros, búsqueda, modal abierto)${colados.length ? ': se colaron ' + colados.join(', ') : ''}`);
  // onSaveLote ya cierra el modal al guardar.
  await page.fill('#searchEmpresas', '');
  await page.waitForTimeout(150);

  // Comercial: lotes sin empresa (disponibles para la venta + pendientes de
  // revisión) — ya no hay una pestaña "Lotes" general, esto reemplaza lo
  // que ahí se podía hacer con los lotes libres.
  await page.click('#tabComercial');
  await page.waitForSelector('#comercialList .tarjeta');
  ok((await page.locator('#comercialCount').textContent()).includes(String(sinEmpresa.length)),
     `el contador de Comercial muestra los ${sinEmpresa.length} lotes sin empresa`);
  await page.click('#filterDisponibleComercial');
  await page.waitForTimeout(150);
  const esperadoDisponible = sinEmpresa.filter((l) => l.disponible).length;
  ok((await page.locator('#comercialCount').textContent()).startsWith(esperadoDisponible + ' de '),
     `"Solo disponibles para la venta" deja ${esperadoDisponible} lotes`);
  await page.click('#filterDisponibleComercial');

  // Abrir un lote comercial también entra a la ficha estándar de lote
  // (view/edit) — no se perdió esa funcionalidad al sacar la pestaña Lotes.
  await page.locator('#comercialList .tarjeta').first().click();
  await page.waitForSelector('#btnEditLote');
  ok((await page.locator('#modal').textContent()).includes('Titularidad'),
     'un lote comercial abre la misma ficha de lote (con su sección Titularidad)');
  await page.click('#xCloseViewLote');

  // Dashboard: KPIs básicos.
  await page.click('#tabDash');
  await page.waitForSelector('.kpi-card');
  const kpis = await page.locator('.kpi-card .n').allTextContents();
  ok(kpis.some((n) => n.trim() === String(lotesGuemes.length)), 'el dashboard muestra el total de lotes del parque activo');
  ok(kpis.some((n) => n.trim() === String(empresasGuemes.length)), 'el dashboard muestra el total de empresas del parque activo');
  await page.click('#tabEmpresas');
  await page.waitForSelector('#empresasList .tarjeta');

  // ======================================================================
  // Columna «Alquilada»: titularidad y ocupación son dos vínculos distintos
  // ======================================================================
  // El caso de referencia es SL010: el lote es de LABORATORIO TECNIMETER
  // (matrícula 100312, escriturada) y lo ocupa TRADELOG. En la planilla de
  // origen los mails de tradelog.com.ar estaban cargados sobre la fila del
  // titular, que es exactamente la confusión que hay que no repetir.
  await page.locator('#parqueSwitch [data-parque="salta"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#empresasList .tarjeta').length > 0);
  ok((await page.locator('#empresasCount').textContent()).includes(String(empresasSalta.length)),
     'al cambiar de parque el listado pasa a las empresas de Salta');

  const ocupSL010 = datos.ocupaciones.find((o) => o.id_lote === 'SL010');
  const titularSL010 = datos.empresas.find((e) => e.id_empresa === ocupSL010.id_empresa_titular);
  const ocupanteSL010 = datos.empresas.find((e) => e.id_empresa === ocupSL010.id_empresa_ocupante);
  ok(ocupanteSL010.nombre_empresa === 'TRADELOG' && /tradelog/.test(ocupanteSL010.mail || ''),
     'los datos institucionales de tradelog.com.ar quedaron en el registro de TRADELOG');
  ok(!/tradelog/.test(titularSL010.mail || '') && !/tradelog/i.test(titularSL010.pagweb || ''),
     'el registro del titular no quedó con los datos institucionales del ocupante');

  await page.fill('#searchEmpresas', titularSL010.nombre_empresa);
  await page.waitForTimeout(150);
  await page.locator('#empresasList .tarjeta', { hasText: titularSL010.nombre_empresa }).first().click();
  await page.waitForSelector('#btnEditEmp');
  await page.click('[data-subtab="lote"]');
  ok((await page.locator('#empSubpanel').textContent()).includes('Alquilado a TRADELOG'),
     'en la ficha del titular, su lote aparece marcado como alquilado y a quién');
  await page.click('[data-goto-lote="SL010"]');
  await page.waitForSelector('#btnEditLote');

  const fichaSL010 = await page.locator('#modal').textContent();
  ok(fichaSL010.includes('100312') && fichaSL010.includes(titularSL010.nombre_empresa),
     'la ficha del lote conserva la matrícula y el titular registral');
  ok(fichaSL010.includes('Ocupación por alquiler') && fichaSL010.includes('TRADELOG'),
     'la ficha identifica por separado a la empresa ocupante');
  ok(fichaSL010.includes('lorena.ralle@tradelog.com.ar'),
     'la ficha muestra los datos institucionales del ocupante, leídos de SU registro');
  const bloqueOcupacion = await page.locator('#modal .view-section.ocupacion').innerHTML();
  ok(!bloqueOcupacion.includes('100312') && !bloqueOcupacion.includes(titularSL010.nombre_empresa),
     'lo registral del lote no se repite dentro del bloque del ocupante (no se confunde titularidad con ocupación)');

  // Una empresa que solo ocupa por alquiler no es un registro vacío. Se mira
  // antes de cambiar el ocupante: después, TRADELOG ya no ocupa nada.
  await page.click('#xCloseViewLote');
  await page.fill('#searchEmpresas', 'TRADELOG');
  await page.waitForTimeout(150);
  ok((await page.locator('#empresasList .tarjeta', { hasText: 'TRADELOG' }).first().textContent())
       .includes('Ocupa 1 lote por alquiler'),
     'la tarjeta de una empresa sin lotes propios dice qué ocupa, en vez de "0 m² totales"');
  await page.locator('#empresasList .tarjeta', { hasText: 'TRADELOG' }).first().click();
  await page.waitForSelector('#btnEditEmp');
  ok((await page.locator('#modal .subtabs').textContent()).includes('Lotes (1)'),
     'el contador de la pestaña Lotes cuenta también el lote que ocupa por alquiler');
  await page.click('[data-subtab="lote"]');
  const panelTradelog = await page.locator('#empSubpanel').textContent();
  ok(panelTradelog.includes('Ocupa por alquiler') && panelTradelog.includes('Titular:'),
     'la ficha del ocupante separa "a su nombre" de "ocupa por alquiler", nombrando al titular');
  ok(panelTradelog.includes('A su nombre (0)'),
     'el bloque de lotes propios se rotula, no queda como si la empresa no tuviera nada');
  ok(!panelTradelog.includes('LABORATORIO TECNIMETER SOCIEDAD ANONIMA  ') ||
     panelTradelog.includes('Titular: LABORATORIO TECNIMETER'),
     'en la ficha del ocupante la propiedad del lote sigue siendo del titular');

  // Criterio de aceptación: cambiar el ocupante no toca nada registral.
  const antesLote = datos.lotes.find((l) => l.id_lote === 'SL010');
  const nuevoOcupante = datos.empresas.find(
    (e) => delParque(e, 'salta') && e.id_empresa !== titularSL010.id_empresa && e.id_empresa !== ocupanteSL010.id_empresa
  );
  await page.click('[data-goto-lote="SL010"]');
  await page.waitForSelector('#btnEditLote');
  await page.click('#btnEditLote');
  await page.waitForSelector('#f_ocupante');
  ok((await page.locator('#f_ocupante option', { hasText: titularSL010.nombre_empresa }).count()) === 0,
     'el titular no se ofrece como ocupante de su propio lote');
  await page.selectOption('#f_ocupante', nuevoOcupante.id_empresa);
  await page.click('#loteForm button[type=submit]');
  await page.waitForTimeout(300);

  const loteDespues = ultimoPost.lotes.find((l) => l.id_lote === 'SL010');
  ok(ultimoPost.lotes.filter((l) => l.id_lote === 'SL010').length === 1,
     'cambiar de ocupante no duplica el lote');
  ok(loteDespues.id_empresa === antesLote.id_empresa &&
     loteDespues.matricula === antesLote.matricula &&
     loteDespues.superficie_m2 === antesLote.superficie_m2 &&
     loteDespues.escritura === antesLote.escritura &&
     loteDespues.propietario_matricula === antesLote.propietario_matricula,
     'los datos registrales del lote y su titularidad quedan idénticos');
  const vigentes = ultimoPost.ocupaciones.filter((o) => o.id_lote === 'SL010' && o.vigente);
  ok(vigentes.length === 1 && vigentes[0].id_empresa_ocupante === nuevoOcupante.id_empresa,
     'queda una sola ocupación vigente, con el ocupante nuevo');
  const cerrada = ultimoPost.ocupaciones.find((o) => o.id_lote === 'SL010' && !o.vigente);
  ok(cerrada && cerrada.id_empresa_ocupante === ocupanteSL010.id_empresa && !!cerrada.fecha_hasta,
     'la ocupación anterior queda cerrada con fecha, no borrada');
  const tradelogDespues = ultimoPost.empresas.find((e) => e.id_empresa === ocupanteSL010.id_empresa);
  const titularDespues = ultimoPost.empresas.find((e) => e.id_empresa === titularSL010.id_empresa);
  ok(JSON.stringify(tradelogDespues) === JSON.stringify(ocupanteSL010) &&
     JSON.stringify(titularDespues) === JSON.stringify(titularSL010),
     'los registros institucionales de las dos empresas quedan intactos');
  ok(tradelogDespues.situacion === 'Activa' && (titularDespues.situacion || null) !== 'Sin actividad',
     'las dos empresas pueden quedar activas a la vez (el estado es de cada una)');

  await page.fill('#searchEmpresas', '');
  await page.waitForTimeout(150);

  // Vuelta a Güemes: el cambio de parque no deja estado del otro colgado.
  await page.locator('#parqueSwitch [data-parque="guemes"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#empresasList .tarjeta').length > 0);
  ok((await page.locator('#empresasCount').textContent()).includes(String(empresasGuemes.length)),
     'al volver a Güemes el listado vuelve a sus empresas');

  ok(problemas.length === 0, 'sin errores de JS ni diálogos nativos' + (problemas.length ? ': ' + problemas.join(' | ') : ''));
  await browser.close();
  server.close();
}

// Las 4 apps comparten un mismo lenguaje de chips de filtro. Esta prueba es
// transversal a propósito: los tests de cada app miran su propia pantalla y no
// detectan que una quedó con chips de otro tamaño (fue exactamente lo que pasó
// con los 44px de @media(pointer:coarse) en Seguimiento contra los 38px del
// resto). También cubre la barra de navegación inferior, que vive duplicada en
// las 5 páginas y por eso es fácil que se desincronice.
async function testUniformidad(puerto) {
  console.log('\n=== UNIFORMIDAD ENTRE PANTALLAS (390x844, táctil) ===');
  // index entra por la barra inferior: es la quinta copia y se desincroniza igual.
  const paginas = ['seguimiento', 'proyectos', 'resoluciones', 'parques', 'index'];
  const htmls = {};
  for (const p of paginas) htmls[p] = fs.readFileSync(path.join(RAIZ, `public/${p}.html`), 'utf8');

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (servirHeaderJs(req, res)) return;
    const cual = paginas.find((p) => req.url.startsWith('/' + p)) || 'seguimiento';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmls[cual]);
  });
  await new Promise((r) => server.listen(puerto, r));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();

  // Resoluciones no tiene chips de sección (es una sola vista con filtros por
  // desplegable), así que solo entra en la comparación de la barra inferior.
  const chipDe = { seguimiento: '.pestana-btn', proyectos: '.tab', parques: '.tab' };
  const medidas = {};
  const barras = {};

  for (const p of paginas) {
    await page.goto(`http://localhost:${puerto}/${p}.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(150);

    barras[p] = await page.evaluate(() => {
      const item = document.querySelector('.bottom-nav .nav-item');
      const nav = document.querySelector('.bottom-nav');
      return {
        items: document.querySelectorAll('.bottom-nav .nav-item').length,
        altoBarra: Math.round(nav.getBoundingClientRect().height),
        altoItem: Math.round(item.getBoundingClientRect().height),
        activos: document.querySelectorAll('.bottom-nav .nav-item.active').length,
      };
    });

    // El + es fijo y lo pone header.js; el overlay del modal lo define cada
    // app en su propio CSS. Con el + por encima quedaba flotando sobre la
    // ficha abierta y además clickeable. Se prueba por comportamiento (quién
    // recibe el toque), no comparando z-index entre archivos.
    if (await page.locator('#fabNuevo').count()) {
      await page.locator('#fabNuevo').click();
      await page.waitForTimeout(250);
      const tapado = await page.evaluate(() => {
        const f = document.getElementById('fabNuevo');
        const r = f.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return el === f || f.contains(el);
      });
      ok(!tapado, `en ${p} el botón + no queda por encima del modal abierto`);
      await page.goto(`http://localhost:${puerto}/${p}.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);
    }

    if (!chipDe[p]) continue;
    medidas[p] = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2;
      const centro = b.top + b.height / 2;
      return {
        alto: Math.round(b.height),
        fuente: cs.fontSize,
        peso: cs.fontWeight,
        padL: cs.paddingLeft,
        gap: getComputedStyle(el.parentElement).gap,
        tactil: el.contains(document.elementFromPoint(x, centro - 21)) &&
                el.contains(document.elementFromPoint(x, centro + 21)),
      };
    }, chipDe[p]);
  }

  const refs = Object.entries(medidas);
  const [nombreRef, ref] = refs[0];
  for (const [p, m] of refs.slice(1)) {
    ok(m.alto === ref.alto, `los chips de ${p} miden igual que los de ${nombreRef} (${m.alto}px vs ${ref.alto}px)`);
    ok(m.fuente === ref.fuente && m.peso === ref.peso, `la tipografía del chip de ${p} coincide (${m.fuente}/${m.peso} vs ${ref.fuente}/${ref.peso})`);
    ok(m.padL === ref.padL && m.gap === ref.gap, `padding y separación del chip de ${p} coinciden (${m.padL}/${m.gap} vs ${ref.padL}/${ref.gap})`);
  }
  ok(ref.alto >= 36 && ref.alto <= 40, `el chip respeta los 36-40px de alto de la especificación (${ref.alto}px)`);
  for (const [p, m] of refs) {
    ok(m.tactil, `en ${p} el chip responde al toque en los 44px completos, aunque mida ${m.alto}px`);
  }

  // --- Header global: mismo componente en las 4 apps ---
  // El criterio de aceptación que pidió el usuario es literal: al cambiar de
  // pantalla el título cambia, pero el ⋮ conserva exactamente la misma
  // alineación horizontal y vertical.
  const encabezados = {};
  for (const p of paginas) {
    if (p === 'index') continue;
    await page.goto(`http://localhost:${puerto}/${p}.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);
    encabezados[p] = await page.evaluate(() => {
      const h = document.querySelector('.app-header');
      const t = document.querySelector('.app-header__titulo');
      const b = document.querySelector('.app-header__menu');
      const rb = b.getBoundingClientRect();
      const rt = t.getBoundingClientRect();
      const cs = getComputedStyle(t);
      return {
        titulo: t.textContent.trim(),
        altoHeader: Math.round(h.getBoundingClientRect().height),
        menuTop: Math.round(rb.top),
        menuDerecha: Math.round(window.innerWidth - rb.right),
        menuAncho: Math.round(rb.width),
        menuAlto: Math.round(rb.height),
        tituloIzquierda: Math.round(rt.left),
        tituloFuente: cs.fontSize,
        // Un título largo no debe empujar ni tapar el botón.
        seSolapan: rt.right > rb.left,
        viejos: document.querySelectorAll('.volver, #btnTheme, #btnNew, .sync-status, .sync-indicator, .header-title').length,
      };
    });
  }
  const esperados = { seguimiento: 'Seguimiento', proyectos: 'Proyectos', resoluciones: 'Resoluciones', parques: 'Parques' };
  const apps = Object.keys(encabezados);
  const refHdr = encabezados[apps[0]];
  for (const p of apps) {
    const e = encabezados[p];
    ok(e.titulo === esperados[p], `el header de ${p} se titula "${esperados[p]}" (dice "${e.titulo}")`);
    ok(e.menuAncho >= 48 && e.menuAlto >= 48, `el ⋮ de ${p} tiene área táctil de al menos 48x48 (${e.menuAncho}x${e.menuAlto})`);
    ok(!e.seSolapan, `en ${p} el título no se superpone con el ⋮`);
    ok(e.viejos === 0, `en ${p} no quedó nada del header viejo (Inicio, tema, botón nuevo, cartel de sync)`);
  }
  for (const p of apps.slice(1)) {
    const e = encabezados[p];
    ok(e.menuTop === refHdr.menuTop && e.menuDerecha === refHdr.menuDerecha,
       `el ⋮ de ${p} está en la misma posición que en ${apps[0]} (y=${e.menuTop}/${refHdr.menuTop}, der=${e.menuDerecha}/${refHdr.menuDerecha})`);
    ok(e.altoHeader === refHdr.altoHeader && e.tituloIzquierda === refHdr.tituloIzquierda && e.tituloFuente === refHdr.tituloFuente,
       `el header de ${p} tiene mismo alto, margen y tipografía que el de ${apps[0]}`);
  }

  // El menú abre, es navegable y cierra con Escape.
  await page.goto(`http://localhost:${puerto}/seguimiento.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(250);
  await page.click('#btnMenu');
  await page.waitForTimeout(150);
  ok(await page.locator('.app-menu').isVisible(), 'el ⋮ abre el menú contextual');
  ok((await page.locator('.app-menu__item').count()) > 0, 'el menú trae opciones de la sección');
  const dentro = await page.evaluate(() => {
    const m = document.querySelector('.app-menu').getBoundingClientRect();
    return m.right <= window.innerWidth && m.left >= 0 && m.bottom <= window.innerHeight;
  });
  ok(dentro, 'el menú queda dentro de la pantalla, sin cortarse por el borde');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok(await page.locator('.app-menu').isHidden(), 'Escape cierra el menú');
  ok(await page.evaluate(() => document.activeElement.id === 'btnMenu'), 'al cerrar, el foco vuelve al ⋮');

  const barraRef = barras[paginas[0]];
  for (const p of paginas.slice(1)) {
    ok(barras[p].altoBarra === barraRef.altoBarra,
       `la barra inferior de ${p} tiene el mismo alto que la de ${paginas[0]} (${barras[p].altoBarra}px vs ${barraRef.altoBarra}px)`);
  }
  for (const p of paginas) {
    ok(barras[p].items === 4, `la barra inferior de ${p} tiene las 4 apps`);
    // index es el selector de entrada: no está "dentro" de ninguna app, así que
    // correctamente no marca ninguna como activa.
    const esperado = p === 'index' ? 0 : 1;
    ok(barras[p].activos === esperado,
       `en ${p} hay ${esperado} app${esperado === 1 ? '' : 's'} marcada${esperado === 1 ? '' : 's'} como activa en la barra inferior`);
  }

  await browser.close();
  server.close();
}

await recorrido('DESKTOP', { width: 1440, height: 900 }, 8799);
await recorrido('MOBILE', { width: 390, height: 844 }, 8798);
await testFechas();
await testSyncYEscape();
await testPendienteAlAbrir();
await testCampoNumero();
await testPlazosYTarjetas();
await testMovilTactil();
await testTecladoYFoco();
await testFlujo();
await testResoluciones({ width: 1440, height: 900 }, 8797);
await testResoluciones({ width: 390, height: 844 }, 8796);
await testProyectos({ width: 1440, height: 900 }, 8795);
await testProyectos({ width: 390, height: 844 }, 8794);
await testParques({ width: 1440, height: 900 }, 8793);
await testParques({ width: 390, height: 844 }, 8792);
await testUniformidad(8791);

console.log(fallas === 0 ? '\nUI OK en desktop y mobile' : `\n${fallas} fallas`);
process.exit(fallas === 0 ? 0 : 1);
