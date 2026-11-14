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
if (entradas.length !== 8) falla(`se esperaban 8 logos en LOGOS, hay ${entradas.length}`);

const ids = new Set(datos.empresas.map((e) => e.id_empresa));
for (const { id, archivo } of entradas) {
  if (!ids.has(id)) falla(`LOGOS apunta a ${id}, que no existe en parques.json`);
  const ruta = path.join(RAIZ, 'public', archivo);
  if (archivo.includes('..') || !fs.existsSync(ruta) || fs.statSync(ruta).size === 0) {
    falla(`${id}: no existe public/${archivo}`);
  }
}

if (fallos) process.exit(1);
console.log(`OK logos: ${entradas.length} entradas en LOGOS, todas con id y archivo válidos; parques.json sin campo logo`);
