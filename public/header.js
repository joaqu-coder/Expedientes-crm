/*
 * Header global — componente único compartido por las 4 apps.
 *
 * Por qué un archivo aparte y no copiado en cada HTML: este repo es un MPA
 * (cada app es un documento independiente, ver CLAUDE.md) y hasta ahora todo
 * el CSS/JS vivía inline en cada página. El header es lo único que tiene que
 * verse EXACTAMENTE igual en las cuatro, así que es el caso que justifica un
 * archivo común: se escribe una vez y las cuatro lo cargan. Sigue sin haber
 * build step — es un <script> más.
 *
 * El aislamiento del MPA se mantiene: este archivo no toca el estado ni el DOM
 * de la app, solo inserta su propio header al principio del <body> y gestiona
 * su menú.
 *
 * Uso, al final del <body> de cada página:
 *
 *   <script src="/header.js"></script>
 *   <script>
 *     HeaderGlobal.init({
 *       titulo: "Parques",
 *       menu: [{ etiqueta: "Configuración", onClick: abrirConfig }]
 *     });
 *   </script>
 *
 * Y para el estado de sincronización, que ya no ocupa lugar fijo en pantalla:
 *
 *   HeaderGlobal.setSync("Sincronizado", "ok");   // ok | pendiente | error
 */
(function () {
  "use strict";

  var CSS = [
    /* El header ocupa el ancho disponible y respeta el margen horizontal de
       cada página. Sin bordes ni sombras: se integra con el fondo. */
    /* El padding real lo fija init() según el contenedor donde se monte: las
       cuatro páginas no tienen el mismo margen de cuerpo (seguimiento.html no
       usa padding en el body y las otras tres sí), y sin compensarlo el ⋮
       quedaba pegado al borde en una pantalla y a 16px en las demás. */
    ".app-header{display:flex;align-items:center;justify-content:space-between;gap:12px;" +
      "background:transparent}",

    /* El título puede ser largo ("Resoluciones"): se recorta en vez de empujar
       el botón, que debe quedar SIEMPRE en la misma posición respecto del
       borde derecho, en las cuatro pantallas. */
    ".app-header__titulo{flex:1 1 auto;min-width:0;margin:0;font-size:clamp(22px,6vw,28px);" +
      "font-weight:600;letter-spacing:-.02em;color:var(--fg,#1f2937);" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    /* 48x48 de objetivo táctil (guía de Android), con el ícono de 24px
       centrado: el área cómoda no agranda el dibujo. */
    ".app-header__menu{flex:0 0 auto;width:48px;height:48px;display:flex;align-items:center;" +
      "justify-content:center;background:none;border:none;padding:0;cursor:pointer;" +
      "border-radius:999px;color:var(--fg,#1f2937);transition:background-color .15s ease}",
    ".app-header__menu:hover{background:var(--surface-2,#f3f4f6)}",
    ".app-header__menu:focus-visible{outline:2px solid var(--accent,#667eea);outline-offset:-2px}",
    ".app-header__menu svg{width:24px;height:24px;display:block}",

    /* Menú contextual: se ancla al botón y nunca se sale de la pantalla. */
    ".app-menu{position:fixed;z-index:60;min-width:216px;max-width:calc(100vw - 32px);" +
      "background:var(--surface,#fff);border:1px solid var(--border,#e5e7eb);border-radius:12px;" +
      "box-shadow:0 10px 30px rgba(0,0,0,.12);padding:6px;overflow:hidden}",
    ".app-menu[hidden]{display:none}",
    ".app-menu__item{display:flex;align-items:center;width:100%;min-height:44px;gap:10px;" +
      "padding:0 12px;background:none;border:none;border-radius:8px;cursor:pointer;" +
      "font-family:inherit;font-size:14px;color:var(--fg,#1f2937);text-align:left}",
    ".app-menu__item:hover{background:var(--surface-2,#f3f4f6)}",
    ".app-menu__item:focus-visible{outline:2px solid var(--accent,#667eea);outline-offset:-2px}",

    /* Estado de sincronización: vive acá adentro en vez de ocupar un lugar fijo
       arriba. Cuando algo falla sí sale a la vista (ver .app-sync-aviso). */
    ".app-menu__estado{padding:10px 12px 8px;font-size:12px;color:var(--muted,#6b7280);" +
      "border-top:1px solid var(--border,#e5e7eb);margin-top:6px}",
    ".app-menu__estado b{display:block;font-weight:600;color:var(--fg,#1f2937);margin-bottom:2px}",

    ".app-menu__velo{position:fixed;inset:0;z-index:59;background:transparent}",
    ".app-menu__velo[hidden]{display:none}",

    /* Aviso de sincronización: oculto mientras todo anda bien (era ruido
       permanente en el header), visible solo si hay cambios sin subir o falló
       la conexión, que es cuando el dato importa. */
    ".app-sync-aviso{display:flex;align-items:center;gap:8px;width:100%;" +
      "margin:0 0 12px;padding:9px 12px;border-radius:10px;border:1px solid transparent;" +
      "font-family:inherit;font-size:12.5px;text-align:left;cursor:pointer}",
    ".app-sync-aviso[hidden]{display:none}",
    ".app-sync-aviso--pendiente{background:var(--warn-bg,#fbead0);border-color:var(--warn,#a8650f);color:var(--warn,#a8650f)}",
    ".app-sync-aviso--error{background:var(--danger-bg,#f7e2dd);border-color:var(--danger,#a1392c);color:var(--danger,#a1392c)}",

    /* El botón flotante vive acá, con el header, porque es el otro elemento
       que tiene que verse y ubicarse EXACTAMENTE igual en las cuatro apps:
       es la acción principal de cada una y antes era un botón con texto
       dentro de cada cabecera, distinto en cada pantalla. Va por encima de
       la barra de navegación inferior (56px + el área segura del teléfono).

       z-index 14 y no más: por debajo del overlay de los modales, que cada
       app define en su propio CSS (20 en parques/proyectos/resoluciones,
       200 en seguimiento). Con 40 el + quedaba FLOTANDO SOBRE el modal
       abierto en tres de las cuatro apps, tapando contenido y, peor, siendo
       clickeable: abría un alta nueva encima de la ficha que se estaba
       mirando. Si alguna vez una app baja su overlay de 14, se rompe de
       nuevo — `testUniformidad` lo verifica por comportamiento, abriendo el
       modal y preguntando quién recibe el toque en el centro del botón. */
    ".app-fab{position:fixed;right:16px;bottom:calc(76px + env(safe-area-inset-bottom,0px));" +
      "width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;z-index:14;" +
      "display:flex;align-items:center;justify-content:center;" +
      "background:var(--accent,#667eea);color:var(--accent-fg,#fff);" +
      "box-shadow:0 4px 12px rgba(0,0,0,.22);transition:box-shadow .2s ease}",
    ".app-fab:hover{box-shadow:0 8px 18px rgba(0,0,0,.28)}",
    ".app-fab:focus-visible{outline:2px solid var(--accent,#667eea);outline-offset:3px}",
    ".app-fab svg{width:26px;height:26px;display:block}"
  ].join("\n");

  var ICONO_MAS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>';

  var ICONO_MENU =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<circle cx="12" cy="5" r="2"></circle>' +
    '<circle cx="12" cy="12" r="2"></circle>' +
    '<circle cx="12" cy="19" r="2"></circle>' +
    "</svg>";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var menuEl = null;
  var veloEl = null;
  var botonEl = null;
  var avisoEl = null;
  var itemsMenu = [];
  var estadoSync = { texto: "", nivel: "ok", onReintentar: null };

  function cerrarMenu(devolverFoco) {
    if (!menuEl || menuEl.hidden) return;
    menuEl.hidden = true;
    veloEl.hidden = true;
    botonEl.setAttribute("aria-expanded", "false");
    if (devolverFoco) botonEl.focus();
  }

  function pintarMenu() {
    var html = itemsMenu
      .map(function (it, i) {
        return (
          '<button type="button" class="app-menu__item" data-i="' + i + '">' + esc(it.etiqueta) + "</button>"
        );
      })
      .join("");
    if (estadoSync.texto) {
      html += '<div class="app-menu__estado"><b>Sincronización</b>' + esc(estadoSync.texto) + "</div>";
    }
    menuEl.innerHTML = html;
    menuEl.querySelectorAll(".app-menu__item").forEach(function (b) {
      b.addEventListener("click", function () {
        var it = itemsMenu[Number(b.getAttribute("data-i"))];
        // El foco vuelve al ⋮ ANTES de ejecutar la acción: si esta abre un
        // modal, el modal guarda el ⋮ como punto de retorno. Si no, guardaría
        // este ítem, que deja de existir al cerrarse el menú, y al cerrar el
        // modal el foco se perdería.
        cerrarMenu(true);
        if (it && typeof it.onClick === "function") it.onClick();
      });
    });
  }

  function abrirMenu() {
    pintarMenu();
    menuEl.hidden = false;
    veloEl.hidden = false;
    botonEl.setAttribute("aria-expanded", "true");
    // Anclado al botón, sin salirse por el borde derecho ni por abajo.
    var r = botonEl.getBoundingClientRect();
    menuEl.style.visibility = "hidden";
    menuEl.style.top = "0px";
    menuEl.style.left = "0px";
    var m = menuEl.getBoundingClientRect();
    var left = Math.max(16, Math.min(r.right - m.width, window.innerWidth - m.width - 16));
    var top = Math.min(r.bottom + 6, Math.max(8, window.innerHeight - m.height - 8));
    menuEl.style.left = left + "px";
    menuEl.style.top = top + "px";
    menuEl.style.visibility = "";
    var primero = menuEl.querySelector(".app-menu__item");
    if (primero) primero.focus();
  }

  function init(opciones) {
    var cfg = opciones || {};
    itemsMenu = Array.isArray(cfg.menu) ? cfg.menu : [];

    var estilo = document.createElement("style");
    estilo.setAttribute("data-header-global", "");
    estilo.textContent = CSS;
    document.head.appendChild(estilo);

    var header = document.createElement("header");
    header.className = "app-header";
    header.innerHTML =
      '<h1 class="app-header__titulo">' + esc(cfg.titulo || "") + "</h1>" +
      '<button type="button" class="app-header__menu" id="btnMenu" aria-label="Más opciones" ' +
      'aria-haspopup="menu" aria-expanded="false">' + ICONO_MENU + "</button>";

    // El aviso de sync va debajo del header, en el flujo: cuando aparece empuja
    // el contenido en vez de taparlo.
    avisoEl = document.createElement("button");
    avisoEl.type = "button";
    avisoEl.className = "app-sync-aviso";
    avisoEl.id = "syncAviso";
    avisoEl.hidden = true;
    avisoEl.addEventListener("click", function () {
      if (typeof estadoSync.onReintentar === "function") estadoSync.onReintentar();
    });

    var ancla = cfg.montarEn ? document.querySelector(cfg.montarEn) : document.body;

    // Alineación idéntica en las cuatro pantallas: el header anula con margen
    // negativo el padding que ya trae el contenedor y pone el suyo propio. Así
    // el título arranca a 16px del borde y el ⋮ queda a 16px del derecho,
    // tenga o no padding la página que lo monta.
    var pc = window.getComputedStyle(ancla);
    var padL = parseFloat(pc.paddingLeft) || 0;
    var padR = parseFloat(pc.paddingRight) || 0;
    var padT = parseFloat(pc.paddingTop) || 0;
    header.style.marginLeft = -padL + "px";
    header.style.marginRight = -padR + "px";
    header.style.marginTop = -padT + "px";
    header.style.padding = "20px 16px 14px";

    ancla.insertBefore(avisoEl, ancla.firstChild);
    ancla.insertBefore(header, ancla.firstChild);

    botonEl = header.querySelector(".app-header__menu");

    veloEl = document.createElement("div");
    veloEl.className = "app-menu__velo";
    veloEl.hidden = true;
    menuEl = document.createElement("div");
    menuEl.className = "app-menu";
    menuEl.setAttribute("role", "menu");
    menuEl.hidden = true;
    document.body.appendChild(veloEl);
    document.body.appendChild(menuEl);

    botonEl.addEventListener("click", function () {
      if (menuEl.hidden) abrirMenu();
      else cerrarMenu(true);
    });
    veloEl.addEventListener("click", function () { cerrarMenu(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !menuEl.hidden) { e.stopPropagation(); cerrarMenu(true); }
    });
    window.addEventListener("resize", function () { cerrarMenu(false); });

    // Acción principal de la app, como botón flotante.
    if (cfg.accion && typeof cfg.accion.onClick === "function") {
      var fab = document.createElement("button");
      fab.type = "button";
      fab.className = "app-fab";
      fab.id = "fabNuevo";
      fab.title = cfg.accion.etiqueta || "Nuevo";
      fab.setAttribute("aria-label", cfg.accion.etiqueta || "Nuevo");
      fab.innerHTML = ICONO_MAS;
      fab.addEventListener("click", cfg.accion.onClick);
      document.body.appendChild(fab);
    }

    return { boton: botonEl };
  }

  function setTitulo(t) {
    var h = document.querySelector(".app-header__titulo");
    if (h) h.textContent = t;
  }

  // nivel: "ok" (no se muestra nada), "pendiente" o "error" (sale el aviso).
  function setSync(texto, nivel, onReintentar) {
    estadoSync = { texto: texto || "", nivel: nivel || "ok", onReintentar: onReintentar || estadoSync.onReintentar };
    if (!avisoEl) return;
    if (nivel === "pendiente" || nivel === "error") {
      avisoEl.textContent = texto;
      avisoEl.className = "app-sync-aviso app-sync-aviso--" + nivel;
      avisoEl.hidden = false;
    } else {
      avisoEl.hidden = true;
    }
    if (menuEl && !menuEl.hidden) pintarMenu();
  }

  function setMenu(items) {
    itemsMenu = Array.isArray(items) ? items : [];
    if (menuEl && !menuEl.hidden) pintarMenu();
  }

  window.HeaderGlobal = { init: init, setTitulo: setTitulo, setSync: setSync, setMenu: setMenu };
})();
