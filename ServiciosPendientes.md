Leyenda: 🟩 implementado y funcional · 🟨 existe, pero parcial o integrado en otro módulo · ❌ no implementado

Kernel
│
├── 🟩 Sistema de archivos (FS)
├── 🟩 Usuarios
├── 🟩 Autenticación
├── 🟨 Permisos
├── 🟩 Preferencias
├── 🟩 Base de datos
├── 🟩 Gestión de aplicaciones
├── 🟩 Registro de aplicaciones
├── 🟩 Registro de servicios
├── 🟨 IPC (comunicación entre procesos)
├── 🟩 Bus de eventos
├── ❌ Scheduler
├── 🟨 Temporizadores
├── 🟩 Procesos
├── ❌ Servicios en segundo plano
├── 🟩 Variables de entorno
├── 🟩 Configuración del sistema
├── ❌ Registro de logs
├── 🟩 Reportes de errores (Crash Reporter)
├── 🟩 Gestión de sesiones
├── ❌ Gestión de energía
├── 🟩 Reinicio y apagado
├── 🟩 Bloqueo de pantalla
├── 🟩 Portapapeles
├── ❌ Gestor de almacenamiento
├── 🟨 Sistema de permisos
├── ❌ Gestor de paquetes
├── 🟩 Asociación de archivos
├── 🟩 Tipos MIME
├── ❌ API de red
├── ❌ API de audio
├── 🟨 API de ventanas
├── 🟨 API de notificaciones
├── ❌ API de dispositivos
├── ❌ Drivers
├── ❌ Sistema de montaje (Mount Points)
├── ❌ Sistema de versiones
├── 🟩 Compatibilidad entre versiones
├── 🟩 API pública del Kernel
├── 🟨 Hooks del sistema
├── ❌ Monitor de rendimiento
├── 🟨 Monitor de recursos
├── ❌ Gestión de memoria (lógica)
├── ❌ Caché del sistema
├── 🟩 Virtual File System (VFS)
├── 🟨 Sistema de plugins
├── ❌ Internacionalización (i18n)
└── ❌ Gestor de políticas del sistema

Notas sobre algunas marcas del Kernel:
- "Autenticación" 🟩 se apoya en `Users.login()` y en la validación de contraseña de la lock screen; funciona, pero no es un módulo de auth separado de Usuarios.
- "Permisos" y "Sistema de permisos" 🟨 (mismo mecanismo, aparece duplicado en la lista original): solo hay banderas `meta.protected` / `meta.systemApp` en nodos del FS. No hay ACL real por usuario ni chequeo del campo `role` en ningún lado del código.
- "Registro de aplicaciones" 🟩 es literalmente el mismo módulo `Apps` que "Gestión de aplicaciones" (store `APPS_META`), no una pieza distinta.
- "Compatibilidad entre versiones" 🟩 se apoya en las migraciones de IndexedDB (`MIGRATIONS`, `DB_VERSION`) y en `fs.hierarchyVersion` con backup automático. "Sistema de versiones" (historial/versionado de archivos) sigue en ❌.
- "API de ventanas" y "API de notificaciones" quedan en 🟨: WM y Toast existen y funcionan bien, pero viven dentro de `shell.html` y no están expuestos como métodos del objeto `Kernel` que una app pueda llamar directamente.
- "Virtual File System (VFS)" 🟩 es, en la práctica, el mismo módulo `FS` — no hay una capa VFS separada de él.
- "Monitor de recursos" 🟨: `neofetch`/`sysinfo` leen `navigator.deviceMemory` y `hardwareConcurrency` una sola vez al pedirlo, no hay monitoreo continuo.

Y fuera del Kernel, tendrías otra lista igual de importante:

Shell
│
├── 🟩 Escritorio
├── 🟩 Barra de tareas
├── ❌ Dock
├── 🟩 Menú de aplicaciones
├── 🟨 Explorador de archivos
├── 🟩 Gestor de ventanas
├── 🟩 Centro de notificaciones
├── ❌ Centro de control
├── 🟩 Pantalla de bloqueo
├── ❌ Pantalla de inicio de sesión
├── 🟨 Selector de fondo
├── 🟨 Selector de tema
├── 🟩 Diálogos del sistema
├── 🟩 Menús contextuales
├── 🟨 Indicadores del sistema
├── 🟨 Bandeja del sistema
├── 🟩 Animaciones
├── ❌ Widgets
└── 🟩 Lanzador de aplicaciones

Notas sobre algunas marcas del Shell:
- "Explorador de archivos" 🟨: está registrado como app (`files`), tiene acceso directo en el escritorio y ejecutable en `/system`, pero su código no está entre los archivos revisados, así que no se puede confirmar al 100% qué tan completo está.
- "Centro de notificaciones" ❌: hoy solo existen toasts efímeros (`Toast` en shell.html) sin cola, historial ni panel persistente — no es lo mismo que un centro de notificaciones real.
- "Pantalla de inicio de sesión" ❌: el sistema hace auto-login silencioso al usuario `admin` al arrancar; no hay una pantalla para elegir entre varios usuarios (aunque `Users` sí soporta varios).
- "Selector de fondo" y "Selector de tema" 🟨: la lógica ya existe en el Kernel/Shell (`BG.setMode`, `applyTheme`, prefs `desktop.wallpaper` / `system.theme`, incluso el comando `color` de terminal), pero el control visual para cambiarlos no aparece en `shell.html` — probablemente vive en la app de Configuración, que no está entre los archivos revisados.
- "Indicadores del sistema" y "Bandeja del sistema" 🟨: los puntos (`sys-dots`) de la esquina son decorativos y pulsan solos, no reflejan datos reales (batería, red, volumen); no hay iconos de apps/servicios en segundo plano.

Y una tercera capa que mucha gente olvida:

Servicios del Sistema
│
├── Servicios
│   │   (módulos en segundo plano que exponen funcionalidad al resto del sistema)
│   │
│   ├── 🟩 Notificaciones — cola y persistencia de notificaciones, consumida por el Centro de notificaciones del Shell.
│   ├── ❌ Bluetooth — descubre, empareja y mantiene conexión con dispositivos Bluetooth cercanos.
│   ├── ❌ Sincronización — mantiene archivos y preferencias al día entre este dispositivo y una copia remota u otros dispositivos.
│   ├── ❌ Actualizaciones — comprueba, descarga y aplica nuevas versiones del sistema o de las apps registradas.
│   ├── 🟩 Indexador de archivos — recorre el FS en segundo plano y construye un índice de contenido para búsquedas.
│   ├── ❌ Motor de búsqueda — resuelve consultas de búsqueda global (nombre + contenido), apoyado en el Indexador de archivos.
│   ├── ❌ Miniaturas — genera y cachea previsualizaciones de imágenes y otros archivos para el Explorador.
│   ├── ❌ Papelera de reciclaje — intercepta los borrados del FS y los mueve a una zona recuperable en vez de eliminarlos al instante.
│   ├── ❌ Telemetría (opcional) — recolecta métricas de uso de forma anónima y las envía si el usuario lo permite.
│   ├── ❌ Servicio de IA (opcional) — motor de IA que las apps pueden invocar para autocompletar, resumir o generar contenido.
│   └── ❌ Compatibilidad — traduce o adapta llamadas de apps antiguas/externas al contrato actual del Kernel.
│
├── APIs
│   │   (interfaces delgadas para que las apps interactúen; sin estado propio complejo)
│   │
│   ├── ❌ API de impresión — envía documentos a imprimir apoyándose en window.print() del navegador.
│   └── ❌ API de compartición — comparte archivos o texto con otras apps o el SO anfitrión vía Web Share API.
│
└── Componentes
    │   (piezas ya existentes, pero enterradas dentro de otro módulo — por eso llevan 🟨)
    │
    ├── 🟨 Sistema de toasts — alertas temporales con auto-cierre en la esquina superior derecha; módulo `Toast` dentro de shell.html, sin cola ni persistencia.
    ├── 🟨 Filtro de aplicaciones (Start Menu) — filtra en memoria el listado de apps mientras el usuario escribe; clase `StartMenu`, no indexa ni busca contenido del FS.
    ├── 🟨 Historial de comandos (Terminal) — navegación ↑/↓ sobre comandos previos; clase `History` de `TerminalModule`, persistida en la preferencia `terminal.history`.
    └── 🟨 Respaldo pre-reinicialización — exporta un volcado JSON del FS y los blobs binarios; función `_backupBeforeWipe()` del Kernel, se dispara solo automáticamente al detectar un cambio en `fs.hierarchyVersion`, sin API invocable por el usuario.

Nota: "Audio" y "Red" se retiraron de esta capa — ya están cubiertas por "API de audio" y "API de red" en el árbol del Kernel; mantenerlas aquí duplicaba la arquitectura.

Lo importante de esta lista es que **no es un checklist** de cosas que haya que implementar sí o sí. Es más bien una guía para organizar la arquitectura.

Puede que algunos módulos nunca sean necesarios, y otros terminen dividiéndose en varios componentes más específicos. La idea es que, cuando aparezca una nueva función, no haya que preguntarse "¿y esto dónde lo meto?", sino que ya exista un lugar lógico para ella.

Así se evita que el Kernel termine convirtiéndose en un cajón de sastre donde acaba viviendo absolutamente todo porque era la opción más fácil. Ese tipo de decisiones suele marcar la diferencia entre una arquitectura que puede seguir creciendo y otra que, después de unas cuantas versiones, da miedo tocar. La V1 fue un buen ejemplo de eso.