/*
 * Biblioteca: plantillas, notas y normativa, dentro de la pestaña Biblioteca de Proyectos.
 *
 * 1. Estático (sin navegador): el índice biblioteca/biblioteca.json es válido, cada
 *    archivo existe dentro de public/biblioteca/, no hay ids repetidos y el marcado
 *    de proyectos.html trae la pestaña, la vista y la ficha.
 * 2. Navegador (si Playwright está instalado): la pestaña se abre, filtra por texto
 *    y categoría, abre la ficha, cierra con Escape, devuelve la búsqueda de
 *    Listado, y muestra los estados vacío y de error. Corre a 390px.
 *    El índice real está vacío, así que este test simula uno con tres documentos.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(RAIZ, 'public');
const CATEGORIAS = ['formularios', 'normativa', 'notas', 'requisitos'];

let fallos = 0;
const falla = (msg) => { console.log('FAIL ' + msg); fallos++; };

// ---- 1. Estático ----
const indicePath = path.join(PUBLIC, 'biblioteca/biblioteca.json');
let indice = null;
try {
  indice = JSON.parse(fs.readFileSync(indicePath, 'utf8'));
} catch (e) {
  falla(`biblioteca/biblioteca.json no es JSON válido: ${e.message}`);
}
if (indice) {
  if (!Array.isArray(indice.documentos)) falla('biblioteca.json: falta el arreglo "documentos"');
  else {
    const ids = new Set();
    for (const d of indice.documentos) {
      if (typeof d.id !== 'string' || !d.id) { falla(`documento sin id: ${JSON.stringify(d).slice(0, 80)}`); continue; }
      if (ids.has(d.id)) falla(`id repetido en biblioteca.json: ${d.id}`);
      ids.add(d.id);
      if (!CATEGORIAS.includes(d.categoria)) falla(`${d.id}: categoría "${d.categoria}" no existe (usar ${CATEGORIAS.join(', ')})`);
      if (typeof d.titulo !== 'string' || !d.titulo) falla(`${d.id}: falta el título`);
      if (typeof d.archivo !== 'string' || !d.archivo) { falla(`${d.id}: falta el archivo`); continue; }
      if (d.archivo.startsWith('/') || d.archivo.includes('..') || /^[a-z]+:/i.test(d.archivo)) {
        falla(`${d.id}: la ruta "${d.archivo}" tiene que ser relativa a biblioteca/ y no salir de la carpeta`);
        continue;
      }
      const ruta = path.join(PUBLIC, 'biblioteca', d.archivo);
      if (!fs.existsSync(ruta) || fs.statSync(ruta).size === 0) falla(`${d.id}: no existe public/biblioteca/${d.archivo}`);
      if (d.tags !== undefined && !Array.isArray(d.tags)) falla(`${d.id}: "tags" tiene que ser una lista`);
    }
  }
}

const html = fs.readFileSync(path.join(PUBLIC, 'proyectos.html'), 'utf8');
for (const id of ['tabBiblio', 'viewBiblio', 'bibChips', 'bibCount', 'bibList', 'bibOv', 'bibBajar', 'bibCerrar', 'bibCompartir', 'bibWhats', 'bibMail', 'bibSel', 'bibSelN', 'bibSelTodos', 'bibSelLimpiar', 'bibSelWa', 'bibSelMail']) {
  if (!html.includes(`id="${id}"`)) falla(`proyectos.html no tiene #${id}`);
}
const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
if (!sw.includes("startsWith('/biblioteca/')")) falla('sw.js: /biblioteca/* no va network-first');

// ---- 2. Navegador ----
let chromium = null;
for (const cand of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(cand)); break; } catch { /* probar el siguiente */ }
}

const FIXTURE = {
  documentos: [
    { id: 'ci-general', categoria: 'formularios', titulo: 'Carta de intención · modelo general', tipo: 'DOCX', version: 'v3',
      resumen: 'Modelo base para responder a un proyecto de inversión.', tags: ['carta', 'intención', 'modelo'],
      archivo: 'archivos/ci-general.docx', texto: 'Señores:\n[ORGANISMO]' },
    { id: 'pase-seguimiento', categoria: 'notas', titulo: 'Nota de pase · a Seguimiento', tipo: 'DOCX', version: 'v2',
      resumen: 'Pase de un expediente a la mesa de seguimiento.', tags: ['pase', 'seguimiento'],
      archivo: 'archivos/pase-seguimiento.docx' },
    { id: 'ley-7701', categoria: 'normativa', titulo: 'Ley de Parques Industriales 7701', tipo: 'PDF', version: 'vigente',
      resumen: 'Marco legal de los parques industriales.', tags: ['ley', '7701'], archivo: 'archivos/ley-7701.pdf' }
  ]
};

function servidor() {
  const cartas = fs.readFileSync(path.join(RAIZ, 'cartas-intencion.json'), 'utf8');
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/api/sync-cartas') return json({ ...JSON.parse(cartas), _meta: { sha: 'x' } });
    if (u.pathname === '/api/version-cartas') return json({ sha: 'x' });
    if (u.pathname.startsWith('/api/')) return json({});
    const f = path.join(PUBLIC, u.pathname === '/' ? 'proyectos.html' : decodeURIComponent(u.pathname));
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
    const tipos = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.pdf': 'application/pdf' };
    res.setHeader('content-type', tipos[path.extname(f)] || 'application/octet-stream');
    res.end(fs.readFileSync(f));
  });
}

// Simula la hoja de compartir del teléfono. 'sin' la quita (escritorio); 'stub'
// la reemplaza por una que anota qué recibió, para leerlo desde el test.
function initCompartir(modo) {
  if (modo === 'sin') return "Object.defineProperty(navigator,'share',{value:undefined,configurable:true});";
  return `window.__compartido = null;
    Object.defineProperty(navigator,'share',{configurable:true,value:function(d){
      window.__compartido={title:d.title,url:d.url||null,files:d.files?d.files.map(function(f){return {name:f.name,size:f.size,type:f.type};}):null};
      return Promise.resolve();}});
    Object.defineProperty(navigator,'canShare',{configurable:true,value:function(d){return !!(d&&d.files);}});`;
}

const FIXTURE_REAL = {
  documentos: [
    { id: 'ley-7701', categoria: 'normativa', titulo: 'Ley 7701 · Parques y áreas industriales', tipo: 'PDF', version: 'vigente',
      resumen: 'Texto ordenado de la ley.', tags: ['ley'], archivo: 'archivos/ley-7701-parques-y-areas-industriales.pdf' }
  ]
};

async function recorrido() {
  const srv = servidor();
  await new Promise((r) => srv.listen(0, r));
  const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] }).catch(async () =>
    chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] }));
  const errores = [];
  try {
    // Cada escenario en contexto propio: el índice simulado cambia por escenario.
    async function abrir(indiceSimulado, { hash = '', share = 'sin' } = {}) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      await ctx.addInitScript(initCompartir(share));
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errores.push(e.message));
      await page.route('**/biblioteca/biblioteca.json', (route) => indiceSimulado === 500
        ? route.fulfill({ status: 500, body: 'error' })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(indiceSimulado) }));
      await page.goto(base + '/proyectos.html' + hash, { waitUntil: 'networkidle' });
      return { ctx, page };
    }

    // Escenario A: índice con tres documentos.
    {
      const { ctx, page } = await abrir(FIXTURE);
      await page.waitForSelector('#expList .exp-card', { timeout: 15000 });
      await page.fill('#search', 'busco algo que no hay en Listado');
      await page.fill('#search', '');
      await page.click('#tabBiblio');
      await page.waitForSelector('#viewBiblio:not([hidden])');
      const enBiblio = await page.evaluate(() => ({
        listadoOculto: document.getElementById('viewList').hidden,
        // Se mide lo que se ve (display calculado), no el atributo: header.js pone display:flex.
        fabOculto: document.querySelector('.app-fab') ? getComputedStyle(document.querySelector('.app-fab')).display === 'none' : true,
        placeholder: document.getElementById('search').placeholder
      }));
      if (!enBiblio.listadoOculto) falla('Biblioteca: el listado sigue visible');
      if (!enBiblio.fabOculto) falla('Biblioteca: el botón + de Nuevo Proyecto sigue visible');
      if (!/plantilla/i.test(enBiblio.placeholder)) falla(`Biblioteca: la búsqueda no cambió de texto (${enBiblio.placeholder})`);
      const docs = await page.$$eval('#bibList .bib-doc', (els) => els.length);
      if (docs !== 3) falla(`Biblioteca: se esperaban 3 documentos y hay ${docs}`);

      await page.fill('#search', '7701');
      const filtrados = await page.$$eval('#bibList .bib-doc-titulo', (els) => els.map((e) => e.textContent));
      if (filtrados.length !== 1 || !/7701/.test(filtrados[0])) falla(`Biblioteca: buscar «7701» dio ${JSON.stringify(filtrados)}`);
      await page.fill('#search', '');

      await page.click('#bibChips [data-cat="notas"]');
      const porPase = await page.$$eval('#bibList .bib-doc-titulo', (els) => els.map((e) => e.textContent));
      if (porPase.length !== 1 || !/pase/i.test(porPase[0])) falla(`Biblioteca: el filtro «notas» dio ${JSON.stringify(porPase)}`);
      await page.click('#bibChips [data-cat="todas"]');

      // Selección: se marcan documentos y los iconos de WhatsApp y Mail mandan los elegidos.
      if (await page.isVisible('#bibSelWa')) falla('Selección: los iconos de envío se ven sin nada seleccionado');
      if (await page.isHidden('#bibSelTodos')) falla('Selección: «Todos» no está disponible sin selección');
      await page.check('#bibList input[data-sel="ci-general"]');
      if (await page.isHidden('#bibSelWa')) falla('Selección: los iconos de envío no aparecen al marcar un documento');
      if (!(await page.isHidden('#bibOv'))) falla('Selección: marcar la casilla abrió la ficha');
      const n1 = await page.textContent('#bibSelN');
      if (n1 !== '1 seleccionado') falla(`Selección: el contador dice «${n1}»`);
      const wa1 = decodeURIComponent((await page.getAttribute('#bibSelWa', 'href')) || '');
      if (!wa1.startsWith('https://wa.me/?text=') || !wa1.includes('/biblioteca/archivos/ci-general.docx') || wa1.includes('pase-seguimiento'))
        falla(`Selección: WhatsApp con un documento no manda el elegido (${wa1})`);
      await page.check('#bibList input[data-sel="pase-seguimiento"]');
      const wa2 = decodeURIComponent((await page.getAttribute('#bibSelWa', 'href')) || '');
      if (!wa2.includes('/biblioteca/archivos/ci-general.docx') || !wa2.includes('/biblioteca/archivos/pase-seguimiento.docx'))
        falla(`Selección: WhatsApp con dos documentos no manda los dos (${wa2})`);
      const mail2 = decodeURIComponent((await page.getAttribute('#bibSelMail', 'href')) || '');
      if (!mail2.startsWith('mailto:?subject=') || !mail2.includes('Documentos de la Biblioteca (2)') || !mail2.includes('/biblioteca/archivos/pase-seguimiento.docx'))
        falla(`Selección: Mail con dos documentos no manda los dos (${mail2})`);
      if ((await page.textContent('#bibSelN')) !== '2 seleccionados') falla('Selección: el contador no pasó a 2');
      await page.click('#bibSelLimpiar');
      if (await page.isVisible('#bibSelWa')) falla('Selección: Limpiar no oculta los iconos de envío');
      if (await page.$('#bibList input[data-sel]:checked')) falla('Selección: Limpiar no desmarcó las casillas');

      // «Todos» marca lo que se ve: con el filtro Notas, solo el pase.
      await page.click('#bibChips [data-cat="notas"]');
      await page.click('#bibSelTodos');
      if ((await page.textContent('#bibSelN')) !== '1 seleccionado') falla(`Selección: «Todos» con filtro Notas dio «${await page.textContent('#bibSelN')}»`);
      await page.click('#bibSelLimpiar');
      await page.click('#bibChips [data-cat="todas"]');
      await page.click('#bibSelTodos');
      if ((await page.textContent('#bibSelN')) !== '3 seleccionados') falla(`Selección: «Todos» sin filtro dio «${await page.textContent('#bibSelN')}»`);
      await page.click('#bibSelLimpiar');

      await page.click('#bibList [data-id="ci-general"]');
      await page.waitForSelector('#bibOv:not([hidden])');
      const href = await page.getAttribute('#bibBajar', 'href');
      if (href !== 'biblioteca/archivos/ci-general.docx') falla(`Ficha: el enlace de descarga es ${href}`);
      // Compartir por WhatsApp y Mail va por enlace: funciona en cualquier navegador.
      const wa = await page.getAttribute('#bibWhats', 'href');
      if (!/^https:\/\/wa\.me\/\?text=/.test(wa || '') || !decodeURIComponent(wa).includes('/biblioteca/archivos/ci-general.docx'))
        falla(`Compartir: el enlace de WhatsApp no lleva el documento (${wa})`);
      if (wa && !decodeURIComponent(wa).includes('http://localhost:')) falla(`Compartir: el enlace de WhatsApp no es absoluto (${wa})`);
      const mail = await page.getAttribute('#bibMail', 'href');
      if (!/^mailto:\?subject=/.test(mail || '') || !decodeURIComponent(mail).includes('Carta de intención · modelo general'))
        falla(`Compartir: el enlace de Mail no tiene el título (${mail})`);
      // Sin navigator.share (escritorio) no hay botón de hoja nativa.
      if (!(await page.isHidden('#bibCompartir'))) falla('Compartir: el botón de hoja nativa se muestra sin navigator.share');
      await page.keyboard.press('Escape');
      if (!(await page.isHidden('#bibOv'))) falla('Ficha: Escape no la cerró');

      // La búsqueda de Listado sobrevive al paso por Biblioteca. Primero se vuelve
      // a Listado: escribir acá sin salir filtraría los documentos, no los expedientes.
      await page.click('#tabList');
      await page.fill('#search', 'hola de listado');
      await page.click('#tabBiblio');
      await page.fill('#search', 'pase');
      await page.click('#tabList');
      const valorListado = await page.inputValue('#search');
      if (valorListado !== 'hola de listado') falla(`Listado: la búsqueda volvió como «${valorListado}», no «hola de listado»`);
      if (await page.isHidden('#viewList')) falla('Listado: la vista no volvió a mostrarse');
      const fabVisible = await page.evaluate(() => { const f = document.querySelector('.app-fab'); return f ? getComputedStyle(f).display !== 'none' : null; });
      if (fabVisible === false) falla('Listado: el botón + no volvió');

      const anchoPagina = await page.evaluate(() => document.documentElement.scrollWidth);
      if (anchoPagina > 390) falla(`Biblioteca: la página se desborda a ${anchoPagina}px en 390px`);
      await ctx.close();
    }

    // Escenario B: el hash abre la pestaña directamente.
    {
      const { ctx, page } = await abrir(FIXTURE, { hash: '#biblioteca' });
      await page.waitForSelector('#viewBiblio:not([hidden])', { timeout: 15000 });
      await ctx.close();
    }

    // Escenario C: índice vacío y error de red.
    {
      const { ctx, page } = await abrir({ documentos: [] });
      await page.click('#tabBiblio');
      await page.waitForSelector('#bibList .bib-vacio');
      const vacio = await page.textContent('#bibList .bib-vacio');
      if (!/Todavía no hay documentos/.test(vacio)) falla(`Biblioteca vacía: mensaje inesperado «${vacio}»`);
      await ctx.close();
    }
    {
      const { ctx, page } = await abrir(500);
      await page.click('#tabBiblio');
      await page.waitForFunction(() => /No se pudo cargar/.test(document.getElementById('bibList').textContent), null, { timeout: 10000 });
      await ctx.close();
    }

    // Escenario D: con hoja de compartir y archivo real, se manda el archivo adjunto.
    {
      const { ctx, page } = await abrir(FIXTURE_REAL, { share: 'stub' });
      await page.click('#tabBiblio');
      await page.click('#bibList [data-id="ley-7701"]');
      await page.waitForSelector('#bibCompartir:not([disabled])', { timeout: 10000 });
      if (await page.isHidden('#bibCompartir')) falla('Compartir: con navigator.share el botón no aparece');
      await page.click('#bibCompartir');
      const enviado = await page.evaluate(() => window.__compartido);
      const f = enviado && enviado.files && enviado.files[0];
      if (!f || enviado.files.length !== 1) falla(`Compartir: no se adjuntó el archivo (${JSON.stringify(enviado)})`);
      else {
        if (f.name !== 'ley-7701-parques-y-areas-industriales.pdf') falla(`Compartir: el archivo adjunto se llama ${f.name}`);
        if (!f.size) falla('Compartir: el archivo adjunto está vacío');
        if (f.type !== 'application/pdf') falla(`Compartir: el tipo del adjunto es ${f.type}`);
      }
      await ctx.close();
    }

    // Escenario E: el archivo no se puede bajar: se comparte el enlace, no un adjunto vacío.
    {
      const { ctx, page } = await abrir(FIXTURE, { share: 'stub' });
      await page.click('#tabBiblio');
      await page.click('#bibList [data-id="ci-general"]');
      await page.waitForSelector('#bibCompartir:not([disabled])', { timeout: 10000 });
      await page.click('#bibCompartir');
      const enviado = await page.evaluate(() => window.__compartido);
      if (!enviado || enviado.files !== null) falla(`Compartir sin archivo: se mandó un adjunto (${JSON.stringify(enviado)})`);
      if (!enviado || !/\/biblioteca\/archivos\/ci-general\.docx$/.test(enviado.url || '')) falla(`Compartir sin archivo: el enlace es ${enviado && enviado.url}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  for (const e of errores) falla(`error de página: ${e}`);
}

if (chromium) {
  try {
    await recorrido();
  } catch (e) {
    falla(`recorrido en el navegador: ${e.message}`);
  }
} else {
  console.log('SKIP biblioteca en navegador: Playwright no está instalado (solo se corrió la parte estática)');
}

if (fallos) { console.log(`FALLAS biblioteca: ${fallos}`); process.exit(1); }
console.log(`OK biblioteca: índice válido (${indice?.documentos?.length ?? 0} documentos), pestaña y ficha en el marcado${chromium ? ', recorrido en navegador a 390px' : ''}`);
