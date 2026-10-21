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

  /* Los colores salen de design-system.css y van sin valor de respaldo: los
     tokens existen siempre porque las cinco páginas cargan ese archivo. Un
     `var(--warn, #a8650f)` sería una segunda copia del color, que hay que
     acordarse de actualizar — el mismo motivo por el que ui-kit.css no tiene
     ni un literal. */
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
      "font-weight:600;letter-spacing:-.02em;color:var(--fg);" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    /* 48x48 de objetivo táctil (guía de Android), con el ícono de 24px
       centrado: el área cómoda no agranda el dibujo. */
    ".app-header__menu{flex:0 0 auto;width:48px;height:48px;display:flex;align-items:center;" +
      "justify-content:center;background:none;border:none;padding:0;cursor:pointer;" +
      "border-radius:999px;color:var(--fg);transition:background-color .15s ease}",
    ".app-header__menu:hover{background:var(--surface-2)}",
    ".app-header__menu:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}",
    ".app-header__menu svg{width:24px;height:24px;display:block}",

    /* Menú contextual: se ancla al botón y nunca se sale de la pantalla. */
    ".app-menu{position:fixed;z-index:60;min-width:216px;max-width:calc(100vw - 32px);" +
      "background:var(--surface);border:1px solid var(--border);border-radius:12px;" +
      "box-shadow:0 10px 30px rgba(0,0,0,.12);padding:6px;overflow:hidden}",
    ".app-menu[hidden]{display:none}",
    ".app-menu__item{display:flex;align-items:center;width:100%;min-height:44px;gap:10px;" +
      "padding:0 12px;background:none;border:none;border-radius:8px;cursor:pointer;" +
      "font-family:inherit;font-size:14px;color:var(--fg);text-align:left}",
    ".app-menu__item:hover{background:var(--surface-2)}",
    ".app-menu__item:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}",

    /* Diálogo de la clave compartida. Mismos tokens que el resto: el radio,
       el borde y las superficies salen de design-system.css, y los botones
       son los `.btn` de ui-kit.css — no hay un botón nuevo para esto. */
    ".app-clave__fondo{position:fixed;inset:0;z-index:70;display:flex;align-items:center;" +
      "justify-content:center;padding:16px;background:rgba(0,0,0,.45)}",
    ".app-clave{width:100%;max-width:360px;background:var(--surface);border:1px solid var(--border);" +
      "border-radius:var(--ds-radius-panel);padding:18px;display:flex;flex-direction:column;gap:12px;" +
      "box-shadow:0 10px 30px rgba(0,0,0,.18)}",
    ".app-clave__tit{margin:0;font-size:18px;font-weight:600;color:var(--fg)}",
    ".app-clave__texto{margin:0;font-size:13.5px;line-height:1.45;color:var(--muted)}",
    /* 16px no es decorativo: con menos, iOS hace zoom al enfocar el campo. */
    ".app-clave__input{width:100%;min-height:var(--ds-control-height);padding:0 12px;font:inherit;" +
      "font-size:16px;color:var(--fg);background:var(--surface);border:1px solid var(--border);" +
      "border-radius:var(--ds-radius-card)}",
    ".app-clave__acciones{display:flex;gap:var(--ds-gap)}",

    /* Estado de sincronización: vive acá adentro en vez de ocupar un lugar fijo
       arriba. Cuando algo falla sí sale a la vista (ver .app-sync-aviso). */
    ".app-menu__estado{padding:10px 12px 8px;font-size:12px;color:var(--muted);" +
      "border-top:1px solid var(--border);margin-top:6px}",
    ".app-menu__estado b{display:block;font-weight:600;color:var(--fg);margin-bottom:2px}",

    ".app-menu__velo{position:fixed;inset:0;z-index:59;background:transparent}",
    ".app-menu__velo[hidden]{display:none}",

    /* Aviso de sincronización: oculto mientras todo anda bien (era ruido
       permanente en el header), visible solo si hay cambios sin subir o falló
       la conexión, que es cuando el dato importa. */
    ".app-sync-aviso{display:flex;align-items:center;gap:8px;width:100%;" +
      "margin:0 0 12px;padding:9px 12px;border-radius:10px;border:1px solid transparent;" +
      "font-family:inherit;font-size:12.5px;text-align:left;cursor:pointer}",
    ".app-sync-aviso[hidden]{display:none}",
    ".app-sync-aviso--pendiente{background:var(--warn-bg);border-color:var(--warn);color:var(--warn)}",
    ".app-sync-aviso--error{background:var(--danger-bg);border-color:var(--danger);color:var(--danger)}",

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
      "background:var(--accent);color:var(--accent-fg);" +
      "box-shadow:0 4px 12px rgba(0,0,0,.22);transition:box-shadow .2s ease}",
    ".app-fab:hover{box-shadow:0 8px 18px rgba(0,0,0,.28)}",
    ".app-fab:focus-visible{outline:2px solid var(--accent);outline-offset:3px}",
    ".app-fab svg{width:26px;height:26px;display:block}",
    /* Variante pastilla (accion.pastilla: true): «+ Nuevo seguimiento», igual
       que «+ Nueva sesión» de la app de Claude. Color, familia y peso salen de
       los mismos tokens que .btn (ui-kit.css), así que cambiar el acento o la
       fuente de la app la cambia también acá. Alto 48px para que el toque
       llegue a 44px sin área extra. */
    ".app-fab--pastilla{width:auto;height:48px;padding:0 20px 0 16px;gap:8px;" +
      "border-radius:var(--ds-radius-pill);font-family:var(--ds-font-sans);" +
      "font-size:16px;font-weight:500;line-height:1;white-space:nowrap}",
    ".app-fab--pastilla svg{width:20px;height:20px}"
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

  /* Iconos de las acciones, en un solo lugar para las cuatro apps. Son los de
     Lucide (save, x, trash-2, pencil, check-circle-2, rotate-ccw, search),
     dibujados a mano como SVG inline: el proyecto no tiene build step ni
     dependencias, así que sumar la librería entera sería traer un paquete
     para siete iconos. Mismo viewBox, mismo grosor de trazo y mismas puntas
     redondeadas que el resto — que es lo que la especificación pide de ellos.
     El tamaño lo fija .btn-icon en ui-kit.css, no cada SVG. */
  var TRAZO =
    '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

  var ICONOS = {
    guardar: TRAZO + '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"></path>' +
      '<path d="M17 21v-8H7v8M7 3v5h8"></path></svg>',
    cancelar: TRAZO + '<path d="M18 6 6 18M6 6l12 12"></path></svg>',
    eliminar: TRAZO + '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path>' +
      '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M10 11v6M14 11v6"></path></svg>',
    editar: TRAZO + '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path></svg>',
    resolver: TRAZO + '<circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg>',
    reabrir: TRAZO + '<path d="M3 2v6h6"></path><path d="M3 13a9 9 0 1 0 3-7.7L3 8"></path></svg>',
    buscar: TRAZO.replace('class="btn-icon"', 'class="search-icon"') +
      '<circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>'
  };

  function icono(nombre) {
    return ICONOS[nombre] || "";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* Conecta una barra de búsqueda ya presente en el HTML: dibuja la lupa y el
     botón de limpiar, y mantiene ese botón visible solo cuando hay texto. No
     toca el `oninput` ni el filtrado de cada app — al limpiar dispara el
     mismo evento `input` que escribir a mano, así que el listado se actualiza
     por el camino que ya existía. */
  function initBuscador(input) {
    if (!input || input.dataset.uiBuscador === "1") return;
    var barra = input.closest(".search-bar");
    if (!barra) return;
    input.dataset.uiBuscador = "1";
    input.classList.add("search-input");

    if (!barra.querySelector(".search-icon")) {
      barra.insertAdjacentHTML("afterbegin", icono("buscar"));
    }

    var limpiar = barra.querySelector(".search-clear");
    if (!limpiar) {
      limpiar = document.createElement("button");
      limpiar.type = "button";
      limpiar.className = "search-clear";
      limpiar.setAttribute("aria-label", "Limpiar la búsqueda");
      limpiar.innerHTML = ICONOS.cancelar.replace('class="btn-icon"', "");
      barra.appendChild(limpiar);
    }

    function sincronizar() {
      limpiar.setAttribute("data-visible", input.value ? "1" : "0");
    }
    input.addEventListener("input", sincronizar);
    limpiar.addEventListener("click", function () {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      sincronizar();
    });
    sincronizar();
  }

  /* Vibración breve al tocar la barra de navegación. Es un extra: solo corre
     donde el navegador lo soporta (hoy, Android), nunca es la única señal de
     que el toque llegó —eso lo hace el :active de ui-kit.css— y se calla si
     el sistema pide menos movimiento. */
  var navListo = false;
  function initVibracionNav() {
    if (navListo) return;
    navListo = true;
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var nav = document.querySelector(".bottom-nav");
    if (!nav) return;
    nav.addEventListener("click", function (ev) {
      if (ev.target.closest(".nav-item")) {
        try { navigator.vibrate(10); } catch (e) {}
      }
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
      var etiquetaFab = cfg.accion.etiqueta || "Nuevo";
      var fab = document.createElement("button");
      fab.type = "button";
      fab.className = cfg.accion.pastilla ? "app-fab app-fab--pastilla" : "app-fab";
      fab.id = "fabNuevo";
      fab.title = etiquetaFab;
      fab.setAttribute("aria-label", etiquetaFab);
      fab.innerHTML = ICONO_MAS;
      // La etiqueta va como texto (no en innerHTML): puede venir de una página.
      if (cfg.accion.pastilla) {
        var textoFab = document.createElement("span");
        textoFab.textContent = etiquetaFab;
        fab.appendChild(textoFab);
      }
      fab.addEventListener("click", cfg.accion.onClick);
      document.body.appendChild(fab);
    }

    // Lo mismo para todas: cada barra de búsqueda que haya en la página y la
    // vibración de la navegación. Si una app suma un buscador después, le
    // alcanza con el marcado — no hay nada que registrar acá.
    document.querySelectorAll(".search-bar input").forEach(initBuscador);
    initVibracionNav();

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

  /* La landing (index.html) no llama a init(): no tiene título de sección ni
     ⋮ ni alta, solo la barra inferior. Pero la barra se comporta igual en las
     cinco páginas, así que lo que no depende de init() arranca solo. Las dos
     funciones son idempotentes, por lo que init() puede volver a llamarlas
     sin duplicar nada. */
  function autoArranque() {
    document.querySelectorAll(".search-bar input").forEach(initBuscador);
    initVibracionNav();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoArranque);
  } else {
    autoArranque();
  }


  /* ===================== CLAVE COMPARTIDA =====================
   *
   * Vive acá y no en cada app por el mismo motivo que el header: tiene que
   * comportarse idéntico en las cuatro, y escribirlo cuatro veces es cómo
   * nacieron los bugs que esta sesión encontró (cuatro implementaciones de
   * sync, dos con un bucle de reintento sin freno).
   *
   * La clave se guarda una vez por DISPOSITIVO, no por app: las cinco
   * páginas comparten origen, así que comparten este localStorage.
   *
   * Mientras el Worker no tenga cargado el secret APP_CLAVE, nunca devuelve
   * 401 y este código no se nota: no pide nada a nadie.
   */
  var CLAVE_KEY = "expedientes_crm_clave_v1";
  var CABECERA_CLAVE = "X-Clave";
  var pidiendoClave = null; // promesa en curso: un solo diálogo aunque fallen varios pedidos a la vez

  function leerClave() {
    try { return localStorage.getItem(CLAVE_KEY) || ""; } catch (e) { return ""; }
  }
  function guardarClave(v) {
    try { v ? localStorage.setItem(CLAVE_KEY, v) : localStorage.removeItem(CLAVE_KEY); } catch (e) {}
  }

  /* Diálogo propio y no prompt(): el proyecto ya decidió que no se usan
     popups bloqueantes del navegador, y prompt() además está deshabilitado
     en algunos contextos. Devuelve la clave escrita, o null si cancelan. */
  function pedirClave(motivo) {
    if (pidiendoClave) return pidiendoClave;
    pidiendoClave = new Promise(function (resolver) {
      var antes = document.activeElement;
      var fondo = document.createElement("div");
      fondo.className = "app-clave__fondo";
      fondo.innerHTML =
        '<div class="app-clave" role="dialog" aria-modal="true" aria-labelledby="appClaveTit">' +
          '<h2 class="app-clave__tit" id="appClaveTit">Clave de acceso</h2>' +
          '<p class="app-clave__texto"></p>' +
          '<input class="app-clave__input" type="password" autocomplete="current-password" ' +
                 'inputmode="text" aria-label="Clave">' +
          '<div class="app-clave__acciones">' +
            '<button type="button" class="btn btn-secondary btn-grow" data-cancelar>Cancelar</button>' +
            '<button type="button" class="btn btn-primary btn-grow" data-aceptar>Entrar</button>' +
          '</div>' +
        '</div>';
      fondo.querySelector(".app-clave__texto").textContent = motivo ||
        "Escribí la clave para ver y guardar los datos. Queda guardada en este dispositivo.";
      document.body.appendChild(fondo);

      var campo = fondo.querySelector(".app-clave__input");
      campo.focus();

      function cerrar(valor) {
        document.removeEventListener("keydown", enTecla, true);
        fondo.remove();
        if (antes && antes.focus) antes.focus();
        pidiendoClave = null;
        resolver(valor);
      }
      function aceptar() {
        var v = campo.value.trim();
        if (!v) { campo.focus(); return; }
        guardarClave(v);
        cerrar(v);
      }
      function enTecla(e) {
        if (e.key === "Escape") { e.preventDefault(); cerrar(null); }
        else if (e.key === "Enter" && fondo.contains(document.activeElement)) { e.preventDefault(); aceptar(); }
        else if (e.key === "Tab") {
          // Trampa de foco: el diálogo tapa la app, el tabulador no sale.
          var focos = fondo.querySelectorAll("input, button");
          var primero = focos[0], ultimo = focos[focos.length - 1];
          if (e.shiftKey && document.activeElement === primero) { e.preventDefault(); ultimo.focus(); }
          else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primero.focus(); }
        }
      }
      document.addEventListener("keydown", enTecla, true);
      fondo.querySelector("[data-aceptar]").addEventListener("click", aceptar);
      fondo.querySelector("[data-cancelar]").addEventListener("click", function () { cerrar(null); });
    });
    return pidiendoClave;
  }

  /* El fetch que usan las cuatro apps para hablar con /api/.
   *
   * Agrega la cabecera si hay clave guardada. Si el Worker responde 401,
   * pide la clave UNA vez y reintenta UNA vez: sin bucle. Si cancelan,
   * devuelve el 401 tal cual para que el llamador lo trate como un fallo
   * normal (y, en las apps, dispare su backoff en vez de insistir). */
  async function fetchApi(recurso, opciones) {
    var opts = Object.assign({}, opciones || {});
    function conClave(clave) {
      var h = new Headers(opts.headers || {});
      if (clave) h.set(CABECERA_CLAVE, clave);
      return Object.assign({}, opts, { headers: h });
    }

    var resp = await fetch(recurso, conClave(leerClave()));
    // Mientras el Worker siga diciendo 401, se vuelve a preguntar. Es un
    // `while` y no un solo reintento porque si no, una clave mal tipeada
    // dejaba la app sin forma de entrar: el diálogo no volvía hasta el
    // siguiente pedido, que podía no llegar nunca. Lo encontró el test del
    // navegador, no la lectura del código.
    //
    // No es un bucle que pueda desbocarse: cada vuelta espera a que una
    // persona escriba algo, y cancelar sale devolviendo el 401 tal cual para
    // que el llamador lo trate como un fallo normal (y dispare su backoff).
    var yaIntento = false;
    while (resp.status === 401) {
      guardarClave("");
      var nueva = await pedirClave(yaIntento
        ? "Esa clave no es correcta. Probá de nuevo."
        : "Esta app pide una clave para ver y guardar los datos. Queda guardada en este dispositivo.");
      if (!nueva) return resp;
      yaIntento = true;
      resp = await fetch(recurso, conClave(nueva));
    }
    return resp;
  }

  window.HeaderGlobal = {
    init: init,
    setTitulo: setTitulo,
    setSync: setSync,
    setMenu: setMenu,
    icono: icono,
    initBuscador: initBuscador,
    fetchApi: fetchApi,
    pedirClave: pedirClave,
    olvidarClave: function () { guardarClave(""); }
  };
})();
