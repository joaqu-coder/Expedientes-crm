/*
 * Worker — Expedientes CRM
 *
 * Sirve los archivos estáticos de public/ (landing + tres apps: Seguimiento,
 * Proyectos y Resoluciones) y expone los endpoints de sync, sin exponer
 * ningún token al navegador. El token vive SOLO como secret de Cloudflare
 * (GITHUB_TOKEN), configurado en el dashboard, nunca en el código. Las tres
 * apps comparten el mismo Worker y el mismo token; cada una escribe su
 * propio archivo en este repo.
 *
 * GET  /api/sync              -> devuelve expedientes.json (Seguimiento)
 * POST /api/sync              -> sobreescribe expedientes.json
 * GET  /api/sync-resoluciones -> devuelve resoluciones.json (Resoluciones)
 * POST /api/sync-resoluciones -> sobreescribe resoluciones.json
 * GET  /api/sync-parques      -> devuelve parques.json (Parques — lotes/empresas de Güemes)
 * POST /api/sync-parques      -> sobreescribe parques.json
 * GET  /api/version-cartas    -> sha de cartas-intencion.json, para el sondeo
 * GET  /api/sync-cartas       -> devuelve cartas-intencion.json (Proyectos)
 * POST /api/sync-cartas       -> sobreescribe cartas-intencion.json (con
 *                                 concurrencia optimista — ver manejarSyncCartas)
 *
 * Proyectos usa un protocolo más rico que las otras dos apps (sondeo de
 * versión + fusión sin pérdidas en vez de "última escritura gana"), portado
 * del repo joaqu-coder/Parques-Industriales donde se armó y probó. No se le
 * bajó el nivel a Seguimiento/Resoluciones; si algún día lo necesitan, es
 * generalizar esto, no repetirlo.
 *
 * Cualquier otra ruta se sirve como archivo estático desde public/.
 */

// Se incrementa a mano para confirmar qué versión está viva en producción.
const WORKER_VERSION = 'auth-1';

const GITHUB_OWNER = 'joaqu-coder';
const GITHUB_REPO = 'Expedientes-crm';
const GITHUB_BRANCH = 'main';

// Una entrada por app: el archivo que guarda en este repo y el valor por
// defecto que devuelve GET cuando ese archivo todavía no existe.
const APPS = {
  '/api/sync': {
    archivo: 'expedientes.json',
    nombre: 'expedientes',
    vacio: { expedientes: [], areas: [], responsables: [] },
    // Concurrencia optimista (como Proyectos y Parques): 409 con el contenido
    // actual si otro dispositivo guardó en el medio. Sin esto era "última
    // escritura gana" y el trabajo del primero desaparecía en silencio.
    conflictos: true
  },
  '/api/sync-resoluciones': {
    archivo: 'resoluciones.json',
    nombre: 'resoluciones',
    vacio: { resoluciones: [] }
  },
  '/api/sync-parques': {
    archivo: 'parques.json',
    nombre: 'parques',
    vacio: { parque: 'Güemes', empresas: [], lotes: [], ocupaciones: [], reservas: [] },
    // Las bajas son permanentes hasta que alguien las deshaga a mano: una
    // copia vieja de otro dispositivo no puede resucitar lo que se borró.
    bajas: true,
    // Concurrencia optimista (como Proyectos): el cliente manda el sha sobre
    // el que trabajó; si el archivo cambió, se responde 409 con el contenido
    // actual para que el cliente fusione en vez de pisarlo.
    conflictos: true
  }
};

// Valida la forma de lo que llega, para las apps del protocolo simple.
//
// Hasta el 2026-10-19 `manejarSync` escribía en GitHub lo que viniera: un
// `POST {"hola":"mundo"}` reemplazaba las 422 resoluciones y devolvía 200.
// `manejarSyncCartas` ya tenía `validarCartas` y su comentario lo decía
// textual — "sin esto, un POST con cualquier JSON sobreescribe el archivo
// entero con basura"—, pero la defensa se había escrito para una sola app.
//
// Las claves obligatorias NO se listan a mano: salen del `vacio` de cada app,
// que ya declara la forma. Si mañana se agrega una app con
// `vacio: { cosas: [] }`, su POST queda obligado a traer `cosas` como array
// sin tocar esta función.
function validarFormaApp(datos, app) {
  if (datos === null || typeof datos !== 'object' || Array.isArray(datos)) {
    return 'El cuerpo debe ser un objeto JSON.';
  }
  const faltan = Object.keys(app.vacio)
    .filter((k) => Array.isArray(app.vacio[k]))
    .filter((k) => !Array.isArray(datos[k]));
  if (faltan.length) {
    return `Faltan, o no son arrays, estas claves: ${faltan.join(', ')}.`;
  }
  return null;
}

// ===== Clave compartida =====
//
// Hasta el 2026-10-19 cualquiera que supiera la URL podía leer los
// expedientes (que tienen datos personales) y, con un POST, vaciar las cuatro
// bases. El GITHUB_TOKEN estaba bien guardado; la puerta que lo usa estaba
// abierta.
//
// MODO TRANSICIÓN, a propósito: si el secret `APP_CLAVE` no está cargado en
// Cloudflare, el Worker se comporta como antes y deja pasar todo. Así este
// deploy no deja afuera a nadie de una app que se usa todos los días. La
// protección se enciende sola en cuanto cargues el secret, y `/api/health`
// dice en qué modo está. Mientras diga `auth_activa: false`, el agujero sigue
// abierto — no es un detalle de configuración, es LA mitad del arreglo.
const CABECERA_CLAVE = 'X-Clave';

// Comparación de tiempo constante. Un `===` filtra, por lo que tarda, cuántos
// caracteres coinciden. Sobre la red es poco práctico de explotar, pero son
// seis líneas y saca la duda.
function clavesIguales(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

// Devuelve una Response si hay que cortar, o null si puede seguir.
function rechazarSiNoAutorizado(request, env) {
  if (!env.APP_CLAVE) return null; // modo transición: sin secret, sin puerta
  const enviada = request.headers.get(CABECERA_CLAVE);
  if (enviada && clavesIguales(enviada, env.APP_CLAVE)) return null;
  return jsonResponse({
    error: 'clave_invalida',
    detalle: enviada ? 'La clave no es correcta.' : 'Esta app necesita una clave.'
  }, 401);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function githubGetFile(token, archivo) {
  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${archivo}?ref=${GITHUB_BRANCH}`,
    {
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'expedientes-crm-worker',
        'Accept': 'application/vnd.github+json'
      }
    }
  );
  if (resp.status === 404) return { sha: null, datos: null };
  if (!resp.ok) throw new Error(`GitHub GET falló: ${resp.status} ${await resp.text()}`);

  const file = await resp.json();
  // decodeURIComponent(escape(...)) para no romper tildes/ñ/emojis del contenido
  const contenido = decodeURIComponent(escape(atob(file.content.replace(/\n/g, ''))));
  return { sha: file.sha, datos: JSON.parse(contenido) };
}

async function githubPutFile(token, archivo, nombre, datos, sha) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(datos, null, 2))));

  const payload = {
    message: `sync: ${nombre} ${new Date().toISOString()}`,
    content,
    branch: GITHUB_BRANCH
  };
  if (sha) payload.sha = sha;

  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${archivo}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'expedientes-crm-worker',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  if (!resp.ok) throw new Error(`GitHub PUT falló: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

// ===== Proyectos (cartas de intención) =====
// Validación de forma: sin esto, un POST con cualquier JSON sobreescribe el
// archivo entero con basura. Las lápidas ('eliminados') se validan igual que
// los expedientes porque viajan en el mismo archivo y una lápida corrupta
// rompe la fusión en todos los dispositivos. Portado de Parques-Industriales.
const ARCHIVO_CARTAS = 'cartas-intencion.json';
const CARTAS_VACIO = { expedientes: [], plazoDias: 90 };

function validarCartas(datos) {
  if (datos === null || typeof datos !== 'object' || Array.isArray(datos)) {
    return 'El cuerpo debe ser un objeto JSON.';
  }
  if (!Array.isArray(datos.expedientes)) return "Falta el array 'expedientes'.";
  if (datos.expedientes.some((e) => e === null || typeof e !== 'object' || Array.isArray(e))) {
    return 'Cada expediente debe ser un objeto.';
  }
  if (datos.eliminados != null) {
    if (!Array.isArray(datos.eliminados)) return "'eliminados' debe ser un array.";
    if (datos.eliminados.some((t) => !t || typeof t !== 'object' || typeof t.id !== 'string' || isNaN(Date.parse(t.en)))) {
      return "Cada entrada de 'eliminados' debe ser {id, en} con una fecha válida.";
    }
  }
  if (datos.plazoDias != null) {
    const p = Number(datos.plazoDias);
    if (!Number.isFinite(p) || p < 1 || p > 3650) return "'plazoDias' debe ser un número entre 1 y 3650.";
  }
  return null;
}

// Detector de cambios barato para el sondeo del cliente (cada ~25s): lista
// el directorio raíz (sha de cada archivo sin su contenido) en vez de pedir
// cartas-intencion.json entero. Tiene que ser el sha del BLOB, el mismo que
// devuelven el GET y el POST de /api/sync-cartas — si se usara el sha del
// commit, el cliente no podría comparar y se tragaría cambios en silencio
// (bug real que ya pasó en Parques-Industriales, ver su worker.js).
async function manejarVersionCartas(env) {
  if (!env.GITHUB_TOKEN) return jsonResponse({ error: 'GITHUB_TOKEN no configurado' }, 500);
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents?ref=${GITHUB_BRANCH}`,
      {
        headers: {
          'Authorization': `token ${env.GITHUB_TOKEN}`,
          'User-Agent': 'expedientes-crm-worker',
          'Accept': 'application/vnd.github+json'
        }
      }
    );
    if (!resp.ok) throw new Error(`GitHub GET falló: ${resp.status} ${await resp.text()}`);
    const entradas = await resp.json();
    const entrada = Array.isArray(entradas) ? entradas.find((e) => e && e.name === ARCHIVO_CARTAS) : null;
    return jsonResponse({ version: entrada ? entrada.sha : null });
  } catch (err) {
    return jsonResponse({ error: 'No se pudo leer la versión', detalle: String(err.message || err) }, 502);
  }
}

async function manejarSyncCartas(request, env) {
  if (!env.GITHUB_TOKEN) {
    return jsonResponse({
      error: 'GITHUB_TOKEN no configurado en el Worker',
      donde: 'Dashboard -> Settings -> "Runtime variables and secrets" (NO "Builds -> Variables and secrets": esas solo existen durante el build y no llegan al runtime)'
    }, 500);
  }

  if (request.method === 'GET') {
    try {
      const { sha, datos } = await githubGetFile(env.GITHUB_TOKEN, ARCHIVO_CARTAS);
      const cuerpo = datos || CARTAS_VACIO;
      // _meta no se escribe nunca en el archivo; solo viaja en la respuesta,
      // para que el cliente distinga "cero expedientes" de "archivo
      // inexistente" y para que el sha vuelva en el próximo POST.
      return jsonResponse(Object.assign({}, cuerpo, { _meta: { existe: !!datos, sha } }));
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (request.method === 'POST') {
    let nuevosDatos;
    try {
      nuevosDatos = await request.json();
    } catch (err) {
      return jsonResponse({ error: 'Cuerpo JSON inválido', detalle: String(err.message || err) }, 400);
    }
    const problema = validarCartas(nuevosDatos);
    if (problema) return jsonResponse({ error: 'Datos rechazados', detalle: problema }, 422);

    try {
      const { sha, datos: actuales } = await githubGetFile(env.GITHUB_TOKEN, ARCHIVO_CARTAS);

      // Concurrencia optimista: el cliente manda el sha sobre el que venía
      // trabajando. Si cambió en el medio, otro dispositivo escribió antes
      // — se devuelve 409 con el contenido actual para que el cliente
      // fusione y reintente, en vez de pisarlo en silencio.
      const base = nuevosDatos._baseSha;
      if (base && sha && base !== sha) {
        return jsonResponse({
          error: 'conflicto',
          detalle: 'Otro dispositivo guardó cambios mientras editabas. Se fusionan y se reintenta.',
          actual: Object.assign({}, actuales || CARTAS_VACIO, { _meta: { existe: !!actuales, sha } })
        }, 409);
      }

      // _baseSha/_meta son protocolo, nunca se escriben en el archivo.
      const aEscribir = Object.assign({}, nuevosDatos);
      delete aEscribir._baseSha;
      delete aEscribir._meta;

      const escrito = await githubPutFile(env.GITHUB_TOKEN, ARCHIVO_CARTAS, 'cartas', aEscribir, sha);
      // El sha nuevo vuelve al cliente: sin él, su próximo POST manda el
      // _baseSha viejo y recibe un 409 contra su propia escritura.
      return jsonResponse({ ok: true, sha: escrito.content.sha });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  return jsonResponse({ error: 'Método no soportado' }, 405);
}

// Une las bajas (`eliminados`) del archivo que llega con las que ya están
// en GitHub, y saca del payload lo que alguna de las dos dio de baja.
//
// Parques reescribe el archivo entero (última escritura gana). Sin esto, un
// dispositivo que todavía tenga una empresa borrada en su localStorage la
// vuelve a subir en su próximo POST. Las bajas solo se suman: nunca se quitan
// desde acá; deshacer una baja es un cambio explícito.
function aplicarBajas(nuevos, remotos) {
  const bajas = {
    empresas: unirIds(remotos?.eliminados?.empresas, nuevos.eliminados?.empresas),
    lotes: unirIds(remotos?.eliminados?.lotes, nuevos.eliminados?.lotes)
  };
  return Object.assign({}, nuevos, {
    eliminados: bajas,
    empresas: (nuevos.empresas || []).filter((e) => !bajas.empresas.includes(e.id_empresa)),
    lotes: (nuevos.lotes || []).filter((l) => !bajas.lotes.includes(l.id_lote)),
    ocupaciones: (nuevos.ocupaciones || []).filter((o) => !bajas.lotes.includes(o.id_lote) && !bajas.empresas.includes(o.id_empresa_ocupante))
  });
}

function unirIds(a, b) {
  return [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
}

async function manejarSync(request, env, app) {
  if (!env.GITHUB_TOKEN) {
    return jsonResponse({
      error: 'GITHUB_TOKEN no configurado en el Worker',
      donde: 'Dashboard -> Settings -> "Runtime variables and secrets" (NO "Builds -> Variables and secrets": esas solo existen durante el build y no llegan al runtime)'
    }, 500);
  }

  try {
    if (request.method === 'GET') {
      const { sha, datos } = await githubGetFile(env.GITHUB_TOKEN, app.archivo);
      if (!app.conflictos) return jsonResponse(datos || app.vacio);
      // _meta viaja solo en la respuesta, nunca se escribe en el archivo.
      return jsonResponse(Object.assign({}, datos || app.vacio, { _meta: { existe: !!datos, sha } }));
    }

    if (request.method === 'POST') {
      let nuevosDatos;
      try {
        nuevosDatos = await request.json();
      } catch (err) {
        return jsonResponse({ error: 'Cuerpo JSON inválido', detalle: String(err.message || err) }, 400);
      }
      const problema = validarFormaApp(nuevosDatos, app);
      if (problema) return jsonResponse({ error: 'Datos rechazados', detalle: problema }, 422);

      // _baseSha y _meta son protocolo: nunca se escriben en el archivo.
      const base = nuevosDatos._baseSha;
      delete nuevosDatos._baseSha;
      delete nuevosDatos._meta;

      const { datos: remotos, sha } = await githubGetFile(env.GITHUB_TOKEN, app.archivo);
      if (app.conflictos && base && sha && base !== sha) {
        return jsonResponse({
          error: 'conflicto',
          detalle: 'Otro dispositivo guardó cambios mientras editabas. Se fusionan y se reintenta.',
          actual: Object.assign({}, remotos || app.vacio, { _meta: { existe: !!remotos, sha } })
        }, 409);
      }
      if (app.bajas) nuevosDatos = aplicarBajas(nuevosDatos, remotos || {});
      const escrito = await githubPutFile(env.GITHUB_TOKEN, app.archivo, app.nombre, nuevosDatos, sha);
      return jsonResponse(app.conflictos ? { ok: true, sha: escrito.content.sha } : { ok: true });
    }

    return jsonResponse({ error: 'Método no soportado' }, 405);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// Tamaño de cada archivo de datos, leído del listado del repo (una sola
// llamada a la API). La API de Contents de GitHub deja de devolver el
// contenido arriba de 1 MB: hay que migrar antes de llegar, así que el
// diagnóstico avisa mucho antes (700 KB).
const UMBRAL_TAMANO_KB = 700;
async function tamanosDeArchivos(token) {
  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents?ref=${GITHUB_BRANCH}`,
    { headers: { 'Authorization': `token ${token}`, 'User-Agent': 'expedientes-crm-worker', 'Accept': 'application/vnd.github+json' } }
  );
  if (!resp.ok) throw new Error(`GitHub GET falló: ${resp.status}`);
  const entradas = await resp.json();
  const tamanos = {};
  for (const e of Array.isArray(entradas) ? entradas : []) {
    if (e && e.type === 'file' && e.name.endsWith('.json')) tamanos[e.name] = e.size;
  }
  return tamanos;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Diagnóstico: confirma qué ve el Worker en runtime sin exponer valores.
    if (url.pathname === '/api/health') {
      let tamanos = null;
      let errorTamanos = null;
      if (env.GITHUB_TOKEN) {
        try { tamanos = await tamanosDeArchivos(env.GITHUB_TOKEN); }
        catch (e) { errorTamanos = String(e.message || e); }
      }
      const archivosDatos = Object.values(APPS).map((a) => a.archivo).concat([ARCHIVO_CARTAS]);
      const alertaTamano = tamanos
        ? archivosDatos.filter((f) => tamanos[f] > UMBRAL_TAMANO_KB * 1024)
        : [];
      return jsonResponse({
        tamanos_kb: tamanos ? Object.fromEntries(archivosDatos.map((f) => [f, tamanos[f] != null ? Math.round(tamanos[f] / 1024) : null])) : null,
        error_tamanos: errorTamanos,
        // Archivos por encima de 700 KB: hay que migrarlos antes del límite de 1 MB de GitHub.
        alerta_tamano: alertaTamano,
        version_worker: WORKER_VERSION,
        tiene_github_token: Boolean(env.GITHUB_TOKEN),
        // false = cualquiera con la URL puede leer y borrar. Cargá el secret
        // APP_CLAVE en Settings -> "Runtime variables and secrets".
        auth_activa: Boolean(env.APP_CLAVE),
        largo_token: env.GITHUB_TOKEN ? env.GITHUB_TOKEN.length : 0,
        tiene_binding_assets: Boolean(env.ASSETS),
        claves_env: Object.keys(env).sort(),
        archivos: Object.values(APPS).map((a) => a.archivo).concat([ARCHIVO_CARTAS])
      });
    }

    // La puerta va acá y no dentro de cada handler: un endpoint nuevo queda
    // protegido por existir bajo /api/, sin que nadie tenga que acordarse.
    // /api/health queda afuera a propósito — no expone ningún dato y es lo
    // primero que se mira cuando algo falla, incluida la propia clave.
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
      const rechazo = rechazarSiNoAutorizado(request, env);
      if (rechazo) return rechazo;
    }

    if (url.pathname === '/api/version-cartas') {
      return manejarVersionCartas(env);
    }
    if (url.pathname === '/api/sync-cartas') {
      return manejarSyncCartas(request, env);
    }

    const app = APPS[url.pathname];
    if (app) {
      return manejarSync(request, env, app);
    }

    return env.ASSETS.fetch(request);
  }
};
