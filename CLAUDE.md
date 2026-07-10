# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

HUEBOS (HuebOS) es un "sistema operativo" que corre íntegramente en el navegador: boot, filesystem virtual, procesos parent/child, registro de apps, terminal nativa, gestor de ventanas y preferencias. **No hay backend**: toda la persistencia vive en IndexedDB (`huebos_db`). Stack: HTML + CSS + JS plano, sin transpilación, sin dependencias, sin package.json.

## Cómo ejecutar y probar

No hay build, lint ni tests. Se sirve como archivos estáticos.

- **Obligatorio servir vía HTTP local**, no abrir con `file://`: el Kernel descubre las apps con `fetch('./apps/index.json')` y luego `fetch` a cada HTML, lo cual el navegador bloquea en `file://`. Cualquier servidor estático sirve, p. ej. desde la raíz del repo:
  - `python -m http.server 8000` → `http://localhost:8000/index.html`
- Flujo: abrir `index.html` (pantalla de boot animada) → tras `Kernel.ready` redirige a `shell.html` (escritorio). `shell.html` y los HTML de diagnóstico también cargan `Kernel.js` y bootean solos.
- Diagnóstico rápido: `diag-kernel.html` (loguea los pasos de boot) y `diag-apps.html` (verifica que cada app tenga manifiesto y se pueda `fetch`-ear). Útiles cuando algo falla antes de que cargue el shell.
- "Reiniciar / formatear" está implementado en `apps/config.html`: vacía stores de IndexedDB, hace `deleteDatabase` (esperando a que complete con reintentos) y recarga vía `postMessage` al shell.

## Arquitectura general

### Boot (`index.html` → `Kernel.js` → `shell.html`)
`Kernel.js` es una IIFE que se auto-arranca en `DOMContentLoaded` en cualquier página que lo incluya. La secuencia `boot()` emite eventos `boot:step` por etapa y finalmente `ready`: `db → fs → session → prefs → apps → ready`. El `Watchdog` registra en `sessionStorage` (`wos_boot_state`) el paso en curso para detectar boots caídos y emitir `boot:recovery`; el `CrashReporter` captura `window.error` y `unhandledrejection` y los persiste en `/sys/crashes/` (máx 20).

### `Kernel.js` — subsistemas (todos expuestos en `window.Kernel`)
- **EventBus** (`on`/`once`/`emit`): toda la comunicación entre subsistemas es por eventos (`fs:write`, `fs:move`, `shell:launch`, `prefs:change`, `procs:spawn`, `apps:registered`, etc.). No hay llamadas directas a través de límites de iframe.
- **DB**: envoltorio IndexedDB. `DB_NAME='huebos_db'`, **`DB_VERSION=3`**. Stores: `fs`, `prefs`, `social`, `apps_meta`, `crashes`, `binary_blobs`. El esquema se gestiona con `MIGRATIONS` (objeto indexado por versión). **Para añadir un store: subir `DB_VERSION`, añadir una entrada en `MIGRATIONS` que cree el objectStore** (el handler de `onupgradeneeded` crea lo que falte, pero las migraciones explícitas documentan cada cambio). `DB.open()` tiene un **timeout de 4s**: si `indexedDB.open` no responde (p. ej. por un `deleteDatabase` zombi pendiente), fuerza `deleteDatabase` y reintenta automáticamente. También maneja `onblocked` reintentando la apertura.
- **FS**: filesystem virtual sobre el store `fs`. Claves = paths normalizados (`_normalize`, reservados top-level `home`/`system`/`temp`/`sys`). Archivos de **texto** guardan `content` inline; archivos **binarios** guardan un nodo en `fs` con `encoding:'binary'` y el Blob en `binary_blobs` (mismo `id` que el path). Soporta directorios, `shortcut` (íconos de escritorio) y `move` estilo `mv`.
- **Apps / AppBinding / ExtensionManager**: registro de apps (`apps_meta`) + binding extensión→app. `Kernel.openFile(path)` resuelve la app por `meta.appId` o por extensión y emite `shell:launch` (con `filePath`/`startPath`, o sin ellos si apunta a `/system` o `/sys`).
- **Procs**: tabla de procesos con árbol parent/child (`spawn` con `parentPid`, `kill` recursivo, `cwd`, `getTree`/`ancestry`/`roots`).
- **Prefs**: clave-valor sobre `prefs`.
- **Session**: id, contador (`boot.sessionCount`), `recoveredBoot`, `firstRun`.
- **`FS_HIERARCHY_VERSION`**: si cambia la jerarquía base, al detectar mismatch el Kernel respalda (descarga un JSON) y borra todos los stores antes de reconstruir. Subir ese número = reset protected.

### `shell.html` — escritorio y window manager (~110 KB, todo en un archivo)
Una sola IIFE. Componentes internos nombrados: `BG` (canvas animado, modos de wallpaper), `Toast`, `CtxMenu`, **`WM`** (window manager: ventanas con titlebar, drag/resize/move, z-index/focus, minimize/maximize/close, items de taskbar), `Dialog` (prompt/confirm construidos como ventanas), `StartMenu` (arranque + buscador), `Desktop` (íconos desde `/home/desktop`, menú contextual, **drop zone** que guarda archivos arrastrados en `/home/downloads`), y **`createNativeTerminal`** (terminal nativa embebida con su propio objeto `COMMANDS`: ls/cd/cat/mkdir/rm/mv/cp/touch/write/stat/tree/echo/ps/kill/history/neofetch/clear/help, más tab-completion e historial).
- Descubre apps con `resolveShellApps()`: lee `apps/index.json`, scrafea el manifiesto de cada HTML y las **fusiona con `NATIVE_SYSTEM_APPS`** (la terminal; `entry:'native:shell-terminal'`, no es un archivo en `apps/`). Dedup por `id`.
- Expone **`window.__wos = { launch, toast }`** y `window.__toast` para que las apps dentro de iframes puedan lanzar otras apps y mostrar toasts.
- Reescucha eventos del Kernel para refrescar escritorio/taskbar en tiempo real (`fs:write/remove/mkdir/move`, `apps:registered/unregistered`, `prefs:change`).

### `apps/` — aplicaciones
Cada app es un HTML independiente que se ejecuta dentro de un **iframe** sandboxeado de una ventana del WM. Convenciones obligatorias:
1. Debe incluir un manifiesto inline: `<script type="application/json" id="wos-manifest">{ "id","name","version","icon","category","singleton","description","winWidth","winHeight", ... }</script>`. El Kernel y el shell lo extraen con un regex.
2. Debe **listarse en `apps/index.json`** (`"apps": ["files.html", ...]`), si no, no se descubre.
3. Acceder al Kernel con prioridad `window.parent.Kernel` (dentro del shell) y fallback `window.Kernel` (standalone); patrón `getKernel()` + `waitForKernel(cb)` que repite con `setTimeout` o espera el evento `ready` del padre.
4. Hablar con el shell vía `postMessage` (p. ej. `editor:open`, `files:navigate`, `wos:reboot`) o `window.parent.__wos.launch/appId/...` y `__wos.toast()` — no mediante llamadas directas a funciones del padre.

Apps actuales: `files.html` (explorador), `editor.html` (id `text-editor`; editor de texto con num. de líneas, abrir/guardar/guardar-como, temas), `config.html` (id `config`, `singleton:true`; ajustes, info de sistema, estadísticas de stores, formatear/reiniciar).

## Convenciones y trampas

- **`/system` está protegido por el kernel.** `FS.remove/mkdir/write/move` lanzan error para `/system/*`; el seed del propio Kernel usa `allowProtected:true` y, donde necesita purgar `.exe` de `/system`, baja a `DB.delete` directo porque `FS.remove` se los rechaza. Lo mismo aplica a nodos con `meta.protected` o `meta.systemApp`. No añadir lógica de usuario que escriba/borre bajo `/system` sin este flag.
- **Versiones dispersas**: `Kernel.version` (`KERNEL_VERSION = '0.4.0'`) y el boot dicen `v0.4.0` (UEFI Firmware). El `index.html` muestra "Alpha 2.0" en UI vieja. `apps/config.html` muestra "Kernel v0.4.0 / UEFI Firmware". El valor de verdad es `Kernel.version` en `Kernel.js`. Úsalo como referencia al mostrar versiones.
- **Preferencias y temas** se propagan por evento `prefs:change`/`prefs:delete` a `shell.html`, `editor.html`, etc., que re-aplican `THEME_PALETTES` y `fontSize` desde CSS vars. Cambiar un pref = `Kernel.prefs.set(key, value)`; el resto se actualiza solo.
- **Abrir un archivo** desde el escritorio/explorador debe pasar por `Kernel.openFile(path)` (resuelve app por extensión vía `AppBinding`) o por `shell:launch` con `filePath`/`startPath` — `launchApp` los inyecta como query params del iframe (que las apps leen vía `URLSearchParams`) y además envía el `postMessage` correspondiente al cargar.
- **No meter terminal en `apps/`**: ya existe como app nativa en `shell.html` (`NATIVE_SYSTEM_APPS`). Si se añade una app llamada `terminal` ahí se duplicaría; `withNativeSystemApps` dedup reservando los ids nativos.
- El manifiesto es scraping de string, no parsing DOM: el regex exige exactamente `id="wos-manifest"` en la tag `<script`. Mantener ese id literal al crear apps.
- **`deleteDatabase` zombi**: si `performFullFormat` (en `config.html`) navega la página **mientras** `deleteDatabase` está pendiente, la operación queda zombi y bloquea todas las futuras `open`/`deleteDatabase` — el Kernel se cuelga en el paso `db` indefinidamente. El fix actual: `performFullFormat` espera a que `deleteDatabase` complete (con reintentos en `onblocked`) antes de navegar, y añade un delay de 300ms tras `K.db.close()`. Si la DB queda corrupta de todos modos, `DB.open()` tiene timeout de 4s que fuerza `deleteDatabase` y reintenta. En el peor caso (DB irrecuperable), limpiar vía DevTools (`Storage.clearDataForOrigin`) o cerrar todas las pestañas del origen.
