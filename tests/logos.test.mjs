/*
 * Logos de empresas en Parques (2026-11-13).
 *
 * Cada empresa con campo `logo` en parques.json tiene que apuntar a un archivo
 * que exista dentro de public/ (el Worker lo sirve como asset). Un logo roto
 * no rompe la app, pero la ficha queda con una imagen rota: lo atrapa acá.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const datos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'parques.json'), 'utf8'));

let fallos = 0;
const conLogo = datos.empresas.filter((e) => e.logo);
if (conLogo.length !== 8) {
  console.log(`FAIL se esperaban 8 empresas con logo, hay ${conLogo.length}`);
  fallos++;
}
for (const e of conLogo) {
  const archivo = path.join(RAIZ, 'public', e.logo);
  const ok = !e.logo.includes('..') && fs.existsSync(archivo) && fs.statSync(archivo).size > 0;
  if (!ok) { console.log(`FAIL ${e.id_empresa} ${e.nombre_empresa}: no existe public/${e.logo}`); fallos++; }
}
if (fallos) process.exit(1);
console.log(`OK logos: ${conLogo.length} empresas con archivo válido en public/logos/`);
