// Pruebas de public/plazos.js (función pura, sin navegador): T1–T8 y T10 del documento
// «Expedientes CRM: resultado final», más la normalización de plazos configurados.
import assert from 'node:assert';
await import('../public/plazos.js');
const P = globalThis.Plazos;
const d = (y, m, dd) => new Date(y, m - 1, dd);
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); n++; };

// T1: lunes 26/10 + 5 hábiles = lunes 2/11 (sáb y dom no cuentan)
eq(P.vencimientoEtapa(d(2026, 10, 26), 5).getTime(), d(2026, 11, 2).getTime(), 'T1 vencimiento 5 días hábiles');
// T2: viernes 23/10 + 2 = martes 27/10
eq(P.vencimientoEtapa(d(2026, 10, 23), 2).getTime(), d(2026, 10, 27).getTime(), 'T2 fin de semana no cuenta');
// T3: en plazo
let r = P.estadoPlazo(d(2026, 10, 14), 20, d(2026, 10, 25));
eq(r.estado, 'en_plazo', 'T3 en plazo'); ok(r.restan > 0, 'T3 restan positivo');
// T4: vence hoy
r = P.estadoPlazo(d(2026, 10, 14), 5, P.vencimientoEtapa(d(2026, 10, 14), 5));
eq(r.estado, 'vence_hoy', 'T4 vence hoy');
// T5/T6/T10: vencido a 1 día hábil, alerta a los 2
const e5 = d(2026, 10, 12); // lunes; vence lunes 19
r = P.estadoPlazo(e5, 5, d(2026, 10, 20));
eq(r.estado, 'vencido', 'T5 vencido sin alerta'); eq(r.diasVencido, 1, 'T5 1 día hábil vencido');
eq(P.estadoPlazo(e5, 5, d(2026, 10, 21)).estado, 'alerta', 'T6/T10 alerta a los 2 días hábiles');
// T7: sin plazo
eq(P.estadoPlazo(d(2026, 10, 1), null, d(2026, 10, 25)).estado, 'sin_plazo', 'T7 sin plazo');
// T8: viernes → lunes = 1 hábil
eq(P.diasHabilesEntre(d(2026, 10, 23), d(2026, 10, 26)), 1, 'T8 viernes→lunes = 1 hábil');
// Feriados: Viernes Santo 3/4/2026 y Malvinas 2/4 no cuentan (1/4 + 2 hábiles = martes 7/4)
eq(P.vencimientoEtapa(d(2026, 4, 1), 2).getTime(), d(2026, 4, 7).getTime(), 'feriados no cuentan');
// Tope: un plazo absurdo no cuelga el cálculo
const t0 = Date.now(); P.vencimientoEtapa(d(2026, 1, 1), 3000000); ok(Date.now() - t0 < 500, 'plazo acotado');

// Plazos configurados
const ref = P.normalizarPlazos(undefined);
eq(ref.join(','), '5,20,10,15,5,10,30,,', 'sin config: tabla del Excel');
eq(ref[7], null, 'etapa 8 sin plazo'); eq(ref[8], null, 'etapa 9 sin plazo');
const cfg = P.normalizarPlazos([{ etapa: 1, dias: 7 }, { etapa: 2, dias: null }, { etapa: 3, dias: 'x' }, { etapa: 99, dias: 4 }, { etapa: 4, dias: 5000 }]);
eq(cfg[0], 7, 'se adopta un plazo válido'); eq(cfg[1], null, 'null = sin plazo');
eq(cfg[2], 10, 'un valor inválido cae al de referencia'); eq(cfg[3], 15, 'sobre el tope cae al de referencia');
eq(cfg.length, 9, 'siempre 9 etapas');
const vuelta = P.normalizarPlazos(P.serializarPlazos(cfg));
eq(JSON.stringify(vuelta), JSON.stringify(cfg), 'serializar y normalizar son inversas');

console.log(`OK: ${n} pruebas de plazos pasaron`);
