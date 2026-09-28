/*
 * Worker — Expedientes CRM
 *
 * Sirve los archivos estáticos de public/ y expone /api/sync para
 * sincronizar expedientes.json con GitHub, sin exponer ningún token
 * al navegador. El token vive SOLO como secret de Cloudflare
 * (GITHUB_TOKEN), configurado en el dashboard, nunca en el código.
 *
 * GET  /api/sync  -> devuelve el contenido actual de expedientes.json
 * POST /api/sync  -> sobreescribe expedientes.json con el body recibido
 *
 * Cualquier otra ruta se sirve como archivo estático desde public/.
 */

const GITHUB_OWNER = 'joaqu-coder';
const GITHUB_REPO = 'Expedientes-crm';
const GITHUB_FILE = 'expedientes.json';
const GITHUB_BRANCH = 'main';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function githubGetFile(token) {
  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`,
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

async function githubPutFile(token, datos, sha) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(datos, null, 2))));

  const payload = {
    message: `sync: expedientes ${new Date().toISOString()}`,
    content,
    branch: GITHUB_BRANCH
  };
  if (sha) payload.sha = sha;

  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
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

async function manejarSync(request, env) {
  if (!env.GITHUB_TOKEN) {
    // Si ves este error justo después de agregar el secret en el dashboard,
    // el deployment activo es anterior al secret: hace falta un redeploy
    // nuevo (los secrets no se aplican retroactivamente a versiones ya
    // desplegadas). Un push nuevo alcanza.
    return jsonResponse({ error: 'GITHUB_TOKEN no configurado en el Worker' }, 500);
  }

  try {
    if (request.method === 'GET') {
      const { datos } = await githubGetFile(env.GITHUB_TOKEN);
      return jsonResponse(datos || { expedientes: [], areas: [], responsables: [] });
    }

    if (request.method === 'POST') {
      const nuevosDatos = await request.json();
      const { sha } = await githubGetFile(env.GITHUB_TOKEN);
      await githubPutFile(env.GITHUB_TOKEN, nuevosDatos, sha);
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

    if (url.pathname === '/api/sync') {
      return manejarSync(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
