# Expedientes CRM

Tres aplicaciones web progresivas (PWA) detrás de una misma landing:

- **Seguimiento** (`public/seguimiento.html`): gestión de expedientes administrativos/legales con sistema automático de semáforo basado en días hábiles hasta vencimiento.
- **Proyectos** (`public/proyectos.html`): cartas de intención de parques industriales (EGPAIS), con listado filtrable y dashboard.
- **Resoluciones** (`public/resoluciones.html`): resoluciones del Directorio — 422 resoluciones de 2012 a 2025, con filtros por tema y año, búsqueda en el texto resolutivo y ficha por resolución.

Comparten un mismo Cloudflare Worker (`worker.js`) y el mismo `GITHUB_TOKEN`, pero cada una sincroniza su propio archivo JSON en este repo (`expedientes.json` / `cartas-intencion.json` / `resoluciones.json`) por rutas de API separadas (`/api/sync` / `/api/sync-cartas` / `/api/sync-resoluciones`). Ver `CLAUDE.md` para el detalle de la arquitectura.

## ✨ Características

- 📋 **CRUD completo**: Crear, editar, eliminar y listar expedientes
- 🚦 **Semáforo automático**: Estado visual según días hábiles restantes
- 📅 **Cálculo inteligente**: Considera fines de semana y feriados argentinos
- 🏢 **Áreas editables**: Gestiona dinámicamente las áreas responsables
- 👤 **Responsables editables**: Agrega o elimina responsables en tiempo real
- 📝 **Intervenciones**: Historial de cambios con timestamp automático
- 💾 **Persistencia local**: LocalStorage sin servidor necesario
- 📱 **Responsive**: Móvil y desktop (sidebar en desktop, modal en móvil)
- 🌙 **Modo oscuro**: Soporte automático por preferencia del navegador
- 📲 **PWA**: Instalable en home screen, funciona offline
- ✅ **Validación**: Formato de expediente con patrón regex

## 🎯 Semáforo de Estados

| Emoji | Color | Rango | Descripción |
|-------|-------|-------|------------|
| 🔴 | Rojo (#7f0000) | 0 días | Vencido o vence hoy |
| 🟠 | Naranja | 1-5 días | Urgente |
| 🟡 | Amarillo (#d5be00) | 6-15 días | Atención |
| 🟢 | Verde (#336d0e) | 16+ días | En plazo |

## 📋 Formato de Expediente

```
(Mesa – Número/Año)
Ejemplo: (363 – 12454/2024)
```

- **Mesa**: 1-3 dígitos
- **Número**: 1-5 dígitos
- **Año**: 4 dígitos

## 🚀 Inicio Rápido

### Opción 1: Abrir directamente
```bash
# Clonar o descargar el repositorio
git clone https://github.com/tu-usuario/expedientes-crm.git
cd expedientes-crm

# Servir con Python (3.7+)
python3 -m http.server 8000

# O con Node
npx http-server
```

Luego abrir en navegador: `http://localhost:8000`

### Opción 2: GitHub Pages
1. Fork este repositorio
2. Ir a Settings → Pages
3. Seleccionar "Deploy from a branch" → main
4. Tu app estará en `https://tu-usuario.github.io/expedientes-crm`

### Opción 3: Instalable
- Abrir en navegador móvil o desktop
- Tocar "Instalar app" (depende del navegador)
- Aparecerá en home screen/menú apps

## 📐 Estructura

```
expedientes-crm/
├── index.html       # App completa (HTML + CSS + JS)
├── manifest.json    # Configuración PWA
├── sw.js           # Service Worker
├── README.md       # Este archivo
└── LICENSE         # MIT License
```

## 🎨 Personalización

### Cambiar colores del semáforo
Edita en `index.html` (líneas ~30):
```css
--red: #7f0000;      /* Cambiar rojo */
--yellow: #d5be00;   /* Cambiar amarillo */
--green: #336d0e;    /* Cambiar verde */
```

### Agregar feriados
Edita el array `FERIADOS` en `index.html` (línea ~880):
```javascript
const FERIADOS = [
  "2024-01-01",   // Año Nuevo
  "2024-12-25",   // Navidad
  // Agrega más aquí
];
```

### Cambiar nombre/ícono
Edita `manifest.json`:
```json
{
  "name": "Tu Nombre",
  "short_name": "Corto",
  "theme_color": "#667eea"
}
```

## 💾 Datos

- **Ubicación**: LocalStorage del navegador
- **Formato**: JSON
- **Claves**:
  - `expedientes_crm_expedientes`: Lista de expedientes
  - `expedientes_crm_areas`: Áreas editables
  - `expedientes_crm_responsables`: Responsables editables

### Exportar datos
Abre DevTools (F12) → Console y copia:
```javascript
console.log(JSON.parse(localStorage.getItem('expedientes_crm_expedientes')))
```

### Importar datos
```javascript
localStorage.setItem('expedientes_crm_expedientes', JSON.stringify([...]));
location.reload();
```

## 🔧 Requisitos

- Navegador moderno (Chrome, Firefox, Safari, Edge)
- JavaScript habilitado
- LocalStorage disponible

## 🌍 Compatibilidad

| Navegador | Desktop | Mobile |
|-----------|---------|--------|
| Chrome | ✅ | ✅ |
| Firefox | ✅ | ✅ |
| Safari | ✅ | ✅ |
| Edge | ✅ | ✅ |

## 📚 Guía de Uso

### Crear expediente
1. Toca botón **+** (móvil) o formulario en sidebar (desktop)
2. Completa campos (el número es requerido con formato correcto)
3. Toca **Guardar**

### Editar expediente
1. Toca tarjeta del expediente
2. Modifica lo que necesites
3. Agrega nota opcional (crea intervención con timestamp)
4. Toca **Guardar**

### Filtrar por área
1. En panel superior, toca botón del área
2. Se muestran solo expedientes de esa área
3. Toca **Total** para ver todos

### Administrar áreas/responsables
1. En sidebar (desktop) o menú ☰ (móvil)
2. Sección **⚙️ Configuración**
3. Agrega con **+** o elimina con **✕**

### Eliminar expediente
1. Abre expediente
2. Toca botón **Eliminar** (rojo)
3. Confirma

## 🐛 Problemas Comunes

### "No aparecen mis cambios"
→ Recarga la página (Ctrl+R)

### "Los datos se borraron"
→ Vacía cache (DevTools → Storage → Clear Site Data)

### "No se instala como PWA"
→ Debe estar en HTTPS (exceto localhost) y tener manifest.json

### "El formato de expediente no valida"
→ Usa exactamente: `(XXX – XXXXX/YYYY)`

## 🤝 Contribuir

1. Fork el repo
2. Crea rama: `git checkout -b mejora/tu-mejora`
3. Commit: `git commit -m "Agregar..."` 
4. Push: `git push origin mejora/tu-mejora`
5. Pull Request

## 📄 Licencia

MIT License - Ver archivo [LICENSE](LICENSE)

## 👨‍💻 Desarrollado

Claude Code | Anthropic

---

**¿Preguntas o sugerencias?** Abre un [Issue](../../issues) en GitHub.

## Deploy Status
- Last updated: Mon Sep 28 15:20:57 UTC 2026
