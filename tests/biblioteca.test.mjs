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
      // Los formularios llevan número en la columna izquierda de la tarjeta: Carta 0, I 1 … IV 4.
      if (d.categoria === 'formularios') {
        const romanos = { I: 1, II: 2, III: 3, IV: 4 };
        const m = d.titulo.match(/^Formulario (I|II|III|IV) ·/);
        const esperado = d.id === 'carta-intencion-requisitos-pdf' ? 0 : m ? romanos[m[1]] : undefined;
        if (esperado !== undefined && d.numero !== esperado) falla(`${d.id}: numero es ${d.numero}, debía ser ${esperado}`);
      }
      if (typeof d.archivo !== 'string' || !d.archivo) { falla(`${d.id}: falta el archivo`); continue; }
      if (d.archivo.startsWith('/') || d.archivo.includes('..') || /^[a-z]+:/i.test(d.archivo)) {
        falla(`${d.id}: la ruta "${d.archivo}" tiene que ser relativa a biblioteca/ y no salir de la carpeta`);
        continue;
      }
      const ruta = path.join(PUBLIC, 'biblioteca', d.archivo);
      if (!fs.existsSync(ruta) || fs.statSync(ruta).size === 0) falla(`${d.id}: no existe public/biblioteca/${d.archivo}`);
      // La hoja de compartir del teléfono solo acepta PDF (y imagen, audio, video, texto):
      // un documento marcado PDF tiene que ser un PDF de verdad, si no WhatsApp/Mail fallan.
      if (d.tipo === 'PDF' && fs.existsSync(ruta)) {
        const cabecera = fs.readFileSync(ruta).subarray(0, 5).toString('latin1');
        if (!/\.pdf$/i.test(d.archivo) || cabecera !== '%PDF-') falla(`${d.id}: marcado PDF pero "${d.archivo}" no es un PDF`);
      }
      if (d.tags !== undefined && !Array.isArray(d.tags)) falla(`${d.id}: "tags" tiene que ser una lista`);
    }
  }
}

const html = fs.readFileSync(path.join(PUBLIC, 'proyectos.html'), 'utf8');
for (const id of ['tabBiblio', 'viewBiblio', 'bibChips', 'bibCount', 'bibList', 'bibOv', 'bibBajar', 'bibCerrar', 'bibBarra', 'bibSelAviso']) {
  if (!html.includes(`id="${id}"`)) falla(`proyectos.html no tiene #${id}`);
}
// La ficha solo descarga: WhatsApp, Mail, resumen y metadatos se quitaron y no deben volver.
for (const id of ['bibWhats', 'bibMail', 'bibAviso', 'bibResumen', 'bibMeta']) {
  if (html.includes(`id="${id}"`)) falla(`proyectos.html todavía tiene #${id} (la ficha ya no lo muestra)`);
}
// Seleccionar como en Resoluciones: sin casillas; la barra la pinta el script.
if (html.includes('data-sel=') || html.includes('bib-check')) falla('proyectos.html todavía tiene casillas de selección en Biblioteca');
if (html.includes('bib-doc-meta')) falla('proyectos.html todavía tiene la línea de metadatos de las tarjetas (bib-doc-meta)');
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
  // window.open se anota en vez de abrir: WhatsApp y mail mandan el enlace por ahí.
  const abre = `window.__abierto = []; window.open = function(u){ window.__abierto.push(String(u)); return null; };`;
  if (modo === 'sin') return abre + "Object.defineProperty(navigator,'share',{value:undefined,configurable:true});";
  // 'falla': la hoja existe pero rechaza el envío (error que no es cancelación).
  if (modo === 'falla') return abre + `Object.defineProperty(navigator,'share',{configurable:true,value:function(){
      return Promise.reject(new DOMException('no se pudo compartir','DataError'));}});
    Object.defineProperty(navigator,'canShare',{configurable:true,value:function(d){return !!(d&&d.files);}});`;
  return abre + `window.__compartido = null;
    Object.defineProperty(navigator,'share',{configurable:true,value:function(d){
      window.__compartido={title:d.title,url:d.url||null,files:d.files?d.files.map(function(f){return {name:f.name,size:f.size,type:f.type};}):null};
      return Promise.resolve();}});
    Object.defineProperty(navigator,'canShare',{configurable:true,value:function(d){return !!(d&&d.files);}});`;
}

// Elige documentos como lo hace una persona: el primer toque en un ícono de envío entra al modo
// con todo lo visible marcado; después se desmarca lo que no va.
const elegir = async (page, ids) => {
  await page.click('#bibSelWa');
  const visibles = await page.$$eval('#bibList .bib-doc', (els) => els.map((e) => e.dataset.id));
  for (const id of visibles) if (!ids.includes(id)) await page.click(`#bibList [data-id="${id}"]`);
};
const ultimoEnlace = (page) => page.evaluate(() => (window.__abierto || []).slice(-1)[0] || '');

const FIXTURE_REAL = {
  documentos: [
    { id: 'ley-7701', categoria: 'normativa', titulo: 'Ley 7701 · Parques y áreas industriales', tipo: 'PDF', version: 'vigente',
      resumen: 'Texto ordenado de la ley.', tags: ['ley'], archivo: 'archivos/ley-7701-parques-y-areas-industriales.pdf' }
  ]
};

const FIXTURE_DOS = {
  documentos: [
    { id: 'ley-7701', categoria: 'normativa', titulo: 'Ley 7701 · Parques y áreas industriales', tipo: 'PDF', version: 'vigente',
      resumen: 'Texto ordenado de la ley.', tags: ['ley'], archivo: 'archivos/ley-7701-parques-y-areas-industriales.pdf' },
    { id: 'anexo-i', categoria: 'formularios', titulo: 'Anexo I · Formulario técnico', tipo: 'PDF', version: 'vigente',
      resumen: 'Formulario técnico del EGPAIS.', tags: ['anexo'], archivo: 'archivos/anexo-i-formulario-tecnico.pdf' }
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
      // Sin chip «Todas»: tocar la categoría activa vuelve a mostrar todo.
      await page.click('#bibChips [data-cat="notas"]');
      if ((await page.$$('#bibList .bib-doc')).length !== 3) falla('Biblioteca: tocar la categoría activa no volvió a mostrar todo');
      if (await page.$('#bibChips [data-cat="todas"]')) falla('Biblioteca: quedó el chip «Todas»');

      // Selección desde los íconos del encabezado (solo en Biblioteca). El primer toque entra al
      // modo con todo lo visible marcado; tocar una tarjeta la desmarca; otro toque envía lo marcado.
      // Sin botones en la barra ni casillas. Escape sale del modo.
      if (!(await page.isVisible('#bibHeadAcciones'))) falla('Selección: los íconos de envío no se ven en Biblioteca');
      if (await page.$('#bibBarra button')) falla('Selección: quedaron botones en la barra');
      if (await page.$('#bibList input[type="checkbox"]')) falla('Selección: quedaron casillas en las tarjetas');
      const ids = await page.$$eval('#bibList .bib-doc', (els) => els.map((e) => e.dataset.id));
      await page.click('#bibSelWa');
      const todos = `${ids.length} seleccionados`;
      if ((await page.textContent('#bibSelN')) !== todos) falla(`Selección: entrar al modo no marcó lo visible (${await page.textContent('#bibSelN')}, esperaba ${todos})`);
      for (const id of ids) if (id !== 'ci-general') await page.click(`#bibList [data-id="${id}"]`);
      if (!(await page.isHidden('#bibOv'))) falla('Selección: tocar una tarjeta en el modo selección abrió la ficha');
      const claseA = await page.getAttribute('#bibList [data-id="ci-general"]', 'class');
      if (!/is-sel/.test(claseA)) falla(`Selección: la tarjeta marcada no tiene el contorno (${claseA})`);
      const n1 = await page.textContent('#bibSelN');
      if (n1 !== '1 seleccionado') falla(`Selección: el contador dice «${n1}»`);
      // Sin navigator.share (escritorio) WhatsApp y Mail mandan el enlace de cada documento.
      await page.click('#bibSelWa');
      const wa1 = decodeURIComponent(await ultimoEnlace(page));
      if (!wa1.startsWith('https://wa.me/?text=') || !wa1.includes('/biblioteca/archivos/ci-general.docx') || wa1.includes('pase-seguimiento'))
        falla(`Selección: WhatsApp con un documento no manda el elegido (${wa1})`);
      await page.click('#bibList [data-id="pase-seguimiento"]');
      await page.click('#bibSelWa');
      const wa2 = decodeURIComponent(await ultimoEnlace(page));
      if (!wa2.includes('/biblioteca/archivos/ci-general.docx') || !wa2.includes('/biblioteca/archivos/pase-seguimiento.docx'))
        falla(`Selección: WhatsApp con dos documentos no manda los dos (${wa2})`);
      await page.click('#bibSelMail');
      const mail2 = decodeURIComponent(await ultimoEnlace(page));
      if (!mail2.startsWith('mailto:?subject=') || !mail2.includes('Documentos de la Biblioteca (2)') || !mail2.includes('/biblioteca/archivos/pase-seguimiento.docx'))
        falla(`Selección: Mail con dos documentos no manda los dos (${mail2})`);
      if ((await page.textContent('#bibSelN')) !== '2 seleccionados') falla('Selección: el contador no pasó a 2');
      await page.keyboard.press('Escape');
      if (await page.$('#bibSelN')) falla('Selección: Escape no salió del modo');
      if (await page.$('#bibList .bib-doc.is-sel')) falla('Selección: Escape no quitó las marcas');

      // Con el filtro Notas, entrar al modo marca solo lo que se ve (el pase).
      await page.click('#bibChips [data-cat="notas"]');
      await page.click('#bibSelWa');
      if ((await page.textContent('#bibSelN')) !== '1 seleccionado') falla(`Selección: entrar con filtro Notas dio «${await page.textContent('#bibSelN')}»`);
      await page.keyboard.press('Escape');
      await page.click('#bibChips [data-cat="notas"]');

      await page.click('#bibList [data-id="ci-general"]');
      await page.waitForSelector('#bibOv:not([hidden])');
      const href = await page.getAttribute('#bibBajar', 'href');
      if (href !== 'biblioteca/archivos/ci-general.docx') falla(`Ficha: el enlace de descarga es ${href}`);
      // Sin navigator.share (escritorio) WhatsApp y Mail mandan el enlace absoluto del documento.
      // La ficha no ofrece WhatsApp ni Mail: el envío sale de la barra de selección.
      if (await page.$('#bibOv #bibWhats, #bibOv #bibMail')) falla('Ficha: quedaron los botones de WhatsApp o Mail');
      if (await page.$('#bibOv #bibResumen, #bibOv #bibMeta')) falla('Ficha: quedó el resumen o la línea de metadatos');
      await page.keyboard.press('Escape');
      if (!(await page.isHidden('#bibOv'))) falla('Ficha: Escape no la cerró');

      // Tarjetas: sin línea de metadatos; el título va a la derecha del número.
      if (await page.$('#bibList .bib-doc-meta')) falla('Tarjetas: quedó la línea de metadatos (bib-doc-meta)');
      const alineado = await page.$eval('#bibList .bib-doc-titulo', (e) => getComputedStyle(e).textAlign);
      if (alineado !== 'left') falla(`Tarjetas: el título no está alineado a la izquierda (text-align: ${alineado})`);

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
      await elegir(page, ['ley-7701']);
      await page.waitForSelector('#bibSelWa:not([disabled])', { timeout: 10000 });
      await page.click('#bibSelWa');
      const enviado = await page.evaluate(() => window.__compartido);
      const f = enviado && enviado.files && enviado.files[0];
      if (!f || enviado.files.length !== 1) falla(`Compartir: WhatsApp no adjuntó el archivo (${JSON.stringify(enviado)})`);
      else {
        if (f.name !== 'ley-7701-parques-y-areas-industriales.pdf') falla(`Compartir: el archivo adjunto se llama ${f.name}`);
        if (!f.size) falla('Compartir: el archivo adjunto está vacío');
        if (f.type !== 'application/pdf') falla(`Compartir: el tipo del adjunto es ${f.type}`);
      }
      if ((await page.evaluate(() => window.__abierto.length)) !== 0) falla('Compartir: con hoja del teléfono se mandó además un enlace');
      // Mail también adjunta el PDF, no el enlace.
      await page.click('#bibSelMail');
      const porMail = await page.evaluate(() => window.__compartido);
      if (!porMail || !porMail.files || porMail.files.length !== 1 || porMail.files[0].name !== 'ley-7701-parques-y-areas-industriales.pdf')
        falla(`Compartir: Mail no adjuntó el PDF (${JSON.stringify(porMail)})`);
      await ctx.close();
    }

    // Escenario E: el archivo no se puede bajar: se comparte el enlace, no un adjunto vacío.
    {
      const { ctx, page } = await abrir(FIXTURE, { share: 'stub' });
      await page.click('#tabBiblio');
      await elegir(page, ['ci-general']);
      await page.waitForSelector('#bibSelWa:not([disabled])', { timeout: 10000 });
      await page.click('#bibSelWa');
      const enviado = await page.evaluate(() => window.__compartido);
      if (enviado) falla(`Compartir sin archivo: se abrió la hoja con algo adjunto (${JSON.stringify(enviado)})`);
      const enlace = decodeURIComponent(await ultimoEnlace(page));
      if (!enlace.startsWith('https://wa.me/?text=') || !enlace.includes('/biblioteca/archivos/ci-general.docx'))
        falla(`Compartir sin archivo: el enlace de WhatsApp es ${enlace}`);
      await ctx.close();
    }

    // Escenario H: la hoja rechaza el envío: el aviso dice por qué, y no se manda un enlace en su lugar.
    {
      const { ctx, page } = await abrir(FIXTURE_REAL, { share: 'falla' });
      await page.click('#tabBiblio');
      await elegir(page, ['ley-7701']);
      await page.waitForSelector('#bibSelWa:not([disabled])', { timeout: 10000 });
      await page.click('#bibSelWa');
      await page.waitForSelector('#bibSelAviso:not([hidden])', { timeout: 5000 }).catch(() => falla('Hoja rechazada: no apareció el aviso'));
      const aviso = await page.textContent('#bibSelAviso');
      if (!/DataError/.test(aviso)) falla(`Hoja rechazada: el aviso no dice el error (${aviso})`);
      if ((await page.evaluate(() => window.__abierto.length)) !== 0) falla('Hoja rechazada: se mandó un enlace en su lugar');
      await ctx.close();
    }

    // Escenario F: selección de dos PDF reales. WhatsApp y Mail abren la hoja con los dos adjuntos.
    {
      const { ctx, page } = await abrir(FIXTURE_DOS, { share: 'stub' });
      await page.click('#tabBiblio');
      await elegir(page, ['ley-7701', 'anexo-i']);
      await page.waitForSelector('#bibSelWa:not([disabled])', { timeout: 10000 });
      await page.click('#bibSelWa');
      const porWa = await page.evaluate(() => window.__compartido);
      const nombresWa = porWa && porWa.files ? porWa.files.map((f) => f.name).sort() : null;
      const esperados = ['anexo-i-formulario-tecnico.pdf', 'ley-7701-parques-y-areas-industriales.pdf'];
      if (JSON.stringify(nombresWa) !== JSON.stringify(esperados)) falla(`Selección WhatsApp: adjuntos ${JSON.stringify(nombresWa)}`);
      else if (porWa.files.some((f) => !f.size || f.type !== 'application/pdf')) falla(`Selección WhatsApp: algún adjunto vacío o sin tipo PDF (${JSON.stringify(porWa.files)})`);
      if ((await page.evaluate(() => window.__abierto.length)) !== 0) falla('Selección WhatsApp: además se mandó un enlace');
      await page.waitForSelector('#bibSelMail:not([disabled])', { timeout: 10000 });
      await page.click('#bibSelMail');
      const porMail = await page.evaluate(() => window.__compartido);
      if (!porMail || !porMail.files || porMail.files.length !== 2) falla(`Selección Mail: no llegaron los dos adjuntos (${JSON.stringify(porMail)})`);
      else if (!/Documentos de la Biblioteca \(2\)/.test(porMail.title || '')) falla(`Selección Mail: el título es ${porMail.title}`);
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
