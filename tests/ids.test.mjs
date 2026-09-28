/*
 * Chequeo estático de public/index.html. No necesita navegador.
 *
 * Existe por el bug del 2026-09-28: el panel de configuración del sidebar y el
 * del popup usaban los MISMOS id. Como getElementById devuelve el primero del
 * documento, todo el JS le pegaba al sidebar y el popup quedaba inerte, sin
 * ningún error en consola que lo delatara.
 *
 * Verifica además que no queden getElementById apuntando a un id que ya no
 * existe: eso tira TypeError y mata todo el script que viene después.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(RAIZ, 'public/index.html'), 'utf8');

// Desde </style> en adelante, para no capturar selectores CSS como si fueran id.
const cuerpo = html.slice(html.indexOf('</style>'));

const ids = [...cuerpo.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const duplicados = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];

const referencias = [...new Set(
  [...html.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
)];
const huerfanas = referencias.filter((r) => !ids.includes(r));

let fallas = 0;
const ok = (cond, msg) => {
  if (!cond) fallas++;
  console.log((cond ? '  OK   ' : '  FALLA') + ': ' + msg);
};

console.log(`\n=== IDs en public/index.html ===`);
ok(duplicados.length === 0,
   duplicados.length ? `id duplicados: ${duplicados.join(', ')}` : `sin id duplicados (${ids.length} ids)`);
ok(huerfanas.length === 0,
   huerfanas.length ? `getElementById a ids inexistentes: ${huerfanas.join(', ')}`
                    : `los ${referencias.length} getElementById apuntan a ids que existen`);

// Una sola fuente de verdad para el formato del número: si el guardado vuelve a
// traer su propia regex, se repite el bug que hacía imposible guardar.
const regexSueltas = [...html.matchAll(/\/\^\\\(\\d\{1,3\}/g)].length;
ok(regexSueltas <= 1,
   regexSueltas <= 1 ? 'una sola regex de validación del número de expediente'
                     : `hay ${regexSueltas} regex del número: deben unificarse en validarNumeroExpediente()`);

console.log(fallas === 0 ? '\nEstructura OK' : `\n${fallas} fallas`);
process.exit(fallas === 0 ? 0 : 1);
