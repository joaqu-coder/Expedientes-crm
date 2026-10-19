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

// 4. El opt-in a la transición entre pantallas va INLINE y es idéntico en las
//    cinco. No puede vivir en design-system.css: el navegador decide si anima
//    en el primer render del documento nuevo y una hoja externa llega tarde.
//    Medido sobre las pantallas reales: en el CSS externo salía en 5 de 8
//    navegaciones, inline en 8 de 8. Una animación intermitente se lee como
//    un error, así que esto es correctitud, no estética. Y si una sola página
//    no opta, la transición tampoco ocurre al venir DESDE ella: hacen falta
//    las dos puntas.
const OPTIN = '<style>@view-transition{navigation:auto}' +
  '@media(prefers-reduced-motion:reduce){@view-transition{navigation:none}}</style>';
for (const nombre of PAGINAS) {
  const html = fs.readFileSync(path.join(RAIZ, `public/${nombre}.html`), 'utf8');
  const tiene = html.includes(OPTIN);
  // Tiene que estar antes de cualquier hoja de estilo, o el navegador ya
  // decidió para cuando lo lee.
  const pos = html.indexOf(OPTIN);
  const primerLink = html.indexOf('<link rel="stylesheet"');
  ok(tiene && pos < primerLink,
     !tiene ? `${nombre}.html no tiene el opt-in inline a la transición, o no es idéntico al de las otras`
            : `${nombre}.html opta a la transición inline y antes de las hojas de estilo`);
}

// 5. Y no está duplicado en el CSS: dos opt-ins es tener que acordarse de los
//    dos. El archivo compartido se queda con lo que sí puede regular desde un
//    solo lugar (qué se anima, cuánto dura, qué se queda quieto).
const dsCss = fs.readFileSync(path.join(RAIZ, 'public/design-system.css'), 'utf8');
// Sin los comentarios: el archivo EXPLICA por qué el opt-in no está ahí, y
// esa explicación nombra la regla. Buscar en el texto crudo la encuentra
// dentro del comentario y falla por la documentación, no por el código.
const optinEnCss = /@view-transition\s*\{/.test(dsCss.replace(/\/\*[\s\S]*?\*\//g, ''));
ok(!optinEnCss,
   optinEnCss ? 'design-system.css volvió a declarar @view-transition: el opt-in va solo inline (ver el comentario del archivo)'
              : 'design-system.css no duplica el opt-in; sí define la animación y qué se queda quieto');

// --- 6. parques.json: titularidad y ocupación no pueden contradecirse ------
//
// El 2026-10-19 la fusión de los exports normalizados dejó tres lotes a
// nombre de su INQUILINO (L121 a ADIONICS en vez de RIXOM, L052 y L053 a
// MOLINO DOÑA ANGELA en vez de DJM MONTAJES, que quedó sin un solo lote). El
// export trae una fila por lote con la empresa que lo OCUPA — es la trampa
// que CLAUDE.md ya documenta—, y la defensa se había aplicado a los campos de
// la empresa (mail, contacto, rubro, links) pero no a `lote.id_empresa`, que
// es la titularidad misma.
//
// No se nota en pantalla: la ficha de la inquilina cuenta el mismo lote dos
// veces ("Lotes (2)"), le suma una superficie que no es suya y dice
// "Alquilado a X" arriba y "Titular: X" abajo, todo con números plausibles.
// Por eso se chequea acá, contra el archivo, y no mirando la pantalla.
const parques = JSON.parse(fs.readFileSync(path.join(RAIZ, 'parques.json'), 'utf8'));
const porLote = new Map(parques.lotes.map((l) => [l.id_lote, l]));
const vigentes = parques.ocupaciones.filter((o) => o.vigente);
const huerfanas = vigentes.filter((o) => !porLote.has(o.id_lote));
ok(huerfanas.length === 0,
   huerfanas.length ? `hay ocupaciones vigentes sobre lotes que no existen: ${huerfanas.map((o) => o.id_lote).join(', ')}`
                    : `las ${vigentes.length} ocupaciones vigentes apuntan a un lote que existe`);
const titularPisado = vigentes.filter((o) => {
  const l = porLote.get(o.id_lote);
  return l && l.id_empresa !== o.id_empresa_titular;
});
ok(titularPisado.length === 0,
   titularPisado.length ? `el titular del lote no coincide con el de su ocupación: ${titularPisado.map((o) => o.id_lote).join(', ')} (¿una fusión de export escribió al inquilino en lote.id_empresa?)`
                        : 'ningún lote quedó a nombre de alguien distinto del titular que declara su ocupación');
const seAlquilaASiMisma = vigentes.filter((o) => {
  const l = porLote.get(o.id_lote);
  return l && l.id_empresa === o.id_empresa_ocupante;
});
ok(seAlquilaASiMisma.length === 0,
   seAlquilaASiMisma.length ? `una empresa figura titular y ocupante del mismo lote: ${seAlquilaASiMisma.map((o) => o.id_lote).join(', ')}`
                            : 'ninguna empresa figura a la vez titular y ocupante del mismo lote');

console.log(fallas === 0 ? '\nEstructura OK' : `\n${fallas} fallas`);
process.exit(fallas === 0 ? 0 : 1);
