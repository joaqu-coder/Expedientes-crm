import worker from '../worker.js';

let llamadas = [];
const originalFetch = global.fetch;

function mockFetch(escenario) {
  global.fetch = async (url, opts) => {
    llamadas.push({ url, method: opts?.method || 'GET', body: opts?.body });
    return escenario(url, opts);
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error('FALLO: ' + msg);
  console.log('OK:', msg);
}

async function testGetSinArchivoTodavia() {
  llamadas = [];
  mockFetch(async (url) => {
    return new Response('Not Found', { status: 404 });
  });

  const req = new Request('https://x.workers.dev/api/sync', { method: 'GET' });
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('debe-usar-assets') } };

  const resp = await worker.fetch(req, env);
  const data = await resp.json();

  assert(resp.status === 200, 'GET sin archivo devuelve 200');
  assert(Array.isArray(data.expedientes) && data.expedientes.length === 0, 'expedientes vacío por defecto');
  assert(Array.isArray(data.areas) && data.areas.length === 0, 'areas vacío por defecto (el cliente pone el default)');
}

async function testPostCreaArchivoNuevo() {
  llamadas = [];
  mockFetch(async (url, opts) => {
    if (!opts || opts.method === undefined || opts.method === 'GET') {
      // GET previo para buscar sha
      return new Response('Not Found', { status: 404 });
    }
    if (opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      assert(!body.sha, 'PUT sin sha cuando el archivo no existía (crea nuevo)');
      assert(body.branch === 'main', 'PUT usa branch main');
      const contenidoDecodificado = Buffer.from(body.content, 'base64').toString('utf8');
      const datos = JSON.parse(contenidoDecodificado);
      assert(datos.expedientes.length === 1, 'el contenido subido tiene 1 expediente');
      assert(datos.expedientes[0].tema === 'Ñandú y café ☕', 'UTF-8 (ñ, tildes, emoji) se preserva en el PUT');
      return new Response(JSON.stringify({ content: { sha: 'nuevo-sha' } }), { status: 201 });
    }
    throw new Error('metodo inesperado: ' + opts.method);
  });

  const payload = {
    expedientes: [{ id: '1', numero: '(1-1/2024)', tema: 'Ñandú y café ☕' }],
    areas: ['Jurídica'],
    responsables: ['María García']
  };

  const req = new Request('https://x.workers.dev/api/sync', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('no debería llamarse') } };

  const resp = await worker.fetch(req, env);
  const data = await resp.json();
  assert(resp.status === 200 && data.ok === true, 'POST responde ok:true');
}

async function testGetConArchivoExistenteYUtf8() {
  llamadas = [];
  const datosOriginales = { expedientes: [{ id: '2', tema: 'Depto. Jurídico – Año 2026' }], areas: ['Jurídica'], responsables: [] };
  const contenidoUtf8 = JSON.stringify(datosOriginales);
  const base64 = Buffer.from(contenidoUtf8, 'utf8').toString('base64');

  mockFetch(async (url) => {
    return new Response(JSON.stringify({ sha: 'abc123', content: base64 }), { status: 200 });
  });

  const req = new Request('https://x.workers.dev/api/sync', { method: 'GET' });
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('no debería llamarse') } };

  const resp = await worker.fetch(req, env);
  const data = await resp.json();
  assert(data.expedientes[0].tema === 'Depto. Jurídico – Año 2026', 'GET decodifica UTF-8 correctamente (tildes, ú, í)');
}

async function testSirveAssetsParaOtrasRutas() {
  const req = new Request('https://x.workers.dev/index.html', { method: 'GET' });
  let llamadoAssets = false;
  const env = {
    GITHUB_TOKEN: 'fake-token',
    ASSETS: { fetch: async () => { llamadoAssets = true; return new Response('<html>ok</html>'); } }
  };
  const resp = await worker.fetch(req, env);
  assert(llamadoAssets === true, 'rutas fuera de /api/sync se sirven via env.ASSETS.fetch');
}

async function testSinTokenConfigurado() {
  const req = new Request('https://x.workers.dev/api/sync', { method: 'GET' });
  const env = { ASSETS: { fetch: async () => new Response('x') } }; // sin GITHUB_TOKEN
  const resp = await worker.fetch(req, env);
  const data = await resp.json();
  assert(resp.status === 500, 'sin GITHUB_TOKEN devuelve 500');
  assert(data.error.includes('GITHUB_TOKEN'), 'el error menciona GITHUB_TOKEN faltante');
}

// ===== /api/sync-cartas (Proyectos / Cartas de Intención) =====
// Mismo Worker y mismo GITHUB_TOKEN que /api/sync, pero escribe un archivo
// distinto (cartas-intencion.json) para no pisar expedientes.json.

async function testCartasGetSinArchivoTodavia() {
  llamadas = [];
  mockFetch(async () => new Response('Not Found', { status: 404 }));

  const req = new Request('https://x.workers.dev/api/sync-cartas', { method: 'GET' });
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('debe-usar-assets') } };

  const resp = await worker.fetch(req, env);
  const data = await resp.json();

  assert(resp.status === 200, 'GET /api/sync-cartas sin archivo devuelve 200');
  assert(Array.isArray(data.expedientes) && data.expedientes.length === 0, 'expedientes vacío por defecto');
  assert(data.plazoDias === 90, 'plazoDias default es 90');
}

async function testCartasPostEscribeArchivoPropio() {
  llamadas = [];
  mockFetch(async (url, opts) => {
    if (!opts || opts.method === undefined || opts.method === 'GET') {
      assert(String(url).includes('cartas-intencion.json'), 'el GET previo apunta a cartas-intencion.json');
      return new Response('Not Found', { status: 404 });
    }
    if (opts.method === 'PUT') {
      assert(String(url).includes('cartas-intencion.json'), 'el PUT escribe en cartas-intencion.json, no expedientes.json');
      const body = JSON.parse(opts.body);
      const contenidoDecodificado = Buffer.from(body.content, 'base64').toString('utf8');
      const datos = JSON.parse(contenidoDecodificado);
      assert(datos.expedientes[0].nombre_empresa === 'Ñandú S.A.', 'UTF-8 (ñ) se preserva en el PUT');
      return new Response(JSON.stringify({ content: { sha: 'nuevo-sha' } }), { status: 201 });
    }
    throw new Error('metodo inesperado: ' + opts.method);
  });

  const payload = { expedientes: [{ id: '1', nombre_empresa: 'Ñandú S.A.' }], plazoDias: 90 };
  const req = new Request('https://x.workers.dev/api/sync-cartas', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('no debería llamarse') } };

  const resp = await worker.fetch(req, env);
  const data = await resp.json();
  assert(resp.status === 200 && data.ok === true, 'POST /api/sync-cartas responde ok:true');
}

async function testSyncYCartasNoSeMezclan() {
  llamadas = [];
  mockFetch(async () => new Response('Not Found', { status: 404 }));

  const envSinToken = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('x') } };
  await worker.fetch(new Request('https://x.workers.dev/api/sync', { method: 'GET' }), envSinToken);
  await worker.fetch(new Request('https://x.workers.dev/api/sync-cartas', { method: 'GET' }), envSinToken);

  const archivosConsultados = llamadas.map((l) => String(l.url));
  assert(archivosConsultados.some((u) => u.includes('/expedientes.json')), '/api/sync consultó expedientes.json');
  assert(archivosConsultados.some((u) => u.includes('/cartas-intencion.json')), '/api/sync-cartas consultó cartas-intencion.json');
}

async function main() {
  await testGetSinArchivoTodavia();
  await testPostCreaArchivoNuevo();
  await testGetConArchivoExistenteYUtf8();
  await testSirveAssetsParaOtrasRutas();
  await testSinTokenConfigurado();
  await testCartasGetSinArchivoTodavia();
  await testCartasPostEscribeArchivoPropio();
  await testSyncYCartasNoSeMezclan();
  console.log('\n✅ TODOS LOS TESTS PASARON');
}

main().catch((e) => {
  console.error('\n❌ TEST FALLÓ:', e.message);
  process.exit(1);
}).finally(() => { global.fetch = originalFetch; });
