/*
 * Worker — Expedientes CRM
 *
 * Sirve los archivos estáticos de public/ (landing + dos apps: Seguimiento y
 * Proyectos) y expone dos pares de endpoints de sync, uno por app, sin
 * exponer ningún token al navegador. El token vive SOLO como secret de
 * Cloudflare (GITHUB_TOKEN), configurado en el dashboard, nunca en el código.
 * Ambas apps comparten el mismo Worker y el mismo token; cada una escribe su
 * propio archivo en este repo.
 *
 * GET  /api/sync              -> devuelve expedientes.json (Seguimiento)
 * POST /api/sync              -> sobreescribe expedientes.json
 * GET  /api/sync-cartas       -> devuelve cartas-intencion.json (Proyectos)
 * POST /api/sync-cartas       -> sobreescribe cartas-intencion.json
 * GET  /api/sync-resoluciones -> devuelve resoluciones.json (Resoluciones)
 * POST /api/sync-resoluciones -> sobreescribe resoluciones.json
 *
 * Cualquier otra ruta se sirve como archivo estático desde public/.
 */

// Se incrementa a mano para confirmar qué versión está viva en producción.
const WORKER_VERSION = 'diag-2';

const GITHUB_OWNER = 'joaqu-coder';
const GITHUB_REPO = 'Expedientes-crm';
const GITHUB_BRANCH = 'main';

// Una entrada por app: el archivo que guarda en este repo y el valor por
// defecto que devuelve GET cuando ese archivo todavía no existe.
const APPS = {
  '/api/sync': {
    archivo: 'expedientes.json',
    nombre: 'expedientes',
    vacio: { expedientes: [], areas: [], responsables: [] }
  },
  '/api/sync-cartas': {
    archivo: 'cartas-intencion.json',
    nombre: 'cartas',
    vacio: { expedientes: [], plazoDias: 90 }
  },
  '/api/sync-resoluciones': {
    archivo: 'resoluciones.json',
    nombre: 'resoluciones',
    vacio: { resoluciones: [] }
  }
};

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

async function manejarSync(request, env, app) {
  if (!env.GITHUB_TOKEN) {
    return jsonResponse({
      error: 'GITHUB_TOKEN no configurado en el Worker',
      donde: 'Dashboard -> Settings -> "Runtime variables and secrets" (NO "Builds -> Variables and secrets": esas solo existen durante el build y no llegan al runtime)'
    }, 500);
  }

  try {
    if (request.method === 'GET') {
      const { datos } = await githubGetFile(env.GITHUB_TOKEN, app.archivo);
      return jsonResponse(datos || app.vacio);
    }

    if (request.method === 'POST') {
      const nuevosDatos = await request.json();
      const { sha } = await githubGetFile(env.GITHUB_TOKEN, app.archivo);
      await githubPutFile(env.GITHUB_TOKEN, app.archivo, app.nombre, nuevosDatos, sha);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: 'Método no soportado' }, 405);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Diagnóstico: confirma qué ve el Worker en runtime sin exponer valores.
    if (url.pathname === '/api/health') {
      return jsonResponse({
        version_worker: WORKER_VERSION,
        tiene_github_token: Boolean(env.GITHUB_TOKEN),
        largo_token: env.GITHUB_TOKEN ? env.GITHUB_TOKEN.length : 0,
        tiene_binding_assets: Boolean(env.ASSETS),
        claves_env: Object.keys(env).sort(),
        archivos: Object.values(APPS).map((a) => a.archivo)
      });
    }

    const app = APPS[url.pathname];
    if (app) {
      return manejarSync(request, env, app);
    }

    return env.ASSETS.fetch(request);
  }
};
