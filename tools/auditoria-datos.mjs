// Auditoría de parques.json — integridad referencial y calidad de datos
import { readFileSync } from 'fs';
const d = JSON.parse(readFileSync(new URL('../parques.json', import.meta.url), 'utf8'));

const out = {};
const emp = d.empresas || [], lot = d.lotes || [], ocu = d.ocupaciones || [], res = d.reservas || [];
const elim = d.eliminados || {};
out.totales = { parques: (d.parques||[]).map(p=>p.id), empresas: emp.length, lotes: lot.length, ocupaciones: ocu.length, reservas: res.length, eliminados: elim };

const empIds = new Set(emp.map(e=>e.id_empresa));
const lotIds = new Set(lot.map(l=>l.id_lote));

// IDs duplicados
const dup = (arr,k)=>{const s={},r=[];arr.forEach(x=>{const v=x[k];if(s[v])r.push(v);s[v]=1;});return r;};
out.ids_duplicados = { empresas: dup(emp,'id_empresa'), lotes: dup(lot,'id_lote') };

// Referencias rotas
out.lotes_con_empresa_inexistente = lot.filter(l=>l.id_empresa && !empIds.has(l.id_empresa)).map(l=>l.id_lote);
out.ocup_lote_inexistente = ocu.filter(o=>!lotIds.has(o.id_lote)).map(o=>o.id);
out.ocup_ocupante_inexistente = ocu.filter(o=>o.id_empresa_ocupante && !empIds.has(o.id_empresa_ocupante)).map(o=>o.id);
out.ocup_titular_inexistente = ocu.filter(o=>o.id_empresa_titular && !empIds.has(o.id_empresa_titular)).map(o=>o.id);
out.reservas_lote_inexistente = res.filter(r=>r.id_lote && !lotIds.has(r.id_lote)).map(r=>r.id_lote);

// Registros que apuntan a IDs ya eliminados (resurrecciones)
const elimEmp = new Set(elim.empresas||[]), elimLot = new Set(elim.lotes||[]);
out.referencias_a_eliminados = {
  lotes_a_empresa_borrada: lot.filter(l=>elimEmp.has(l.id_empresa)).map(l=>l.id_lote),
  ocup_a_borrados: ocu.filter(o=>elimLot.has(o.id_lote)||elimEmp.has(o.id_empresa_ocupante)||elimEmp.has(o.id_empresa_titular)).map(o=>o.id)
};

// CUITs
const cuitRe = /^\d{11}$/;
const cuitNorm = v => String(v||'').replace(/[^\d]/g,'');
out.cuit = { sin_cuit: 0, invalidos: [], duplicados: [] };
const vistos = {};
emp.forEach(e=>{
  const c = cuitNorm(e.cuit);
  if(!c){ out.cuit.sin_cuit++; return; }
  if(!cuitRe.test(c)) out.cuit.invalidos.push(e.id_empresa+':'+e.cuit);
  else { if(vistos[c]) out.cuit.duplicados.push(c+' ('+vistos[c]+','+e.id_empresa+')'); vistos[c]=e.id_empresa; }
});
// dígito verificador
function dvOk(c){ const m=[5,4,3,2,7,6,5,4,3,2]; let s=0; for(let i=0;i<10;i++)s+=+c[i]*m[i]; let dv=11-(s%11); if(dv===11)dv=0; if(dv===10)return false; return dv===+c[10]; }
out.cuit.dv_malo = emp.map(e=>({id:e.id_empresa,c:cuitNorm(e.cuit)})).filter(x=>cuitRe.test(x.c)&&!dvOk(x.c)).map(x=>x.id+':'+x.c);

// Lotes: superficie
out.lotes_sin_superficie = lot.filter(l=>l.superficie_m2==null||l.superficie_m2==='').length;
out.lotes_superficie_rara = lot.filter(l=>{const n=Number(l.superficie_m2); return l.superficie_m2!=null && (isNaN(n)||n<=0||n>1000000);}).map(l=>l.id_lote+':'+l.superficie_m2);

// Estado "Alquilada" sin ocupación vigente
const ocuVig = new Set(ocu.filter(o=>o.vigente).map(o=>o.id_lote));
out.alquilados_sin_ocupante = lot.filter(l=>String(l.estado||'')==='Alquilada'&&!ocuVig.has(l.id_lote)).map(l=>l.id_lote);
// Ocupación vigente en lote no "Alquilada"
out.ocupado_estado_distinto = ocu.filter(o=>o.vigente).map(o=>lot.find(l=>l.id_lote===o.id_lote)).filter(l=>l&&String(l.estado||'')!=='Alquilada').map(l=>l.id_lote+':'+(l.estado||'null'));

// disponible=true pero con empresa asignada
out.disponible_con_empresa = lot.filter(l=>l.disponible&&l.id_empresa).map(l=>l.id_lote);

// Empresas sin ningún lote ni ocupación
const conLote = new Set(lot.map(l=>l.id_empresa).filter(Boolean));
const ocupantes = new Set(ocu.filter(o=>o.vigente).map(o=>o.id_empresa_ocupante));
out.empresas_sin_vinculo = emp.filter(e=>!conLote.has(e.id_empresa)&&!ocupantes.has(e.id_empresa)).map(e=>e.id_empresa);

// id_parque faltante o desconocido
const pIds = new Set((d.parques||[]).map(p=>p.id));
out.sin_id_parque = { empresas: emp.filter(e=>!e.id_parque).length, lotes: lot.filter(l=>!l.id_parque).length };
out.id_parque_desconocido = { empresas: emp.filter(e=>e.id_parque&&!pIds.has(e.id_parque)).length, lotes: lot.filter(l=>l.id_parque&&!pIds.has(l.id_parque)).length };

// matriculas[] vs campos sueltos inconsistentes
out.matricula_suelta_vs_lista = lot.filter(l=>Array.isArray(l.matriculas)&&l.matriculas.length&&l.matricula&&!l.matriculas.some(m=>String(m.matricula)===String(l.matricula))).map(l=>l.id_lote);

// nombres duplicados (mismo parque, normalizado)
const norm = s=>String(s||'').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\b(S\.?\s?A\.?|S\.?\s?R\.?\s?L\.?|LTDA\.?)\b/g,'').replace(/[^A-Z0-9 ]/g,'').replace(/\s+/g,' ').trim();
const porNombre = {};
emp.forEach(e=>{const k=(e.id_parque||'?')+'|'+norm(e.nombre_empresa); (porNombre[k]=porNombre[k]||[]).push(e.id_empresa);});
out.nombres_duplicados_mismo_parque = Object.entries(porNombre).filter(([,v])=>v.length>1).map(([k,v])=>k.split('|')[1]+': '+v.join(','));

// tamaño del archivo
import { statSync } from 'fs';
out.tamano_kb = Math.round(statSync(new URL('../parques.json', import.meta.url)).size/1024);

console.log(JSON.stringify(out, null, 1));
