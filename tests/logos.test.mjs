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
if (entradas.length !== 93) falla(`se esperaban 93 logos en LOGOS, hay ${entradas.length}`);

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

// 5. Marcado válido: la baldosa de empresa es un <button>, cuyo contenido debe
//    ser fraseante (sin <div>). Un <div> dentro se renderiza, pero es HTML inválido.
const baldosa = html.match(/var resumen = [\s\S]*?<\/button>'/);
if (!baldosa) falla('no se encontró la plantilla de baldosa .emp-tile en parques.html');
else if (/<div[\s>]/.test(baldosa[0])) falla('la baldosa .emp-tile (un <button>) contiene <div>: usar <span>');

if (fallos) process.exit(1);
console.log(`OK logos: ${entradas.length} entradas en LOGOS, con id y archivo válidos, PNG RGB sin alfa; parques.json sin campo logo; baldosa sin <div>`);
