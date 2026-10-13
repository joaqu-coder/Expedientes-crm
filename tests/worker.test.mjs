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

// ===== /api/sync-cartas y /api/version-cartas (Proyectos / Cartas de Intención) =====
// Protocolo más rico que /api/sync: sondeo de versión + concurrencia
// optimista (409 con el contenido actual en vez de pisar en silencio).
// Portado de joaqu-coder/Parques-Industriales, donde se armó y probó.

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
  assert(data._meta.existe === false, '_meta.existe es false cuando el archivo no existe todavía');
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
      assert(!('_baseSha' in datos) && !('_meta' in datos), '_baseSha/_meta nunca se escriben en el archivo');
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

async function testCartasConflicto409() {
  llamadas = [];
  const actuales = { expedientes: [{ id: '1', nombre_empresa: 'Original S.A.' }], plazoDias: 90 };
  const base64 = Buffer.from(JSON.stringify(actuales), 'utf8').toString('base64');
  mockFetch(async () => new Response(JSON.stringify({ sha: 'sha-servidor', content: base64 }), { status: 200 }));

  const payload = { expedientes: [{ id: '1', nombre_empresa: 'Editado localmente' }], plazoDias: 90, _baseSha: 'sha-viejo' };
  const req = new Request('https://x.workers.dev/api/sync-cartas', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('no debería llamarse') } };

  const resp = await worker.fetch(req, env);
  const data = await resp.json();
  assert(resp.status === 409, 'sha base distinto del sha del servidor devuelve 409');
  assert(data.error === 'conflicto', 'el 409 trae error:"conflicto"');
  assert(data.actual.expedientes[0].nombre_empresa === 'Original S.A.', 'el 409 trae el contenido actual del servidor para fusionar');
}

async function testCartasValidacionRechazaDatosRotos() {
  llamadas = [];
  const req = new Request('https://x.workers.dev/api/sync-cartas', {
    method: 'POST',
    body: JSON.stringify({ expedientes: 'no-es-un-array' })
  });
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('no debería llamarse') } };

  const resp = await worker.fetch(req, env);
  const data = await resp.json();
  assert(resp.status === 422, "'expedientes' no-array se rechaza con 422, nunca se llega a escribir");
  assert(data.error === 'Datos rechazados', 'el 422 explica el motivo');
}

async function testCartasVersion() {
  llamadas = [];
  mockFetch(async (url) => {
    assert(String(url).includes('/contents?ref=main'), '/api/version-cartas lista el directorio raíz, no pide el archivo entero');
    return new Response(JSON.stringify([
      { name: 'cartas-intencion.json', sha: 'sha-del-blob' },
      { name: 'expedientes.json', sha: 'otro-sha' }
    ]), { status: 200 });
  });

  const req = new Request('https://x.workers.dev/api/version-cartas', { method: 'GET' });
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('no debería llamarse') } };

  const resp = await worker.fetch(req, env);
  const data = await resp.json();
  assert(data.version === 'sha-del-blob', '/api/version-cartas devuelve el sha del blob, no del commit');
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

// ===== /api/sync-parques (Parques — lotes/empresas de Güemes) =====
// Protocolo simple, igual que /api/sync y /api/sync-resoluciones.

async function testParquesGetSinArchivoTodavia() {
  llamadas = [];
  mockFetch(async () => new Response('Not Found', { status: 404 }));

  const req = new Request('https://x.workers.dev/api/sync-parques', { method: 'GET' });
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('debe-usar-assets') } };

  const resp = await worker.fetch(req, env);
  const data = await resp.json();

  assert(resp.status === 200, 'GET /api/sync-parques sin archivo devuelve 200');
  assert(data.parque === 'Güemes', "el default trae parque:'Güemes'");
  assert(Array.isArray(data.lotes) && data.lotes.length === 0, 'lotes vacío por defecto');
  assert(Array.isArray(data.empresas) && data.empresas.length === 0, 'empresas vacío por defecto');
}

async function testParquesPostEscribeArchivoPropio() {
  llamadas = [];
  mockFetch(async (url, opts) => {
    if (!opts || opts.method === undefined || opts.method === 'GET') {
      assert(String(url).includes('parques.json'), 'el GET previo apunta a parques.json');
      return new Response('Not Found', { status: 404 });
    }
    if (opts.method === 'PUT') {
      assert(String(url).includes('parques.json'), 'el PUT escribe en parques.json');
      const body = JSON.parse(opts.body);
      const contenidoDecodificado = Buffer.from(body.content, 'base64').toString('utf8');
      const datos = JSON.parse(contenidoDecodificado);
      assert(datos.empresas[0].nombre_empresa === 'V8 PRODUCTOS DE HORMIGÓN', 'UTF-8 (Ó) se preserva en el PUT');
      return new Response(JSON.stringify({ content: { sha: 'nuevo-sha' } }), { status: 201 });
    }
    throw new Error('metodo inesperado: ' + opts.method);
  });

  const payload = {
    parque: 'Güemes',
    empresas: [{ id_empresa: 'E001', nombre_empresa: 'V8 PRODUCTOS DE HORMIGÓN' }],
    lotes: [{ id_lote: 'L001', id_empresa: 'E001' }],
    ocupaciones: [],
    reservas: []
  };
  const req = new Request('https://x.workers.dev/api/sync-parques', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('no debería llamarse') } };

  const resp = await worker.fetch(req, env);
  const data = await resp.json();
  assert(resp.status === 200 && data.ok === true, 'POST /api/sync-parques responde ok:true');
}

async function testParquesNoSeMezclaConOtrasApps() {
  llamadas = [];
  mockFetch(async () => new Response('Not Found', { status: 404 }));

  const envSinToken = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('x') } };
  await worker.fetch(new Request('https://x.workers.dev/api/sync-parques', { method: 'GET' }), envSinToken);

  const archivosConsultados = llamadas.map((l) => String(l.url));
  assert(archivosConsultados.some((u) => u.includes('/parques.json')), '/api/sync-parques consultó parques.json, no otro archivo');
}

async function main() {
  await testGetSinArchivoTodavia();
  await testPostCreaArchivoNuevo();
  await testGetConArchivoExistenteYUtf8();
  await testSirveAssetsParaOtrasRutas();
  await testSinTokenConfigurado();
  await testCartasGetSinArchivoTodavia();
  await testCartasPostEscribeArchivoPropio();
  await testCartasConflicto409();
  await testCartasValidacionRechazaDatosRotos();
  await testCartasVersion();
  await testSyncYCartasNoSeMezclan();
  await testParquesGetSinArchivoTodavia();
  await testParquesPostEscribeArchivoPropio();
  await testParquesNoSeMezclaConOtrasApps();
  console.log('\n✅ TODOS LOS TESTS PASARON');
}

main().catch((e) => {
  console.error('\n❌ TEST FALLÓ:', e.message);
  process.exit(1);
}).finally(() => { global.fetch = originalFetch; });
