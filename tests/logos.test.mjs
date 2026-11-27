/*
 * Logos de empresas en Parques.
 *
 * Los logos viven en el mapa LOGOS de public/parques.html, no en parques.json:
 * el dato se sincroniza y se fusiona por registro, y un dispositivo con una
 * copia vieja podía pisar un campo `logo` en el servidor. Este test verifica:
 *   1. parques.json no trae ningún campo `logo` (si vuelve, la fusión lo pisa).
 *   2. Cada entrada de LOGOS apunta a un id de empresa que existe.
 *   3. Cada archivo de logo existe dentro de public/ y no está vacío.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const datos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'parques.json'), 'utf8'));
const html = fs.readFileSync(path.join(RAIZ, 'public/parques.html'), 'utf8');

let fallos = 0;
const falla = (msg) => { console.log('FAIL ' + msg); fallos++; };

const conCampoLogo = datos.empresas.filter((e) => 'logo' in e);
if (conCampoLogo.length) falla(`parques.json tiene campo "logo" en ${conCampoLogo.length} empresas: la fusión lo puede pisar`);

const bloque = html.match(/var LOGOS = \{([\s\S]*?)\};/);
if (!bloque) { falla('no se encontró el mapa LOGOS en parques.html'); process.exit(1); }
const entradas = [...bloque[1].matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)].map((m) => ({ id: m[1], archivo: m[2] }));
if (entradas.length !== 126) falla(`se esperaban 126 logos en LOGOS, hay ${entradas.length}`);

const ids = new Set(datos.empresas.map((e) => e.id_empresa));
for (const { id, archivo } of entradas) {
  if (!ids.has(id)) falla(`LOGOS apunta a ${id}, que no existe en parques.json`);
  const ruta = path.join(RAIZ, 'public', archivo);
  if (archivo.includes('..') || !fs.existsSync(ruta) || fs.statSync(ruta).size === 0) {
    falla(`${id}: no existe public/${archivo}`);
  }
}

// 4. Fondo blanco en todos los casos: cada logo es PNG RGB de 8 bits, sin canal
//    alfa (color type 2). Con alfa o paleta, el fondo depende del navegador.
for (const { id, archivo } of entradas) {
  const ruta = path.join(RAIZ, 'public', archivo);
  if (!archivo.endsWith('.png')) { falla(`${id}: ${archivo} no es PNG (la normalización genera PNG)`); continue; }
  const cab = fs.readFileSync(ruta).subarray(0, 26);
  const firma = cab.subarray(0, 8).toString('hex');
  if (firma !== '89504e470d0a1a0a') { falla(`${id}: ${archivo} no tiene firma PNG`); continue; }
  const profundidad = cab[24], tipo = cab[25];
  if (profundidad !== 8 || tipo !== 2) falla(`${id}: ${archivo} es color type ${tipo}/${profundidad} bit; se espera RGB 8 bit (tipo 2)`);
}

// 4b. Escala de grises: todos los logos van en gris (R=G=B en cada píxel), como
//     el resto de la colección. Un logo a color se ve distinto al lado de los
//     demás y no se corrige desde el CSS (`.emp-logo` no lleva filtro).
// Decodificador PNG mínimo: RGB 8 bit, no entrelazado, los cinco filtros.
function pixelesPng(buf) {
  let pos = 8, w = 0, h = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), tipo = buf.subarray(pos + 4, pos + 8).toString('latin1');
    const datos = buf.subarray(pos + 8, pos + 8 + len);
    if (tipo === 'IHDR') { w = datos.readUInt32BE(0); h = datos.readUInt32BE(4); }
    if (tipo === 'IDAT') idat.push(datos);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 3, out = Buffer.alloc(stride * h);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const r = raw[y * (stride + 1) + 1 + x];
      const a = x >= 3 ? out[y * stride + x - 3] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 3 && y > 0 ? out[(y - 1) * stride + x - 3] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      out[y * stride + x] = (r + pred) & 255;
    }
  }
  return out;
}
for (const { id, archivo } of entradas) {
  const px = pixelesPng(fs.readFileSync(path.join(RAIZ, 'public', archivo)));
  let color = 0;
  for (let i = 0; i < px.length; i += 3) if (px[i] !== px[i + 1] || px[i] !== px[i + 2]) color++;
  if (color) falla(`${id}: ${archivo} tiene ${color} píxeles a color; los logos van en escala de grises (R=G=B)`);
}

// 5. Marcado válido: la baldosa de empresa es un <button>, cuyo contenido debe
//    ser fraseante (sin <div>). Un <div> dentro se renderiza, pero es HTML inválido.
const baldosa = html.match(/var resumen = [\s\S]*?<\/button>'/);
if (!baldosa) falla('no se encontró la plantilla de baldosa .emp-tile en parques.html');
else if (/<div[\s>]/.test(baldosa[0])) falla('la baldosa .emp-tile (un <button>) contiene <div>: usar <span>');

// 6. Íconos de inicio: 192 y 512 exactos, PNG RGB sin alfa (un fondo transparente
//    se oscurece en algunos lanzadores), y en sw.js van network-first. Si no,
//    un celular con caché sigue mostrando el ícono anterior después del deploy.
const iconos = { 'icon-192.png': 192, 'icon-512.png': 512 };
for (const [archivo, lado] of Object.entries(iconos)) {
  const ruta = path.join(RAIZ, 'public', archivo);
  const cab = fs.readFileSync(ruta).subarray(0, 26);
  if (cab.readUInt32BE(16) !== lado || cab.readUInt32BE(20) !== lado) falla(`${archivo} no mide ${lado}x${lado}`);
  if (cab[25] !== 2 || cab[24] !== 8) falla(`${archivo} no es RGB 8 bit sin alfa (tipo ${cab[25]}/${cab[24]})`);
}
const sw = fs.readFileSync(path.join(RAIZ, 'public/sw.js'), 'utf8');
const criticos = sw.match(/const CRITICOS = \[([^\]]*)\]/);
const enRed = criticos ? criticos[1] : '';
for (const r of ['/icon-192.png', '/icon-512.png', '/manifest.json']) {
  if (!enRed.includes(`'${r}'`)) falla(`sw.js: ${r} no está en CRITICOS (network-first); quedaría con la versión vieja en el caché`);
}
if (!/pathname\.startsWith\('\/logos\/'\)/.test(sw)) falla('sw.js: /logos/* no va network-first');

if (fallos) process.exit(1);
console.log(`OK logos: ${entradas.length} entradas en LOGOS, con id y archivo válidos, PNG RGB sin alfa; parques.json sin campo logo; baldosa sin <div>`);
