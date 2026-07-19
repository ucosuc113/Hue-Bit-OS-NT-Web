# HUEBOS — Kernel API Documentation

> **Versión del Kernel:** `0.4.0` (UEFI Firmware)
> **Versión de DB:** `3` (IndexedDB `huebos_db`)
> **Scope:** Todas las APIs expuestas en `window.Kernel` y cómo usarlas desde apps, el shell o diagnóstico.

---

## Tabla de contenidos

1. [Acceso al Kernel](#acceso-al-kernel)
2. [Propiedades de instancia](#propiedades-de-instancia)
3. [EventBus — `Kernel.on / once / emit`](#eventbus)
4. [DB — `Kernel.db`](#db--kerneldb)
5. [FS — `Kernel.fs` (Sistema de Archivos)](#fs--kernelfs)
6. [Prefs — `Kernel.prefs`](#prefs--kernelprefs)
7. [Env — `Kernel.env` (Variables de Entorno)](#env--kernelenv)
8. [Users — `Kernel.users`](#users--kernelusers)
9. [Apps — `Kernel.apps`](#apps--kernelapps)
10. [Procs — `Kernel.procs` (Procesos)](#procs--kernelprocs)
11. [Extensions — `Kernel.extensions`](#extensions--kernelextensions)
12. [Bindings — `Kernel.bindings` (AppBinding)](#bindings--kernelbindings)
13. [CrashReporter — `Kernel.crash`](#crashreporter--kernelcrash)
14. [Watchdog (interno)](#watchdog-interno)
15. [Boot & Repair](#boot--repair)
16. [Catálogo de Eventos del EventBus](#catálogo-de-eventos-del-eventbus)
17. [Constantes y Stores](#constantes-y-stores)

---

## Acceso al Kernel

El Kernel es una IIFE que se auto-arranca en cualquier página que la incluya. Se expone en `window.Kernel`.

### Desde el shell (`shell.html`)

```js
// El shell corre en el top-level, el Kernel ya está cargado.
Kernel.fs.write('/home/docs/nota.txt', 'Hola');
```

### Desde una app dentro de un iframe

```js
function getKernel() {
  return window.parent?.Kernel || window.Kernel || null;
}

function waitForKernel(cb) {
  const k = getKernel();
  if (k && k.isReady) return cb(k);
  setTimeout(() => waitForKernel(cb), 100);
}

waitForKernel(k => {
  k.fs.read('/home/docs/readme.txt').then(console.log);
});
```

> **Convención:** Priorizar `window.parent.Kernel` (dentro del shell) con fallback a `window.Kernel` (standalone).

---

## Propiedades de instancia

| Propiedad | Tipo | Descripción |
|---|---|---|
| `Kernel.version` | `string` | `"0.4.0"` — versión del Kernel. **Fuente de verdad** para mostrar versiones. |
| `Kernel.isReady` | `boolean` (getter) | `true` si la DB ya está abierta y el boot completó el paso `db`. |
| `Kernel.safeMode` | `boolean` (getter) | `true` si el boot actual fue en modo seguro (F8). |
| `Kernel.uptime` | `number` (getter) | Milisegundos desde que empezó el boot. |
| `Kernel.uptimeSeconds` | `number` (getter) | Segundos enteros desde el boot. |
| `Kernel.session` | `object` (getter) | Copia del objeto de sesión actual: `{ id, count, startedAt, recoveredBoot, firstRun }`. |
| `Kernel.STORES` | `object` | Nombres de los objectStores de IndexedDB. |

---

## EventBus

Toda la comunicación entre subsistemas es por eventos. No hay llamadas directas a través de límites de iframe.

### `Kernel.on(event, handler)`

Suscribe un handler a un evento. Devuelve una función `unsubscribe`.

```js
const unsub = Kernel.on('fs:write', ({ path, size }) => {
  console.log('Archivo escrito:', path, size, 'bytes');
});
// Para dejar de escuchar:
unsub();
```

### `Kernel.once(event, handler)`

Igual que `on` pero el handler se ejecuta una sola vez y luego se desuscribe automáticamente.

```js
Kernel.once('ready', (payload) => {
  console.log('Kernel listo, versión:', payload.version);
});
```

### `Kernel.emit(event, payload)`

Emite un evento a todos los handlers suscritos. Los handlers se ejecutan en orden de suscripción y los errores se capturan individualmente.

```js
Kernel.emit('app:custom-event', { data: 42 });
```

> **Nota:** `emit` es síncrono. Los handlers se llaman inmediatamente.

---

## DB — `Kernel.db`

Envoltorio de bajo nivel sobre IndexedDB. Normalmente **no** se usa directamente desde las apps (usar `Kernel.fs`, `Kernel.prefs`, etc.), pero está expuesto para casos avanzados.

| Método | Firma | Descripción |
|---|---|---|
| `open(attempt?)` | `() => Promise<IDBDatabase>` | Abre la DB. Timeout de 4s; si no responde, fuerza `deleteDatabase` y reintenta (máx 3 intentos). Maneja `onblocked` (candado de instancia única). |
| `get(store, id)` | `(string, string) => Promise<object\|null>` | Lee un registro por clave. |
| `put(store, record)` | `(string, object) => Promise<void>` | Inserta o actualiza un registro (upsert). El registro debe tener `id`. |
| `delete(store, id)` | `(string, string) => Promise<void>` | Elimina un registro por clave. |
| `list(store)` | `(string) => Promise<object[]>` | Devuelve todos los registros del store. |
| `keys(store)` | `(string) => Promise<string[]>` | Devuelve todas las claves del store. |
| `clear(store)` | `(string) => Promise<void>` | Vacía un store completo. |
| `close()` | `() => void` | Cierra la conexión a IndexedDB. |

```js
// Ejemplo: leer directamente del store de prefs
const record = await Kernel.db.get(Kernel.STORES.PREFS, 'system.theme');
console.log(record?.value); // 'dark'
```

---

## FS — `Kernel.fs`

Sistema de archivos virtual sobre el store `fs` de IndexedDB. Las claves son paths normalizados (`/home/docs/nota.txt`).

### Utilidades de path

| Método | Firma | Descripción |
|---|---|---|
| `normalize(path)` | `(string) => string` | Normaliza un path: colapsa slashes, canónicaliza directorios reservados (`home`, `system`, `temp`, `sys`). |
| `dirname(path)` | `(string) => string` | Devuelve el directorio padre. `"/"` si es raíz. |
| `basename(path)` | `(string) => string` | Devuelve el nombre del archivo/directorio (último segmento). |

```js
Kernel.fs.normalize('/home//docs/../docs/./nota.txt'); // '/home/docs/nota.txt'
Kernel.fs.dirname('/home/docs/nota.txt');              // '/home/docs'
Kernel.fs.basename('/home/docs/nota.txt');             // 'nota.txt'
```

### Directorios y archivos de texto

#### `mkdir(path, opts?)`

Crea un directorio. Crea los padres recursivamente si no existen.

```js
await Kernel.fs.mkdir('/home/proyectos/web');
```

| Parámetro | Tipo | Default | Descripción |
|---|---|---|---|
| `path` | `string` | — | Path del directorio a crear. |
| `opts.allowProtected` | `boolean` | `false` | Permitir crear bajo `/system` (solo kernel). |

**Errores:** Lanza si el path está bajo `/system` sin `allowProtected`, o si ya existe un nodo de tipo distinto.

---

#### `write(path, content, opts?)`

Escribe un archivo de texto. Sobrescribe si ya existe. Crea los padres si faltan.

```js
await Kernel.fs.write('/home/docs/nota.txt', 'Contenido del archivo');
```

| Parámetro | Tipo | Default | Descripción |
|---|---|---|---|
| `path` | `string` | — | Path del archivo. |
| `content` | `string` | `''` | Contenido de texto. |
| `opts.allowProtected` | `boolean` | `false` | Permitir escribir bajo `/system`. |
| `opts.meta` | `object` | `{}` | Metadatos a fusionar en el nodo (p. ej. `{ appId: 'text-editor' }`). |

**Emite:** `fs:write` con `{ path, size }`.

---

#### `read(path)`

Lee el contenido de texto de un archivo.

```js
const contenido = await Kernel.fs.read('/home/docs/nota.txt');
```

**Errores:** Lanza si el path no existe o es un directorio.

---

#### `stat(path)`

Devuelve los metadatos del nodo **sin** el contenido. `null` si no existe.

```js
const info = await Kernel.fs.stat('/home/docs/nota.txt');
// { id, type:'file', name, parent, ctime, mtime, size, meta }
```

---

#### `touch(path, opts?)`

Crea un archivo vacío si no existe, o actualiza su `mtime` si ya existe. Equivalente a `touch` de Unix. No sobrescribe contenido.

```js
await Kernel.fs.touch('/home/docs/nuevo.txt');
```

---

#### `readdir(path)`

Lista los hijos directos de un directorio. Devuelve un array de nodos **sin** `content`.

```js
const hijos = await Kernel.fs.readdir('/home/docs');
// [{ id, type, name, parent, ctime, mtime, size, meta }, ...]
```

**Errores:** Lanza si el path no existe o no es directorio.

---

#### `remove(path, opts?)`

Elimina un archivo o directorio.

```js
await Kernel.fs.remove('/home/docs/viejo.txt');
await Kernel.fs.remove('/home/proyectos', { recursive: true });
```

| Parámetro | Tipo | Default | Descripción |
|---|---|---|---|
| `path` | `string` | — | Path a eliminar. |
| `opts.recursive` | `boolean` | `false` | Permite borrar directorios no vacíos. |

**Errores:** Lanza si el path está bajo `/system`, si el nodo tiene `meta.protected`/`meta.systemApp`, o si es un directorio no vacío sin `recursive`.

**Emite:** `fs:remove` con `{ path }`.

---

#### `move(src, dst)`

Mueve o renombra un archivo/directorio. Semántica estilo `mv` de Unix: si el destino es un directorio existente, mueve el origen **dentro** de él.

```js
// Renombrar
await Kernel.fs.move('/home/docs/nota.txt', '/home/docs/nota-renombrada.txt');

// Mover a otra carpeta
await Kernel.fs.move('/home/docs/nota.txt', '/home/docs/archivadas');
// → /home/docs/archivadas/nota.txt
```

**Reglas:**
- No se puede mover bajo `/system`.
- No se puede mover una carpeta dentro de sí misma o de un descendiente.
- El directorio padre del destino debe existir.
- No puede reemplazar un nodo de tipo distinto.

**Emite:** `fs:move` con `{ src, dst }`.

---

#### `exists(path)`

Devuelve `true`/`false` si el path existe.

```js
if (await Kernel.fs.exists('/home/docs/nota.txt')) { /* ... */ }
```

---

#### `isProtected(path)`

Devuelve `true` si el nodo en ese path tiene `meta.protected` o `meta.systemApp` (y no es un shortcut de escritorio).

```js
const protegido = await Kernel.fs.isProtected('/system/index.sys'); // true
```

---

#### `createShortcut(path, opts)`

Crea un acceso directo (shortcut) en el escritorio o donde se indique.

```js
await Kernel.fs.createShortcut('/home/desktop/mi-app', {
  appId: 'text-editor',
  name: 'Mi Editor',
  icon: '📝',
  entry: '/system/bloc_notas.exe',
  metadata: { isDesktopShortcut: true }
});
```

| Parámetro | Tipo | Descripción |
|---|---|---|
| `path` | `string` | Path del shortcut. |
| `opts.appId` | `string` | ID de la app a la que apunta. |
| `opts.name` | `string` | Nombre a mostrar. |
| `opts.icon` | `string` | Emoji o ícono. Default: `'🔗'`. |
| `opts.entry` | `string\|null` | Path del ejecutable del sistema al que apunta. |
| `opts.metadata` | `object` | Metadatos extra. |

**Emite:** `fs:write` con `{ path, type: 'shortcut' }`.

---

### FS Binario (v0.3.0)

Para archivos binarios (imágenes, audio, etc.), el contenido se guarda como `Blob` en el store `binary_blobs`, y el nodo en `fs` tiene `encoding: 'binary'`.

#### `writeBinary(path, data, mime?)`

Escribe un archivo binario. `data` debe ser `Blob`, `ArrayBuffer` o `ArrayBufferView`.

```js
// Guardar una imagen descargada
const blob = await fetch('https://...').then(r => r.blob());
await Kernel.fs.writeBinary('/home/media/foto.png', blob, 'image/png');
```

**Emite:** `fs:write` con `{ path, size, encoding: 'binary', mime }`.

---

#### `readBlob(path)`

Devuelve el `Blob` del archivo binario. Si el archivo es de texto (sin blob asociado), devuelve un `Blob` de texto plano.

```js
const blob = await Kernel.fs.readBlob('/home/media/foto.png');
const url = URL.createObjectURL(blob);
img.src = url;
```

---

#### `readArrayBuffer(path)`

Devuelve un `ArrayBuffer` del archivo binario.

```js
const buffer = await Kernel.fs.readArrayBuffer('/home/media/audio.mp3');
```

---

#### `readDataURL(path)`

Devuelve un Data URL (`data:image/png;base64,...`) del archivo binario.

```js
const dataUrl = await Kernel.fs.readDataURL('/home/media/foto.png');
img.src = dataUrl;
```

---

#### `isBinary(path)`

Devuelve `true` si el nodo tiene `encoding === 'binary'`.

```js
const esBin = await Kernel.fs.isBinary('/home/media/foto.png'); // true
```

---

#### `getMime(path)`

Devuelve el MIME type del archivo, o `null` si no existe.

```js
const mime = await Kernel.fs.getMime('/home/media/foto.png'); // 'image/png'
```

---

## Prefs — `Kernel.prefs`

Almacén clave-valor persistente sobre el store `prefs`. Todas las preferencias del sistema viven aquí.

#### `get(key, defaultValue?)`

```js
const theme = await Kernel.prefs.get('system.theme', 'dark');
```

#### `set(key, value)`

Establece un valor y emite `prefs:change`.

```js
await Kernel.prefs.set('system.theme', 'light');
// → todas las apps que escuchan prefs:change se actualizan
```

#### `delete(key)`

Elimina una preferencia y emite `prefs:delete`.

```js
await Kernel.prefs.delete('system.theme');
```

#### `all()`

Devuelve un objeto plano con todas las preferencias.

```js
const todas = await Kernel.prefs.all();
// { 'system.theme': 'dark', 'system.lang': 'es', ... }
```

### Claves de preferencias conocidas

| Clave | Tipo | Default | Descripción |
|---|---|---|---|
| `system.theme` | `string` | `'dark'` | Tema activo. |
| `system.lang` | `string` | `'es'` | Idioma del sistema. |
| `system.fontSize` | `number` | `14` | Tamaño de fuente base (px). |
| `desktop.wallpaper` | `string` | `'default'` | Modo de wallpaper. |
| `desktop.grid` | `boolean` | `true` | Alineación de íconos en cuadrícula. |
| `shell.prompt` | `string` | `'$ '` | Prompt de la terminal. |
| `shell.history` | `string[]` | `[]` | Historial de comandos. |
| `boot.firstRun` | `boolean` | `true` | `true` la primera vez, se pone en `false` tras el primer boot. |
| `boot.sessionId` | `string` | — | ID de la sesión actual. |
| `boot.sessionCount` | `number` | `0` | Contador de boots. |
| `boot.startedAt` | `number` | — | Timestamp del último boot. |
| `boot.lastBoot` | `number` | — | Timestamp del boot anterior. |
| `fs.hierarchyVersion` | `number` | `1` | Versión de jerarquía del FS. |
| `users.list` | `object[]` | — | Lista de usuarios registrados. |
| `users.current` | `object` | — | Usuario con sesión activa. |
| `security.password` | `string` | `''` | Contraseña de seguridad global. |
| `env.*` | `any` | — | Variables de entorno (ver Env). |

---

## Env — `Kernel.env`

Variables de entorno persistidas en prefs con prefijo `env.`. Cacheadas en memoria tras el primer `_load()`.

#### `get(key, defaultValue?)`

```js
const home = await Kernel.env.get('HOME', '/home');
```

#### `set(key, value)`

Establece una variable y emite `env:change`.

```js
await Kernel.env.set('PATH', '/system:/home/bin');
```

#### `unset(key)`

Elimina una variable y emite `env:delete`.

```js
await Kernel.env.unset('PATH');
```

#### `all()`

Devuelve una copia de todas las variables de entorno.

```js
const env = await Kernel.env.all();
// { HOME: '/home', PATH: '/system:/home/bin', ... }
```

#### `expand(str)`

Expande `$VAR` o `${VAR}` en un string. Las variables no definidas se dejan tal cual.

```js
const expanded = await Kernel.env.expand('Ruta: $HOME/docs');
// 'Ruta: /home/docs'
```

---

## Users — `Kernel.users`

Sistema de multiusuario simple: un usuario activo, datos en prefs.

#### `list()`

Devuelve el array de usuarios registrados.

```js
const users = await Kernel.users.list();
// [{ id:'admin', name:'Administrador', avatar:'👤', role:'admin', ... }]
```

#### `get(id)`

Devuelve un usuario por ID, o `null`.

```js
const admin = await Kernel.users.get('admin');
```

#### `create(id, name, opts?)`

Crea un nuevo usuario.

```js
await Kernel.users.create('juan', 'Juan Pérez', {
  password: '1234',
  avatar: '🧑',
  role: 'user'
});
```

| Parámetro | Tipo | Default | Descripción |
|---|---|---|---|
| `id` | `string` | — | Identificador único. |
| `name` | `string` | `id` | Nombre a mostrar. |
| `opts.password` | `string` | `''` | Contraseña. |
| `opts.avatar` | `string` | `'👤'` | Emoji/avatar. |
| `opts.role` | `string` | `'user'` | Rol (`'admin'` o `'user'`). |

**Emite:** `users:created` con `{ id }`.

---

#### `delete(id)`

Elimina un usuario. No se puede eliminar a `admin`.

```js
await Kernel.users.delete('juan');
```

**Emite:** `users:deleted` con `{ id }`.

---

#### `login(id, password)`

Inicia sesión. Valida contra `user.password` y, si está vacío, contra `security.password` de prefs.

```js
try {
  const session = await Kernel.users.login('admin', 'miPassword');
  console.log('Logueado como:', session.name);
} catch (e) {
  console.error('Login fallido:', e.message);
}
```

**Emite:** `users:login` con `{ id, name, avatar, role }`.

---

#### `logout()`

Cierra la sesión activa.

```js
await Kernel.users.logout();
```

**Emite:** `users:logout` con el usuario anterior.

---

#### `current()`

Devuelve el usuario con sesión activa, o `null`.

```js
const user = await Kernel.users.current();
if (user) console.log('Sesión:', user.name);
```

---

#### `isLoggedIn()`

Devuelve `true`/`false`.

```js
if (await Kernel.users.isLoggedIn()) { /* ... */ }
```

---

#### `updateProfile(updates)`

Actualiza el perfil del usuario actual.

```js
await Kernel.users.updateProfile({ name: 'Admin Renombrado', avatar: '🛡️' });
```

**Emite:** `users:profileChanged`.

---

#### `setPassword(newPassword)`

Cambia la contraseña del usuario actual. Actualiza tanto `users.list` como `security.password`.

```js
await Kernel.users.setPassword('nuevaClave123');
```

**Emite:** `users:passwordChanged` con `{ id }`.

---

## Apps — `Kernel.apps`

Registro de aplicaciones. Los manifiestos se extraen de los HTML en `apps/` y se guardan en el store `apps_meta`.

#### `register(manifest)`

Registra una app manualmente.

```js
await Kernel.apps.register({
  id: 'mi-app',
  name: 'Mi App',
  version: '1.0.0',
  icon: '🚀',
  category: 'utility',
  singleton: false,
  entry: './apps/mi-app.html',
  meta: { description: 'Una app de ejemplo', winWidth: 800, winHeight: 600 }
});
```

**Emite:** `apps:registered` con `{ id }`.

---

#### `get(id)`

Devuelve el manifiesto de una app, o `null`.

```js
const app = await Kernel.apps.get('text-editor');
// { id, name, version, icon, entry, meta: { winWidth, winHeight, ... } }
```

---

#### `list()`

Devuelve todas las apps registradas.

```js
const apps = await Kernel.apps.list();
apps.forEach(a => console.log(a.id, a.name));
```

---

#### `unregister(id)`

Elimina una app del registro.

```js
await Kernel.apps.unregister('mi-app');
```

**Emite:** `apps:unregistered` con `{ id }`.

---

## Procs — `Kernel.procs`

Administrador de procesos con árbol parent/child.

#### `spawn(appId, opts?)`

Crea un nuevo proceso y devuelve el registro.

```js
const proc = Kernel.procs.spawn('text-editor', {
  title: 'Editor — nota.txt',
  icon: '📝',
  parentPid: 5,       // PID del proceso que lo lanza (opcional)
  cwd: '/home/docs'   // directorio de trabajo (default: '/home')
});
console.log('Nuevo PID:', proc.pid);
```

**Emite:** `procs:spawn` con `{ pid, appId, parentPid }`.

---

#### `kill(pid)`

Termina un proceso y **todos sus descendientes** recursivamente.

```js
Kernel.procs.kill(3);
```

**Emite:** `procs:kill` por cada proceso terminado.

---

#### `suspend(pid)`

Marca un proceso como `'suspended'`.

```js
Kernel.procs.suspend(3);
```

**Emite:** `procs:suspend`.

---

#### `resume(pid)`

Marca un proceso como `'running'`.

```js
Kernel.procs.resume(3);
```

**Emite:** `procs:resume`.

---

#### `setCwd(pid, newCwd)`

Cambia el directorio de trabajo del proceso.

```js
Kernel.procs.setCwd(3, '/home/media');
```

**Emite:** `procs:cwd`.

---

#### `update(pid, patch)`

Actualiza campos arbitrarios del proceso (p. ej. `title`, `icon`, `window`).

```js
Kernel.procs.update(3, { title: 'Editor — otro.txt', window: winRef });
```

**Emite:** `procs:update`.

---

#### `list()`

Devuelve todos los procesos activos.

```js
const procs = Kernel.procs.list();
```

---

#### `get(pid)`

Devuelve el proceso, o `null`.

```js
const proc = Kernel.procs.get(3);
```

---

#### `getChildren(pid)`

Devuelve los procesos hijos directos.

```js
const hijos = Kernel.procs.getChildren(1);
```

---

#### `getTree(pid)`

Devuelve el proceso con su árbol de descendientes anidado.

```js
const tree = Kernel.procs.getTree(1);
// { pid:1, appId:'shell', children: [{ pid:2, ..., children: [...] }, ...] }
```

---

#### `ancestry(pid)`

Devuelve la cadena de ancestros desde el proceso hasta la raíz.

```js
const cadena = Kernel.procs.ancestry(5);
// [proc5, proc3, proc1]
```

---

#### `roots()`

Devuelve los procesos sin padre (raíces del árbol).

```js
const raices = Kernel.procs.roots();
```

---

#### `count` (getter)

Número de procesos activos.

```js
console.log('Procesos activos:', Kernel.procs.count);
```

---

## Extensions — `Kernel.extensions`

Registro de extensiones de archivo → handler (appId).

#### `register(extension, handler, mime?)`

Registra una extensión manualmente.

```js
Kernel.extensions.register('.xyz', 'mi-app', 'application/x-xyz');
```

---

#### `resolve(pathOrExtension)`

Resuelve la extensión de un path o string y devuelve `{ extension, handler, mime }` o `null`.

```js
const resolved = Kernel.extensions.resolve('/home/docs/archivo.txt');
// { extension: '.txt', handler: 'text-editor', mime: 'text/plain' }
```

---

#### `getExtension(path)`

Extrae la extensión de un path (con punto, minúsculas).

```js
const ext = Kernel.extensions.getExtension('/home/docs/nota.TXT'); // '.txt'
```

---

#### `list()`

Devuelve todas las extensiones registradas.

```js
const exts = Kernel.extensions.list();
// [{ extension: '.txt', handler: 'text-editor' }, ...]
```

---

## Bindings — `Kernel.bindings`

Capa de binding entre extensiones/archivos y apps.

#### `registerExtension(extension, appId, mime?)`

Registra una extensión → appId (atajo para `extensions.register`).

```js
Kernel.bindings.registerExtension('.txt', 'text-editor', 'text/plain');
```

---

#### `bindFileField(fieldName, appId)`

Asocia un campo de archivo a una app.

```js
Kernel.bindings.bindFileField('editor', 'text-editor');
```

---

#### `openFile(filePath, opts?)` — también disponible como `Kernel.openFile()`

Resuelve la app para un archivo y emite `shell:launch` para abrirlo.

```js
const result = await Kernel.openFile('/home/docs/nota.txt');
if (!result.ok) {
  console.log('No se pudo abrir:', result.reason);
  // 'NO_HANDLER' o 'APP_NOT_FOUND'
} else {
  console.log('Abriendo con:', result.appId);
}
```

**Lógica de resolución:**
1. `node.meta.appId` (si el nodo lo tiene).
2. Extensión del archivo vía `ExtensionManager`.
3. `opts.appId` explícito.

Si el nodo es un ejecutable del sistema (`meta.systemApp` + `meta.source === 'system-executable'`), emite `shell:launch` con solo `{ appId }`. Si no, emite con `{ appId, filePath, startPath }`.

**Emite:** `shell:launch` o `app:fallback` (si no hay handler).

---

## CrashReporter — `Kernel.crash`

Captura de errores y reportes de crash. Persiste en `/sys/crashes/` (máx 20).

#### `install()`

Instala los listeners globales de `window.error` y `unhandledrejection`. Lo llama el boot automáticamente.

```js
Kernel.crash.install(); // normalmente no necesario llamarlo a mano
```

---

#### `report(message, error, extra?)`

Genera un reporte de crash manual.

```js
try {
  riskyOperation();
} catch (e) {
  Kernel.crash.report('Falló riskyOperation', e, { context: 'mi-app' });
}
```

---

#### `list()`

Devuelve las entradas del directorio `/sys/crashes/`.

```js
const crashes = await Kernel.crash.list();
```

---

#### `read(id)`

Lee un reporte de crash por ID (sin la extensión `.json`).

```js
const report = await Kernel.crash.read('crash_1234567890_abcde');
// { id, ts, source, message, stack, url, userAgent, kernelVersion }
```

---

#### `clear()`

Elimina todos los reportes de crash.

```js
await Kernel.crash.clear();
```

---

## Watchdog (interno)

Detecta boots caídos. Registra el paso en curso en `sessionStorage` (`wos_boot_state`).

| Método | Descripción |
|---|---|
| `checkPreviousBoot()` | Verifica si el boot anterior quedó a medias. Emite `boot:recovery` si detecta fallo. |
| `markStep(step)` | Marca el inicio de un paso del boot. |
| `completeStep()` | Marca el paso actual como completado. |
| `clearAll()` | Limpia el estado del watchdog (boot exitoso). |

> No se expone directamente en `Kernel`, pero sus efectos son visibles vía el evento `boot:recovery`.

---

## Boot & Repair

### `Kernel.boot()`

Inicia la secuencia de boot. Se auto-ejecuta en `DOMContentLoaded`. Envuelve `_bootAttempt()` con un watchdog de 15s.

**Secuencia de pasos (eventos `boot:step`):**

| Paso | Label | Descripción |
|---|---|---|
| `db` | Iniciando IndexedDB… | Abre la DB. |
| `fs` | Montando sistema de archivos… | Verifica jerarquía, crea directorios base. |
| `session` | Iniciando sesión… | Crea/recupera la sesión. |
| `prefs` | Cargando preferencias… | Inicializa prefs, Env, Users. Auto-login admin. |
| `apps` | Registrando aplicaciones… | Descubre apps, crea ejecutables, extensiones, atajos. |
| `ready` | Sistema listo. | Boot completo. Emite `ready`. |

> En **Safe Mode** (detectado por F8 en `index.html`), el paso `apps` se omite: solo se hidrata las apps existentes, sin re-crear atajos ni ejecutables.

### `Kernel.repair.redirectToRepair(reason, extra?)`

Redirige a `repairboot.html` ante un fallo crítico. Guarda el motivo en `sessionStorage` (`huebos_boot_failure`).

```js
Kernel.repair.redirectToRepair('mi-razon', { detail: 'info extra' });
```

**Emite:** `boot:critical` con `{ reason, ...extra, ts }`.

---

## Catálogo de Eventos del EventBus

### Boot

| Evento | Payload | Descripción |
|---|---|---|
| `boot:step` | `{ step, label, detail }` | Emitido en cada paso del boot. |
| `boot:recovery` | `{ failedStep, failedAt }` | Detectado boot anterior caído. |
| `boot:error` | `{ error }` | Error durante el boot. |
| `boot:critical` | `{ reason, ts, ...extra }` | Fallo crítico → redirección a repair. |
| `boot:singleInstance` | `{ ts, phase, tone, message }` | Otra instancia de HUEBOS detectada (candado). |
| `ready` | `{ ts, version, sessionId, sessionCount, recoveredBoot, firstRun, safeMode, uefiConfig, user }` | Boot completo. |

### Filesystem

| Evento | Payload | Descripción |
|---|---|---|
| `fs:write` | `{ path, size, type?, encoding?, mime? }` | Archivo escrito o shortcut creado. |
| `fs:mkdir` | `{ path }` | Directorio creado. |
| `fs:remove` | `{ path }` | Nodo eliminado. |
| `fs:move` | `{ src, dst }` | Nodo movido/renombrado. |

### Preferencias

| Evento | Payload | Descripción |
|---|---|---|
| `prefs:change` | `{ key, value }` | Preferencia establecida. |
| `prefs:delete` | `{ key }` | Preferencia eliminada. |

### Entorno

| Evento | Payload | Descripción |
|---|---|---|
| `env:change` | `{ key, value }` | Variable de entorno establecida. |
| `env:delete` | `{ key }` | Variable de entorno eliminada. |

### Usuarios

| Evento | Payload | Descripción |
|---|---|---|
| `users:created` | `{ id }` | Usuario creado. |
| `users:deleted` | `{ id }` | Usuario eliminado. |
| `users:login` | `{ id, name, avatar, role }` | Sesión iniciada. |
| `users:logout` | `prev` (objeto usuario) | Sesión cerrada. |
| `users:profileChanged` | `{ id, name, avatar, role }` | Perfil actualizado. |
| `users:passwordChanged` | `{ id }` | Contraseña cambiada. |

### Apps

| Evento | Payload | Descripción |
|---|---|---|
| `apps:registered` | `{ id }` | App registrada. |
| `apps:unregistered` | `{ id }` | App desregistrada. |
| `app:fallback` | `{ filePath, extension, appId? }` | No se encontró handler para abrir un archivo. |
| `shell:launch` | `{ appId, filePath?, startPath? }` | Solicitar al shell que lance una app. |

### Procesos

| Evento | Payload | Descripción |
|---|---|---|
| `procs:spawn` | `{ pid, appId, parentPid }` | Proceso creado. |
| `procs:kill` | `{ pid, appId }` | Proceso terminado. |
| `procs:suspend` | `{ pid }` | Proceso suspendido. |
| `procs:resume` | `{ pid }` | Proceso reanudado. |
| `procs:cwd` | `{ pid, cwd }` | Directorio de trabajo cambiado. |
| `procs:update` | `{ pid, patch }` | Proceso actualizado. |

### Crashes

| Evento | Payload | Descripción |
|---|---|---|
| `crash:logged` | `{ id, source, message, ts }` | Reporte de crash persistido. |

---

## Constantes y Stores

### Stores de IndexedDB (`Kernel.STORES`)

| Store | Key | Descripción |
|---|---|---|
| `fs` | path normalizado | Nodos del filesystem (archivos, directorios, shortcuts). |
| `prefs` | clave string | Preferencias del sistema. |
| `social` | — | Store reservado para datos sociales. |
| `apps_meta` | app id | Manifiestos de apps registradas. |
| `crashes` | crash id | Reportes de crash (máx 20). |
| `binary_blobs` | path | Blobs binarios asociados a nodos del FS. |

### Directorios reservados

| Path | Descripción |
|---|---|
| `/home` | Espacio personal del usuario. |
| `/home/desktop` | Escritorio (íconos y shortcuts). |
| `/home/docs` | Documentos. |
| `/home/media` | Archivos multimedia (binarios). |
| `/home/downloads` | Descargas. |
| `/system` | **Protegido por el kernel.** Ejecutables y archivos del sistema. |
| `/sys` | Datos del sistema (crashes, logs). |
| `/sys/crashes` | Reportes de crash. |
| `/temp` | Archivos temporales. |

### Protección de `/system`

Las operaciones `FS.write`, `FS.mkdir`, `FS.remove`, `FS.move`, `FS.writeBinary` y `FS.createShortcut` **lanzan error** si el path está bajo `/system`, a menos que se pase `opts.allowProtected: true` (uso interno del kernel). Los nodos con `meta.protected` o `meta.systemApp` también están protegidos contra eliminación.

---

## Ejemplos de uso completos

### Crear y leer un archivo

```js
// Escribir
await Kernel.fs.write('/home/docs/tareas.txt', '1. Comprar pan\n2. Estudiar');

// Leer
const contenido = await Kernel.fs.read('/home/docs/tareas.txt');
console.log(contenido);
```

### Escuchar cambios en preferencias

```js
Kernel.on('prefs:change', ({ key, value }) => {
  if (key === 'system.theme') {
    aplicarTema(value);
  }
});
```

### Lanzar una app desde un iframe

```js
// Dentro de una app (iframe)
window.parent.__wos.launch('text-editor', { filePath: '/home/docs/nota.txt' });
```

### Abrir un archivo por extensión

```js
const result = await Kernel.openFile('/home/docs/nota.txt');
if (result.ok) {
  console.log('Abriendo con:', result.appId);
}
```

### Guardar y mostrar una imagen binaria

```js
// Guardar
const blob = await (await fetch('foto.png')).blob();
await Kernel.fs.writeBinary('/home/media/foto.png', blob, 'image/png');

// Mostrar
const dataUrl = await Kernel.fs.readDataURL('/home/media/foto.png');
document.querySelector('img').src = dataUrl;
```

### Trabajar con procesos

```js
// Lanzar un proceso hijo
const parent = Kernel.procs.spawn('files', { title: 'Explorador' });
const child  = Kernel.procs.spawn('text-editor', {
  title: 'Editor',
  parentPid: parent.pid,
  cwd: '/home/docs'
});

// Ver el árbol
console.log(Kernel.procs.getTree(parent.pid));

// Terminar todo el árbol
Kernel.procs.kill(parent.pid); // mata también al hijo
```

### Usar variables de entorno

```js
await Kernel.env.set('EDITOR', 'text-editor');
const expanded = await Kernel.env.expand('Abrir con $EDITOR');
// 'Abrir con text-editor'
```

---

> **Última actualización:** Kernel v0.4.0 — UEFI + Env + Users + Safe Mode