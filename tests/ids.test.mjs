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
chequearArchivo('public/resoluciones.html');
chequearArchivo('public/parques.html');

// Una sola fuente de verdad para el formato del número de expediente: si el
// guardado vuelve a traer su propia regex, se repite el bug que hacía
// imposible guardar. Solo aplica a seguimiento.html (cartas de intención no
// tiene ese formato de número).
const regexSueltas = [...htmlSeguimiento.matchAll(/\/\^\\\(\\d\{1,3\}/g)].length;
ok(regexSueltas <= 1,
   regexSueltas <= 1 ? 'una sola regex de validación del número de expediente'
                     : `hay ${regexSueltas} regex del número: deben unificarse en validarNumeroExpediente()`);

// ---------------------------------------------------------------------------
// El sistema de diseño es la única fuente de los valores visuales
// ---------------------------------------------------------------------------
// Chequeo rápido y sin navegador, complementario al de ui.test.mjs (que prueba
// el comportamiento). Acá se verifica lo que un ojo no ve al abrir la página:
// que ninguna pantalla se haya vuelto a traer la paleta adentro.
console.log('\n=== Sistema de diseño ===');

const PAGINAS = ['index', 'seguimiento', 'proyectos', 'resoluciones', 'parques'];

// 1. Las cinco cargan los dos archivos, y en ese orden: ui-kit.css lee los
//    --ds-* y ya no tiene valores de respaldo, así que al revés (o sin el
//    primero) los botones salen sin alto y sin radio.
for (const nombre of PAGINAS) {
  const html = fs.readFileSync(path.join(RAIZ, `public/${nombre}.html`), 'utf8');
  const ds = html.indexOf('href="/design-system.css"');
  const kit = html.indexOf('href="/ui-kit.css"');
  ok(ds !== -1 && kit !== -1 && ds < kit,
     ds === -1 ? `${nombre}.html no carga design-system.css`
     : kit === -1 ? `${nombre}.html no carga ui-kit.css`
     : ds < kit ? `${nombre}.html carga el sistema de diseño antes que los componentes`
     : `${nombre}.html carga ui-kit.css ANTES que design-system.css: los --ds-* no resuelven`);
}

// 2. Los componentes no tienen valores literales: si ui-kit.css vuelve a
//    clavar un color o un radio, cambiar el token deja de alcanzar.
const kitCss = fs.readFileSync(path.join(RAIZ, 'public/ui-kit.css'), 'utf8');
const literalesKit = [...kitCss.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
ok(literalesKit.length === 0,
   literalesKit.length ? `ui-kit.css tiene colores literales (${literalesKit.join(', ')}): van como token en design-system.css`
                       : 'ui-kit.css no tiene ni un color literal: todo sale de los tokens');

// 3. Ninguna página redeclara un token que el sistema ya posee. La excepción
//    viva está declarada acá, no en el aire: seguimiento pisa --orange y
//    --yellow porque su naranja es el del semáforo de urgencia, no el de las
//    categorías. Si aparece una desviación nueva, se agrega a esta lista —
//    con su motivo— o se saca de la página.
const DEL_SISTEMA = ['--accent', '--accent-fg', '--bg', '--surface', '--surface-2',
  '--border', '--fg', '--muted', '--danger', '--ok', '--warn', '--idle', '--primary',
  '--text', '--text-muted', '--gray-50', '--gray-100', '--gray-200', '--gray-300',
  '--red', '--green', '--font-body', '--font-display', '--font-mono'];
const DESVIOS_PERMITIDOS = { seguimiento: ['--orange', '--yellow'] };

for (const nombre of PAGINAS) {
  const html = fs.readFileSync(path.join(RAIZ, `public/${nombre}.html`), 'utf8');
  const estilos = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  const permitidos = DESVIOS_PERMITIDOS[nombre] || [];
  // Una DECLARACIÓN del token, no un uso. Tres de las páginas escriben varios
  // por línea (`--bg:#fff; --surface:#fff;`), así que no alcanza con mirar el
  // principio de la línea: se exige que venga después de `{`, `;` o espacio.
  // `var(--bg)` queda afuera porque ahí lo precede un paréntesis.
  const redeclarados = DEL_SISTEMA.filter((t) =>
    !permitidos.includes(t) && new RegExp(`(?:^|[;{\\s])${t}\\s*:`).test(estilos));
  ok(redeclarados.length === 0,
     redeclarados.length
       ? `${nombre}.html redeclara tokens del sistema (${redeclarados.join(', ')}): sacalos o anotá el desvío en DESVIOS_PERMITIDOS`
       : `${nombre}.html no redeclara ningún token del sistema${permitidos.length ? ` (desvío anotado: ${permitidos.join(', ')})` : ''}`);
}

console.log(fallas === 0 ? '\nEstructura OK' : `\n${fallas} fallas`);
process.exit(fallas === 0 ? 0 : 1);
