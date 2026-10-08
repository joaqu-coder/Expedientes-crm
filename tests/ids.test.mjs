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

let fallas = 0;
const ok = (cond, msg) => {
  if (!cond) fallas++;
  console.log((cond ? '  OK   ' : '  FALLA') + ': ' + msg);
};

// Cada página es un documento HTML independiente (no SPA con hash-routing),
// así que el chequeo de ids duplicados/huérfanos corre por archivo: un id
// repetido DENTRO del mismo documento es el bug; el mismo id en dos páginas
// distintas no es problema (son DOM separados).
function chequearArchivo(archivo) {
  const html = fs.readFileSync(path.join(RAIZ, archivo), 'utf8');

  // Desde </style> en adelante, para no capturar selectores CSS como si fueran id.
  const marcaEstilo = html.indexOf('</style>');
  const cuerpo = marcaEstilo === -1 ? html : html.slice(marcaEstilo);

  // Se descartan los id armados por JS con concatenación de strings
  // (ej. 'id="f_'+name+'"' dentro de un template-helper): no son ids
  // literales del documento, son código fuente que matchea el patrón por
  // casualidad. Un id real nunca contiene comillas ni '+'.
  const ids = [...cuerpo.matchAll(/\sid="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((id) => !id.includes('+') && !id.includes("'"));
  const duplicados = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];

  const referencias = [...new Set(
    [...html.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
  )];
  const huerfanas = referencias.filter((r) => !ids.includes(r));

  console.log(`\n=== IDs en ${archivo} ===`);
  ok(duplicados.length === 0,
     duplicados.length ? `id duplicados: ${duplicados.join(', ')}` : `sin id duplicados (${ids.length} ids)`);
  ok(huerfanas.length === 0,
     huerfanas.length ? `getElementById a ids inexistentes: ${huerfanas.join(', ')}`
                      : `los ${referencias.length} getElementById apuntan a ids que existen`);

  return html;
}

chequearArchivo('public/index.html');
const htmlSeguimiento = chequearArchivo('public/seguimiento.html');
chequearArchivo('public/proyectos.html');

// Una sola fuente de verdad para el formato del número de expediente: si el
// guardado vuelve a traer su propia regex, se repite el bug que hacía
// imposible guardar. Solo aplica a seguimiento.html (cartas de intención no
// tiene ese formato de número).
const regexSueltas = [...htmlSeguimiento.matchAll(/\/\^\\\(\\d\{1,3\}/g)].length;
ok(regexSueltas <= 1,
   regexSueltas <= 1 ? 'una sola regex de validación del número de expediente'
                     : `hay ${regexSueltas} regex del número: deben unificarse en validarNumeroExpediente()`);

console.log(fallas === 0 ? '\nEstructura OK' : `\n${fallas} fallas`);
process.exit(fallas === 0 ? 0 : 1);
