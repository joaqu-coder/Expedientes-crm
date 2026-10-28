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
  assert(data.sha === 'nuevo-sha', 'POST /api/sync-cartas devuelve el sha nuevo para que el cliente no mande un _baseSha viejo');
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

// plazosEtapas (menú ⋮ de Proyectos) lo leen las dos apps: un valor roto no puede llegar al archivo.
async function testCartasValidaPlazosEtapas() {
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('no debería llamarse') } };
  const malos = {
    'no es un array': 'x',
    'una etapa fuera de 1..9': [{ etapa: 10, nombre: 'X', dias: 5 }],
    'dias negativos': [{ etapa: 1, nombre: 'Carta', dias: -3 }],
    'dias sobre el tope': [{ etapa: 1, nombre: 'Carta', dias: 5000 }],
    'dias no entero': [{ etapa: 1, nombre: 'Carta', dias: 2.5 }]
  };
  for (const [queEs, plazosEtapas] of Object.entries(malos)) {
    llamadas = [];
    mockFetch(async () => { throw new Error('no debería llegar a GitHub'); });
    const resp = await worker.fetch(new Request('https://x.workers.dev/api/sync-cartas', {
      method: 'POST', body: JSON.stringify({ expedientes: [], plazosEtapas })
    }), env);
    assert(resp.status === 422, `plazosEtapas que ${queEs} se rechaza con 422 (dio ${resp.status})`);
  }
  llamadas = [];
  mockFetch(async (url, opts) => {
    if (!opts || opts.method === 'GET' || !opts.method) return new Response('', { status: 404 });
    return new Response(JSON.stringify({ content: { sha: 'n' } }), { status: 201 });
  });
  const bien = [{ etapa: 1, nombre: 'Carta de intención', dias: 7 }, { etapa: 8, nombre: 'Procedimiento de venta', dias: null }];
  const resp = await worker.fetch(new Request('https://x.workers.dev/api/sync-cartas', {
    method: 'POST', body: JSON.stringify({ expedientes: [], plazosEtapas: bien })
  }), env);
  assert(resp.status === 200, `plazosEtapas válido (con null = sin plazo) se acepta (dio ${resp.status})`);
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

// Las bajas de Parques son permanentes: una copia vieja no resucita lo borrado.
async function testParquesBajasSeUnenYNoResucitan() {
  llamadas = [];
  const remoto = {
    parques: [{ id: 'guemes', nombre: 'Güemes' }],
    empresas: [{ id_empresa: 'E001', nombre_empresa: 'V8' }],
    lotes: [{ id_lote: 'L001', id_empresa: 'E001' }],
    ocupaciones: [{ id: 1, id_lote: 'L002', id_empresa_ocupante: 'E009' }],
    eliminados: { empresas: ['E009'], lotes: [] }
  };
  let escrito = null;
  mockFetch(async (url, opts) => {
    if (!opts || opts.method === undefined || opts.method === 'GET') {
      const content = Buffer.from(JSON.stringify(remoto), 'utf8').toString('base64');
      return new Response(JSON.stringify({ sha: 'sha-base', content }), { status: 200 });
    }
    if (opts.method === 'PUT') {
      escrito = JSON.parse(Buffer.from(JSON.parse(opts.body).content, 'base64').toString('utf8'));
      return new Response(JSON.stringify({ content: { sha: 'nuevo' } }), { status: 201 });
    }
    throw new Error('metodo inesperado: ' + opts.method);
  });
  // Lo que manda un dispositivo viejo: todavía tiene E009 y L002 (ocupado por E009)
  // y, en cambio, acaba de dar de baja L001.
  const payload = {
    parques: [{ id: 'guemes', nombre: 'Güemes' }],
    empresas: [{ id_empresa: 'E001' }, { id_empresa: 'E009' }],
    lotes: [{ id_lote: 'L001' }, { id_lote: 'L002' }],
    ocupaciones: [{ id: 1, id_lote: 'L002', id_empresa_ocupante: 'E009' }],
    reservas: [],
    eliminados: { empresas: [], lotes: ['L001'] }
  };
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('x') } };
  const resp = await worker.fetch(new Request('https://x.workers.dev/api/sync-parques', { method: 'POST', body: JSON.stringify(payload) }), env);
  assert(resp.status === 200, 'POST con bajas responde 200');
  assert(!escrito.empresas.some((e) => e.id_empresa === 'E009'), 'E009 (dada de baja en GitHub) no vuelve con la copia vieja');
  assert(!escrito.lotes.some((l) => l.id_lote === 'L001'), 'L001 (baja del dispositivo) sale del archivo');
  assert(escrito.lotes.some((l) => l.id_lote === 'L002'), 'un lote que no fue dado de baja se conserva');
  assert(escrito.ocupaciones.length === 0, 'la ocupación de una empresa dada de baja tampoco vuelve');
  assert(escrito.eliminados.empresas.includes('E009') && escrito.eliminados.lotes.includes('L001'), 'las bajas se unen y quedan guardadas');
  assert(escrito.empresas.some((e) => e.id_empresa === 'E001'), 'lo que no se dio de baja queda intacto');
}

async function testParquesNoSeMezclaConOtrasApps() {
  llamadas = [];
  mockFetch(async () => new Response('Not Found', { status: 404 }));

  const envSinToken = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('x') } };
  await worker.fetch(new Request('https://x.workers.dev/api/sync-parques', { method: 'GET' }), envSinToken);

  const archivosConsultados = llamadas.map((l) => String(l.url));
  assert(archivosConsultados.some((u) => u.includes('/parques.json')), '/api/sync-parques consultó parques.json, no otro archivo');
}


// ---------------------------------------------------------------------------
// Validación de forma en las apps del protocolo simple
// ---------------------------------------------------------------------------
// Hasta el 2026-10-19 `manejarSync` escribía en GitHub lo que viniera: un
// POST de cuatro bytes reemplazaba las 422 resoluciones y devolvía 200.
// Se verifica app por app porque el bug era justamente que la defensa
// existía en UNA sola (/api/sync-cartas).
async function testValidacionDeFormaEnLasTresApps() {
  const CASOS = [
    ['/api/sync', 'expedientes.json', { expedientes: [], areas: [], responsables: [] }],
    ['/api/sync-resoluciones', 'resoluciones.json', { resoluciones: [] }],
    ['/api/sync-parques', 'parques.json', { empresas: [], lotes: [], ocupaciones: [], reservas: [] }]
  ];
  const BASURA = [
    [{ hola: 'mundo' }, 'un objeto con otras claves'],
    [[], 'un array'],
    [null, 'null'],
    ['texto', 'un string'],
    [{ expedientes: 'no soy un array', resoluciones: 'tampoco', empresas: 1 }, 'claves presentes pero no arrays']
  ];

  for (const [ruta, archivo, valido] of CASOS) {
    for (const [cuerpo, queEs] of BASURA) {
      llamadas = [];
      mockFetch(async () => new Response(JSON.stringify({
        sha: 'sha-1', content: Buffer.from(JSON.stringify({ real: true }), 'utf8').toString('base64')
      }), { status: 200 }));
      const resp = await worker.fetch(new Request('https://x.workers.dev' + ruta, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo)
      }), { GITHUB_TOKEN: 'fake', ASSETS: { fetch: async () => new Response('x') } });
      const escribio = llamadas.some((l) => l.method === 'PUT');
      assert(resp.status === 422 && !escribio,
        `${ruta} rechaza ${queEs} con 422 y NO escribe ${archivo} (dio ${resp.status}, PUT=${escribio})`);
    }

    // Y lo válido sigue pasando: una validación que rechaza todo no sirve.
    llamadas = [];
    mockFetch(async (url, opts) => {
      if ((opts?.method || 'GET') === 'GET') return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify({ content: { sha: 'nuevo' } }), { status: 201 });
    });
    const ok = await worker.fetch(new Request('https://x.workers.dev' + ruta, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valido)
    }), { GITHUB_TOKEN: 'fake', ASSETS: { fetch: async () => new Response('x') } });
    assert(ok.status === 200 && llamadas.some((l) => l.method === 'PUT'),
      `${ruta} sigue aceptando un cuerpo bien formado (dio ${ok.status})`);
  }
}

// ---------------------------------------------------------------------------
// Clave compartida
// ---------------------------------------------------------------------------
async function testClaveCompartida() {
  const RUTAS = ['/api/sync', '/api/sync-resoluciones', '/api/sync-parques',
                 '/api/sync-cartas', '/api/version-cartas'];
  const contenidoOk = async () => new Response(JSON.stringify({
    sha: 'sha-1', content: Buffer.from(JSON.stringify({ expedientes: [] }), 'utf8').toString('base64')
  }), { status: 200 });

  // 1. Sin secret cargado: modo transición, todo pasa como antes. Es lo que
  //    evita que este deploy deje afuera a quien usa la app todos los días.
  for (const ruta of RUTAS) {
    mockFetch(contenidoOk);
    const r = await worker.fetch(new Request('https://x.workers.dev' + ruta),
      { GITHUB_TOKEN: 'fake', ASSETS: { fetch: async () => new Response('x') } });
    assert(r.status !== 401, `sin APP_CLAVE configurada, ${ruta} no pide clave (dio ${r.status})`);
  }

  // 2. Con secret cargado: sin cabecera, 401 y NO se toca GitHub.
  const env = { GITHUB_TOKEN: 'fake', APP_CLAVE: 'la-clave-buena', ASSETS: { fetch: async () => new Response('x') } };
  for (const ruta of RUTAS) {
    llamadas = [];
    mockFetch(contenidoOk);
    const r = await worker.fetch(new Request('https://x.workers.dev' + ruta), env);
    assert(r.status === 401 && llamadas.length === 0,
      `con APP_CLAVE, ${ruta} sin clave da 401 y ni consulta GitHub (dio ${r.status}, ${llamadas.length} llamadas)`);
  }

  // 3. Un POST sin clave tampoco escribe: es el borrado remoto que se cierra.
  llamadas = [];
  mockFetch(contenidoOk);
  const borrado = await worker.fetch(new Request('https://x.workers.dev/api/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expedientes: [], areas: [], responsables: [] })
  }), env);
  assert(borrado.status === 401 && !llamadas.some((l) => l.method === 'PUT'),
    `con APP_CLAVE, un POST sin clave no vacía el archivo (dio ${borrado.status})`);

  // 4. Clave equivocada: 401. Clave correcta: pasa.
  mockFetch(contenidoOk);
  const mala = await worker.fetch(new Request('https://x.workers.dev/api/sync',
    { headers: { 'X-Clave': 'la-clave-mala' } }), env);
  assert(mala.status === 401, `una clave equivocada da 401 (dio ${mala.status})`);

  mockFetch(contenidoOk);
  const buena = await worker.fetch(new Request('https://x.workers.dev/api/sync',
    { headers: { 'X-Clave': 'la-clave-buena' } }), env);
  assert(buena.status === 200, `la clave correcta pasa (dio ${buena.status})`);

  // 5. Mismo largo pero distinta: la comparación de tiempo constante tiene
  //    que seguir comparando bien, no solo rápido.
  mockFetch(contenidoOk);
  const mismoLargo = await worker.fetch(new Request('https://x.workers.dev/api/sync',
    { headers: { 'X-Clave': 'la-clave-buenX' } }), env);
  assert(mismoLargo.status === 401, `una clave del mismo largo pero distinta da 401 (dio ${mismoLargo.status})`);

  // 6. /api/health queda abierta —no expone datos— y dice en qué modo está.
  //    Si alguna vez dice auth_activa:false en producción, el agujero está abierto.
  mockFetch(contenidoOk);
  const salud = await worker.fetch(new Request('https://x.workers.dev/api/health'), env);
  const cuerpoSalud = await salud.json();
  assert(salud.status === 200 && cuerpoSalud.auth_activa === true,
    '/api/health responde sin clave y reporta auth_activa:true');
  mockFetch(contenidoOk);
  const saludAbierta = await worker.fetch(new Request('https://x.workers.dev/api/health'),
    { GITHUB_TOKEN: 'fake', ASSETS: { fetch: async () => new Response('x') } });
  assert((await saludAbierta.json()).auth_activa === false,
    '/api/health reporta auth_activa:false cuando el secret no está cargado');

  // 7. Los estáticos no piden clave: son la cáscara de la app, el dato está
  //    detrás de /api/. Pedirla acá dejaría una pantalla en blanco.
  mockFetch(contenidoOk);
  const estatico = await worker.fetch(new Request('https://x.workers.dev/parques.html'), env);
  assert(estatico.status === 200, 'los archivos estáticos se sirven sin clave');
}

// Parques usa concurrencia optimista (como Proyectos): si el archivo cambió
// desde la base que mandó el cliente, responde 409 con el contenido actual y
// NO escribe. Sin esto, dos dispositivos se pisaban en silencio.
async function testParquesConflicto409() {
  llamadas = [];
  const remoto = { parques: [{ id: 'guemes', nombre: 'Güemes' }], empresas: [{ id_empresa: 'E001', nombre_empresa: 'REMOTA' }], lotes: [], ocupaciones: [], reservas: [], eliminados: { empresas: [], lotes: [] } };
  let putHecho = false;
  mockFetch(async (url, opts) => {
    if (!opts || opts.method === undefined || opts.method === 'GET') {
      const contenido = Buffer.from(JSON.stringify(remoto)).toString('base64');
      return new Response(JSON.stringify({ sha: 'sha-nuevo', content: contenido }), { status: 200 });
    }
    if (opts.method === 'PUT') { putHecho = true; return new Response(JSON.stringify({ content: { sha: 'sha-escrito' } }), { status: 200 }); }
    throw new Error('metodo inesperado: ' + opts.method);
  });
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('no') } };

  const req = new Request('https://x.workers.dev/api/sync-parques', {
    method: 'POST',
    body: JSON.stringify({ parques: [], empresas: [], lotes: [], ocupaciones: [], reservas: [], _baseSha: 'sha-viejo' })
  });
  const resp = await worker.fetch(req, env);
  const data = await resp.json();
  assert(resp.status === 409, 'POST con base vieja responde 409');
  assert(data.actual && data.actual.empresas[0].nombre_empresa === 'REMOTA', 'el 409 trae el contenido actual para fusionar');
  assert(data.actual._meta && data.actual._meta.sha === 'sha-nuevo', 'el 409 trae el sha actual');
  assert(!putHecho, 'con conflicto no se escribe nada en GitHub');

  // Con la base correcta, sí escribe y devuelve el sha nuevo.
  putHecho = false;
  const req2 = new Request('https://x.workers.dev/api/sync-parques', {
    method: 'POST',
    body: JSON.stringify({ parques: [], empresas: [], lotes: [], ocupaciones: [], reservas: [], _baseSha: 'sha-nuevo' })
  });
  const resp2 = await worker.fetch(req2, env);
  assert(resp2.status === 200 && putHecho, 'con la base actual escribe y responde 200');
}

// Seguimiento (/api/sync) también usa concurrencia optimista desde el 2026-10-22:
// antes era última-escritura-gana y un dispositivo pisaba el trabajo del otro.
async function testSeguimientoConflicto409() {
  llamadas = [];
  const remoto = { expedientes: [{ id: '1', tema: 'REMOTO' }], areas: ['Jurídica'], responsables: ['Ana'] };
  let putHecho = false;
  mockFetch(async (url, opts) => {
    if (!opts || opts.method === undefined || opts.method === 'GET') {
      const contenido = Buffer.from(JSON.stringify(remoto)).toString('base64');
      return new Response(JSON.stringify({ sha: 'sha-nuevo', content: contenido }), { status: 200 });
    }
    if (opts.method === 'PUT') { putHecho = true; return new Response(JSON.stringify({ content: { sha: 'sha-escrito' } }), { status: 200 }); }
    throw new Error('metodo inesperado: ' + opts.method);
  });
  const env = { GITHUB_TOKEN: 'fake-token', ASSETS: { fetch: async () => new Response('no') } };
  const post = (base) => new Request('https://x.workers.dev/api/sync', {
    method: 'POST',
    body: JSON.stringify({ expedientes: [], areas: [], responsables: [], _baseSha: base })
  });

  const get = await (await worker.fetch(new Request('https://x.workers.dev/api/sync'), env)).json();
  assert(get._meta && get._meta.sha === 'sha-nuevo', 'el GET de /api/sync trae el sha para la base del cliente');

  const resp = await worker.fetch(post('sha-viejo'), env);
  const data = await resp.json();
  assert(resp.status === 409, 'POST de Seguimiento con base vieja responde 409');
  assert(data.actual && data.actual.expedientes[0].tema === 'REMOTO', 'el 409 trae el contenido actual para fusionar');
  assert(!putHecho, 'con conflicto no se escribe nada en GitHub');

  const resp2 = await worker.fetch(post('sha-nuevo'), env);
  const data2 = await resp2.json();
  assert(resp2.status === 200 && putHecho, 'con la base actual escribe y responde 200');
  assert(data2.sha === 'sha-escrito', 'devuelve el sha nuevo para que el cliente lo tome como base');
}

// /api/health avisa antes del límite de 1 MB de la API de Contents de GitHub:
// un archivo por encima de 700 KB aparece en alerta_tamano.
async function testHealthAvisaArchivoGrande() {
  const listado = (tamResol) => [
    { type: 'file', name: 'expedientes.json', size: 6000 },
    { type: 'file', name: 'resoluciones.json', size: tamResol },
    { type: 'file', name: 'cartas-intencion.json', size: 130000 },
    { type: 'file', name: 'parques.json', size: 240000 },
    { type: 'file', name: 'README.md', size: 100 }
  ];
  const env = { GITHUB_TOKEN: 'fake', ASSETS: { fetch: async () => new Response('x') } };

  mockFetch(async (url) => {
    if (String(url).endsWith('/contents?ref=main')) return new Response(JSON.stringify(listado(322000)), { status: 200 });
    throw new Error('url inesperada: ' + url);
  });
  const normal = await (await worker.fetch(new Request('https://x.workers.dev/api/health'), env)).json();
  assert(Array.isArray(normal.alerta_tamano) && normal.alerta_tamano.length === 0,
    'con resoluciones de 322 KB no hay alerta de tamaño');
  assert(normal.tamanos_kb && normal.tamanos_kb['resoluciones.json'] === 314,
    'reporta el tamaño en KB de cada archivo de datos');

  mockFetch(async (url) => {
    if (String(url).endsWith('/contents?ref=main')) return new Response(JSON.stringify(listado(750 * 1024)), { status: 200 });
    throw new Error('url inesperada: ' + url);
  });
  const grande = await (await worker.fetch(new Request('https://x.workers.dev/api/health'), env)).json();
  assert(grande.alerta_tamano.includes('resoluciones.json'),
    'con resoluciones de 750 KB aparece en alerta_tamano');
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
  await testCartasValidaPlazosEtapas();
  await testCartasVersion();
  await testSyncYCartasNoSeMezclan();
  await testParquesGetSinArchivoTodavia();
  await testParquesPostEscribeArchivoPropio();
  await testParquesBajasSeUnenYNoResucitan();
  await testParquesConflicto409();
  await testSeguimientoConflicto409();
  await testHealthAvisaArchivoGrande();
  await testParquesNoSeMezclaConOtrasApps();
  await testValidacionDeFormaEnLasTresApps();
  await testClaveCompartida();
  console.log('\n✅ TODOS LOS TESTS PASARON');
}

main().catch((e) => {
  console.error('\n❌ TEST FALLÓ:', e.message);
  process.exit(1);
}).finally(() => { global.fetch = originalFetch; });
