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
const UI_KIT = fs.readFileSync(path.join(RAIZ, 'public/ui-kit.css'), 'utf8');
const DESIGN_SYSTEM = fs.readFileSync(path.join(RAIZ, 'public/design-system.css'), 'utf8');
// La tarjeta «¿Desea guardar los cambios?» también es compartida: sin este
// archivo, el <script> cae al HTML de relleno y la página tira SyntaxError.
const CONFIRMAR_JS = fs.readFileSync(path.join(RAIZ, 'public/confirmar-cambios.js'), 'utf8');
// Los dos archivos compartidos por las 5 páginas. Si el server de un test no
// los sirve, esa pantalla corre sin header, sin botones con estilo y sin la
// lupa de la búsqueda — y el test falla por una razón que no es la que
// estaba probando.
function servirHeaderJs(req, res) {
  // design-system.css es dependencia DURA de ui-kit.css desde el 2026-10-19:
  // los --ui-* ya no tienen valor de respaldo, los leen de los --ds-*. Si un
  // server de prueba no lo sirve, los botones salen sin alto y sin radio y el
  // test falla por el server, no por el código.
  if (req.url.startsWith('/design-system.css')) {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(DESIGN_SYSTEM);
    return true;
  }
  if (req.url.startsWith('/ui-kit.css')) {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(UI_KIT);
    return true;
  }
  if (req.url.startsWith('/confirmar-cambios.js')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(CONFIRMAR_JS);
    return true;
  }
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
  await new Promise((r) => ctx.server.listen(8790, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8794' });
  const page = await context.newPage();
  await page.goto('http://localhost:8790/', { waitUntil: 'networkidle' });
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

  // Búsqueda: 14px y Roboto por pedido del usuario (2026-10-20). Antes era
  // ≥16px para que iOS no hiciera zoom; el pedido lo cambia y queda anotado.
  const fuente = (sel) => page.evaluate((s) => parseFloat(getComputedStyle(document.querySelector(s)).fontSize), sel);
  ok((await fuente('#searchInput')) === 14, `el buscador tiene fuente de 14px (${await fuente('#searchInput')}px)`);

  // Objetivos táctiles de 44px.
  await page.locator('.expediente-header-urgencia').first().click();
  const alto = async (sel) => (await page.locator(sel).first().boundingBox()).height;
  ok((await alto('#btnMenu')) >= 44, `el menú ⋮ mide ≥44px de alto (${Math.round(await alto('#btnMenu'))}px)`);
  // Los chips de filtro y, desde el ui-kit, también los botones de acción
  // miden menos a la vista (38 y 40px, las medidas pedidas) y extienden el
  // objetivo táctil a 44px con un pseudo-elemento. Por eso no se mide el alto
  // del rect sino lo que importa de verdad: que un dedo que cae en esa franja
  // active el control.
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
  // Mismo criterio para los botones de acción: 40px a la vista (la medida de
  // la especificación) y 44px de área táctil.
  const resolver = await page.evaluate(() => {
    const el = document.querySelector('.expediente-actions .btn');
    // Al centro de la pantalla antes de medir: si el botón queda abajo de
    // todo, quien recibe el toque es la barra de navegación y el test falla
    // por dónde estaba parada la página, no por el tamaño del objetivo.
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    const x = b.left + b.width / 2;
    const centro = b.top + b.height / 2;
    const ha = document.elementFromPoint(x, centro - 21);
    const hb = document.elementFromPoint(x, centro + 21);
    return {
      alto: b.height,
      arriba: el.contains(ha),
      abajo: el.contains(hb),
      quien: (ha ? ha.className : 'null') + ' / ' + (hb ? hb.className : 'null'),
      y: Math.round(b.top)
    };
  });
  ok(Math.round(resolver.alto) === 40, `Resolver mide los 40px de la especificación (${Math.round(resolver.alto)}px)`);
  ok(resolver.arriba && resolver.abajo,
     `Resolver responde al toque en los 44px completos (arriba=${resolver.arriba}, abajo=${resolver.abajo}, y=${resolver.y}, tapa=${resolver.quien})`);

  // Resolver y Editar van uno al lado del otro, del mismo ancho y en la misma
  // línea (pedido del usuario 2026-10-21: antes apilados a todo el ancho).
  const filaAcciones = await page.evaluate(() => {
    const botones = [...document.querySelector('.expediente-actions').querySelectorAll('.btn')];
    const cajas = botones.map((b) => b.getBoundingClientRect());
    return {
      cantidad: botones.length,
      mismaLinea: new Set(cajas.map((b) => Math.round(b.top))).size === 1,
      anchos: cajas.map((b) => Math.round(b.width))
    };
  });
  ok(filaAcciones.cantidad === 2 && filaAcciones.mismaLinea,
     `Resolver y Editar van en la misma fila (${filaAcciones.cantidad} botones, misma línea=${filaAcciones.mismaLinea})`);
  ok(Math.max(...filaAcciones.anchos) - Math.min(...filaAcciones.anchos) <= 1,
     `Resolver y Editar miden lo mismo de ancho (${filaAcciones.anchos.join(' / ')}px)`);

  // Distancias pedidas (2026-10-21), a 96 dpi: 0,5 mm entre el ⋮ y la búsqueda
  // (2px) y 0,8 mm entre los chips y las tarjetas (3px). Esos 3px son el área
  // táctil de 44px del chip (.area-btn::after): si la tarjeta los tapa, el chip
  // deja de responder al borde de abajo.
  const distancias = await page.evaluate(() => {
    // Arriba de todo: el test anterior bajó la página para medir Resolver, y
    // con la página bajada el ⋮ ya no está al lado de la búsqueda.
    window.scrollTo(0, 0);
    const menu = document.querySelector('#btnMenu').getBoundingClientRect();
    const busqueda = document.querySelector('.search-bar').getBoundingClientRect();
    const chip = document.querySelector('.area-btn').getBoundingClientRect();
    const tarjeta = document.querySelector('.expediente-card-new').getBoundingClientRect();
    return { menuBusqueda: busqueda.top - menu.bottom, chipTarjeta: tarjeta.top - chip.bottom };
  });
  ok(Math.abs(distancias.menuBusqueda - 2) < 0.6,
     `el ⋮ y la búsqueda quedan a 2px, 0,5 mm (${distancias.menuBusqueda.toFixed(2)}px)`);
  ok(Math.abs(distancias.chipTarjeta - 3) < 0.6,
     `los chips de área y la primera tarjeta quedan a 3px, 0,8 mm (${distancias.chipTarjeta.toFixed(2)}px)`);
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('areaBotones')).scrollbarWidth) === 'none',
     'la barra de desplazamiento de los chips está oculta (no aparece la línea al arrastrarlos)');

  // Orden de la presentación de la tarjeta: Tema, Expediente, Vencimiento. El
  // fondo de alarma se mantiene (el color del semáforo, no blanco).
  const presentacion = await page.evaluate(() => {
    const hdr = document.querySelector('.expediente-header-urgencia');
    return {
      orden: [...hdr.querySelectorAll('.expediente-urgencia-title > *')].map((e) => e.className),
      fondo: getComputedStyle(hdr).backgroundColor
    };
  });
  ok(presentacion.orden[0].includes('urgencia-tema') && presentacion.orden[1].includes('urgencia-label')
     && presentacion.orden[2].includes('urgencia-dias'),
     `la tarjeta muestra Tema, Expediente y Vencimiento en ese orden (${presentacion.orden.join(' > ')})`);
  ok(presentacion.fondo !== 'rgba(0, 0, 0, 0)' && presentacion.fondo !== 'transparent',
     `la cabecera de la tarjeta conserva el color de alarma (${presentacion.fondo})`);

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
  // El contenido que queda justo debajo de la barra fija tiene que ser
  // contenido, no la barra: si la barra se hace más alta, el punto de prueba
  // se corre con ella.
  const tapado = await page.evaluate(() => {
    const primera = document.querySelector('.expediente-card-new');
    const r = primera.getBoundingClientRect();
    const barra = document.querySelector('.sticky-top').getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, Math.max(r.y, barra.bottom) + 10);
    return el ? !!el.closest('.sticky-top') : false;
  });
  ok(!tapado, 'ningún panel fijo tapa el contenido al scrollear');
  await page.evaluate(() => window.scrollTo(0, 0));

  // El formulario ocupa toda la pantalla.
  await page.click('#fabNuevo');
  const caja = await page.locator('.modal-form').boundingBox();
  ok(Math.round(caja.width) === 390 && Math.round(caja.height) === 844, `el formulario es pantalla completa (${Math.round(caja.width)}x${Math.round(caja.height)})`);
  // Formulario (pedido 2026-10-20): campo a 12px sobre --surface-2 y etiqueta a 14px
  // en --text. Los tokens se comparan con un elemento de prueba, no con hex.
  ok((await fuente('#tema')) === 16, `los campos del formulario tienen fuente de 16px, el criterio común (${await fuente('#tema')}px)`);
  ok(await page.evaluate(() => {
    const etiqueta = getComputedStyle(document.querySelector('label[for="tema"]'));
    const campo = getComputedStyle(document.getElementById('tema'));
    const prueba = document.createElement('i');
    prueba.style.color = 'var(--text)';
    prueba.style.background = 'var(--surface-2)';
    document.body.appendChild(prueba);
    const token = getComputedStyle(prueba);
    const resultado = etiqueta.fontSize === '14px' && etiqueta.color === token.color && campo.backgroundColor === token.backgroundColor;
    prueba.remove();
    return resultado;
  }), 'la etiqueta mide 14px en --text y el campo tiene fondo --surface-2');
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
  // Piso, no cifra: el archivo cambia con cada carga manual (157 → 158 el
  // 2026-10-20). Lo que importa es que sea la base real y no un fixture chico.
  ok(total >= 100, `el archivo trae los ${total} expedientes reales`);
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
  // Pedido del usuario (2026-10-21). Este expediente es el caso completo: está
  // archivado, tiene situación y tiene la nota automática de archivado, así que
  // si alguno de los tres vuelve al primer panel o el cartel "SISTEMA" vuelve a
  // dibujarse, el test lo ve.
  const panel = await page.evaluate(() => {
    const head = document.querySelector('#modal .view-head');
    return {
      extra: [...head.querySelectorAll('*')].filter((el) => !el.matches('.view-empresa, .view-exp')).length,
      texto: head.textContent.replace(/\s+/g, ' ').trim(),
      empresa: document.querySelector('#modal .view-empresa').textContent.trim(),
      nro: document.querySelector('#modal .view-exp').textContent.trim(),
      sys: document.querySelectorAll('#modal .hist .sys').length,
      notas: document.querySelector('#modal .hist').textContent,
      grilla: document.querySelector('#modal .view-section').textContent,
    };
  });
  const sinEspacios = (t) => t.replace(/\s+/g, '');
  ok(panel.extra === 0 && sinEspacios(panel.texto) === sinEspacios(panel.empresa + panel.nro),
     `el primer panel de la ficha muestra la empresa y el número, nada más ("${panel.texto}")`);
  ok(panel.grilla.includes('Situación') && panel.grilla.includes('Archivado el'),
     'la situación y la fecha de archivado bajaron a la grilla de Expediente, no se perdieron');
  ok(panel.sys === 0 && !/SISTEMA/i.test(panel.notas) && panel.notas.includes('Archivado automáticamente'),
     'la nota de archivado automático se lee sin el cartel "SISTEMA"');
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
 * Proyectos: dos cargas manuales seguidas, la segunda mientras la primera
 * todavía sube. Antes la segunda se perdía: el POST que terminaba borraba la
 * marca de pendiente sin mirar si había llegado algo nuevo, nunca se enviaba,
 * y la descarga siguiente la pisaba en el dispositivo. Además el POST no
 * devolvía su sha, así que cada guardado posterior daba 409 contra sí mismo.
 */
async function testProyectosCargaSolapada() {
  console.log('\n=== PROYECTOS: CARGAS SOLAPADAS NO SE PIERDEN ===');
  const html = fs.readFileSync(path.join(RAIZ, 'public/proyectos.html'), 'utf8');
  const inicial = JSON.parse(fs.readFileSync(path.join(RAIZ, 'cartas-intencion.json'), 'utf8'));
  const POST_MS = 1500;
  let store = JSON.parse(JSON.stringify(inicial));
  // Copia del servidor con el nombre anterior del parque: al cargar tiene que
  // aparecer como Rosario, no como un parque que la lista no reconoce.
  store.expedientes[0].parque_industrial = 'RDLF';
  let sha = 'sha-0';
  const respuestas = [];

  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/api/version-cartas')) return json(200, { version: sha });
    if (req.url.startsWith('/api/sync-cartas')) {
      if (req.method === 'GET') return json(200, Object.assign({}, store, { _meta: { existe: true, sha } }));
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = JSON.parse(body);
        // Mismo contrato que el Worker: 409 si la base cambió desde _baseSha.
        if (p._baseSha && p._baseSha !== sha) {
          respuestas.push(409);
          return json(409, { error: 'conflicto', actual: Object.assign({}, store, { _meta: { existe: true, sha } }) });
        }
        setTimeout(() => {
          const nuevo = Object.assign({}, p);
          delete nuevo._baseSha; delete nuevo._meta;
          store = nuevo;
          sha = 'sha-' + (respuestas.length + 1);
          respuestas.push(200);
          json(200, { ok: true, sha });
        }, POST_MS);
      });
      return;
    }
    if (servirHeaderJs(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(8791, r));

  const problemas = [];
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  page.on('dialog', async (d) => { await d.dismiss(); });
  await page.goto('http://localhost:8791/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.app-fab');

  const cargar = async (nombre) => {
    await page.click('.app-fab');
    await page.waitForSelector('#f_nombre_empresa');
    await page.fill('#f_nombre_empresa', nombre);
    await page.fill('#f_fecha_inicio', '2026-10-09');
    await page.click('#expForm button[type=submit]');
  };
  const enServidor = (n) => store.expedientes.some((e) => e.nombre_empresa === n);

  const guardadoAlCargar = await page.evaluate(() => JSON.parse(localStorage.getItem('cartas_intencion_parques_v3') || '[]'));
  ok(!guardadoAlCargar.some((e) => e.parque_industrial === 'RDLF') && guardadoAlCargar.some((e) => e.id === store.expedientes[0].id && e.parque_industrial === 'Rosario'),
     'una copia del servidor con RDLF se lee como Rosario');

  // Alta: calendario nativo igual que Expediente, arranca con la fecha de hoy,
  // título «Nuevo proyecto» y el parque aparece como Rosario.
  await page.click('.app-fab');
  await page.waitForSelector('#f_nombre_empresa');
  const formulario = await page.evaluate(() => {
    const fecha = document.getElementById('f_fecha_inicio');
    const hoy = new Date();
    const iso = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0') + '-' + String(hoy.getDate()).padStart(2, '0');
    const parques = [...document.getElementById('f_parque_industrial').options].map((o) => o.value);
    return { tipo: fecha.type, valor: fecha.value, iso,
      titulo: document.querySelector('.modal-head h2').textContent,
      rosario: parques.includes('Rosario'), rdlf: parques.includes('RDLF'),
      etiqueta: getComputedStyle(document.querySelector('label[for="f_nombre_empresa"]')).fontSize };
  });
  ok(formulario.tipo === 'date', 'la fecha de inicio usa el calendario nativo, igual que Expediente');
  ok(formulario.valor === formulario.iso, `el alta arranca con la fecha de hoy (${formulario.valor})`);
  ok(formulario.titulo === 'Nuevo proyecto', `el título del alta es «Nuevo proyecto» (${formulario.titulo})`);
  ok(formulario.rosario && !formulario.rdlf, 'el parque aparece como Rosario, no como RDLF');
  ok(formulario.etiqueta === '14px', `las etiquetas miden 14px (${formulario.etiqueta})`);
  await page.click('#xClose');
  await page.waitForTimeout(150);

  await cargar('CARGA SOLAPADA A');
  await page.waitForTimeout(2000); // A ya está subiendo (arranca a los 1500 ms)
  await cargar('CARGA SOLAPADA B'); // se guarda mientras A vuela

  for (let i = 0; i < 20 && !enServidor('CARGA SOLAPADA B'); i++) await page.waitForTimeout(500);
  ok(enServidor('CARGA SOLAPADA A'), 'la carga A llega al servidor');
  ok(store.expedientes.find((e) => e.nombre_empresa === 'CARGA SOLAPADA A')?.fecha_inicio === '09/10/2026',
     'la fecha del calendario se guarda en el formato dd/mm/aaaa de siempre');
  ok(enServidor('CARGA SOLAPADA B'), 'la carga hecha mientras A subía llega al servidor (antes se perdía)');
  ok(await page.evaluate(() => localStorage.getItem('cartas_intencion_parques_v3')).then((r) => JSON.parse(r).some((e) => e.nombre_empresa === 'CARGA SOLAPADA B')),
     'y sigue en el dispositivo');
  ok(!respuestas.includes(409), 'ningún 409 espurio: el POST devuelve el sha y el siguiente lo usa como base');
  ok(problemas.length === 0, 'sin errores de JS' + (problemas.length ? ': ' + problemas.join(' | ') : ''));
  await browser.close();
  server.close();
}

/*
 * Proyectos, dos casos de pérdida o desorden de datos:
 *  - Arranque con copia vieja: el dispositivo tiene una marca de pendiente y
 *    una copia local sin la carga que otro dispositivo ya subió. Antes subía
 *    esa copia con _baseSha null y el servidor perdía la carga ajena.
 *  - Archivo: ordenado por fecha de archivado de verdad, no por texto
 *    dd/mm/aaaa (20/12/2025 quedaba antes que 15/01/2026).
 */
async function testProyectosArranqueYArchivo() {
  console.log('\n=== PROYECTOS: ARRANQUE CON COPIA VIEJA Y ORDEN DEL ARCHIVO ===');
  const html = fs.readFileSync(path.join(RAIZ, 'public/proyectos.html'), 'utf8');
  const inicial = JSON.parse(fs.readFileSync(path.join(RAIZ, 'cartas-intencion.json'), 'utf8'));
  const store = JSON.parse(JSON.stringify(inicial));
  store.expedientes.push({
    id: 'exp_otro_dispositivo', nro_expediente: '363-99999/2026-01',
    nombre_empresa: 'CARGA DEL OTRO DISPOSITIVO', fecha_inicio: '09/10/2026',
    situacion: 'Sin_tratamiento', intervenciones: [],
    actualizado_en: new Date().toISOString()
  });
  let sha = 'sha-7';
  const posts = [];

  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/api/version-cartas')) return json(200, { version: sha });
    if (req.url.startsWith('/api/sync-cartas')) {
      if (req.method === 'GET') return json(200, Object.assign({}, store, { _meta: { existe: true, sha } }));
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = JSON.parse(body);
        posts.push({ baseSha: p._baseSha, tieneOtro: p.expedientes.some((e) => e.id === 'exp_otro_dispositivo') });
        // Mismo contrato que el Worker: 409 si la base cambió desde _baseSha.
        if (p._baseSha && p._baseSha !== sha) {
          return json(409, { error: 'conflicto', actual: Object.assign({}, store, { _meta: { existe: true, sha } }) });
        }
        store.expedientes = p.expedientes;
        sha = 'sha-' + (posts.length + 7);
        json(200, { ok: true, sha });
      });
      return;
    }
    if (servirHeaderJs(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(8789, r));

  const problemas = [];
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  page.on('dialog', async (d) => { await d.dismiss(); });
  const url = 'http://localhost:8789/';

  // 1) Copia vieja + pendiente, sin la carga ajena.
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate((base) => {
    localStorage.setItem('cartas_intencion_parques_v3', JSON.stringify(base));
    localStorage.setItem('cartas_intencion_sync_pendiente_v2', '1');
  }, inicial.expedientes);
  await page.reload({ waitUntil: 'networkidle' });
  for (let i = 0; i < 16 && !store.expedientes.some((e) => e.id === 'exp_otro_dispositivo'); i++) await page.waitForTimeout(500);
  ok(store.expedientes.some((e) => e.id === 'exp_otro_dispositivo'),
     'la carga que otro dispositivo ya subió sobrevive al arranque con copia vieja');
  ok(posts.length > 0 && posts.every((p) => p.baseSha === 'sha-7'),
     'el POST del arranque lleva el sha del servidor como base, no null');
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('cartas_intencion_parques_v3')).some((e) => e.id === 'exp_otro_dispositivo')),
     'y el dispositivo también la tiene después de fusionar');

  // 2) Orden del Archivo con fechas que cruzan años.
  const archivados = [
    ['ARCH 20 DIC 2025', '20/12/2025 10:00'],
    ['ARCH 05 ENE 2026', '05/01/2026 09:00'],
    ['ARCH 01 DIC 2025', '01/12/2025 08:00'],
    ['ARCH 15 ENE 2026', '15/01/2026 09:00']
  ].map(([nombre, fecha], i) => ({
    id: 'exp_arch_' + i, nro_expediente: '999-0000' + i + '/2025-0', nombre_empresa: nombre,
    fecha_inicio: '01/01/2025', situacion: 'Sin_tratamiento', archivado: true,
    fecha_archivado: fecha, intervenciones: []
  }));
  store.expedientes.push(...archivados);
  sha = 'sha-8';
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.exp-card').length > 0);
  await page.click('#tabArchivo');
  await page.waitForSelector('#archivoList .exp-card');
  const orden = await page.locator('#archivoList .exp-card').allTextContents();
  const posiciones = ['ARCH 15 ENE 2026', 'ARCH 05 ENE 2026', 'ARCH 20 DIC 2025', 'ARCH 01 DIC 2025']
    .map((n) => orden.findIndex((t) => t.includes(n)));
  ok(posiciones.every((p) => p >= 0) && posiciones.every((p, i) => i === 0 || p > posiciones[i - 1]),
     'el Archivo muestra el más reciente primero: 15/01/2026, 05/01/2026, 20/12/2025, 01/12/2025');

  ok(problemas.length === 0, 'sin errores de JS' + (problemas.length ? ': ' + problemas.join(' | ') : ''));
  await browser.close();
  server.close();
}

/*
 * Proyectos, puntos de la auditoría 3 a 6:
 *  3. El número de expediente se valida (formato y duplicado) cuando es nuevo
 *     o cambió; los registros viejos con otra forma se pueden editar.
 *  4. Dentro de un color del semáforo, lo más urgente va primero.
 *  5. Escape y el clic afuera no cierran un formulario con texto sin guardar.
 */
/*
 * Proyectos: las salidas de la ficha y el borrado con Deshacer. Cada caso
 * existe por un defecto real que se encontró leyendo el código y se confirmó
 * antes de tocarlo: (1) un clic sobre el fondo que nace de seleccionar texto
 * dentro de la ficha abría la tarjeta sin que nadie quisiera salir; (2) el
 * botón atrás cambiaba la vista con la ficha sucia, sin preguntar y con la URL
 * desfasada de la pantalla; (3) Eliminar usaba confirm() nativo.
 */
async function testProyectosSalidasYDeshacer() {
  console.log('\n=== PROYECTOS: SALIDAS DE LA FICHA Y DESHACER ===');
  const html = fs.readFileSync(path.join(RAIZ, 'public/proyectos.html'), 'utf8');
  const inicial = JSON.parse(fs.readFileSync(path.join(RAIZ, 'cartas-intencion.json'), 'utf8'));
  const store = JSON.parse(JSON.stringify(inicial));
  const objetivo = store.expedientes.find((e) => e.nombre_empresa && !e.archivado);
  let sha = 'sha-0';
  const posts = [];

  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/api/version-cartas')) return json(200, { version: sha });
    if (req.url.startsWith('/api/sync-cartas')) {
      if (req.method === 'GET') return json(200, Object.assign({}, store, { _meta: { existe: true, sha } }));
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = JSON.parse(body);
        posts.push(p);
        if (p._baseSha && p._baseSha !== sha) return json(409, { error: 'conflicto', actual: Object.assign({}, store, { _meta: { existe: true, sha } }) });
        store.expedientes = p.expedientes;
        store.eliminados = p.eliminados || [];
        sha = 'sha-' + (posts.length + 1);
        json(200, { ok: true, sha });
      });
      return;
    }
    if (servirHeaderJs(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(8785, r));

  const problemas = [];
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  // Ningún diálogo nativo: ni confirm() ni alert(). Si aparece, es regresión.
  page.on('dialog', async (d) => { problemas.push('dialog nativo: ' + d.message()); await d.dismiss(); });
  await page.goto('http://localhost:8785/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.app-fab');
  const modalAbierto = async () => !(await page.locator('#veil').evaluate((v) => v.hidden));
  const tarjetaVisible = () => page.isVisible('.cc-card');
  const esperar = (ms) => page.waitForTimeout(ms);
  const abrirFicha = async () => {
    await page.locator('.exp-card', { hasText: objetivo.nombre_empresa }).first().click();
    await page.waitForSelector('#btnEdit');
  };

  // A) Clic sobre el fondo que nace de seleccionar texto dentro de la ficha:
  // el gesto empieza en el campo y termina afuera. No debe abrir la tarjeta.
  await abrirFicha();
  await page.click('#btnEdit');
  await page.waitForSelector('#f_nombre_empresa');
  await page.fill('#f_nombre_empresa', 'TEXTO A SELECCIONAR');
  const campo = await page.locator('#f_nombre_empresa').boundingBox();
  await page.mouse.move(campo.x + 5, campo.y + campo.height / 2);
  await page.mouse.down();
  await page.mouse.move(5, 5, { steps: 5 });   // arrastre hasta el fondo
  await page.mouse.up();
  await esperar(150);
  ok(!(await tarjetaVisible()) && (await modalAbierto()),
     'arrastrar desde la ficha hasta el fondo no abre la tarjeta (el gesto no empezó afuera)');

  // B) Clic real en el fondo con texto sin guardar: sí pregunta.
  await page.mouse.click(5, 5);
  await esperar(150);
  ok(await tarjetaVisible(), 'un clic que empieza y termina en el fondo sí pregunta con texto sin guardar');
  await page.click('.cc-card [data-opcion="seguir"]');
  await esperar(100);

  // C) Botón atrás (hash) con la ficha sucia: pregunta, y «Seguir editando»
  // deja la ficha abierta y la URL de vuelta en la vista que se ve.
  await page.evaluate(() => { location.hash = '#archivo'; });
  await esperar(200);
  ok(await tarjetaVisible() && (await modalAbierto()), 'cambiar la vista con la ficha sucia pregunta antes de hacerlo');
  await page.click('.cc-card [data-opcion="seguir"]');
  await esperar(200);
  ok((await page.evaluate(() => location.hash)) === '#listado' && (await modalAbierto()) &&
     (await page.locator('#viewList').isVisible()),
     'con «Seguir editando» la URL vuelve a #listado y la vista no cambia');

  // D) Mismo caso, «No guardar»: la ficha se cierra y la vista cambia.
  await page.evaluate(() => { location.hash = '#archivo'; });
  await esperar(200);
  await page.click('.cc-card [data-opcion="descartar"]');
  await esperar(200);
  ok(!(await modalAbierto()) && (await page.locator('#viewArchivo').isVisible()),
     '«No guardar» cierra la ficha y muestra la vista pedida');
  await page.evaluate(() => { location.hash = '#listado'; });
  await esperar(200);

  // E) Mismo caso, «Guardar» con un error de validación: la ficha queda
  // abierta con el error y la URL vuelve a la vista que se ve.
  await abrirFicha();
  await page.click('#btnEdit');
  await page.waitForSelector('#f_fecha_inicio');
  await page.fill('#f_fecha_inicio', '');   // sin fecha: el calendario no admite una inválida
  await page.evaluate(() => { location.hash = '#dashboard'; });
  await esperar(200);
  await page.click('.cc-card [data-opcion="guardar"]');
  await esperar(300);
  ok((await modalAbierto()) && (await page.evaluate(() => location.hash)) === '#listado',
     'Guardar con error de validación deja la ficha abierta y la URL en la vista que se ve');
  await page.click('#xClose');
  await esperar(150);
  await page.click('.cc-card [data-opcion="descartar"]');
  await esperar(150);

  // F) Eliminar: sin confirm nativo, borra al instante y ofrece Deshacer.
  const cantAntes = store.expedientes.length;
  await abrirFicha();
  await page.click('#btnEdit');
  await page.waitForSelector('#btnDelete');
  await page.click('#btnDelete');
  await esperar(250);
  // La subida va con debounce de 1500 ms (DEBOUNCE_MS): esperar al POST, no adivinarlo.
  const toast = page.locator('#toast');
  ok(!(await toast.isHidden()) && (await page.locator('#toastAccion').isVisible()),
     'Eliminar muestra el toast con Deshacer');
  await esperar(2200);
  const ultimo = posts[posts.length - 1];
  ok(ultimo && ultimo.expedientes.length === cantAntes - 1,
     'el expediente sale de la lista y el resto de los datos queda igual');
  ok(ultimo && !ultimo.expedientes.some((e) => e.id === objetivo.id) && ultimo.eliminados.some((t) => t.id === objetivo.id),
     'el borrado sube con su lápida (eliminados), para que no reaparezca en otro dispositivo');
  await page.click('#toastAccion');
  await esperar(2200);
  const restaurado = posts[posts.length - 1];
  ok(restaurado && restaurado.expedientes.some((e) => e.id === objetivo.id) && !restaurado.eliminados.some((t) => t.id === objetivo.id),
     'Deshacer restaura el expediente y saca su lápida; el POST lo lleva de vuelta');
  ok(await toast.isHidden(), 'después de Deshacer el toast se oculta');

  ok(problemas.length === 0, 'sin errores de JS ni diálogos nativos' + (problemas.length ? ': ' + problemas.join(' | ') : ''));
  await browser.close();
  server.close();
}

async function testProyectosValidacionYOrden() {
  console.log('\n=== PROYECTOS: NÚMERO, ORDEN DEL SEMÁFORO Y FORMULARIO SUCIO ===');
  const html = fs.readFileSync(path.join(RAIZ, 'public/proyectos.html'), 'utf8');
  const inicial = JSON.parse(fs.readFileSync(path.join(RAIZ, 'cartas-intencion.json'), 'utf8'));
  const formato = /^\d{3}\s*[-–—]\s*\d{1,6}\/\d{4}\s*[-–—]\s*\d{1,2}$/;
  const valido = inicial.expedientes.find((e) => formato.test(e.nro_expediente));
  const legacy = inicial.expedientes.find((e) =>
    !/^\d{3}-\d{1,6}\/\d{4}-\d{1,2}$/.test(e.nro_expediente) &&
    inicial.expedientes.filter((x) => x.nombre_empresa === e.nombre_empresa).length === 1);
  const store = JSON.parse(JSON.stringify(inicial));
  // Dos vencidos en rojo con fechas distintas: el de 2020 tiene que ir primero.
  const vencidoViejo = { id: 'exp_rojo_2020', nro_expediente: '999-00001/2020-0', nombre_empresa: 'ROJO DE 2020 S.A.',
    fecha_inicio: '01/01/2020', situacion: 'Sin_tratamiento', intervenciones: [] };
  const vencidoReciente = { id: 'exp_rojo_2025', nro_expediente: '999-00002/2025-0', nombre_empresa: 'ROJO DE 2025 S.A.',
    fecha_inicio: '01/06/2025', situacion: 'Sin_tratamiento', intervenciones: [] };
  store.expedientes.push(vencidoReciente, vencidoViejo);
  let sha = 'sha-0';
  const posts = [];

  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/api/version-cartas')) return json(200, { version: sha });
    if (req.url.startsWith('/api/sync-cartas')) {
      if (req.method === 'GET') return json(200, Object.assign({}, store, { _meta: { existe: true, sha } }));
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = JSON.parse(body);
        posts.push(p);
        if (p._baseSha && p._baseSha !== sha) return json(409, { error: 'conflicto', actual: Object.assign({}, store, { _meta: { existe: true, sha } }) });
        store.expedientes = p.expedientes;
        sha = 'sha-' + (posts.length + 1);
        json(200, { ok: true, sha });
      });
      return;
    }
    if (servirHeaderJs(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(8788, r));

  const problemas = [];
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  page.on('dialog', async (d) => { await d.dismiss(); });
  await page.goto('http://localhost:8788/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.app-fab');
  const modalTexto = () => page.locator('#modal').textContent();
  const modalAbierto = async () => !(await page.locator('#veil').evaluate((v) => v.hidden));

  // 3a) Alta con formato inválido: no se guarda y lo dice.
  await page.click('.app-fab');
  await page.waitForSelector('#f_nro_expediente');
  await page.fill('#f_nro_expediente', '123');
  await page.fill('#f_nombre_empresa', 'ALTA CON NRO MAL');
  await page.fill('#f_fecha_inicio', '2026-10-09');
  await page.click('#expForm button[type=submit]');
  await page.waitForTimeout(2000);
  ok((await modalTexto()).includes('Formato: 363-1254/2025-01'), 'un número mal formado se rechaza con el formato esperado');
  ok(posts.length === 0, 'y no sale ningún POST con ese número');

  // 3b) Alta con un número que ya existe, escrito con otros guiones y espacios.
  await page.fill('#f_nro_expediente', valido.nro_expediente.replace('-', ' – '));
  await page.click('#expForm button[type=submit]');
  await page.waitForTimeout(300);
  ok((await modalTexto()).includes('Ya existe un expediente con ese número'),
     'un número repetido se rechaza aunque venga con otros guiones o espacios');
  ok(posts.length === 0, 'y tampoco sale POST');

  // 3c) Editar un registro viejo con otra forma sin tocar su número: se guarda.
  // Quedó texto sin guardar del 3b: la × ahora pregunta con la tarjeta, y el
  // test elige «No guardar» para seguir con el registro viejo.
  await page.click('#xClose');
  await page.waitForTimeout(200);
  await page.click('.cc-card [data-opcion="descartar"]');
  await page.waitForTimeout(200);
  await page.locator('.exp-card', { hasText: legacy.nombre_empresa }).first().click();
  await page.click('#btnEdit');
  await page.waitForSelector('#f_nombre_empresa');
  await page.fill('#f_nombre_empresa', legacy.nombre_empresa + ' EDITADO');
  await page.click('#expForm button[type=submit]');
  await page.waitForTimeout(2200);
  ok(posts.length === 1 && posts[0].expedientes.some((e) => e.nombre_empresa === legacy.nombre_empresa + ' EDITADO' && e.nro_expediente === legacy.nro_expediente),
     'editar un expediente con número en otro formato guarda, sin tocar el número');

  // 5) Escape con texto sin guardar no cierra ni descarta.
  await page.click('.app-fab');
  await page.waitForSelector('#f_nombre_empresa');
  await page.fill('#f_nombre_empresa', 'TEXTO QUE NO SE PIERDE');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok(await modalAbierto(), 'Escape con texto sin guardar no cierra la ficha');
  ok(await page.isVisible('.cc-card'), 'Escape con texto sin guardar muestra la tarjeta «¿Desea guardar los cambios?»');
  ok((await page.inputValue('#f_nombre_empresa')) === 'TEXTO QUE NO SE PIERDE', 'y lo escrito sigue ahí');
  await page.click('.cc-card [data-opcion="seguir"]'); // seguir editando: no pierde nada
  await page.waitForTimeout(150);
  ok(await modalAbierto() && !(await page.isVisible('.cc-card')), 'Seguir editando deja la ficha abierta y cierra la tarjeta');
  await page.click('#xClose'); // la × pregunta de nuevo
  await page.waitForTimeout(150);
  await page.click('.cc-card [data-opcion="descartar"]'); // no guardar: descarte explícito
  await page.waitForTimeout(150);
  ok(!(await modalAbierto()), 'la × + «No guardar» descarta y cierra la ficha');

  // 4) Orden dentro del rojo: el vencido hace más tiempo va antes.
  await page.waitForSelector('#expList .exp-card');
  const nombres = await page.locator('#expList .exp-card').allTextContents();
  const iViejo = nombres.findIndex((t) => t.includes('ROJO DE 2020'));
  const iReciente = nombres.findIndex((t) => t.includes('ROJO DE 2025'));
  ok(iViejo >= 0 && iReciente >= 0 && iViejo < iReciente,
     'dentro del rojo, el vencido desde 2020 aparece antes que el de 2025');

  ok(problemas.length === 0, 'sin errores de JS' + (problemas.length ? ': ' + problemas.join(' | ') : ''));
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
// Proyectos: orden de la pantalla, filtros desplegables y configuración del
// semáforo con Guardar / Cancelar. Pedido del usuario (2026-10-20): el plazo
// sale del encabezado y vive en Análisis › Urgencias.
async function testProyectosLayoutYFiltros() {
  console.log('\n=== PROYECTOS: ORDEN DE LA PANTALLA, FILTROS Y CONFIGURACIÓN ===');
  const html = fs.readFileSync(path.join(RAIZ, 'public/proyectos.html'), 'utf8');
  const store = JSON.parse(fs.readFileSync(path.join(RAIZ, 'cartas-intencion.json'), 'utf8'));
  let sha = 'sha-fil-1';
  const posts = [];

  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/api/version-cartas')) return json(200, { version: sha });
    if (req.url.startsWith('/api/sync-cartas')) {
      if (req.method === 'GET') return json(200, Object.assign({}, store, { _meta: { existe: true, sha } }));
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = JSON.parse(body);
        posts.push(p);
        sha = 'sha-fil-' + (posts.length + 1);
        json(200, { ok: true, sha });
      });
      return;
    }
    if (servirHeaderJs(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(8788, r));

  const problemas = [];
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  await page.goto('http://localhost:8788/proyectos.html', { waitUntil: 'networkidle' });

  // Orden: título → búsqueda → pestañas → contenido.
  const orden = await page.evaluate(() => {
    const y = (sel) => document.querySelector(sel).getBoundingClientRect().top;
    return { titulo: y('.app-header__titulo'), busqueda: y('#busquedaListado'), pestanas: y('.app-tabs'), contenido: y('#viewList') };
  });
  ok(orden.titulo < orden.busqueda && orden.busqueda < orden.pestanas && orden.pestanas < orden.contenido,
    `el orden es título → búsqueda → pestañas → contenido (${JSON.stringify(orden)})`);

  // La búsqueda filtra el listado: se muestra solo en Listado.
  ok(await page.locator('#busquedaListado').isVisible(), 'la búsqueda se ve en el listado');
  await page.click('#tabArchivo');
  ok(!(await page.locator('#busquedaListado').isVisible()), 'la búsqueda se oculta en Archivo');
  await page.click('#tabList');
  ok(await page.locator('#busquedaListado').isVisible(), 'la búsqueda vuelve al listado');

  // Ningún control de plazo queda en el encabezado del listado.
  ok(await page.locator('#plazoDias').count() === 0 && await page.locator('.settings-row').count() === 0,
    'el plazo ya no está en el listado');

  // Filtros avanzados: cerrados por defecto, se abren desde el botón.
  ok(await page.locator('#filtrosPanel').isHidden(), 'los filtros avanzados arrancan plegados');
  ok((await page.getAttribute('#filtrosToggle', 'aria-expanded')) === 'false', 'el botón Filtros dice que está cerrado');
  await page.click('#filtrosToggle');
  ok(await page.locator('#filtrosPanel').isVisible(), 'el botón Filtros despliega el panel');
  ok((await page.getAttribute('#filtrosToggle', 'aria-expanded')) === 'true', 'el botón Filtros dice que está abierto');
  await page.selectOption('#filterSituacion', 'Adjudicada');
  ok((await page.textContent('#filtrosN')).trim() === '1', 'el botón muestra cuántos filtros hay puestos (1)');
  await page.click('#filtrosToggle');
  ok(await page.locator('#filtrosPanel').isHidden(), 'el botón Filtros vuelve a plegar el panel');
  ok((await page.textContent('#filtrosN')).trim() === '1', 'con el panel cerrado sigue viéndose el filtro puesto');
  await page.click('#filtrosToggle');
  await page.selectOption('#filterSituacion', '');

  // Configuración en Análisis › Urgencias: nada se aplica sin Guardar.
  await page.click('#tabDash');
  await page.click('[data-sec="urgencias"]');
  const original = await page.inputValue('#uPlazo');
  const nuevo = original === '45' ? '60' : '45';
  await page.fill('#uPlazo', nuevo);
  ok((await page.evaluate(() => localStorage.getItem('cartas_intencion_plazo_v1'))) !== nuevo,
    'cambiar el plazo sin Guardar no lo aplica');
  await page.click('#cfgCancelar');
  ok((await page.inputValue('#uPlazo')) === original, 'Cancelar vuelve el plazo al valor guardado');

  await page.fill('#uPlazo', nuevo);
  await page.click('#cfgGuardar');
  ok((await page.evaluate(() => localStorage.getItem('cartas_intencion_plazo_v1'))) === nuevo,
    `Guardar aplica el plazo (${nuevo} días hábiles)`);
  // La subida va en background, con debounce: se espera a que llegue al servidor.
  for (let i = 0; i < 40 && !posts.some((p) => p.plazoDias === Number(nuevo)); i++) await page.waitForTimeout(150);
  ok(posts.some((p) => p.plazoDias === Number(nuevo)), 'el plazo guardado llega al servidor en el POST');

  ok(problemas.length === 0, 'sin errores de JS (' + problemas.join(' | ') + ')');
  await browser.close();
  server.close();
}

/* Escala tipográfica de la ficha de Proyectos (design-system.css, --ds-text-*).
   Se mide en el navegador: el CSS puede declarar un token y la página no usarlo.
   Lo que se exige: el primer panel (empresa + número de expediente) a 16px y
   alineado al mismo borde izquierdo, subtítulos 14 y el resto de la ficha 13,
   nunca otro tamaño; rótulos en negrita; respuestas en el gris global (--muted).
   El primer panel queda fuera de la escala 14/13 a propósito: es un pedido
   explícito del usuario (2026-10-21), anotado acá para que no se "corrija". */
async function testProyectosEscalaFicha(viewport) {
  console.log(`\n=== PROYECTOS: ESCALA TIPOGRÁFICA DE LA FICHA (${viewport.nombre}) ===`);
  const html = fs.readFileSync(path.join(RAIZ, 'public/proyectos.html'), 'utf8');
  const store = JSON.parse(fs.readFileSync(path.join(RAIZ, 'cartas-intencion.json'), 'utf8'));
  const sha = 'sha-escala-1';

  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/api/version-cartas')) return json(200, { version: sha });
    if (req.url.startsWith('/api/sync-cartas')) return json(200, Object.assign({}, store, { _meta: { existe: true, sha } }));
    if (servirHeaderJs(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(8789, r));

  const problemas = [];
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: viewport.ancho, height: viewport.alto } });
  page.on('pageerror', (e) => problemas.push('pageerror: ' + e.message));
  await page.goto('http://localhost:8789/proyectos.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.exp-card').length > 0);
  await page.locator('.exp-card').first().click();
  await page.waitForSelector('#modal .view-section');

  const medidas = await page.evaluate(() => {
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    const probe = document.createElement('i');
    probe.style.color = 'var(--muted)';
    document.body.appendChild(probe);
    const grisGlobal = getComputedStyle(probe).color;
    probe.remove();

    // Todo texto del cuerpo de la ficha. El primer panel va aparte: tiene su
    // propio tamaño (16px) pedido por el usuario.
    const zonas = ['.view-section', '.hist'];
    const tamanos = new Set();
    const fuera = [];
    for (const z of zonas) {
      document.querySelectorAll('#modal ' + z + ', #modal ' + z + ' *').forEach((el) => {
        const tieneTexto = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!tieneTexto) return;
        const st = getComputedStyle(el);
        tamanos.add(st.fontSize);
        if (!['14px', '13px'].includes(st.fontSize)) fuera.push(el.className + ' ' + st.fontSize);
      });
    }
    const head = document.querySelector('#modal .view-head');
    const empresa = document.querySelector('#modal .view-empresa');
    const nro = document.querySelector('#modal .view-exp');
    return {
      grisGlobal,
      // Qué hay en el primer panel, además de los dos textos pedidos: cualquier
      // badge, pastilla de urgencia o fecha de archivado contaría acá.
      headExtra: [...head.querySelectorAll('*')]
        .filter((el) => !el.matches('.view-empresa, .view-exp'))
        .map((el) => el.className || el.tagName),
      headTexto: head.textContent.replace(/\s+/g, ' ').trim(),
      headIzquierda: Math.abs(empresa.getBoundingClientRect().left - nro.getBoundingClientRect().left),
      empresa: { size: cs('#modal .view-empresa').fontSize, weight: cs('#modal .view-empresa').fontWeight },
      nro: { size: cs('#modal .view-exp').fontSize },
      // El cartel "SISTEMA" de las notas automáticas se sacó (2026-10-21).
      sys: document.querySelectorAll('#modal .hist .sys').length,
      histTexto: document.querySelector('#modal .hist').textContent,
      subtitulo: { size: cs('#modal .view-section h3').fontSize, weight: cs('#modal .view-section h3').fontWeight },
      rotulo: { size: cs('#modal .view-item label').fontSize, weight: cs('#modal .view-item label').fontWeight },
      respuesta: { size: cs('#modal .view-item .v').fontSize, color: cs('#modal .view-item .v').color },
      nota: { size: cs('#modal .hist-text').fontSize, lh: cs('#modal .hist-text').lineHeight, color: cs('#modal .hist-text').color },
      tamanos: [...tamanos],
      fuera,
    };
  });

  ok(medidas.empresa.size === '16px' && medidas.empresa.weight === '700' && medidas.nro.size === '16px',
    `primer panel: empresa y número de expediente a 16px (${medidas.empresa.size}/${medidas.empresa.weight} y ${medidas.nro.size})`);
  ok(medidas.headIzquierda === 0,
    `primer panel: las dos líneas arrancan en el mismo borde izquierdo (diferencia ${medidas.headIzquierda}px)`);
  ok(medidas.headExtra.length === 0,
    `primer panel: solo el nombre de la empresa y el número, nada más (sobra: ${medidas.headExtra.join(' | ') || 'nada'})`);
  ok(!/d háb|Archivado|Sin tratamiento|En tratamiento/.test(medidas.headTexto),
    `primer panel: sin situación, plazo ni fecha de archivado (dice: "${medidas.headTexto}")`);
  ok(medidas.subtitulo.size === '14px' && medidas.subtitulo.weight === '700', `subtítulo de sección: 14px en negrita (${medidas.subtitulo.size}/${medidas.subtitulo.weight})`);
  ok(medidas.rotulo.size === '13px' && medidas.rotulo.weight === '700', `rótulo (Parque, Rubro…): 13px en negrita (${medidas.rotulo.size}/${medidas.rotulo.weight})`);
  ok(medidas.respuesta.size === '13px' && medidas.respuesta.color === medidas.grisGlobal,
    `respuesta: 13px en el gris global (${medidas.respuesta.size}, ${medidas.respuesta.color} vs ${medidas.grisGlobal})`);
  ok(medidas.nota.size === '13px' && medidas.nota.lh === '18px' && medidas.nota.color === medidas.grisGlobal,
    `texto de nota: 13px, alto 18px, gris global (${medidas.nota.size}/${medidas.nota.lh})`);
  ok(medidas.fuera.length === 0 && medidas.tamanos.every((t) => ['14px', '13px'].includes(t)),
    `ningún texto del cuerpo de la ficha sale de la escala 14/13 (encontrados: ${medidas.tamanos.join(', ')}; fuera: ${medidas.fuera.join(' | ') || 'ninguno'})`);
  ok(medidas.sys === 0 && !/SISTEMA/i.test(medidas.histTexto),
    `las notas no llevan el cartel "SISTEMA" (${medidas.sys} encontrados)`);

  ok(problemas.length === 0, 'sin errores de JS (' + problemas.join(' | ') + ')');
  await browser.close();
  server.close();
}

/* La misma escala (design-system.css, --ds-text-*) en las otras tres fichas.
   Cada chequeo mide un elemento real de la pantalla; si el selector no
   existe, el test falla: no hay forma de "pasar" una ficha que no se abrió. */
const ESCALA_NIVELES = {
  titulo:    { size: '18px', weight: '700', color: 'text' },
  subtitulo: { size: '14px', weight: '700', color: 'text' },
  rotulo:    { size: '13px', weight: '700', color: 'text' },
  respuesta: { size: '13px', weight: '400', color: 'muted' },
  info:      { size: '13px', weight: '400', color: 'muted' },
};

async function verificarEscala(page, pantalla, chequeos, zonas) {
  const medidas = await page.evaluate(({ chequeos, zonas }) => {
    const color = (v) => { const p = document.createElement('i'); p.style.color = `var(--${v})`; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; };
    const colores = { text: color('text'), muted: color('muted') };
    const elementos = chequeos.map((c) => {
      const el = document.querySelector(c.sel);
      if (!el) return { nombre: c.nombre, ausente: true };
      const st = getComputedStyle(el);
      return { nombre: c.nombre, nivel: c.nivel, size: st.fontSize, weight: st.fontWeight, color: st.color };
    });
    // Ningún texto propio de la zona sale de la escala. Botones, badges y
    // avisos de urgencia tienen sus propios componentes: quedan afuera.
    const tamanos = new Set();
    const fuera = [];
    for (const z of zonas) {
      document.querySelectorAll(z + ' *, ' + z).forEach((el) => {
        // El avatar (iniciales) es un componente con su propio tamaño, como los badges.
        if (el.closest('.btn, .badge, .urg, .view-actions, .expediente-actions, .modal-head, .avatar')) return;
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return;
        const fs = getComputedStyle(el).fontSize;
        tamanos.add(fs);
        if (!['18px', '14px', '13px'].includes(fs)) fuera.push((el.className || el.tagName) + ' ' + fs);
      });
    }
    return { colores, elementos, tamanos: [...tamanos], fuera };
  }, { chequeos, zonas });

  for (const e of medidas.elementos) {
    if (e.ausente) { ok(false, `${pantalla}: ${e.nombre} existe en la ficha`); continue; }
    const esperado = ESCALA_NIVELES[e.nivel];
    const colorOk = e.color === medidas.colores[esperado.color];
    ok(e.size === esperado.size && e.weight === esperado.weight && colorOk,
      `${pantalla}: ${e.nombre} es ${esperado.size}/${esperado.weight} en ${esperado.color === 'muted' ? 'gris' : 'texto'} (${e.size}/${e.weight}, ${e.color})`);
  }
  ok(medidas.fuera.length === 0,
    `${pantalla}: ningún texto de la ficha sale de la escala 18/14/13 (encontrados: ${medidas.tamanos.join(', ')}; fuera: ${medidas.fuera.join(' | ') || 'ninguno'})`);
}

async function testEscalaOtrasFichas() {
  console.log('\n=== ESCALA TIPOGRÁFICA: RESOLUCIONES, PARQUES Y SEGUIMIENTO ===');
  const problemas = [];
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // Resoluciones: ficha de una resolución.
  {
    const html = fs.readFileSync(path.join(RAIZ, 'public/resoluciones.html'), 'utf8');
    const datos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'resoluciones.json'), 'utf8'));
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(datos)); }
      if (servirHeaderJs(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise((r) => server.listen(8782, r));
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', (e) => problemas.push('resoluciones: ' + e.message));
    await page.goto('http://localhost:8782/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('.res-card').length > 0);
    await page.locator('.res-card').first().click();
    await page.waitForSelector('#modal .view-texto');
    await verificarEscala(page, 'Resoluciones', [
      { nombre: 'título (N° de resolución)', sel: '#modal .view-title', nivel: 'titulo' },
      { nombre: 'subtítulo (Datos)', sel: '#modal .view-section h3', nivel: 'subtitulo' },
      { nombre: 'rótulo (Tema)', sel: '#modal .view-item label', nivel: 'rotulo' },
      { nombre: 'respuesta (valor del dato)', sel: '#modal .view-item .v', nivel: 'respuesta' },
      { nombre: 'texto resolutivo', sel: '#modal .view-texto', nivel: 'info' },
    ], ['#modal .view-head', '#modal .view-section']);
    await page.close();
    server.close();
  }

  // Parques: ficha de empresa (Empresa) y ficha de lote.
  {
    const html = fs.readFileSync(path.join(RAIZ, 'public/parques.html'), 'utf8');
    const datos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'parques.json'), 'utf8'));
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api/')) {
        if (req.method === 'POST') { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(datos));
      }
      if (servirHeaderJs(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise((r) => server.listen(8783, r));
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', (e) => problemas.push('parques: ' + e.message));
    await page.goto('http://localhost:8783/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('#empresasList .ui-card').length > 0);

    await page.locator('#empresasList .ui-card', { hasText: 'AGSOF S.A' }).first().click();
    await page.waitForSelector('#btnEditEmp');
    await verificarEscala(page, 'Parques (empresa)', [
      { nombre: 'título (nombre de la empresa)', sel: '#modal .view-title', nivel: 'titulo' },
      { nombre: 'rótulo (Representante)', sel: '#modal .info-row dt', nivel: 'rotulo' },
      { nombre: 'respuesta (dato de la empresa)', sel: '#modal .info-row dd', nivel: 'respuesta' },
    ], ['#modal .view-head', '#modal .info-list']);
    await page.click('#xCloseViewEmp');
    await page.waitForTimeout(200);

    await page.click('#tabComercial');
    await page.waitForSelector('[data-open-lote]');
    await page.locator('[data-open-lote]').first().click();
    await page.waitForSelector('#modal .view-section h3');
    await verificarEscala(page, 'Parques (lote)', [
      { nombre: 'título (N° de lote)', sel: '#modal .view-title', nivel: 'titulo' },
      { nombre: 'subtítulo (Ubicación)', sel: '#modal .view-section h3', nivel: 'subtitulo' },
      { nombre: 'rótulo (Manzana)', sel: '#modal .view-item label', nivel: 'rotulo' },
      { nombre: 'respuesta (valor del lote)', sel: '#modal .view-item .v', nivel: 'respuesta' },
    ], ['#modal .view-head', '#modal .view-section']);
    await page.close();
    server.close();
  }

  // Seguimiento: tarjeta expandida, con notas.
  {
    const ctx = levantarServer(8781);
    await new Promise((r) => ctx.server.listen(8781, r));
    ctx.ctl.datos = { expedientes: [{ id: 'esc', numero: '363-9/2026-01', tema: 'Tema de prueba de escala', area: 'Jurídica', responsable: 'Ana', estado: 'activo', intervenciones: [{ hora: '20/10/2026 13:44', texto: 'Nota de prueba para medir la escala de la tarjeta.', tipo: 'nota' }], fechaInicio: '2099-01-05', diasPlazo: 30 }], areas: ['Jurídica'], responsables: ['Ana'] };
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', (e) => problemas.push('seguimiento: ' + e.message));
    await page.goto('http://localhost:8781/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.expediente-header-urgencia');
    await page.locator('.expediente-header-urgencia').first().click();
    await page.waitForSelector('.nota-texto');
    await verificarEscala(page, 'Seguimiento (tarjeta)', [
      { nombre: 'título (tema)', sel: '.expediente-expanded-tema', nivel: 'titulo' },
      { nombre: 'subtítulo (Notas)', sel: '.notas-header', nivel: 'subtitulo' },
      { nombre: 'rótulo (Inicio:)', sel: '.expediente-expanded-dates .label', nivel: 'rotulo' },
      { nombre: 'respuesta (fecha de inicio)', sel: '.expediente-expanded-dates > div > span:last-child', nivel: 'respuesta' },
      { nombre: 'fecha de la nota', sel: '.nota-hora', nivel: 'info' },
      { nombre: 'texto de la nota', sel: '.nota-texto', nivel: 'info' },
    ], ['.expediente-expanded-tema', '.expediente-expanded-meta', '.expediente-expanded-dates', '.expediente-notas-section']);
    await page.close();
    ctx.server.close();
  }

  ok(problemas.length === 0, 'sin errores de JS (' + problemas.join(' | ') + ')');
  await browser.close();
}

async function testParques(viewport, puerto) {
  console.log(`\n=== PARQUES (${viewport.width}x${viewport.height}) ===`);
  const html = fs.readFileSync(path.join(RAIZ, 'public/parques.html'), 'utf8');
  const datos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'parques.json'), 'utf8'));
  let ultimoPost = null;
  let posts = 0;

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          ultimoPost = JSON.parse(body);
          posts++;
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
  await page.waitForFunction(() => document.querySelectorAll('#empresasList .ui-card').length > 0);

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
  // 139 desde el 2026-10-19: guemes_normalizado trajo un lote que no estaba
  // (en el origen «L40», sin el relleno de ceros, y por eso no chocaba con
  // L040, que es otro lote: CERÁMICA SALTEÑA contra CRAYÓN S.R.L).
  ok(lotesGuemes.length === 139, `el archivo trae los ${lotesGuemes.length} lotes reales de Güemes`);
  // Piso, no cifra: las bajas hechas desde la app cambian el número a
  // propósito. EGPAIS salió el 2026-10-19 en un sync de la propia app (53
  // hoy). El conteo que pinta la pantalla se compara contra este archivo más
  // abajo (#empresasCount), así que no hace falta fijarlo acá.
  ok(empresasGuemes.length >= 50, `el archivo trae las ${empresasGuemes.length} empresas reales de Güemes`);
  const posta = datos.empresas.find((e) => /AGROCONSTRUCCIONES LA POSTA/i.test(e.nombre_empresa || ''));
  ok(!!posta && posta.id_parque === 'guemes', 'AGROCONSTRUCCIONES LA POSTA está cargada en Güemes');
  ok(['L115', 'L116'].every((id) =>
       (datos.lotes.find((l) => l.id_lote === id) || {}).id_empresa === posta.id_empresa),
     'L115 y L116 vuelven a estar a nombre de LA POSTA, no libres');
  ok(lotesSalta.length === 135, `el archivo trae los ${lotesSalta.length} lotes reales del Parque Industrial Salta`);
  ok(datos.parques.map((p) => p.nombre).join('|') === 'Güemes|Salta',
     'los dos parques se llaman por su nombre corto en el archivo');
  // 150 desde el 2026-10-19: 136 del origen + 15 ocupantes de la columna
  // «Alquilada» - ADMINISTRACION PARQUE INDUSTRIAL SALTA (A.P.I.S), que el
  // usuario borró desde la app y la fusión de los exports había conservado
  // (no figuraba en el export, así que se tomó como "dato que el export no
  // trae" en vez de como una baja hecha a mano; no era titular de ningún
  // lote ni parte de ninguna ocupación).
  ok(empresasSalta.length === 150,
     `el archivo trae las ${empresasSalta.length} empresas de Salta (136 del origen + 15 ocupantes de la columna «Alquilada», menos la baja de A.P.I.S)`);
  ok(!datos.empresas.some((e) => /ADMINISTRACION PARQUE INDUSTRIAL SALTA/i.test(e.nombre_empresa || '')),
     'la empresa que el usuario borró no volvió a aparecer en los datos');
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

  // ======================================================================
  // El filtro de situación tiene que FILTRAR, en los dos parques
  // ======================================================================
  // Hasta el 2026-10-19 esto solo verificaba que la opción "Todos los
  // estados" existiera, y por eso pasó en verde un desplegable que en
  // Güemes estaba deshabilitado (sus 53 empresas tenían `situacion: null`,
  // el dato había quedado en el estado de los lotes). La cuenta esperada se
  // calcula acá contra el archivo, con la misma regla pero escrita aparte.
  const situacionEsperada = (e) => {
    if (e.situacion) return e.situacion;
    const estados = datos.lotes.filter((l) => l.id_empresa === e.id_empresa).map((l) => l.estado);
    // "Alquilada" describe al LOTE, no dice si su titular sigue operando.
    return ['Activa', 'En construcción', 'Sin actividad'].find((x) => estados.includes(x)) || null;
  };
  for (const [parque, empresasDel] of [['guemes', empresasGuemes], ['salta', empresasSalta]]) {
    await page.locator(`#parqueSwitch [data-parque="${parque}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('#empresasList .ui-card').length > 0);
    const opciones = await page.locator('#filterEstadoEmpresas option').evaluateAll((os) =>
      os.map((o) => o.value).filter(Boolean));
    const presentes = ['Activa', 'Sin actividad', 'En construcción']
      .filter((x) => empresasDel.some((e) => situacionEsperada(e) === x));
    ok(opciones.join('|') === presentes.join('|'),
       `${parque}: el filtro ofrece las situaciones que el parque realmente tiene (${presentes.join(', ') || 'ninguna'})`);
    ok(!(await page.locator('#filterEstadoEmpresas').isDisabled()),
       `${parque}: el filtro de situación está habilitado`);
    for (const valor of presentes) {
      await page.selectOption('#filterEstadoEmpresas', valor);
      await page.waitForTimeout(120);
      const esperadas = empresasDel.filter((e) => situacionEsperada(e) === valor).length;
      ok((await page.locator('#empresasList .ui-card').count()) === esperadas,
         `${parque}: filtrar por "${valor}" deja las ${esperadas} empresas que corresponden`);
    }
    await page.selectOption('#filterEstadoEmpresas', '');
    await page.waitForTimeout(120);
    ok((await page.locator('#empresasList .ui-card').count()) === empresasDel.length,
       `${parque}: volver a "Todos los estados" muestra las ${empresasDel.length} empresas otra vez`);
  }

  // Un filtro guardado que no existe en este parque no puede dejar la lista
  // recortada mientras el desplegable dice "Todos los estados": se ve como
  // "el filtro no funciona" y no hay forma de sacarlo desde la pantalla.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('parques_crm_v1'));
    s.parqueActivo = 'guemes';
    s.filterSituacionEmpresas = 'Una situación que no existe';
    localStorage.setItem('parques_crm_v1', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('#empresasList .ui-card').length > 0);
  ok((await page.locator('#empresasList .ui-card').count()) === empresasGuemes.length,
     'un filtro guardado que este parque no ofrece se descarta en vez de recortar la lista a ciegas');

  // El chip es una etiqueta corta al lado de "Güemes" (pedido del usuario
  // 2026-10-19): el nombre largo ocupaba la fila entera.
  ok((await page.locator('#parqueSwitch [data-parque="salta"]').textContent()).replace(/\d+/g, '').trim() === 'Salta',
     'el chip del segundo parque dice "Salta", no el nombre largo');

  // Elegir parque es estado de pantalla. Si marca cambio pendiente, cada
  // toque sube el archivo entero y deja un commit en el repo: seis toques
  // daban seis commits y 1,4 MB subidos sin que nadie hubiera editado nada.
  const postsAntes = posts;
  for (let i = 0; i < 2; i++) {
    await page.locator('#parqueSwitch [data-parque="salta"]').click();
    await page.waitForTimeout(250);
    await page.locator('#parqueSwitch [data-parque="guemes"]').click();
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(400);
  ok(posts === postsAntes, `cambiar de parque no dispara ningún POST (${posts - postsAntes} en 4 cambios)`);

  // Escape cierra la ficha, igual que en Seguimiento y Proyectos: hasta el
  // 2026-10-19 acá la única salida era la × o el clic afuera.
  await page.locator('#empresasList .ui-card').first().click();
  await page.waitForSelector('#btnEditEmp');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok(await page.locator('#veil').isHidden(), 'Escape cierra la ficha abierta');

  // Búsqueda por empresa — AGSOF S.A. ya no debe aparecer duplicada.
  await page.fill('#searchEmpresas', 'AGSOF');
  await page.waitForTimeout(150);
  const esperadoAgsof = datos.empresas.filter((e) => e.nombre_empresa.toUpperCase().includes('AGSOF')).length;
  ok(esperadoAgsof === 1, 'AGSOF S.A. quedó fusionada en un solo registro en los datos');
  ok((await page.locator('#empresasList .ui-card').count()) === esperadoAgsof,
     `la búsqueda encuentra ${esperadoAgsof} tarjeta de AGSOF (sin duplicado)`);
  await page.fill('#searchEmpresas', '');
  await page.waitForTimeout(150);

  // Ficha de empresa: tab Empresa — Representante, Cargo, Rubro, Situación,
  // en ese orden, con el contacto real de la empresa instalada. Actividad,
  // CUIT y Observación salieron de la tarjeta el 2026-10-19 (pedido del
  // usuario): AGSOF sirve de caso porque SÍ tiene `observacion` cargada
  // (la nota de la fusión con E004), así que si el bloque volviera, este
  // test lo ve.
  await page.locator('#empresasList .ui-card', { hasText: 'AGSOF S.A' }).first().click();
  await page.waitForSelector('#btnEditEmp');
  const fichaEmpresa = await page.locator('#modal').textContent();
  ok(fichaEmpresa.includes('Guillermo Frisch'), 'la ficha de la empresa muestra su contacto (Representante)');
  ok(fichaEmpresa.includes('Encargado'), 'la ficha de la empresa muestra el Cargo');
  const ordenCampos = ['Representante', 'Cargo', 'Rubro', 'Situación']
    .map((campo) => fichaEmpresa.indexOf(campo));
  ok(ordenCampos.every((i, idx) => idx === 0 || i > ordenCampos[idx - 1]),
     'el tab Empresa respeta el orden Representante/Cargo/Rubro/Situación');
  ok(!/Actividad|CUIT|Observación/.test(fichaEmpresa),
     'la tarjeta de empresa ya no muestra Actividad, CUIT ni Observación');
  ok(!fichaEmpresa.includes('Fusionada el 2026-10-13'),
     'el texto de la observación no se filtra por otra vía a la tarjeta');
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
  // Un campo con dos o tres valores pegados daba un link roto: "mailto:" +
  // las tres direcciones juntas no abre nada, y tel: concatenaba los dígitos
  // de los dos teléfonos en un número de 20 que marcaba cualquier cosa — el
  // peor de los dos, porque parecía funcionar. Se verifica contra una
  // empresa real del archivo, no contra un caso inventado.
  const conDosMails = datos.empresas.find((e) => delParque(e, 'guemes') && (e.mail || '').split('@').length > 2);
  const conDosTels = datos.empresas.find((e) => delParque(e, 'guemes') && /[|;/\n]/.test(e.telefono || ''));
  ok(!!conDosMails && !!conDosTels, 'el archivo sigue teniendo los casos de dos mails y dos teléfonos en un campo');
  for (const [emp, campo, etiqueta] of [[conDosMails, 'mail', 'Email'], [conDosTels, 'telefono', 'Teléfono']]) {
    await page.click('#xCloseViewEmp');
    await page.fill('#searchEmpresas', emp.nombre_empresa);
    await page.waitForTimeout(200);
    await page.locator('#empresasList .ui-card').first().click();
    await page.waitForSelector('#btnEditEmp');
    await page.click('[data-subtab="contacto"]');
    const fila = page.locator('#empSubpanel .contact-row', { hasText: emp[campo].slice(0, 18) }).first();
    ok((await fila.textContent()).includes(emp[campo]),
       `${etiqueta}: se siguen mostrando los dos valores, el dato no se toca`);
    const href = await fila.getAttribute('href');
    if (campo === 'mail') {
      const primero = emp.mail.match(/[^\s|;,/<>()]+@[^\s|;,/<>()]+/)[0];
      ok(href === `mailto:${primero}`,
         `el mail enlaza a una sola dirección (${href}), no a las ${emp.mail.split('@').length - 1} pegadas`);
    } else {
      const digitos = (href || '').replace(/\D/g, '');
      ok(digitos.length > 0 && digitos.length <= 13,
         `el teléfono enlaza a un número solo (${href}), no a los dos concatenados`);
      ok(emp.telefono.replace(/\D/g, '').startsWith(digitos),
         'el número enlazado es el primero del campo, no un invento');
    }
  }
  // Un valor que existe pero del que no sale un link ("no", "5000") queda
  // como texto, nunca como <a href="">.
  const mailFalso = datos.empresas.find((e) => delParque(e, 'guemes') && e.mail && !e.mail.includes('@'));
  if (mailFalso) {
    await page.click('#xCloseViewEmp');
    await page.fill('#searchEmpresas', mailFalso.nombre_empresa);
    await page.waitForTimeout(200);
    await page.locator('#empresasList .ui-card').first().click();
    await page.waitForSelector('#btnEditEmp');
    await page.click('[data-subtab="contacto"]');
    ok((await page.locator('#empSubpanel a[href=""]').count()) === 0,
       `un "mail" que no es un mail (${mailFalso.mail}) no deja un link vacío`);
  }
  await page.click('#xCloseViewEmp');
  await page.fill('#searchEmpresas', 'AGSOF S.A');
  await page.waitForTimeout(200);
  await page.locator('#empresasList .ui-card').first().click();
  await page.waitForSelector('#btnEditEmp');
  await page.click('[data-subtab="contacto"]');
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

  // El formulario de empresa tampoco pide los tres campos. No es cosmética:
  // mientras los inputs existieran, onSaveEmpresa escribía
  // actividad/cuit = "" en cada guardado (los recreaba después de que la
  // fusión de los exports los sacó) y, al sacar solo el textarea, habría
  // pisado con "" la observación que es la procedencia de los 15 ocupantes
  // de alquiler. Se guarda y se mira el POST, no el formulario.
  await page.click('#btnEditEmp');
  await page.waitForSelector('#f_nombre_empresa');
  ok((await page.locator('#f_actividad').count()) === 0
     && (await page.locator('#f_cuit').count()) === 0
     && (await page.locator('#f_observacion').count()) === 0,
     'el formulario de empresa no pide Actividad, CUIT ni Observación');
  await page.click('#empresaForm button[type=submit]');
  await page.waitForTimeout(300);
  const agsofPost = ultimoPost?.empresas?.find((e) => e.id_empresa === 'E003');
  ok(agsofPost && !('actividad' in agsofPost) && !('cuit' in agsofPost),
     'guardar una empresa no vuelve a crear actividad ni cuit');
  ok(agsofPost && /Fusionada el 2026-10-13/.test(agsofPost.observacion || ''),
     'guardar una empresa no borra la observación que ya tenía cargada');
  // onSaveEmpresa ya cerró la ficha al guardar.

  // Sublocación: L038 tiene una ocupación vigente (titular E008/ALISAN,
  // ocupante E028) — se revisa entrando por la ficha de la empresa titular,
  // ya que el lote en sí no tiene una pestaña propia fuera de "Comercial".
  const alisan = datos.empresas.find((e) => e.id_empresa === 'E008');
  await page.fill('#searchEmpresas', alisan.nombre_empresa);
  await page.waitForTimeout(150);
  await page.locator('#empresasList .ui-card', { hasText: alisan.nombre_empresa }).first().click();
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
  // _baseSha es protocolo (la versión del servidor sobre la que se editó), no estado de UI.
  const camposPermitidos = ['parques', 'empresas', 'lotes', 'ocupaciones', 'reservas', 'eliminados', '_baseSha'];
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
  await page.waitForSelector('#comercialList .ui-card');
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
  await page.locator('#comercialList .ui-card').first().click();
  await page.waitForSelector('#btnEditLote');
  ok((await page.locator('#modal').textContent()).includes('Titularidad'),
     'un lote comercial abre la misma ficha de lote (con su sección Titularidad)');
  await page.click('#xCloseViewLote');

  // "Análisis" está en stand by hasta definir los KPIs (DASH_STANDBY en
  // parques.html). Se verifica que la pestaña no se vea y que un #dashboard
  // viejo —un favorito, el historial— caiga en Empresas en vez de dejar la
  // pantalla vacía. El dashboard en sí no se prueba: el código sigue ahí pero
  // no hay forma de llegar, y cuando se reactive este bloque vuelve a ser la
  // prueba de KPIs de arriba.
  ok(await page.locator('#tabDash').isHidden(), 'la pestaña Análisis está oculta (stand by)');
  await page.evaluate(() => { location.hash = '#dashboard'; });
  await page.waitForSelector('#empresasList .ui-card');
  ok(await page.locator('#viewDash').isHidden() && await page.locator('#viewEmpresas').isVisible(),
     'un #dashboard viejo cae en Empresas, no en una pantalla vacía');
  await page.evaluate(() => { location.hash = '#empresas'; });
  await page.waitForSelector('#empresasList .ui-card');

  // ======================================================================
  // Columna «Alquilada»: titularidad y ocupación son dos vínculos distintos
  // ======================================================================
  // El caso de referencia es SL010: el lote es de LABORATORIO TECNIMETER
  // (matrícula 100312, escriturada) y lo ocupa TRADELOG. En la planilla de
  // origen los mails de tradelog.com.ar estaban cargados sobre la fila del
  // titular, que es exactamente la confusión que hay que no repetir.
  await page.locator('#parqueSwitch [data-parque="salta"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#empresasList .ui-card').length > 0);
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
  await page.locator('#empresasList .ui-card', { hasText: titularSL010.nombre_empresa }).first().click();
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
  ok((await page.locator('#empresasList .ui-card', { hasText: 'TRADELOG' }).first().textContent())
       .includes('Ocupa 1 lote por alquiler'),
     'la tarjeta de una empresa sin lotes propios dice qué ocupa, en vez de "0 m² totales"');
  await page.locator('#empresasList .ui-card', { hasText: 'TRADELOG' }).first().click();
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

  // Un lote puede tener varias matrículas y la ficha mostraba UNA. No es un
  // detalle de presentación: en SL009 las dos matrículas tienen distinto
  // titular y distinta escritura, así que la ficha afirmaba "Escritura: Sí,
  // propietario Sanabria Salmón" sobre un lote cuya otra mitad es del Ente y
  // no está escriturada. Se prueban los tres casos que existen en los datos.
  const abrirLoteDeSalta = async (idLote) => {
    const emp = datos.lotes.find((l) => l.id_lote === idLote).id_empresa;
    const nombre = datos.empresas.find((e) => e.id_empresa === emp).nombre_empresa;
    await page.fill('#searchEmpresas', nombre);
    await page.waitForTimeout(200);
    await page.locator('#empresasList .ui-card').first().click();
    await page.waitForSelector('#btnEditEmp');
    await page.click('[data-subtab="lote"]');
    await page.click(`[data-goto-lote="${idLote}"]`);
    await page.waitForSelector('#btnEditLote');
  };
  const cerrarLote = async () => {
    await page.click('#xCloseViewLote');
    await page.fill('#searchEmpresas', '');
    await page.waitForTimeout(150);
  };

  // (a) Dos matrículas que NO coinciden entre sí.
  const sl009 = datos.lotes.find((l) => l.id_lote === 'SL009');
  ok(sl009.matriculas.length === 2, 'SL009 sigue siendo el caso de dos matrículas en conflicto');
  await abrirLoteDeSalta('SL009');
  const fichaSL009 = (await page.locator('#modal').textContent()).replace(/\s+/g, ' ');
  for (const m of sl009.matriculas) {
    ok(fichaSL009.includes(String(m.matricula)), `la ficha muestra la matrícula ${m.matricula}, no solo la primera`);
    ok(fichaSL009.includes(m.titulares[0]), `la ficha muestra el titular de ${m.matricula} (${m.titulares[0]})`);
  }
  ok(/Escritura:? Sí/.test(fichaSL009) && /Escritura:? No/.test(fichaSL009),
     'cada matrícula lleva su propio estado de escritura (una Sí y otra No en el mismo lote)');
  ok(fichaSL009.includes('Según matrícula'),
     'el resumen del lote no afirma una escritura ni un propietario únicos cuando las matrículas difieren');
  ok(/no coinciden entre sí en titular y escritura/.test(fichaSL009),
     'la ficha avisa que el lote no es de una sola propiedad');
  ok(fichaSL009.includes('2 matrículas'), 'el encabezado dice cuántas matrículas tiene, en vez de nombrar una');
  await cerrarLote();

  // (b) Cuatro matrículas que SÍ coinciden: se listan igual, pero sin aviso
  //     ni "Según matrícula" — si no, el aviso perdería significado.
  await abrirLoteDeSalta('SL005');
  const fichaSL005 = (await page.locator('#modal').textContent()).replace(/\s+/g, ' ');
  ok(fichaSL005.includes('4 matrículas') &&
     datos.lotes.find((l) => l.id_lote === 'SL005').matriculas.every((m) => fichaSL005.includes(String(m.matricula))),
     'SL005 lista sus 4 matrículas');
  ok(!fichaSL005.includes('Según matrícula') && !/no coinciden entre sí/.test(fichaSL005),
     'con todas las matrículas coincidentes no se avisa nada y el resumen da el valor');
  await cerrarLote();

  // (c) Una sola matrícula: la ficha queda exactamente como estaba, sin una
  //     sección "Matrículas (1)" repitiendo el dato de arriba.
  await abrirLoteDeSalta('SL001');
  const fichaSL001 = (await page.locator('#modal').textContent()).replace(/\s+/g, ' ');
  ok(fichaSL001.includes('Matrícula 172586') && !/MATRÍCULAS \(/i.test(fichaSL001),
     'un lote de una sola matrícula no gana una sección nueva');
  await cerrarLote();

  // (d) El domicilio del lote: 123 de los 135 de Salta lo traen y la ficha
  //     no lo mostraba, con la sección llamándose "Ubicación".
  const conDomicilio = datos.lotes.find((l) => delParque(l, 'salta') && l.ubicacion && l.id_empresa);
  ok(!!conDomicilio, 'el archivo sigue trayendo lotes de Salta con domicilio');
  await abrirLoteDeSalta(conDomicilio.id_lote);
  const fichaDom = (await page.locator('#modal').textContent()).replace(/\s+/g, ' ');
  ok(fichaDom.includes('Domicilio') && fichaDom.includes(conDomicilio.ubicacion),
     `la ficha del lote muestra su domicilio (${conDomicilio.ubicacion})`);
  await cerrarLote();

  // (e) Un lote sin matrícula ni superficie se dibujaba como una fila de
  //     guiones, sin distinguir "falta el dato" de "no corresponde".
  const sinRegistral = datos.lotes.find((l) => delParque(l, 'salta') && l.superficie_m2 == null && !l.matricula);
  ok(!!sinRegistral, 'el archivo sigue trayendo lotes sin datos registrales');
  await abrirLoteDeSalta(sinRegistral.id_lote);
  const fichaSin = (await page.locator('#modal').textContent()).replace(/\s+/g, ' ');
  ok(/no tiene matrícula ni superficie en el archivo/.test(fichaSin),
     'la ficha avisa que faltan los datos registrales, en vez de dejar solo guiones');
  await cerrarLote();

  // Y el aviso NO sale donde los datos están: si apareciera siempre, dejaría
  // de significar algo.
  const completo = datos.lotes.find((l) => delParque(l, 'salta') && l.superficie_m2 != null && l.matricula);
  await abrirLoteDeSalta(completo.id_lote);
  ok(!/en el archivo\. Los guiones de arriba/.test((await page.locator('#modal').textContent())),
     'un lote con sus datos registrales no muestra el aviso');
  await cerrarLote();

  // La superficie del lote es la suma de sus matrículas: si alguna vez deja
  // de serlo, el total de la app y el detalle de la ficha se contradicen.
  const sumasMal = datos.lotes.filter((l) => (l.matriculas || []).length > 1).filter((l) => {
    const suma = l.matriculas.reduce((t, m) => t + (Number(m.superficie_m2) || 0), 0);
    return Math.abs(suma - (Number(l.superficie_m2) || 0)) > 1;
  });
  ok(sumasMal.length === 0,
     `la superficie de cada lote es la suma de sus matrículas${sumasMal.length ? ': falla en ' + sumasMal.map((l) => l.id_lote).join(', ') : ''}`);

  // Vuelta a Güemes: el cambio de parque no deja estado del otro colgado.
  await page.locator('#parqueSwitch [data-parque="guemes"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#empresasList .ui-card').length > 0);
  ok((await page.locator('#empresasCount').textContent()).includes(String(empresasGuemes.length)),
     'al volver a Güemes el listado vuelve a sus empresas');

  // Bajas permanentes: una empresa borrada en pantalla se declara como baja
  // en el POST, y una copia vieja del dispositivo que todavía la tiene no la
  // vuelve a mostrar. EGPAIS es la que se restauró el 2026-10-20.
  await page.locator('#empresasList .ui-card', { hasText: 'EGPAIS' }).first().click();
  await page.locator('#btnDeleteViewEmp').click();
  const bajaDeclarada = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      if (ultimoPost?.eliminados?.empresas?.includes('E014-2')) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
  ok(bajaDeclarada, 'borrar EGPAIS en pantalla la declara como baja en el POST (eliminados.empresas)');
  ok(!ultimoPost?.empresas?.some((e) => e.id_empresa === 'E014-2'), 'y el POST ya no la trae');

  // Copia vieja: el dispositivo todavía tiene EGPAIS en su localStorage.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('parques_crm_v1'));
    s.empresas.push({ id_empresa: 'E014-2', id_empresa_original: 'E014', nombre_empresa: 'EGPAIS', id_parque: 'guemes' });
    s.eliminados = s.eliminados || { empresas: [], lotes: [] };
    s.eliminados.empresas = s.eliminados.empresas.filter((id) => id !== 'E014-2');
    localStorage.setItem('parques_crm_v1', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('#empresasList .ui-card').length > 0);
  ok((await page.locator('#empresasList .ui-card', { hasText: 'EGPAIS' }).count()) === 0,
     'una copia vieja con EGPAIS no la vuelve a mostrar');
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
  const botones = {};
  const buscadores = {};

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
    // La barra de búsqueda: misma pastilla en las cuatro apps, con lupa SVG
    // (en Seguimiento la "lupa" era un emoji dentro del placeholder, que se
    // dibuja distinto en cada sistema operativo).
    buscadores[p] = await page.evaluate(() => {
      const barra = document.querySelector('.search-bar');
      if (!barra) return null;
      const input = barra.querySelector('input');
      const cs = getComputedStyle(barra);
      return {
        alto: Math.round(barra.getBoundingClientRect().height),
        radio: cs.borderTopLeftRadius,
        fuente: Math.round(parseFloat(getComputedStyle(input).fontSize)),
        familia: getComputedStyle(input).fontFamily,
        lupa: !!barra.querySelector('svg.search-icon'),
        limpiar: !!barra.querySelector('.search-clear'),
        emoji: /[\u{1F300}-\u{1FAFF}\u{2190}-\u{2BFF}]/u.test(input.placeholder || '')
      };
    });

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

      // Con el formulario abierto están a la vista Guardar / Cancelar: es el
      // momento de comparar el componente de botón entre pantallas.
      botones[p] = await page.evaluate(() => {
        const visibles = [...document.querySelectorAll('.btn')].filter((b) => b.offsetParent !== null);
        if (!visibles.length) return null;
        const cs = getComputedStyle(visibles[0]);
        // Ancho: se compara DENTRO de cada fila, no entre filas — dos filas
        // distintas pueden tener dos y tres botones, y ahí el ancho correcto
        // es distinto. Lo que el usuario pidió es que en una misma fila
        // Guardar, Cancelar y Eliminar midan lo mismo.
        const filas = [...new Set(visibles.map((b) => b.parentElement))].map((fila) => {
          const anchos = [...fila.querySelectorAll(':scope > .btn')]
            .filter((b) => b.offsetParent !== null)
            .map((b) => Math.round(b.getBoundingClientRect().width));
          return { clase: fila.className, anchos: [...new Set(anchos)], cuantos: anchos.length };
        }).filter((f) => f.cuantos > 1);
        return {
          cuantos: visibles.length,
          filas,
          alto: Math.round(visibles[0].getBoundingClientRect().height),
          altos: [...new Set(visibles.map((b) => Math.round(b.getBoundingClientRect().height)))],
          radio: cs.borderTopLeftRadius,
          fuente: Math.round(parseFloat(cs.fontSize)) + '/' + cs.fontWeight,
          alineado: cs.alignItems + '/' + cs.justifyContent,
          iconos: visibles.filter((b) => b.querySelector('svg.btn-icon')).length,
          tamIcono: (() => {
            const i = document.querySelector('.btn svg.btn-icon');
            return i ? Math.round(i.getBoundingClientRect().width) : 0;
          })()
        };
      });

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

  // ---- Un solo componente de botón para las cuatro apps ----
  // Antes de ui-kit.css convivían tres alturas (38/41/44px), Eliminar venía
  // en 13px contra 14px del resto, y en Seguimiento era además un botón
  // "small": la mitad de peso visual que Guardar para una acción más grave.
  const conBotones = Object.keys(botones).filter((p) => botones[p]);
  ok(conBotones.length === 4, `las 4 apps exponen botones del sistema compartido (${conBotones.join(', ')})`);
  const btnRef = botones[conBotones[0]];
  for (const p of conBotones) {
    const b = botones[p];
    ok(b.altos.length === 1 && b.altos[0] === 40,
       `en ${p} todos los botones a la vista miden los 40px de la especificación (${b.altos.join('/')}px)`);
    ok(b.radio === btnRef.radio && b.fuente === btnRef.fuente && b.alineado === btnRef.alineado,
       `el botón de ${p} comparte radio, tipografía y alineación con el de ${conBotones[0]} (${b.radio}, ${b.fuente})`);
    ok(b.iconos > 0 && b.tamIcono === 18,
       `en ${p} los botones llevan icono del juego compartido, a 18px (${b.iconos} con icono, ${b.tamIcono}px)`);
    // Pastilla, como la pestaña "Análisis" de Proyectos: el usuario lo pidió
    // explícitamente (2026-10-19) y es lo que hace que los cinco botones se
    // lean como un solo componente.
    ok(b.radio === '999px' || parseFloat(b.radio) >= 20,
       `el botón de ${p} tiene el radio de pastilla de la pestaña Análisis (${b.radio})`);
    // Mismo ancho dentro de cada fila de acciones.
    for (const fila of b.filas) {
      ok(fila.anchos.length === 1,
         `en ${p} los ${fila.cuantos} botones de .${fila.clase.trim().split(/\s+/).join('.')} miden todos lo mismo de ancho (${fila.anchos.join('/')}px)`);
    }
  }

  // ---- Una sola barra de búsqueda ----
  const conBusqueda = Object.keys(buscadores).filter((p) => buscadores[p]);
  ok(conBusqueda.length === 4, `las 4 apps usan la barra de búsqueda compartida (${conBusqueda.join(', ')})`);
  const busRef = buscadores[conBusqueda[0]];
  for (const p of conBusqueda) {
    const s = buscadores[p];
    ok(s.alto === busRef.alto && s.radio === busRef.radio && s.fuente === busRef.fuente,
       `la búsqueda de ${p} mide y se ve igual que la de ${conBusqueda[0]} (${s.alto}px, radio ${s.radio}, ${s.fuente}px)`);
    // 14px y Roboto en las cuatro, por pedido del usuario (2026-10-20).
    ok(s.fuente === 14, `la búsqueda de ${p} usa fuente de 14px (${s.fuente}px)`);
    ok(s.familia.startsWith('Roboto'), `la búsqueda de ${p} usa Roboto, Helvetica, sans-serif (${s.familia})`);
    ok(s.lupa && !s.emoji, `la búsqueda de ${p} tiene lupa SVG y ningún emoji en el placeholder`);
    ok(s.limpiar, `la búsqueda de ${p} tiene botón para limpiar`);
  }

  // ---- El sistema de diseño es una sola fuente de verdad ----
  // Es LA prueba del pedido del usuario (2026-10-19): "si modificás el radio
  // de los botones o el color principal, el cambio se aplica en todas las
  // pantallas sin editar cada una por separado".
  //
  // No se verifica leyendo el CSS —eso solo diría que el token existe— sino
  // pisando el token en caliente y preguntándole al navegador qué pinta. Si
  // alguien vuelve a clavar un color o un radio en el <style> de una página,
  // esa página deja de moverse y este test la nombra.
  const PRUEBAS = [
    { token: '--ds-accent', valor: 'rgb(255, 0, 0)', sel: '.btn-primary',
      prop: 'backgroundColor', espera: 'rgb(255, 0, 0)', que: 'el color principal del botón' },
    { token: '--ds-radius-button', valor: '3px', sel: '.btn-primary',
      prop: 'borderTopLeftRadius', espera: '3px', que: 'el radio del botón' },
    { token: '--ds-control-height', valor: '57px', sel: '.btn-primary',
      prop: 'minHeight', espera: '57px', que: 'el alto de los controles' },
    { token: '--ds-bg', valor: 'rgb(0, 128, 0)', sel: 'body',
      prop: 'backgroundColor', espera: 'rgb(0, 128, 0)', que: 'el fondo de la pantalla' },
    { token: '--ds-fg', valor: 'rgb(0, 0, 255)', sel: 'body',
      prop: 'color', espera: 'rgb(0, 0, 255)', que: 'el color del texto' }
  ];
  for (const p of paginas) {
    await page.goto(`http://localhost:${puerto}/${p}.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(150);
    for (const prueba of PRUEBAS) {
      const leido = await page.evaluate(({ token, valor, sel, prop }) => {
        // Un botón de muestra: no todas las pantallas tienen uno a la vista
        // al cargar, y lo que se prueba es la clase, no que esté en pantalla.
        let temp = null;
        if (!document.querySelector(sel)) {
          temp = document.createElement('button');
          temp.className = 'btn btn-primary';
          document.body.appendChild(temp);
        }
        document.documentElement.style.setProperty(token, valor);
        const v = getComputedStyle(document.querySelector(sel))[prop];
        document.documentElement.style.removeProperty(token);
        if (temp) temp.remove();
        return v;
      }, prueba);
      ok(leido === prueba.espera,
         `en ${p}, cambiar ${prueba.token} cambia ${prueba.que} sin tocar la página ` +
         `(esperaba ${prueba.espera}, dio ${leido})`);
    }
  }

  await browser.close();
  server.close();
}

// ---------------------------------------------------------------------------
// Transición entre pantallas
// ---------------------------------------------------------------------------
// El usuario pidió (2026-10-19) que el cambio de pantalla no fuera brusco.
// Como es un MPA, lo resuelve la API de View Transitions entre documentos.
//
// Se mide por comportamiento y no mirando el CSS, porque el modo de fallar de
// esto NO es "la regla no está": es que la regla esté y el navegador la
// ignore por llegar tarde al primer render. Con el opt-in en design-system.css
// la transición salía en 5 de 8 navegaciones; inline en el <head>, en 8 de 8.
// Un test que leyera el CSS habría dado verde en los dos casos.
//
// OJO si tocás esto: no se puede sacar screenshots durante la navegación —
// hacerlo interfiere con la transición y da falsos negativos. Se escucha el
// evento `pagereveal`, que es el que dice si el documento nuevo entró con
// transición o sin ella.
// ---------------------------------------------------------------------------
// El reintento de sync no se desboca
// ---------------------------------------------------------------------------
// Regresión del bug más grave que encontró la auditoría del 2026-10-19. En
// Resoluciones y Parques el `catch` de subirCambios() terminaba llamándose a
// sí mismo de inmediato, porque al fallar no se borra la marca de pendiente:
//
//     }catch(e){ setSyncStatus("offline"); }
//     syncEnProgreso = false;
//     if(haySyncPendiente()) subirCambios();   // ← otra vez, ya
//
// Medido con los datos reales y el server devolviendo 500: 62 POST por
// segundo, 170 MB en 10 segundos, y las llamadas que eso dispara contra la
// API de GitHub agotaban el presupuesto de 5.000/hora en 40 segundos. Como el
// token es uno solo para las cuatro apps, un teléfono con mala señal dejaba
// sin sincronizar a las otras tres.
//
// Se mide por comportamiento —cuántos POST llegan y con qué separación—
// porque leer el código solo diría que hay un setTimeout, no que la espera
// crezca ni que exista un techo.
async function testReintentoSyncNoSeDesboca() {
  console.log('\n=== REINTENTO DE SYNC (no se desboca) ===');

  const paginas = {
    resoluciones: { endpoint: '/api/sync-resoluciones', vacio: { resoluciones: [] } },
    parques: { endpoint: '/api/sync-parques', vacio: { parques: [], empresas: [], lotes: [], ocupaciones: [], reservas: [] } }
  };

  for (const [app, cfg] of Object.entries(paginas)) {
    const html = fs.readFileSync(path.join(RAIZ, `public/${app}.html`), 'utf8');
    const posts = [];
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api/')) {
        if (req.method === 'POST') {
          posts.push(Date.now());
          // 500: el fallo transitorio clásico (incluido el que devuelve el
          // propio Worker cuando le falta el GITHUB_TOKEN). Tiene que
          // reintentar, pero espaciado.
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end('{"error":"simulado"}');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(cfg.vacio));
      }
      if (servirHeaderJs(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise((r) => server.listen(8779, r));

    const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto('http://localhost:8779/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // Alta por la UI, como una persona: el FAB y el formulario.
    await page.click('#fabNuevo');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      document.querySelectorAll('form input[type=text], form input:not([type]), form input[type=number]')
        .forEach((i, n) => { if (!i.value) { i.value = i.type === 'number' ? '1' : ('P' + n); i.dispatchEvent(new Event('input', { bubbles: true })); } });
      document.querySelectorAll('form select').forEach((sel) => {
        if (sel.options.length > 1 && !sel.value) { sel.selectedIndex = 1; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      });
    });
    posts.length = 0;
    await page.evaluate(() => { const f = document.querySelector('form'); if (f) f.requestSubmit(); });
    await page.waitForTimeout(9000);

    const huecos = posts.slice(1).map((t, i) => t - posts[i]);
    // En 9 segundos, con esperas de 2s, 4s y 8s, entran 3 intentos. La
    // cota se verifica POR LOS DOS LADOS a propósito:
    //  - techo 10: el bucle desbocado daba más de 3.000;
    //  - piso 2: si alguien "arregla" el bucle dejando de reintentar, los
    //    cambios se quedan en el teléfono sin subir nunca y la pantalla
    //    dice "guardado". Eso es peor que el bucle, porque no se nota.
    // Esta segunda mitad no estaba en la primera versión del test, y por eso
    // una recreación parcial del bug pasaba en verde.
    ok(posts.length >= 2 && posts.length <= 10,
       `${app}: ${posts.length} POST en 9s con el server caído — reintenta pero no se desboca (el bucle daba >3000, rendirse daría 1)`);
    // Solo los primeros huecos en el mensaje: con el bug puesto son miles y
    // el fallo se vuelve ilegible justo cuando hay que leerlo.
    const muestra = huecos.slice(0, 5).map((h) => h + 'ms').join(', ') +
      (huecos.length > 5 ? ` … y ${huecos.length - 5} más` : '');
    ok(huecos.length === 0 || huecos.every((h) => h >= 1500),
       `${app}: entre reintentos pasan al menos 1,5s (${muestra || 'un solo intento'})`);
    ok(huecos.length < 2 || huecos[1] > huecos[0],
       `${app}: la espera crece entre un intento y el siguiente (${huecos.slice(0, 3).map((h) => h + 'ms').join(' -> ')})`);
    // Con la espera creciente el reintento se calma solo; sin ella no.
    // Este es el número que importaba: 62 POST/s contra 0,3 POST/s.
    console.log(`         (ritmo: ${(posts.length / 9).toFixed(1)} POST por segundo; el bucle daba 62)`);

    await browser.close();
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Clave compartida: el flujo del lado del navegador
// ---------------------------------------------------------------------------
// El Worker con APP_CLAVE cargada responde 401. Este test verifica lo que
// pasa DESPUÉS, que es lo que decide si la app queda usable o no:
// aparece el diálogo, la clave se guarda, el pedido se reintenta y en la
// próxima pantalla ya no vuelve a preguntar.
//
// Es el camino más riesgoso del cambio: si esto falla, cargar el secret en
// Cloudflare deja la app en blanco y sin forma de entrar.
async function testClaveCompartidaEnElNavegador() {
  console.log('\n=== CLAVE COMPARTIDA (navegador) ===');
  const CLAVE = 'la-clave-buena';
  const paginas = ['seguimiento', 'proyectos', 'resoluciones', 'parques'];
  const htmls = {};
  for (const p of paginas) htmls[p] = fs.readFileSync(path.join(RAIZ, `public/${p}.html`), 'utf8');

  let sinClave = 0, conClave = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      if (req.headers['x-clave'] !== CLAVE) {
        sinClave++;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end('{"error":"clave_invalida"}');
      }
      conClave++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        expedientes: [], areas: [], responsables: [], resoluciones: [],
        parques: [], empresas: [], lotes: [], ocupaciones: [], reservas: [],
        _meta: { sha: 'x' }
      }));
    }
    if (servirHeaderJs(req, res)) return;
    const cual = paginas.find((p) => req.url.startsWith('/' + p)) || 'seguimiento';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmls[cual]);
  });
  await new Promise((r) => server.listen(8778, r));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  await page.goto('http://localhost:8778/resoluciones.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const dialogo = page.locator('.app-clave');
  ok(await dialogo.isVisible(), 'con el Worker pidiendo clave, aparece el diálogo');
  ok(await page.locator('.app-clave__input').isVisible(), 'el diálogo tiene un campo para escribirla');
  // 16px o iOS hace zoom al enfocar; y type=password para que no quede a la vista.
  const campo = await page.evaluate(() => {
    const i = document.querySelector('.app-clave__input');
    return { fuente: parseFloat(getComputedStyle(i).fontSize), tipo: i.type, enfocado: document.activeElement === i };
  });
  ok(campo.fuente >= 16, `el campo usa fuente ≥16px, para que iOS no haga zoom (${campo.fuente}px)`);
  ok(campo.tipo === 'password', 'la clave no queda a la vista mientras se escribe');
  ok(campo.enfocado, 'el campo arranca enfocado: se puede escribir sin tocarlo');

  // Clave equivocada: vuelve a preguntar, no deja la app colgada.
  conClave = 0;
  await page.fill('.app-clave__input', 'equivocada');
  await page.click('.app-clave [data-aceptar]');
  await page.waitForTimeout(700);
  ok(await page.locator('.app-clave').isVisible(), 'con la clave equivocada vuelve a preguntar');
  ok(conClave === 0, 'con la clave equivocada no pasó ningún pedido');

  // Clave correcta: entra y la guarda.
  await page.fill('.app-clave__input', CLAVE);
  await page.click('.app-clave [data-aceptar]');
  await page.waitForTimeout(900);
  ok(!(await page.locator('.app-clave').count()) || !(await page.locator('.app-clave').isVisible()),
     'con la clave correcta el diálogo se cierra');
  ok(conClave > 0, `el pedido se reintentó solo con la clave puesta (${conClave} pedidos autorizados)`);

  // Y no vuelve a preguntar: ni al recargar, ni en las otras apps. La clave
  // es por dispositivo, no por pantalla — las cinco comparten origen.
  for (const otra of ['resoluciones', 'parques', 'proyectos', 'seguimiento']) {
    await page.goto(`http://localhost:8778/${otra}.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const pide = await page.locator('.app-clave').count();
    ok(pide === 0, `${otra} no vuelve a pedir la clave: se guardó para todo el dispositivo`);
  }

  // Cancelar no deja un diálogo colgado ni un bucle de pedidos.
  await page.evaluate(() => HeaderGlobal.olvidarClave());
  await page.goto('http://localhost:8778/resoluciones.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  ok(await page.locator('.app-clave').isVisible(), 'tras olvidar la clave, vuelve a pedirla');
  sinClave = 0;
  await page.click('.app-clave [data-cancelar]');
  await page.waitForTimeout(1500);
  ok((await page.locator('.app-clave').count()) === 0, 'cancelar cierra el diálogo');
  ok(sinClave <= 4, `cancelar no dispara un bucle de pedidos (${sinClave} en 1,5s)`);

  await browser.close();
  server.close();
}

async function testTransiciones() {
  console.log('\n=== TRANSICIÓN ENTRE PANTALLAS ===');
  const paginas = ['index', 'seguimiento', 'proyectos', 'resoluciones', 'parques'];
  const htmls = {};
  for (const p of paginas) htmls[p] = fs.readFileSync(path.join(RAIZ, `public/${p}.html`), 'utf8');

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    if (servirHeaderJs(req, res)) return;
    const cual = paginas.find((p) => req.url.startsWith('/' + p)) || 'index';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmls[cual]);
  });
  await new Promise((r) => server.listen(8780, r));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  // Recorrido por las cuatro apps y vuelta: así entra y sale de cada pantalla,
  // que es como se usa la barra de abajo. La landing queda afuera del
  // recorrido porque la barra no enlaza a ella (se llega por el icono de la
  // app), pero sí entra en el chequeo de la barra quieta, más abajo.
  const RECORRIDO = ['parques', 'resoluciones', 'seguimiento', 'proyectos', 'parques'];

  for (const reducido of [false, true]) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: reducido ? 'reduce' : 'no-preference'
    });
    const page = await ctx.newPage();
    const vistos = [];
    page.on('console', (m) => { if (m.text().startsWith('VT|')) vistos.push(m.text().slice(3) === '1'); });
    await page.addInitScript(() => {
      addEventListener('pagereveal', (e) => console.log('VT|' + (e.viewTransition ? '1' : '0')));
    });
    await page.goto('http://localhost:8780/proyectos.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    vistos.length = 0;
    for (const destino of RECORRIDO) {
      await page.click(`a[href="/${destino}.html"]`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(300);
    }
    const conTransicion = vistos.filter(Boolean).length;
    if (reducido) {
      ok(conTransicion === 0,
         `con "menos movimiento" activado no se anima ninguna de las ${vistos.length} navegaciones (${conTransicion} animadas)`);
    } else {
      ok(vistos.length === RECORRIDO.length && conTransicion === RECORRIDO.length,
         `las ${RECORRIDO.length} navegaciones entre pantallas entran con transición (${conTransicion}/${vistos.length})`);
    }
    await ctx.close();
  }

  // La barra de abajo no se desvanece con el contenido: tiene nombre propio,
  // así que el navegador la trata como el mismo elemento en las dos pantallas.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  for (const p of paginas) {
    await page.goto(`http://localhost:8780/${p}.html`, { waitUntil: 'domcontentloaded' });
    const r = await page.evaluate(() => {
      const barras = document.querySelectorAll('.bottom-nav');
      return {
        cuantas: barras.length,
        nombre: barras[0] ? getComputedStyle(barras[0]).viewTransitionName : null
      };
    });
    // Dos elementos con el mismo view-transition-name hacen que el navegador
    // descarte la transición ENTERA, sin avisar.
    ok(r.cuantas === 1 && r.nombre === 'ds-barra-apps',
       `en ${p} la barra de abajo se queda quieta durante el cambio (${r.cuantas} barra/s, nombre "${r.nombre}")`);
  }
  await ctx.close();

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
await testProyectosCargaSolapada();
await testProyectosArranqueYArchivo();
await testProyectosValidacionYOrden();
await testProyectosSalidasYDeshacer();
await testProyectosLayoutYFiltros();
await testProyectosEscalaFicha({ nombre: 'mobile', ancho: 390, alto: 844 });
await testProyectosEscalaFicha({ nombre: 'desktop', ancho: 1280, alto: 800 });
await testEscalaOtrasFichas();
await testParques({ width: 1440, height: 900 }, 8793);
await testParques({ width: 390, height: 844 }, 8792);
/*
 * Formularios iguales en las cuatro apps. Pedido del usuario (2026-10-21):
 * "tienen que ser idénticos… en el color de la letra, en el tamaño, en el
 * background, en el calendario, en todo eso". Se abre el alta de cada app con
 * su + y se compara, por comportamiento, cada tipo de control: etiqueta, campo
 * de texto, fecha, selector y área de texto. Si una app difiere, se nombra.
 */
async function testFormulariosUniformes(puerto) {
  console.log('\n=== FORMULARIOS UNIFORMES ENTRE PANTALLAS (390x844, táctil) ===');
  const paginas = ['seguimiento', 'proyectos', 'resoluciones', 'parques'];
  const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const f = path.join(RAIZ, 'public', u.pathname === '/' ? 'seguimiento.html' : u.pathname);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(puerto, r));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();

  const CONTROLES = {
    etiqueta: '.form-label, .field label',
    texto: '.form-input[type=text], .field input[type=text]',
    fecha: 'input[type=date]',
    selector: '.form-select, .field select',
    area: '.form-textarea, .field textarea',
  };
  const medidas = {};
  for (const p of paginas) {
    await page.goto(`http://localhost:${puerto}/${p}.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app-fab');
    await page.click('.app-fab');
    await page.waitForTimeout(250);
    medidas[p] = await page.evaluate((controles) => {
      const out = {};
      for (const [nombre, sel] of Object.entries(controles)) {
        const el = document.querySelector(sel);
        if (!el) { out[nombre] = null; continue; }
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        out[nombre] = {
          fuente: cs.fontSize,
          peso: cs.fontWeight,
          color: cs.color,
          fondo: cs.backgroundColor,
          borde: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
          radio: cs.borderRadius,
          relleno: cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft,
          tipografia: cs.fontFamily,
          alto: Math.round(r.height),
        };
      }
      return out;
    }, CONTROLES);
  }
  await browser.close();
  server.close();

  // Se compara cada control contra la primera app que lo tiene. Una propiedad
  // distinta se nombra con sus dos valores, para que el arreglo sea directo.
  const ref = {};
  for (const control of Object.keys(CONTROLES)) {
    const conEsta = paginas.filter((p) => medidas[p][control]);
    ok(conEsta.length >= 2, `${control}: al menos dos pantallas tienen este control (${conEsta.join(', ') || 'ninguna'})`);
    const base = conEsta[0];
    ref[control] = base;
    for (const p of conEsta.slice(1)) {
      const a = medidas[base][control];
      const b = medidas[p][control];
      const difs = Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k} ${a[k]} vs ${b[k]}`);
      ok(difs.length === 0, `${control}: ${p} igual que ${base}` + (difs.length ? ` — difiere en ${difs.join('; ')}` : ''));
    }
  }
}

await testUniformidad(8791);
await testFormulariosUniformes(8792);
await testTransiciones();
await testReintentoSyncNoSeDesboca();
await testClaveCompartidaEnElNavegador();

console.log(fallas === 0 ? '\nUI OK en desktop y mobile' : `\n${fallas} fallas`);
process.exit(fallas === 0 ? 0 : 1);
