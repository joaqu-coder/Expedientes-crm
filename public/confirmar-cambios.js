/*
 * Confirmar cambios — tarjeta «¿Desea guardar los cambios?».
 * Componente compartido: una sola implementación para todas las apps.
 *
 * Uso (una vez cargado el script):
 *
 *   ConfirmarCambios.pedir({
 *     titulo: "¿Desea guardar los cambios?",     // opcional, este es el default
 *     mensaje: "Hay cambios sin guardar en este expediente.", // opcional
 *     textoGuardar: "Guardar",                   // opcional
 *     textoDescartar: "No guardar",              // opcional
 *     textoSeguir: "Seguir editando"             // opcional
 *   }).then(function(opcion){
 *     // opcion: "guardar" | "descartar" | "seguir"
 *   });
 *
 * Contrato:
 *   - No guarda nada ni cierra nada: solo pregunta y devuelve la decisión.
 *     Quien llama decide qué hacer con cada opción.
 *   - "seguir" es la salida segura: también es Escape, el clic en el fondo y
 *     la respuesta si se abre otra tarjeta antes de contestar esta.
 *   - Foco: entra al botón primario, Tab no se escapa de la tarjeta, y al
 *     cerrar vuelve al elemento que tenía el foco antes.
 *   - Sin ids ni dependencias: no choca con los ids de cada página.
 *
 * Dependencias: solo las clases de ui-kit.css (.cc-*, .btn). Sin ellas, la
 * tarjeta se ve sin estilo pero funciona.
 */
(function(){
  "use strict";

  var DEFAULTS = {
    titulo: "¿Desea guardar los cambios?",
    mensaje: "Hay cambios sin guardar en este expediente.",
    textoGuardar: "Guardar",
    textoDescartar: "No guardar",
    textoSeguir: "Seguir editando"
  };

  var veil = null;     // contenedor de la tarjeta, se crea la primera vez
  var card = null;
  var resolver = null; // función que cierra la promesa actual
  var focoPrevio = null;

  function construir(){
    veil = document.createElement("div");
    veil.className = "cc-veil";
    veil.hidden = true;
    veil.innerHTML =
      '<div class="cc-card" role="alertdialog" aria-modal="true" aria-labelledby="cc-titulo" aria-describedby="cc-mensaje">' +
        '<h2 class="cc-title" id="cc-titulo"></h2>' +
        '<p class="cc-msg" id="cc-mensaje"></p>' +
        '<div class="cc-actions">' +
          '<button type="button" class="btn btn-primary" data-opcion="guardar"></button>' +
          '<button type="button" class="btn btn-danger" data-opcion="descartar"></button>' +
          '<button type="button" class="btn btn-secondary" data-opcion="seguir"></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(veil);
    card = veil.querySelector(".cc-card");

    // Clic en un botón: se resuelve con esa opción.
    veil.addEventListener("click", function(ev){
      if(ev.target === veil){ responder("seguir"); return; }   // fondo = seguir
      var btn = ev.target.closest && ev.target.closest("[data-opcion]");
      if(btn) responder(btn.getAttribute("data-opcion"));
    });

    // Teclado. Se engancha a la tarjeta y corta la propagación: si no, el
    // Escape de la ficha de atrás se dispararía a la vez y la reabriría.
    veil.addEventListener("keydown", function(ev){
      if(ev.key === "Escape"){
        ev.preventDefault();
        ev.stopPropagation();
        responder("seguir");
        return;
      }
      if(ev.key === "Tab") atrapar(ev);
    }, true);
  }

  function focusables(){
    return Array.prototype.filter.call(
      card.querySelectorAll("button:not([disabled])"),
      function(el){ return !el.hidden; }
    );
  }

  // Trampa de foco: Tab y Shift+Tab no salen de la tarjeta.
  function atrapar(ev){
    var f = focusables();
    if(!f.length) return;
    var primero = f[0], ultimo = f[f.length - 1];
    if(ev.shiftKey && document.activeElement === primero){ ev.preventDefault(); ultimo.focus(); }
    else if(!ev.shiftKey && document.activeElement === ultimo){ ev.preventDefault(); primero.focus(); }
  }

  function responder(opcion){
    if(!resolver) return;
    var r = resolver;
    resolver = null;
    veil.hidden = true;
    if(focoPrevio && focoPrevio.focus) focoPrevio.focus();
    focoPrevio = null;
    r(opcion);
  }

  function pedir(opciones){
    opciones = opciones || {};
    if(!veil) construir();
    // Si ya había una tarjeta abierta, la anterior se resuelve como "seguir"
    // para que nadie quede colgado esperando una respuesta que no llega.
    if(resolver) responder("seguir");

    var t = Object.assign({}, DEFAULTS, opciones);
    card.querySelector(".cc-title").textContent = t.titulo;
    card.querySelector(".cc-msg").textContent = t.mensaje;
    card.querySelector('[data-opcion="guardar"]').textContent = t.textoGuardar;
    card.querySelector('[data-opcion="descartar"]').textContent = t.textoDescartar;
    card.querySelector('[data-opcion="seguir"]').textContent = t.textoSeguir;

    focoPrevio = document.activeElement;
    veil.hidden = false;
    return new Promise(function(resolve){
      resolver = resolve;
      var primario = card.querySelector('[data-opcion="guardar"]');
      if(primario) primario.focus();
    });
  }

  function abierto(){
    return !!veil && !veil.hidden;
  }

  window.ConfirmarCambios = { pedir: pedir, abierto: abierto };
})();
