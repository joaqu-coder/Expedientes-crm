// Plazos por etapa en días hábiles. Funciones puras, sin DOM: las usan Seguimiento
// y Proyectos (un solo calendario, un solo cálculo) y las prueba tests/plazos.test.mjs.
//
// Reglas (documento «Expedientes CRM: resultado final»):
//  - El conteo arranca el día siguiente a la entrada a la etapa.
//  - Sábados, domingos y feriados no cuentan.
//  - El reloj no se pausa: si el expediente está en otra unidad, el plazo corre igual.
//  - Vence hoy = rojo. A los UMBRAL_ALERTA_DIAS_HABILES días hábiles de vencida, alerta
//    (corresponde intimar).
(function(root){
  "use strict";

  // Feriados argentinos 2024-2028. Viernes Santo y Carnaval salen de Pascua; los
  // trasladables (17/6, 17/8, 12/10, 20/11) siguen la Ley 27.399: martes o miércoles
  // pasan al lunes anterior, jueves o viernes al lunes siguiente. Los decretos que
  // agregan puentes turísticos o mueven un feriado por su cuenta NO están: hay que
  // sumarlos a mano cuando salen (pendiente de confirmar con el usuario, ver CLAUDE.md).
  // tests/ui.test.mjs recalcula Pascua y las reglas y falla si esta tabla se desvía.
  var FERIADOS = [
    "2024-01-01", "2024-02-12", "2024-02-13", "2024-03-24", "2024-03-29",
    "2024-04-02", "2024-05-01", "2024-05-25", "2024-06-17", "2024-06-20",
    "2024-07-09", "2024-07-25", "2024-08-17", "2024-10-12", "2024-11-18",
    "2024-12-08", "2024-12-25",
    "2025-01-01", "2025-03-03", "2025-03-04", "2025-03-24", "2025-04-02",
    "2025-04-18", "2025-05-01", "2025-05-25", "2025-06-16", "2025-06-20",
    "2025-07-09", "2025-07-25", "2025-08-17", "2025-10-12", "2025-11-24",
    "2025-12-08", "2025-12-25",
    "2026-01-01", "2026-02-16", "2026-02-17", "2026-03-24", "2026-04-02",
    "2026-04-03", "2026-05-01", "2026-05-25", "2026-06-15", "2026-06-20",
    "2026-07-09", "2026-07-25", "2026-08-17", "2026-10-12", "2026-11-23",
    "2026-12-08", "2026-12-25",
    "2027-01-01", "2027-02-08", "2027-02-09", "2027-03-24", "2027-03-26",
    "2027-04-02", "2027-05-01", "2027-05-25", "2027-06-20", "2027-06-21",
    "2027-07-09", "2027-07-25", "2027-08-16", "2027-10-11", "2027-11-20",
    "2027-12-08", "2027-12-25",
    "2028-01-01", "2028-02-28", "2028-02-29", "2028-03-24", "2028-04-02",
    "2028-04-14", "2028-05-01", "2028-05-25", "2028-06-17", "2028-06-20",
    "2028-07-09", "2028-07-25", "2028-08-21", "2028-10-16", "2028-11-20",
    "2028-12-08", "2028-12-25"
      
  ];

  var UMBRAL_ALERTA_DIAS_HABILES = 2;
  var PLAZO_MAX_DIAS = 999;

  // Tabla de referencia (Excel «Procedimiento_CartaIntencion»). p:null = sin plazo.
  // Los valores se cambian desde Proyectos (menú ⋮ → Plazos por etapa).
  var ETAPAS = [
    {n:"Carta de intención",     r:"Ente",                      p:5},
    {n:"Presentación",           r:"Empresa",                   p:20},
    {n:"Chequeo",                r:"Ente",                      p:10},
    {n:"Evaluación técnica",     r:"Subsecretaría",             p:15},
    {n:"Preadjudicación",        r:"Ente",                      p:5},
    {n:"Autorización",           r:"Secretaría de Industria",   p:10},
    {n:"Protocolización",        r:"Escribanía de Gobierno",    p:30},
    {n:"Procedimiento de venta", r:"Ente",                      p:null},
    {n:"Escrituración",          r:"Empresa",                   p:null}
  ];

  function soloFecha(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function clave(d){
    var m = String(d.getMonth()+1).padStart(2,"0"), dd = String(d.getDate()).padStart(2,"0");
    return d.getFullYear()+"-"+m+"-"+dd;
  }
  // "YYYY-MM-DD" -> fecha local (nunca new Date("YYYY-MM-DD"), que es UTC).
  function parsear(str){
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str || "");
    return m ? new Date(+m[1], +m[2]-1, +m[3]) : null;
  }
  function esHabil(d){
    var dia = d.getDay();
    if (dia === 0 || dia === 6) return false;
    return FERIADOS.indexOf(clave(d)) === -1;
  }

  // Días hábiles en el intervalo (desde, hasta].
  function diasHabilesEntre(desde, hasta){
    var a = soloFecha(desde), b = soloFecha(hasta);
    if (b <= a) return 0;
    var n = 0, cur = new Date(a);
    while (cur < b){
      cur.setDate(cur.getDate()+1);
      if (cur <= b && esHabil(cur)) n++;
    }
    return n;
  }

  // Vence: entrada + plazo días hábiles.
  function vencimientoEtapa(entrada, plazo){
    var cur = soloFecha(entrada), n = 0;
    var tope = Math.min(plazo, PLAZO_MAX_DIAS);
    while (n < tope){
      cur.setDate(cur.getDate()+1);
      if (esHabil(cur)) n++;
    }
    return cur;
  }

  // Estado del plazo de una etapa. plazo null = sin plazo.
  // estado: sin_plazo | en_plazo | vence_hoy | vencido | alerta
  function estadoPlazo(entrada, plazo, hoy){
    if (plazo === null || plazo === undefined) return { estado: "sin_plazo" };
    var fin = vencimientoEtapa(entrada, plazo);
    var h = soloFecha(hoy);
    if (h <= fin){
      if (h.getTime() === fin.getTime()) return { estado: "vence_hoy", fin: fin, restan: 0 };
      return { estado: "en_plazo", fin: fin, restan: diasHabilesEntre(h, fin) };
    }
    var vencido = diasHabilesEntre(fin, h);
    return { estado: vencido >= UMBRAL_ALERTA_DIAS_HABILES ? "alerta" : "vencido", fin: fin, diasVencido: vencido };
  }

  // Plazos configurados -> lista de 9 (entero 1..999 o null). Acepta lo que guarda
  // cartas-intencion.json ([{etapa, nombre, dias}]) y cae a la tabla de referencia
  // en todo lo que falte o venga mal: un dato ajeno no puede colgar la pantalla.
  function normalizarPlazos(raw){
    var out = ETAPAS.map(function(e){ return e.p; });
    if (!Array.isArray(raw)) return out;
    raw.forEach(function(x){
      var i = x && Number(x.etapa) - 1;
      if (!(i >= 0 && i < out.length) || i !== Math.floor(i)) return;
      if (x.dias === null) { out[i] = null; return; }
      var d = Number(x.dias);
      if (Number.isInteger(d) && d >= 1 && d <= PLAZO_MAX_DIAS) out[i] = d;
    });
    return out;
  }
  // Inversa: lo que se guarda en cartas-intencion.json.
  function serializarPlazos(plazos){
    return ETAPAS.map(function(e, i){
      return { etapa: i+1, nombre: e.n, dias: plazos[i] === undefined ? e.p : plazos[i] };
    });
  }

  var API = {
    FERIADOS: FERIADOS, ETAPAS: ETAPAS,
    UMBRAL_ALERTA_DIAS_HABILES: UMBRAL_ALERTA_DIAS_HABILES, PLAZO_MAX_DIAS: PLAZO_MAX_DIAS,
    esHabil: esHabil, diasHabilesEntre: diasHabilesEntre, vencimientoEtapa: vencimientoEtapa,
    estadoPlazo: estadoPlazo, normalizarPlazos: normalizarPlazos, serializarPlazos: serializarPlazos,
    parsear: parsear, clave: clave
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.Plazos = API;
})(typeof window !== "undefined" ? window : globalThis);
