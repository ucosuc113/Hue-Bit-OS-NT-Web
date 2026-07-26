;(function (global) {
  'use strict';

  /* ═══════════════════════════════════════════════════
     CONSTANTES
  ═══════════════════════════════════════════════════ */
  const DB_NAME    = 'huebos_db';
  const DB_VERSION = 4;
  const KERNEL_VERSION = '0.5.2';
  const STORES = {
    FS           : 'fs',
    PREFS        : 'prefs',
    SOCIAL       : 'social',
    APPS_META    : 'apps_meta',
    CRASHES      : 'crashes',
    BINARY_BLOBS : 'binary_blobs',
    NOTIFICATIONS : 'notifications'
  };

  const HOME_DIR = '/home';
  const DESKTOP_DIR = '/home/desktop';
  const SYSTEM_DIR = '/system';
  const TEMP_DIR = '/temp';
  const FS_HIERARCHY_VERSION = 1; // Incrementar cuando cambie la jerarquía base

  const REPAIR_PAGE        = 'repairboot.html';   // pantalla de recuperación
  const BOOT_WATCHDOG_MS   = 15000;                // boot() no debe tardar más que esto
  const BOOT_FAILURE_KEY   = 'huebos_boot_failure'; // sessionStorage: motivo del último fallo crítico

  const SYSTEM_EXECUTABLES = [
    { path: `${SYSTEM_DIR}/archivos.exe`, appId: 'files', name: 'Archivos', icon: '📁' },
    { path: `${SYSTEM_DIR}/bloc_notas.exe`, appId: 'text-editor', name: 'Bloc de notas', icon: '📝' },
    { path: `${SYSTEM_DIR}/config.exe`, appId: 'config', name: 'Configuración', icon: '⚙️' },
  ];

  /* ═══════════════════════════════════════════════════
     MIGRATION SYSTEM                          [Release 1.0.0]
  ═══════════════════════════════════════════════════ */
  const MIGRATIONS = {

    2: (db /*, tx */) => {
      if (!db.objectStoreNames.contains(STORES.CRASHES)) {
        db.createObjectStore(STORES.CRASHES, { keyPath: 'id' });
        console.info('[Kernel:db] migración v2: store "crashes" creado');
      }
    },

    3: (db /*, tx */) => {
      if (!db.objectStoreNames.contains(STORES.BINARY_BLOBS)) {
        db.createObjectStore(STORES.BINARY_BLOBS, { keyPath: 'id' });
        console.info('[Kernel:db] migración v3: store "binary_blobs" creado');
      }
    },

    4: (db /*, tx */) => {
      if (!db.objectStoreNames.contains(STORES.NOTIFICATIONS)) {
        db.createObjectStore(STORES.NOTIFICATIONS, { keyPath: 'id' });
        console.info('[Kernel:db] migración v4: store "notifications" creado');
      }
    },

  };

  /* ═══════════════════════════════════════════════════
     EVENT BUS
  ═══════════════════════════════════════════════════ */
  const _listeners = {};

  const EventBus = {
    on(event, handler) {
      if (!_listeners[event]) _listeners[event] = [];
      _listeners[event].push(handler);
      return () => {
        _listeners[event] = _listeners[event].filter(h => h !== handler);
      };
    },

    emit(event, payload) {
      const now = Date.now();
      console.debug(`[Kernel:emit] ${event}`, payload ?? '');
      (_listeners[event] || []).forEach(h => {
        try { h(payload, now); }
        catch (err) { console.error(`[Kernel:emit] handler error on "${event}"`, err); }
      });
    },

    once(event, handler) {
      const unsub = this.on(event, (payload, ts) => {
        handler(payload, ts);
        unsub();
      });
      return unsub;
    },
  };

  /* ═══════════════════════════════════════════════════
     BASE DE DATOS  (IndexedDB)
  ═══════════════════════════════════════════════════ */
  let _db = null;

  const DB = {
open(attempt = 0) {
      const MAX_OPEN_ATTEMPTS = 3;
      return new Promise((resolve, reject) => {
        let settled = false;
        let blockedNotified = false;
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        // Timeout: SOLO dispara si tras 4s no hubo ninguna respuesta en
        // absoluto (ni onsuccess, ni onerror, ni onblocked). Eso sí es un
        // estado colgado de verdad (p. ej. un deleteDatabase anterior
        // quedó a medias). Si en cambio onblocked SÍ disparó, sabemos
        // exactamente qué pasa: otra instancia de HUEBOS sigue abierta
        // reteniendo la conexión. Eso NO es corrupción, es el candado de
        // instancia única funcionando como debería — así que aquí no
        // forzamos ningún borrado (ver req.onblocked más abajo).
        const timeoutId = setTimeout(() => {
          if (settled || blockedNotified) return;
          settled = true;
          try { req.onupgradeneeded = null; req.onsuccess = null; req.onerror = null; req.onblocked = null; } catch(_) {}

          if (attempt >= MAX_OPEN_ATTEMPTS) {
            console.error(`[Kernel:db] open() agotó ${MAX_OPEN_ATTEMPTS} intentos sin respuesta — abortando`);
            reject(new Error('DB_OPEN_UNRECOVERABLE'));
            return;
          }

          console.warn(`[Kernel:db] open() sin respuesta tras 4s — forzando deleteDatabase y reintento (${attempt + 1}/${MAX_OPEN_ATTEMPTS})`);
          const delReq = indexedDB.deleteDatabase(DB_NAME);
          delReq.onsuccess = () => { console.info('[Kernel:db] DB stale eliminada, reintentando open()'); setTimeout(() => resolve(DB.open(attempt + 1)), 200); };
          delReq.onerror = () => { setTimeout(() => resolve(DB.open(attempt + 1)), 500); };
delReq.onblocked = () => {
            // También aquí: bloqueado = otra instancia sigue abierta, no
            // corrupción. No cuenta como intento fallido — reintentamos con
            // el mismo `attempt` (no lo incrementamos) para no disparar el
            // aborto por MAX_OPEN_ATTEMPTS mientras solo estamos esperando.
            EventBus.emit('boot:singleInstance', {
              ts: Date.now(),
              phase: 'recovery',
              tone: 'security',
              message: 'Protección de seguridad: solo puede existir una instancia del sistema abierta en este navegador.',
            });
            setTimeout(() => resolve(DB.open(attempt)), 1500);
          };
        }, 4000);

        req.onupgradeneeded = (e) => {
          const db         = e.target.result;
          const oldVersion = e.oldVersion;

          Object.values(STORES).forEach(name => {
            if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name, { keyPath: 'id' });
              console.info(`[Kernel:db] store creado: ${name}`);
            }
          });

          for (let v = oldVersion + 1; v <= DB_VERSION; v++) {
            if (MIGRATIONS[v]) {
              try {
                MIGRATIONS[v](db, e.target.transaction);
                console.info(`[Kernel:db] ✓ migración v${v} aplicada`);
              } catch (migErr) {
                console.error(`[Kernel:db] ✗ migración v${v} falló:`, migErr);
              }
            }
          }
        };

        req.onsuccess = (e) => {
          clearTimeout(timeoutId);
          _db = e.target.result;
          console.info(`[Kernel:db] IndexedDB lista (v${DB_VERSION})`);
          settled = true;
          resolve(_db);
        };

        req.onerror = (e) => {
          clearTimeout(timeoutId);
          console.error('[Kernel:db] Error al abrir IndexedDB', e.target.error);
          if (!settled) { settled = true; reject(e.target.error); }
        };

req.onblocked = () => {
          // No es un fallo del Kernel: otra pestaña/ventana con HUEBOS
          // abierto sigue reteniendo una conexión a la misma base de
          // datos. Es exactamente la protección de instancia única
          // funcionando — avisamos una sola vez y dejamos la request
          // original viva; onsuccess disparará solo cuando esa otra
          // instancia cierre su conexión, sin que nosotros reintentemos
          // ni borremos nada.
if (!blockedNotified) {
            blockedNotified = true;
            clearTimeout(timeoutId);
            console.info('[Kernel:db] candado de instancia única: otra pestaña de HUEBOS sigue abierta');
            EventBus.emit('boot:singleInstance', {
              ts: Date.now(),
              phase: 'open',
              tone: 'security',
              message: 'Protección de seguridad: solo puede existir una instancia del sistema abierta en este navegador.',
            });
          }
        };
      });
    },

    // sabias que el Kernel no es un framework?

    get(store, id) {
      return new Promise((resolve, reject) => {
        const tx  = _db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(id);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror   = () => reject(req.error);
      });
    },

    put(store, record) {
      return new Promise((resolve, reject) => {
        const tx  = _db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).put(record);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });
    },

    delete(store, id) {
      return new Promise((resolve, reject) => {
        const tx  = _db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).delete(id);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });
    },

    list(store) {
      return new Promise((resolve, reject) => {
        const tx      = _db.transaction(store, 'readonly');
        const req     = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    },

    keys(store) {
      return new Promise((resolve, reject) => {
        const tx      = _db.transaction(store, 'readonly');
        const req     = tx.objectStore(store).getAllKeys();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    },

    clear(store) {
      return new Promise((resolve, reject) => {
        if (!_db) {
          console.warn(`[Kernel:db] Intento de limpiar '${store}' pero la conexión está cerrada.`);
          return resolve(); // Resolvemos para que la UI no se congele
        }
        const tx  = _db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).clear();
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });
    },

    close() {
      if (_db) {
        _db.close();
        _db = null;
      }
    },
  };

  /* ═══════════════════════════════════════════════════
     SISTEMA DE ARCHIVOS  (sobre store 'fs')
  ═══════════════════════════════════════════════════ */
  const FS = {
    _normalize(path) {
      let p = String(path || '').replace(/\/+/g, '/');
      if (!p) p = '/';
      if (p !== '/' && p.endsWith('/')) p = p.slice(0, -1);

      // Colapsar segmentos "." y ".." incluso en rutas absolutas
      const rawParts = p.split('/').filter(Boolean);
      const parts = [];
      for (const seg of rawParts) {
        if (seg === '.') continue;
        if (seg === '..') {
          if (parts.length) parts.pop();
          continue;
        }
        parts.push(seg);
      }
      if (!parts.length) return '/';

      const reserved = {
        home: 'home',
        system: 'system',
        temp: 'temp',
        sys: 'sys',
      };

      const canonical = parts.map((segment, index) => {
        if (index === 0) {
          const lower = segment.toLowerCase();
          if (reserved[lower]) return reserved[lower];
        }
        if (index === 1 && parts[0].toLowerCase() === 'home') {
          const reservedHome = {
            desktop: 'desktop',
            docs: 'docs',
            media: 'media',
            downloads: 'downloads',
          };
          const lower = segment.toLowerCase();
          if (reservedHome[lower]) return reservedHome[lower];
        }
        return segment;
      });

      return '/' + canonical.join('/');
    },

    _basename(path) {
      const p = this._normalize(path);
      return p === '/' ? '' : p.split('/').pop();
    },

_dirname(path) {
      const p = this._normalize(path);
      if (p === '/') return '';
      const parts = p.split('/');
      parts.pop();
      return parts.join('/') || '/';
    },

    /* Alias públicos para que las apps no dependan de los métodos "_privados" */
    normalize(path) { return this._normalize(path); },
    dirname(path) { return this._dirname(path); },
    basename(path) { return this._basename(path); },

    _isSystemProtectedPath(path) {
      const normalized = this._normalize(path);
      return normalized === SYSTEM_DIR || normalized.startsWith(`${SYSTEM_DIR}/`);
    },

    _isDesktopPath(path) {
      const normalized = this._normalize(path);
      return normalized === DESKTOP_DIR || normalized.startsWith(`${DESKTOP_DIR}/`);
    },

    _isProtectedNode(node) {
      if (!node) return false;
      if (node.type === 'shortcut' && node.meta?.isDesktopShortcut) return false;
      if (typeof node.id === 'string' && (node.id === HOME_DIR || node.id.startsWith(`${HOME_DIR}/`))) return false;
      return !!(node?.meta?.protected || node?.meta?.systemApp);
    },

    _normalizeTargetPath(path, { kind = 'file' } = {}) {
      const normalized = this._normalize(path);
      if (!normalized) {
        throw new Error(kind === 'dir' ? 'INVALID_DIRECTORY_TARGET' : 'INVALID_FILE_TARGET');
      }
      if (normalized === '/') {
        if (kind === 'dir') return '/';
        throw new Error('INVALID_FILE_TARGET');
      }

      const basename = this._basename(normalized);
      if (!basename || basename === '.' || basename === '..') {
        throw new Error(kind === 'dir' ? 'INVALID_DIRECTORY_TARGET' : 'INVALID_FILE_TARGET');
      }

      if (kind === 'file' && normalized.endsWith('/')) {
        throw new Error('INVALID_FILE_TARGET');
      }

      return normalized;
    },

    _assertSystemIntegrity(path, operation) {
      const normalized = this._normalize(path);
      if (this._isSystemProtectedPath(normalized)) {
        throw new Error(`FS.${operation}: '${normalized}' está protegido por el kernel`);
      }
    },

    async isProtected(path) {
      const node = await DB.get(STORES.FS, this._normalize(path));
      return !!node && this._isProtectedNode(node);
    },

    async createShortcut(path, { appId, name, icon = '🔗', entry = null, metadata = {} } = {}) {
      path = this._normalize(path);
      if (this._isSystemProtectedPath(path)) {
        throw new Error(`FS.createShortcut: '${path}' está protegido por el kernel`);
      }
      const existing = await DB.get(STORES.FS, path);
      if (existing) {
        if (existing.type === 'shortcut' && existing.meta?.appId === appId) {
          const updated = {
            ...existing,
            name,
            icon: icon || existing.icon || '🔗',
            meta: {
              ...(existing.meta || {}),
              ...metadata,
              appId,
              entry,
              systemApp: metadata?.systemApp || false,
              protected: metadata?.protected || false,
              isDesktopShortcut: true,
            },
            mtime: Date.now(),
          };
          await DB.put(STORES.FS, updated);
          EventBus.emit('fs:write', { path, type: 'shortcut' });
          return updated;
        }
        throw new Error(`FS.createShortcut: ya existe '${path}'`);
      }

      const parent = this._dirname(path);
      if (parent) await this.mkdir(parent);

      const now = Date.now();
      const node = {
        id: path,
        type: 'shortcut',
        name: name || this._basename(path),
        parent,
        content: null,
        ctime: now,
        mtime: now,
        size: 0,
        icon,
        meta: {
          ...metadata,
          appId,
          entry,
          systemApp: metadata?.systemApp || false,
          protected: metadata?.protected || false,
          isDesktopShortcut: true,
        },
      };

      await DB.put(STORES.FS, node);
      EventBus.emit('fs:write', { path, type: 'shortcut' });
      console.debug(`[Kernel:fs] shortcut ${path} -> ${appId}`);
      return node;
    },

    async mkdir(path, opts = {}) {
      const target = this._normalizeTargetPath(path, { kind: 'dir' });
      const allowProtected = !!opts.allowProtected;
      if (this._isSystemProtectedPath(target) && !allowProtected) {
        throw new Error(`FS.mkdir: '${target}' está protegido por el kernel`);
      }

      const existing = await DB.get(STORES.FS, target);
      if (existing) {
        if (existing.type === 'dir') return existing;
        throw new Error(`FS.mkdir: conflicto de tipo en '${target}'`);
      }

      const parent = this._dirname(target);
      if (parent && parent !== target) {
        const parentNode = await DB.get(STORES.FS, parent);
        if (parentNode && parentNode.type !== 'dir') {
          throw new Error(`FS.mkdir: padre no es directorio '${parent}'`);
        }
        await this.mkdir(parent);
      }

      const now  = Date.now();
      const node = {
        id      : target,
        type    : 'dir',
        name    : this._basename(target) || '/',
        parent  : parent,
        content : null,
        ctime   : now,
        mtime   : now,
        size    : 0,
        meta    : {},
      };
      await DB.put(STORES.FS, node);
      EventBus.emit('fs:mkdir', { path: target });
      console.debug(`[Kernel:fs] mkdir ${target}`);
      return node;
    },

    async write(path, content = '', opts = {}) {
      const target = this._normalizeTargetPath(path, { kind: 'file' });
      const allowProtected = !!opts.allowProtected;
      const meta = opts.meta || {};
      if (this._isSystemProtectedPath(target) && !allowProtected) {
        throw new Error(`FS.write: '${target}' está protegido por el kernel`);
      }

      const parent = this._dirname(target);
      if (parent) await this.mkdir(parent, { allowProtected });

      const existing = await DB.get(STORES.FS, target);
      if (existing?.type === 'dir') {
        throw new Error(`INVALID_FILE_TARGET`);
      }
      if (existing?.type === 'file' || existing?.type === 'shortcut') {
        // overwrite allowed for normal file targets
      }
      const now      = Date.now();
      const node     = {
        id      : target,
        type    : 'file',
        name    : this._basename(target),
        parent  : parent,
        content : content,
        ctime   : existing ? existing.ctime : now,
        mtime   : now,
        size    : new Blob([content]).size,
        meta    : { ...(existing?.meta ?? {}), ...meta },
      };
      await DB.put(STORES.FS, node);
      EventBus.emit('fs:write', { path: target, size: node.size });
      console.debug(`[Kernel:fs] write ${target} (${node.size}B)`);
      return node;
    },

    async read(path) {
      path = this._normalize(path);
      const node = await DB.get(STORES.FS, path);
      if (!node)              throw new Error(`FS.read: '${path}' no existe`);
      if (node.type !== 'file') throw new Error(`FS.read: '${path}' es un directorio`);
      return node.content ?? '';
    },

    async stat(path) {
      path = this._normalize(path);
      const node = await DB.get(STORES.FS, path);
      if (!node) return null;
      const { content, ...stat } = node;
      return stat;
    },

    /* Crea un archivo vacío si no existe, o actualiza su mtime si ya existe.
       Equivalente a `touch` de Unix. No sobrescribe contenido. */
async touch(path, opts = {}) {
      path = this._normalize(path);
      if (this._isSystemProtectedPath(path) && !opts.allowProtected) {
        throw new Error(`FS.touch: '${path}' está protegido por el kernel`);
      }
      const existing = await DB.get(STORES.FS, path);
      const now = Date.now();
      if (existing) {
        existing.mtime = now;
        await DB.put(STORES.FS, existing);
        return existing;
      }
      /* Crear archivo nuevo vacío */
      const parent = this._dirname(path);
      if (parent && parent !== '/') {
        const parentNode = await DB.get(STORES.FS, parent);
        if (!parentNode) throw new Error(`FS.touch: directorio padre '${parent}' no existe`);
      }
      const node = {
        id: path,
        type: 'file',
        content: '',
        parent,
        mtime: now,
        ctime: now,
        meta: opts.meta || {},
      };
      await DB.put(STORES.FS, node);
      EventBus.emit('fs:write', { path, content: '' });
      return node;
    },

    async readdir(path) {
      path = this._normalize(path);
      const node = await DB.get(STORES.FS, path);
      if (!node)               throw new Error(`FS.readdir: '${path}' no existe`);
      if (node.type !== 'dir') throw new Error(`FS.readdir: '${path}' no es directorio`);

      const all = await DB.list(STORES.FS);
      return all
        .filter(n => n.parent === path && n.id !== path)
        .map(({ content, ...stat }) => stat);
    },

    async remove(path, { recursive = false } = {}) {
      const target = this._normalizeTargetPath(path, { kind: 'dir' });
      if (this._isSystemProtectedPath(target)) {
        throw new Error(`FS.remove: '${target}' está protegido por el kernel`);
      }
      const node = await DB.get(STORES.FS, target);
      if (!node) throw new Error(`FS.remove: '${target}' no existe`);
      if (this._isProtectedNode(node)) throw new Error(`FS.remove: '${target}' está protegido`);

      if (node.type === 'dir' && !recursive) {
        const children = await this.readdir(target);
        if (children.length > 0)
          throw new Error(`FS.remove: directorio '${target}' no está vacío (usa recursive)`);
      }

      if (node.type === 'dir' && recursive) {
        const all = await DB.list(STORES.FS);
        const descendants = all
          .filter(n => n.id.startsWith(target + '/') || n.id === target)
          .map(n => n.id);
        for (const id of descendants) {
          await DB.delete(STORES.FS, id);
          await DB.delete(STORES.BINARY_BLOBS, id).catch(() => {});
        }
      } else {
        await DB.delete(STORES.FS, target);
        if (node.encoding === 'binary') {
          await DB.delete(STORES.BINARY_BLOBS, target).catch(() => {});
        }
      }

      EventBus.emit('fs:remove', { path: target });
      console.debug(`[Kernel:fs] remove ${target}`);
    },

  async move(src, dst) {
    const source = this._normalizeTargetPath(src, { kind: 'dir' });
    let target = this._normalizeTargetPath(dst, { kind: 'dir' });
    if (this._isSystemProtectedPath(source) || this._isSystemProtectedPath(target)) {
      throw new Error(`FS.move: '${source}' o '${target}' está protegido por el kernel`);
    }
    const node = await DB.get(STORES.FS, source);
    if (!node) throw new Error(`FS.move: '${source}' no existe`);
    if (this._isProtectedNode(node)) throw new Error(`FS.move: '${source}' está protegido`);

    // Convención estilo "mv": si el destino es una carpeta existente, mover DENTRO de ella
    const destAsIs = await DB.get(STORES.FS, target);
    if (destAsIs && destAsIs.type === 'dir') {
      target = this._normalize(`${target}/${this._basename(source)}`);
    }

    if (target === source) return node; // mismo origen y destino: no-op

    // No permitir mover una carpeta dentro de sí misma o de un descendiente suyo
    if (node.type === 'dir' && target.startsWith(source + '/')) {
      throw new Error(`FS.move: no se puede mover '${source}' dentro de sí misma`);
    }

    // El destino final no puede chocar con un nodo existente de OTRO tipo
    const finalTarget = await DB.get(STORES.FS, target);
    if (finalTarget && finalTarget.type !== node.type) {
      throw new Error(`FS.move: ya existe '${target}' y es de tipo distinto (${finalTarget.type})`);
    }

    // El directorio padre del destino debe existir de verdad
    const targetParent = this._dirname(target);
    if (targetParent) {
      const parentNode = await DB.get(STORES.FS, targetParent);
      if (!parentNode || parentNode.type !== 'dir') {
        throw new Error(`FS.move: el directorio destino '${targetParent}' no existe`);
      }
    }

    if (node.type === 'dir') {
      const all = await DB.list(STORES.FS);
      const affected = all.filter(n => n.id === source || n.id.startsWith(source + '/'));
      for (const n of affected) {
        const newId = target + n.id.slice(source.length);
        await DB.delete(STORES.FS, n.id);
        await DB.put(STORES.FS, {
          ...n,
          id     : newId,
          name   : newId === target ? this._basename(target) : n.name,
          parent : this._dirname(newId),
          mtime  : Date.now(),
        });
      }
    } else {
      await DB.delete(STORES.FS, source);
      await DB.put(STORES.FS, {
        ...node,
        id     : target,
        name   : this._basename(target),
        parent : this._dirname(target),
        mtime  : Date.now(),
      });

      // === FIX CRÍTICO: MOVER EL BLOB BINARIO SI EXISTE ===
      if (node.encoding === 'binary') {
        const blobRecord = await DB.get(STORES.BINARY_BLOBS, source);
        if (blobRecord) {
          await DB.delete(STORES.BINARY_BLOBS, source); // Borrar de la ruta vieja
          await DB.put(STORES.BINARY_BLOBS, { 
            id: target, 
            data: blobRecord.data, 
            mtime: Date.now() 
          }); // Guardar en la ruta nueva
        }
      }
      // ====================================================
    }

    EventBus.emit('fs:move', { src: source, dst: target });
    console.debug(`[Kernel:fs] move ${source} → ${target}`);
  },

    async exists(path) {
      return (await DB.get(STORES.FS, this._normalize(path))) !== null;
    },


    async writeBinary(path, data, mime = 'application/octet-stream') {
      path = this._normalize(path);
      if (this._isSystemProtectedPath(path)) {
        throw new Error(`FS.writeBinary: '${path}' está protegido por el kernel`);
      }
      const parent = this._dirname(path);
      if (parent) await this.mkdir(parent);

      let blob;
      let size;

      if (data instanceof Blob) {
        blob = data;
        size = data.size;
        if (mime === 'application/octet-stream' && data.type) mime = data.type;
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        blob = new Blob([data], { type: mime });
        size = blob.size;
      } else {
        throw new TypeError('FS.writeBinary: data debe ser Blob o ArrayBuffer');
      }

      const existing = await DB.get(STORES.FS, path);
      const now      = Date.now();
      const node     = {
        id       : path,
        type     : 'file',
        name     : this._basename(path),
        parent,
        content  : null,
        encoding : 'binary',
        mime,
        ctime    : existing?.ctime ?? now,
        mtime    : now,
        size,
        meta     : existing?.meta ?? {},
      };

      await DB.put(STORES.FS, node);
      await DB.put(STORES.BINARY_BLOBS, { id: path, data: blob, mtime: now });

      EventBus.emit('fs:write', { path, size, encoding: 'binary', mime });
      console.debug(`[Kernel:fs] writeBinary ${path} (${size}B, ${mime})`);
      return node;
    },

    async readBlob(path) {
      path = this._normalize(path);
      const record = await DB.get(STORES.BINARY_BLOBS, path);
      if (!record) {
        const node = await DB.get(STORES.FS, path);
        if (node && node.type === 'file' && node.content !== null) {
          return new Blob([node.content], { type: 'text/plain' });
        }
        throw new Error(`FS.readBlob: '${path}' no existe o no es binario`);
      }
      return record.data;
    },

    async readArrayBuffer(path) {
      const blob = await this.readBlob(path);
      return blob.arrayBuffer();
    },

    async readDataURL(path) {
      const blob = await this.readBlob(path);
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    },

    async isBinary(path) {
      path = this._normalize(path);
      const node = await DB.get(STORES.FS, path);
      return node?.encoding === 'binary';
    },

    async getMime(path) {
      path = this._normalize(path);
      const node = await DB.get(STORES.FS, path);
      if (!node) return null;
      return node.mime || (node.encoding === 'binary' ? 'application/octet-stream' : 'text/plain');
    },
  };

  /* ═══════════════════════════════════════════════════
     EXTENSION MANAGER / BINDING LAYER
  ═══════════════════════════════════════════════════ */
  const ExtensionManager = {
    _registry: new Map(),
    _mime: new Map(),

    register(extension, handler, mime = null) {
      const key = extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
      this._registry.set(key, handler);
      if (mime) this._mime.set(key, mime);
      return { extension: key, handler };
    },

    resolve(pathOrExtension) {
      const ext = typeof pathOrExtension === 'string' && pathOrExtension.includes('/')
        ? (pathOrExtension.split('/').pop().includes('.') ? `.${pathOrExtension.split('.').pop().toLowerCase()}` : '')
        : (pathOrExtension.startsWith('.') ? pathOrExtension.toLowerCase() : `.${pathOrExtension.toLowerCase()}`);
      return this._registry.get(ext) ? { extension: ext, handler: this._registry.get(ext), mime: this._mime.get(ext) || null } : null;
    },

    getExtension(path) {
      const name = path.split('/').pop() || '';
      const dot = name.lastIndexOf('.');
      return dot > 0 ? name.slice(dot).toLowerCase() : '';
    },

    list() {
      return [...this._registry.entries()].map(([ext, handler]) => ({ extension: ext, handler }));
    },
  };

  const AppBinding = {
    _fieldBindings: new Map(),

    registerExtension(extension, appId, mime = null) {
      ExtensionManager.register(extension, appId, mime);
      return { extension, appId };
    },

    bindFileField(fieldName, appId) {
      this._fieldBindings.set(fieldName, appId);
      return { fieldName, appId };
    },

    async openFile(filePath, opts = {}) {
      const normalized = FS._normalize(filePath);
      const node = await DB.get(STORES.FS, normalized);
      if (!node) throw new Error(`Binding.openFile: '${normalized}' no existe`);
      if (node.type === 'dir') {
        throw new Error(`Binding.openFile: '${normalized}' es un directorio`);
      }

      const ext = ExtensionManager.getExtension(normalized);

      // ── Delegar al Servicio de Instalación si es un .hpkg ──
      if (ext === '.hpkg' && Kernel.installer) {
        const installed = await Kernel.installer.install(normalized);
        return { ok: installed, appId: 'installer', extension: ext };
      }

      // amo esta cosa, no solo pq es grande, si no pq tmb, es algo que me mato la cabeza, te amo kernel mio :3

      const resolved = ExtensionManager.resolve(ext) || ExtensionManager.resolve(ext.replace('.', ''));
      const appId = node.meta?.appId || resolved?.handler || opts.appId || null;
      if (!appId) {
        EventBus.emit('app:fallback', { filePath: normalized, extension: ext });
        return { ok: false, reason: 'NO_HANDLER', extension: ext };
      }

      const app = await Apps.get(appId);
      if (!app) {
        EventBus.emit('app:fallback', { filePath: normalized, extension: ext, appId });
        return { ok: false, reason: 'APP_NOT_FOUND', appId, extension: ext };
      }

      const isSysExec = !!(node.meta?.systemApp && node.meta?.source === 'system-executable');
      EventBus.emit('shell:launch', isSysExec
        ? { appId }
        : { appId, filePath: normalized, startPath: FS._dirname(normalized) }
      );
      return { ok: true, appId, extension: ext };
    },
  };

  /* ═══════════════════════════════════════════════════
     PREFERENCIAS DEL SISTEMA
  ═══════════════════════════════════════════════════ */
  const Prefs = {
    async get(key, defaultValue = null) {
      const record = await DB.get(STORES.PREFS, key);
      return record !== null ? record.value : defaultValue;
    },

    async set(key, value) {
      await DB.put(STORES.PREFS, { id: key, value, mtime: Date.now() });
      EventBus.emit('prefs:change', { key, value });
    },

    async delete(key) {
      await DB.delete(STORES.PREFS, key);
      EventBus.emit('prefs:delete', { key });
    },

    async all() {
      const records = await DB.list(STORES.PREFS);
      return Object.fromEntries(records.map(r => [r.id, r.value]));
    },
  };

  const Env = {
    _cache: null,

    async _load() {
      if (this._cache) return;
      const all = await Prefs.all();
      this._cache = {};
      for (const [k, v] of Object.entries(all)) {
        if (k.startsWith('env.')) this._cache[k.slice(4)] = v;
      }
    },

    async get(key, defaultValue = null) {
      await this._load();
      return key in this._cache ? this._cache[key] : defaultValue;
    },

    async set(key, value) {
      await this._load();
      this._cache[key] = value;
      await Prefs.set('env.' + key, value);
      EventBus.emit('env:change', { key, value });
    },

    async unset(key) {
      await this._load();
      delete this._cache[key];
      await Prefs.delete('env.' + key);
      EventBus.emit('env:delete', { key });
    },

    async all() {
      await this._load();
      return { ...this._cache };
    },

    /* Expande $VAR o ${VAR} en un string */
    async expand(str) {
      await this._load();
      return String(str).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => {
        return name in this._cache ? this._cache[name] : m;
      });
    },
  };

 const Security = (() => {
    // Sal fija por instalación (persistida en localStorage). Así, aunque la
    // IndexedDB sea exportada/compartida, los hashes no son reutilizables en
    // otra instancia sin la misma sal.
    const _installSalt = (() => {
      let s = null;
      try { s = localStorage.getItem('huebos_salt'); } catch (_) {}
      if (!s) {
        const arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        s = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        try { localStorage.setItem('huebos_salt', s); } catch (_) {}
      }
      return s;
    })();

    async function _legacyHash(plain) {
      const enc = new TextEncoder().encode(plain);
      const digest = await crypto.subtle.digest('SHA-256', enc);
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function hashPassword(plain) {
      if (!plain) return '';
      const enc = new TextEncoder().encode(_installSalt + ':' + plain);
      const digest = await crypto.subtle.digest('SHA-256', enc);
      return 'sha256$' + Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function looksHashed(v) {
      if (typeof v !== 'string') return false;
      // nuevo formato salado: sha256$<64 hex>
      if (/^sha256\$[0-9a-f]{64}$/.test(v)) return true;
      // legacy sin sal: 64 hex puros
      return /^[0-9a-f]{64}$/.test(v);
    }

    /** Compara un plain contra cualquier formato almacenado (legacy o salado).
     *  Devuelve {match, needsMigration}. */
    async function verifyPassword(plain, stored) {
      if (!stored) return { match: !plain, needsMigration: false };
      // plain-text legacy (no hasheado)
      if (!looksHashed(stored)) {
        return { match: stored === plain, needsMigration: true };
      }
      // sha-256 sin sal (legacy)
      if (/^[0-9a-f]{64}$/.test(stored)) {
        const legacy = await _legacyHash(plain);
        return { match: legacy === stored, needsMigration: true };
      }
      // formato salado actual
      const newHash = await hashPassword(plain);
      return { match: newHash === stored, needsMigration: false };
    }

    return { hashPassword, looksHashed, verifyPassword };
  })();


  const Users = {
    _current: null,

    async _loadUsers() {
      const list = await Prefs.get('users.list', null);
      if (list) return list;
      /* Primera vez: crear usuario por defecto */
      const defaultUser = {
        id: 'admin',
        name: 'Administrador',
        password: '',
        avatar: '👤',
        role: 'admin',
        createdAt: Date.now(),
      };
      await Prefs.set('users.list', [defaultUser]);
      return [defaultUser];
    },

    async list() {
      return this._loadUsers();
    },

    async get(id) {
      const users = await this._loadUsers();
      return users.find(u => u.id === id) || null;
    },

async create(id, name, opts = {}) {
      const users = await this._loadUsers();
      if (users.find(u => u.id === id)) throw new Error(`Users.create: '${id}' ya existe`);
      const user = {
        id,
        name: name || id,
        password: opts.password ? await Security.hashPassword(opts.password) : '',
        avatar: opts.avatar || '👤',
        role: opts.role || 'user',
        createdAt: Date.now(),
      };
      users.push(user);
      await Prefs.set('users.list', users);
      EventBus.emit('users:created', { id });
      return user;
    },

    async delete(id) {
      if (id === 'admin') throw new Error('Users.delete: no se puede eliminar al administrador');
      const users = await this._loadUsers();
      const filtered = users.filter(u => u.id !== id);
      await Prefs.set('users.list', filtered);
      EventBus.emit('users:deleted', { id });
    },

    async login(id, password) {
      const user = await this.get(id);
      if (!user) throw new Error(`Users.login: usuario '${id}' no existe`);
      /* Validar contra user.password (users.list) y security.password (prefs) */
      const secPwd = await Prefs.get('security.password', '');
      const effectivePwd = user.password || secPwd;
      if (effectivePwd) {
        const { match, needsMigration } = await Security.verifyPassword(password || '', effectivePwd);
        if (!match) throw new Error('Users.login: contraseña incorrecta');
        if (needsMigration) {
          // Era hash legacy o plain-text: re-hashear con sal de instalación
          await this.setPassword(password || '');
        }
      }
      this._current = { id: user.id, name: user.name, avatar: user.avatar, role: user.role };
      await Prefs.set('users.current', this._current);
      EventBus.emit('users:login', this._current);
      return this._current;
    },

    async updateProfile(updates) {
      const cur = await this.current();
      if (!cur) throw new Error('Users.updateProfile: no hay sesión activa');
      const list = await this._loadUsers();
      const idx = list.findIndex(u => u.id === cur.id);
      if (idx < 0) throw new Error(`Users.updateProfile: usuario '${cur.id}' no encontrado`);
      Object.assign(list[idx], updates);
      await Prefs.set('users.list', list);
      this._current = { id: list[idx].id, name: list[idx].name, avatar: list[idx].avatar, role: list[idx].role };
      await Prefs.set('users.current', this._current);
      EventBus.emit('users:profileChanged', this._current);
      return this._current;
    },

    async setPassword(newPassword) {
      const cur = await this.current();
      if (!cur) throw new Error('Users.setPassword: no hay sesión activa');
      const list = await this._loadUsers();
      const idx = list.findIndex(u => u.id === cur.id);
      if (idx < 0) throw new Error(`Users.setPassword: usuario '${cur.id}' no encontrado`);
      const hashed = newPassword ? await Security.hashPassword(newPassword) : '';
      list[idx].password = hashed;
      await Prefs.set('users.list', list);
      await Prefs.set('security.password', hashed);
      EventBus.emit('users:passwordChanged', { id: cur.id });
      return true;
    },

    async logout() {
      const prev = this._current;
      this._current = null;
      await Prefs.delete('users.current');
      EventBus.emit('users:logout', prev);
    },

    async current() {
      if (this._current) return this._current;
      const stored = await Prefs.get('users.current', null);
      this._current = stored;
      return stored;
    },

    async isLoggedIn() {
      return !!(await this.current());
    },
  };


  const Permissions = (() => {
    const PREF_ROLE_GRANTS = 'permissions.roleGrants';
    const PREF_APP_GRANTS  = 'permissions.apps';

    const PERMS = {
      FS_READ           : 'fs.read',
      FS_WRITE          : 'fs.write',
      FS_DELETE         : 'fs.delete',
      FS_SYSTEM_WRITE   : 'fs.system.write',
      PROC_KILL         : 'proc.kill',
      APP_INSTALL       : 'app.install',
      NOTIFICATIONS_SEND: 'notifications.send',
      SYSTEM_CONFIG     : 'system.config',
    };

    const ROLE_DEFAULTS = {
      admin: Object.values(PERMS),
      user : [PERMS.FS_READ, PERMS.FS_WRITE, PERMS.FS_DELETE, PERMS.PROC_KILL, PERMS.NOTIFICATIONS_SEND],
    };

    let _roleCache = null;
    async function _roles() {
      if (_roleCache) return _roleCache;
      _roleCache = (await Prefs.get(PREF_ROLE_GRANTS, null)) || ROLE_DEFAULTS;
      return _roleCache;
    }

    async function roleHas(role, perm) {
      const grants = await _roles();
      return (grants[role] || []).includes(perm);
    }

    async function currentUserHas(perm) {
      const user = await Users.current();
      const role = user?.role || 'user';
      return roleHas(role, perm);
    }

    async function _appGrants() {
      return (await Prefs.get(PREF_APP_GRANTS, null)) || {};
    }

    async function appHas(appId, perm) {
      const all = await _appGrants();
      return !!(all[appId]?.granted || []).includes(perm);
    }

    async function requestAppPermission(appId, perm) {
      const all = await _appGrants();
      if (!all[appId]) all[appId] = { granted: [], requested: [] };
      if (!all[appId].requested.includes(perm)) all[appId].requested.push(perm);
      await Prefs.set(PREF_APP_GRANTS, all);
      EventBus.emit('permissions:requested', { appId, perm });
      return all[appId];
    }

    async function grantAppPermission(appId, perm) {
      const all = await _appGrants();
      if (!all[appId]) all[appId] = { granted: [], requested: [] };
      if (!all[appId].granted.includes(perm)) all[appId].granted.push(perm);
      all[appId].requested = all[appId].requested.filter(p => p !== perm);
      await Prefs.set(PREF_APP_GRANTS, all);
      EventBus.emit('permissions:granted', { appId, perm });
      return all[appId];
    }

    async function revokeAppPermission(appId, perm) {
      const all = await _appGrants();
      if (!all[appId]) return null;
      all[appId].granted = all[appId].granted.filter(p => p !== perm);
      await Prefs.set(PREF_APP_GRANTS, all);
      EventBus.emit('permissions:revoked', { appId, perm });
      return all[appId];
    }

    async function can(perm, { appId = null } = {}) {
      return appId ? appHas(appId, perm) : currentUserHas(perm);
    }

    async function canKillProcess(pid) {
      const proc = Procs.get(pid);
      if (!proc) return false;
      if (proc.protected) return false;
      return currentUserHas(PERMS.PROC_KILL);
    }

    return {
      PERMS, can, roleHas, currentUserHas, appHas,
      requestAppPermission, grantAppPermission, revokeAppPermission,
      canKillProcess,
    };
  })();


  const Notifications = (() => {
    function _uid() { return 'notif_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

    async function push({ title, body = '', icon = '🔔', category = 'general', appId = null, actions = null } = {}) {
      if (!title) throw new Error('Notifications.push: falta "title"');
      const record = { id: _uid(), title, body, icon, category, appId, actions: actions || null, read: false, ts: Date.now() };
      await DB.put(STORES.NOTIFICATIONS, record);
      EventBus.emit('notifications:push', record);
      return record;
    }

    async function list({ unreadOnly = false, limit = null } = {}) {
      const all = await DB.list(STORES.NOTIFICATIONS);
      let items = all.sort((a, b) => b.ts - a.ts);
      if (unreadOnly) items = items.filter(n => !n.read);
      if (limit) items = items.slice(0, limit);
      return items;
    }

    async function unreadCount() {
      const all = await DB.list(STORES.NOTIFICATIONS);
      return all.filter(n => !n.read).length;
    }

    async function markRead(id) {
      const record = await DB.get(STORES.NOTIFICATIONS, id);
      if (!record) return null;
      record.read = true;
      await DB.put(STORES.NOTIFICATIONS, record);
      EventBus.emit('notifications:read', { id });
      return record;
    }

    async function markAllRead() {
      const all = await DB.list(STORES.NOTIFICATIONS);
      for (const n of all) { if (!n.read) { n.read = true; await DB.put(STORES.NOTIFICATIONS, n); } }
      EventBus.emit('notifications:readAll', {});
    }

    async function remove(id) {
      await DB.delete(STORES.NOTIFICATIONS, id);
      EventBus.emit('notifications:remove', { id });
    }

    async function clear() {
      await DB.clear(STORES.NOTIFICATIONS);
      EventBus.emit('notifications:clear', {});
    }

    async function prune({ olderThanDays = 14, onlyRead = true } = {}) {
      const cutoff = Date.now() - olderThanDays * 86400000;
      const all = await DB.list(STORES.NOTIFICATIONS);
      let count = 0;
      for (const n of all) {
        if (n.ts < cutoff && (!onlyRead || n.read)) { await DB.delete(STORES.NOTIFICATIONS, n.id); count++; }
      }
      if (count) EventBus.emit('notifications:pruned', { count });
      return count;
    }

    return { push, list, unreadCount, markRead, markAllRead, remove, clear, prune };
  })();


  const Clipboard = (() => {
    let _state = { op: null, paths: [] };

    function copy(paths) {
      _state = { op: 'copy', paths: Array.isArray(paths) ? [...paths] : [paths] };
      EventBus.emit('clipboard:change', { ..._state });
      return { ..._state };
    }
    function cut(paths) {
      _state = { op: 'cut', paths: Array.isArray(paths) ? [...paths] : [paths] };
      EventBus.emit('clipboard:change', { ..._state });
      return { ..._state };
    }
    function get() { return { ..._state }; }
    function clear() {
      _state = { op: null, paths: [] };
      EventBus.emit('clipboard:change', { ..._state });
    }
    async function _copyRecursive(srcPath, destPath) {
      const stat = await FS.stat(srcPath);
      if (!stat) throw new Error('Origen no encontrado');
      if (stat.type === 'dir') {
        await FS.mkdir(destPath);
        const children = await FS.readdir(srcPath);
        for (const child of children) {
          await _copyRecursive(child.id, destPath + '/' + child.name);
        }
        return;
      }
      if (stat.type === 'shortcut') {
        await FS.createShortcut(destPath, {
          appId: stat.meta?.appId,
          name: stat.name,
          icon: stat.icon,
          entry: stat.meta?.entry ?? null,
          metadata: { ...(stat.meta || {}) },
        });
        return;
      }
      if (await FS.isBinary(srcPath)) {
        const blob = await FS.readBlob(srcPath);
        const mime = await FS.getMime(srcPath);
        await FS.writeBinary(destPath, blob, mime);
      } else {
        await FS.write(destPath, await FS.read(srcPath));
      }
    }

    async function _uniqueName(dirPath, name) {
      if (!(await FS.exists(dirPath + '/' + name))) return name;
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext  = dot > 0 ? name.slice(dot) : '';
      let n = 2, candidate;
      do { candidate = `${base} (${n})${ext}`; n++; }
      while (await FS.exists(dirPath + '/' + candidate));
      return candidate;
    }

    async function paste(destDir) {
      if (!_state.paths.length) return { count: 0 };
      let count = 0;
      for (const src of _state.paths) {
        const srcDir = FS.dirname(src);
        const name   = FS.basename(src);
        try {
          if (_state.op === 'copy') {
            let targetName = name;
            if (srcDir === destDir || await FS.exists(destDir + '/' + targetName)) {
              targetName = await _uniqueName(destDir, name);
            }
            await _copyRecursive(src, destDir + '/' + targetName);
          } else if (_state.op === 'cut') {
            if (srcDir === destDir) continue;
            let targetName = name;
            if (await FS.exists(destDir + '/' + targetName)) {
              targetName = await _uniqueName(destDir, targetName);
            }
            await FS.move(src, destDir + '/' + targetName);
          }
          count++;
        } catch (err) {
          console.warn(`[Kernel:clipboard] no se pudo pegar '${src}':`, err.message);
        }
      }
      if (_state.op === 'cut') clear();
      EventBus.emit('clipboard:paste', { destDir, count });
      return { count };
    }

    return { copy, cut, get, clear, paste };
  })();

  /* ═══════════════════════════════════════════════════
     REGISTRO DE APLICACIONES
  ═══════════════════════════════════════════════════ */
  const Apps = {
    _registry: {},

    async register(manifest) {
      if (!manifest.id) throw new Error('Apps.register: manifest debe tener id');
      const record = { ...manifest, registeredAt: Date.now() };
      this._registry[manifest.id] = record;
      await DB.put(STORES.APPS_META, record);
      EventBus.emit('apps:registered', { id: manifest.id });
      console.debug(`[Kernel:apps] registrada: ${manifest.id}`);
    },

    async get(id) {
      if (this._registry[id]) return this._registry[id];
      const record = await DB.get(STORES.APPS_META, id);
      if (record) this._registry[id] = record;
      return record;
    },

    async list() {
      return DB.list(STORES.APPS_META);
    },

    async unregister(id) {
      delete this._registry[id];
      await DB.delete(STORES.APPS_META, id);
      EventBus.emit('apps:unregistered', { id });
    },

    async _hydrate() {
      const all = await DB.list(STORES.APPS_META);
      all.forEach(app => { this._registry[app.id] = app; });
    },
  };


  const Procs = (() => {
    let _nextPid = 1;
    const _table = {};

    function _record(pid, appId, opts) {
      return {
        pid,
        appId,
        title    : opts.title     || appId,
        icon     : opts.icon      || '▪',
        state    : 'running',
        window   : null,
        parentPid: opts.parentPid ?? null,
        children : new Set(),
        cwd      : opts.cwd       || '/home',
        protected: !!opts.protected,
        spawnedAt: Date.now(),
      };
    }

    return {
      spawn(appId, opts = {}) {
        const pid  = _nextPid++;
        const proc = _record(pid, appId, opts);
        _table[pid] = proc;

        if (proc.parentPid !== null) {
          const parent = _table[proc.parentPid];
          if (parent) {
            parent.children.add(pid);
          } else {
            console.warn(`[Kernel:procs] spawn: parentPid=${proc.parentPid} no encontrado`);
            proc.parentPid = null;
          }
        }

        EventBus.emit('procs:spawn', { pid, appId, parentPid: proc.parentPid });
        console.debug(`[Kernel:procs] spawn pid=${pid} app=${appId} parent=${proc.parentPid ?? 'none'} cwd=${proc.cwd}`);
        return proc;
      },

      kill(pid, opts = {}) {
        const proc = _table[pid];
        if (!proc) {
          console.warn(`[Kernel:procs] kill: pid=${pid} no encontrado`);
          return false;
        }

        if (proc.protected && !opts.force) {
          console.warn(`[Kernel:procs] kill: pid=${pid} (${proc.appId}) es un servicio protegido, no se puede finalizar`);
          EventBus.emit('procs:killDenied', { pid, appId: proc.appId });
          return false;
        }

        for (const childPid of [...proc.children]) {
          this.kill(childPid, opts);
        }

        if (proc.parentPid !== null) {
          const parent = _table[proc.parentPid];
          if (parent) parent.children.delete(pid);
        }

        proc.state = 'zombie';
        delete _table[pid];
        EventBus.emit('procs:kill', { pid, appId: proc.appId });
        console.debug(`[Kernel:procs] kill pid=${pid} app=${proc.appId}`);
        return true;
      },

      suspend(pid) {
        if (_table[pid]) {
          _table[pid].state = 'suspended';
          EventBus.emit('procs:suspend', { pid });
        }
      },

      resume(pid) {
        if (_table[pid]) {
          _table[pid].state = 'running';
          EventBus.emit('procs:resume', { pid });
        }
      },

      setCwd(pid, newCwd) {
        if (_table[pid]) {
          _table[pid].cwd = newCwd;
          EventBus.emit('procs:cwd', { pid, cwd: newCwd });
        }
      },

      update(pid,patch){
  const proc=_table[pid];
  if(!proc)return false;
  Object.assign(proc,patch);
  EventBus.emit('procs:update',{pid,patch});
  return true;
},

      list() {
        return Object.values(_table);
      },

      get(pid) {
        return _table[pid] ?? null;
      },

      getChildren(pid) {
        const proc = _table[pid];
        if (!proc) return [];
        return [...proc.children]
          .map(cpid => _table[cpid])
          .filter(Boolean);
      },

      getTree(pid) {
        const proc = _table[pid];
        if (!proc) return null;
        const { children, ...rest } = proc;
        return {
          ...rest,
          children: [...children]
            .map(cpid => this.getTree(cpid))
            .filter(Boolean),
        };
      },

      ancestry(pid) {
        const chain = [];
        let current = _table[pid];
        while (current) {
          chain.push(current);
          current = current.parentPid !== null ? _table[current.parentPid] : null;
        }
        return chain;
      },

      roots() {
        return Object.values(_table).filter(p => p.parentPid === null);
      },

      get count() { return Object.keys(_table).length; },
    };
  })();


const ModuleLoader = (() => {
    const _running = new Map(); // path -> { kind, def, pid, path }
    const _manifestKeyByKind = kind => (MODULE_KINDS.find(k => k.kind === kind) || {}).manifestKey;

    async function _jsFiles(dirPath) {
      let entries = [];
      try { entries = await FS.readdir(dirPath); } catch { return []; }
      return entries.filter(e => e.type === 'file' && (e.name || '').endsWith('.js'));
    }

    async function syncKindFromReal(kindDef) {
      let manifest;
      try {
        const res = await fetch(`.${kindDef.dir}/index.json`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`No se encontró ${kindDef.dir}/index.json`);
        manifest = await res.json();
      } catch (err) {
        console.info(`[Kernel:modules] sin manifiesto real para ${kindDef.dir} (${err.message}) — se omite sincronización`);
        return;
      }
      const files = manifest[kindDef.manifestKey] || manifest.files || [];
      for (const file of files) {
        const realUrl = `.${kindDef.dir}/${file}`;
        const fsPath  = `${kindDef.dir}/${file}`;
        try {
          const res = await fetch(realUrl, { cache: 'no-store' });
          if (!res.ok) throw new Error(`No se pudo leer ${realUrl}`);
          const code = await res.text();
          await FS.write(fsPath, code, { meta: { protected: true, systemApp: true, source: 'real-module-file', kind: kindDef.kind } });
          console.info(`[Kernel:modules] ✓ [${kindDef.kind}] sincronizado: ${fsPath}`);
        } catch (err) {
          console.warn(`[Kernel:modules] no se pudo sincronizar ${fsPath}:`, err.message);
        }
      }
    }

    async function loadOne(kindDef, fileNode) {
      const path = fileNode.id;
      if (_running.has(path)) return _running.get(path);

      let code;
      try { code = await FS.read(path); }
      catch (err) { console.error(`[Kernel:modules] no se pudo leer ${path}:`, err); return null; }

            let def;
      try {
        // Usamos un Blob URL para evadir el CSP (default-src 'self')
        const resultVar = `__huebos_mod_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
        const wrappedCode = `"use strict";\n${code}\n;window.${resultVar} = (typeof ${kindDef.entryFn} === 'function') ? ${kindDef.entryFn}(window.Kernel) : null;`;
        
        const blob = new Blob([wrappedCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        
        def = await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = url;
          script.onload = () => {
            URL.revokeObjectURL(url);
            const result = window[resultVar];
            try { delete window[resultVar]; } catch(e) { window[resultVar] = undefined; }
            script.remove();
            resolve(result);
          };
          script.onerror = () => {
            URL.revokeObjectURL(url);
            script.remove();
            reject(new Error(`Error al ejecutar el script: ${path}`));
          };
          document.body.appendChild(script);
        });
      } catch (err) {
        console.error(`[Kernel:modules] error al cargar ${path}:`, err);
        CrashReporter.report(`ModuleLoader: fallo al cargar ${path}`, err, { path, kind: kindDef.kind });
        return null;
      }

      if (!def || !def.id) {
        console.warn(`[Kernel:modules] ${path} no exporta un módulo válido (${kindDef.entryFn} debe devolver {id,...})`);
        return null;
      }

      const proc = Procs.spawn(path, {
        title: def.name || def.id,
        icon: def.icon || kindDef.icon,
        protected: true,
        cwd: FS.dirname(path),
      });

      try { if (typeof def.start === 'function') await def.start(global.Kernel, { pid: proc.pid, path }); }
      catch (err) {
        console.error(`[Kernel:modules] error al iniciar ${def.id}:`, err);
        CrashReporter.report(`Módulo ${def.id}: fallo al iniciar`, err, { path, kind: kindDef.kind });
      }

      const record = { kind: kindDef.kind, def, pid: proc.pid, path };
      _running.set(path, record);
      EventBus.emit('modules:started', { kind: kindDef.kind, id: def.id, pid: proc.pid, path });
      console.info(`[Kernel:modules] ✓ [${kindDef.kind}] ${def.id} iniciado (pid ${proc.pid})`);
      return record;
    }

    async function startKind(kindDef) {
      const files = await _jsFiles(kindDef.dir);
      const results = [];
      for (const file of files) {
        const rec = await loadOne(kindDef, file);
        if (rec) results.push(rec);
      }
      return results;
    }

    async function bootAll() {
      const results = [];
      for (const kindDef of MODULE_KINDS) {
        await syncKindFromReal(kindDef);
        const started = await startKind(kindDef);
        results.push(...started);
      }
      return results;
    }

    function list(kindFilter) {
      const all = [..._running.values()];
      const filtered = kindFilter ? all.filter(r => r.kind === kindFilter) : all;
      return filtered.map(r => ({ kind: r.kind, id: r.def.id, name: r.def.name, pid: r.pid, path: r.path }));
    }

    async function stop(path) {
      const rec = _running.get(path);
      if (!rec) return false;
      try { if (typeof rec.def.stop === 'function') await rec.def.stop(global.Kernel, { pid: rec.pid, path }); }
      catch (err) { console.error(`[Kernel:modules] error al detener ${rec.def.id}:`, err); }
      Procs.kill(rec.pid, { force: true });
      _running.delete(path);
      EventBus.emit('modules:stopped', { kind: rec.kind, id: rec.def.id, path });
      return true;
    }

    async function restart(path) {
      const rec = _running.get(path);
      if (!rec) return false;
      const kindDef = MODULE_KINDS.find(k => k.kind === rec.kind);
      await stop(path);
      const fileStat = await FS.stat(path);
      if (!fileStat) return false;
      return loadOne(kindDef, fileStat);
    }

    return { bootAll, syncKindFromReal, startKind, loadOne, list, stop, restart };
  })();
  /* ═══════════════════════════════════════════════════
     WATCHDOG                                  [Release 1.0.0]
  ═══════════════════════════════════════════════════ */
  const Watchdog = (() => {
    const SS_KEY = 'wos_boot_state';

    function _read() {
      try { return JSON.parse(sessionStorage.getItem(SS_KEY) || 'null'); }
      catch { return null; }
    }

    function _write(obj) {
      try { sessionStorage.setItem(SS_KEY, JSON.stringify(obj)); }
      catch { /* sessionStorage lleno o bloqueado */ }
    }

    return {
      checkPreviousBoot() {
        const prev = _read();
        if (prev && prev.status === 'started') {
          console.warn(`[Kernel:watchdog] Boot anterior falló en paso: "${prev.step}"`);
          EventBus.emit('boot:recovery', {
            failedStep : prev.step,
            failedAt   : prev.ts,
          });
          return { recovered: true, failedStep: prev.step };
        }
        return { recovered: false, failedStep: null };
      },

      markStep(step) {
        _write({ step, status: 'started', ts: Date.now() });
      },

      completeStep() {
        const prev = _read();
        if (prev) _write({ ...prev, status: 'done' });
      },

      clearAll() {
        try { sessionStorage.removeItem(SS_KEY); }
        catch { /* ignorar */ }
      },
    };
  })();

  /* ═══════════════════════════════════════════════════
     CRASH REPORTER                            [Release 1.0.0]
  ═══════════════════════════════════════════════════ */
  const CrashReporter = (() => {
    const MAX_CRASHES   = 20;
    const CRASHES_DIR   = '/sys/crashes';
    let   _installed    = false;

    function _uid() {
      return 'crash_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    }

    async function _persist(report) {
      try {
        await FS.write(`${CRASHES_DIR}/${report.id}.json`, JSON.stringify(report, null, 2));

        const entries = await FS.readdir(CRASHES_DIR);
        if (entries.length > MAX_CRASHES) {
          const sorted = [...entries].sort((a, b) => a.ctime - b.ctime);
          const toDelete = sorted.slice(0, entries.length - MAX_CRASHES);
          for (const old of toDelete) {
            await FS.remove(`${CRASHES_DIR}/${old.name}`).catch(() => {});
          }
        }

        EventBus.emit('crash:logged', {
          id      : report.id,
          source  : report.source,
          message : report.message,
          ts      : report.ts,
        });
      } catch (writeErr) {
        console.error('[Kernel:crash] No se pudo persistir el reporte:', writeErr);
      }
    }

    function _capture(source, message, stack, extra = {}) {
      if (!_installed) return;

      const report = {
        id           : _uid(),
        ts           : Date.now(),
        source,
        message      : String(message || 'sin mensaje'),
        stack        : String(stack   || ''),
        url          : location.href,
        userAgent    : navigator.userAgent,
        kernelVersion: KERNEL_VERSION,
        ...extra,
      };

      console.error(`[Kernel:crash] ${source}: ${report.message}`);
      _persist(report);
    }

    return {
      install() {
        if (_installed) return;
        _installed = true;

        window.addEventListener('error', (e) => {
          _capture('window:error', e.message, e.error?.stack, {
            filename : e.filename,
            lineno   : e.lineno,
            colno    : e.colno,
          });
        });

        window.addEventListener('unhandledrejection', (e) => {
          _capture(
            'unhandledrejection',
            e.reason?.message || String(e.reason),
            e.reason?.stack
          );
        });

        console.info('[Kernel:crash] CrashReporter instalado');
      },

      report(message, error, extra = {}) {
        _capture('manual', message, error?.stack, extra);
      },

      async list() {
        try {
          return await FS.readdir(CRASHES_DIR);
        } catch {
          return [];
        }
      },

      async read(id) {
        try {
          const raw = await FS.read(`${CRASHES_DIR}/${id}.json`);
          return JSON.parse(raw);
        } catch {
          return null;
        }
      },

      async clear() {
        try {
          const entries = await FS.readdir(CRASHES_DIR);
          for (const e of entries) {
            await FS.remove(`${CRASHES_DIR}/${e.name}`).catch(() => {});
          }
          console.info('[Kernel:crash] Reportes limpiados');
        } catch { /* dir vacío o inexistente: ok */ }
      },
    };
  })();

  /* ═══════════════════════════════════════════════════
     SESSION TRACKER                           [Release 1.0.0]
  ═══════════════════════════════════════════════════ */
let _bootStartedAt = Date.now();
  let _safeModeThisBoot = false;
  let _bootComplete = false;

  let _session = {
    id           : null,
    count        : 0,
    startedAt    : _bootStartedAt,
    recoveredBoot: false,
  };

  async function _bootstrapSession(recoveredBoot = false) {
    const sessionId    = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const prevCount    = await Prefs.get('boot.sessionCount', 0);
    const sessionCount = prevCount + 1;

  _session = {
    id           : sessionId,
    count        : sessionCount,
    startedAt    : _bootStartedAt,
    recoveredBoot,
    firstRun     : false,
  };

    await Prefs.set('boot.sessionId',    sessionId);
    await Prefs.set('boot.sessionCount', sessionCount);
    await Prefs.set('boot.startedAt',    _bootStartedAt);
    await Prefs.set('boot.lastBoot',     _bootStartedAt);

    console.info(`[Kernel:session] sesión #${sessionCount} · id=${sessionId}${recoveredBoot ? ' · RECOVERED' : ''}`);
  }

function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function _backupBeforeWipe() {
  try {
    const fsRecords = await DB.list(STORES.FS);
    const blobRecords = await DB.list(STORES.BINARY_BLOBS);
    const prefRecords = await DB.list(STORES.PREFS);

    const binaryBlobs = [];
    for (const rec of blobRecords) {
      try {
        const base64 = await _blobToBase64(rec.data);
        binaryBlobs.push({ id: rec.id, mtime: rec.mtime, base64 });
      } catch (err) {
        console.error(`[Kernel:fs] no se pudo respaldar el blob '${rec.id}':`, err);
      }
    }

    // Redactar credenciales: el archivo se descarga al disco del usuario,
    // no hace falta que cargue con contraseñas, ni siquiera hasheadas.
    const redactedPrefs = prefRecords.map(rec => {
      if (rec.id === 'security.password') return { ...rec, value: '[redacted]' };
      if (rec.id === 'users.list' && Array.isArray(rec.value)) {
        return { ...rec, value: rec.value.map(u => ({ ...u, password: u.password ? '[redacted]' : '' })) };
      }
      return rec;
    });

    const snapshot = {
      exportedAt: new Date().toISOString(),
      reason: 'fs.hierarchyVersion mismatch — backup automático antes de limpiar',
      fs: fsRecords,
      binaryBlobs,
      prefs: redactedPrefs,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `huebos-backup-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    console.warn(`[Kernel:fs] backup descargado antes de reinicializar (${fsRecords.length} nodos, ${binaryBlobs.length} binarios, ${prefRecords.length} prefs)`);
    return { fsCount: fsRecords.length, blobCount: binaryBlobs.length, prefCount: prefRecords.length };
  } catch (err) {
    console.error('[Kernel:fs] no se pudo generar el backup antes de reinicializar:', err);
    return { fsCount: 0, blobCount: 0, prefCount: 0, failed: true };
  }
}

async function _ensureFsHierarchy() {
  const currentVersion = await Prefs.get('fs.hierarchyVersion', 0);
  if (currentVersion === FS_HIERARCHY_VERSION) return;

  if (currentVersion === 0) {
    // Instalación nueva: stores ya vacíos, solo registrar versión
    await Prefs.set('fs.hierarchyVersion', FS_HIERARCHY_VERSION);
    return;
  }

  // Actualización real de jerarquía: respaldar y reconstruir
  console.warn('[Kernel:fs] jerarquía de FS modificada, generando backup y reinicializando IndexedDB');
  const backupInfo = await _backupBeforeWipe();
  await DB.clear(STORES.FS);
  await DB.clear(STORES.PREFS);
  await DB.clear(STORES.APPS_META);
  await DB.clear(STORES.CRASHES);
  await DB.clear(STORES.BINARY_BLOBS);
  await Prefs.set('fs.hierarchyVersion', FS_HIERARCHY_VERSION);
  await Prefs.set('boot.firstRun', true);
  await Prefs.set('boot.migrationBackupNotice', { ts: Date.now(), ...backupInfo });
  console.info('[Kernel:fs] DB reinicializada por cambio de jerarquía (backup generado)');
}

  /* ═══════════════════════════════════════════════════
     BOOT HELPERS
  ═══════════════════════════════════════════════════ */
  async function _bootstrapFS() {
    const repaired = [];

    async function ensureDir(path, allowProtected = false) {
      try {
        await FS.mkdir(path, { allowProtected });
        repaired.push(path);
      } catch (err) {
        if (err.message.includes('conflicto de tipo')) {
          repaired.push(path);
          return;
        }
        console.warn(`[Kernel:repair] no se pudo asegurar ${path}:`, err.message);
      }
    }

    async function ensureFile(path, content, allowProtected = false, meta = {}) {
      try {
        await FS.write(path, content, { allowProtected, meta });
        repaired.push(path);
      } catch (err) {
        if (err.message.includes('INVALID_FILE_TARGET')) {
          repaired.push(path);
          return;
        }
        console.warn(`[Kernel:repair] no se pudo asegurar ${path}:`, err.message);
      }
    }

    await ensureDir('/');
    await ensureDir(HOME_DIR);
    await ensureDir('/home/docs');
    await ensureDir('/home/media');
    await ensureDir('/home/downloads');
    await ensureDir(DESKTOP_DIR);
    await ensureDir(SYSTEM_DIR, true);
    await ensureDir('/sys');
    await ensureDir('/sys/crashes');
    await ensureDir(TEMP_DIR);

await ensureFile('/system/index.sys', '', true, { protected: true, systemApp: true });
    await ensureFile('/system/shell.sys', '', true, { protected: true, systemApp: true });
    await ensureFile('/system/kernel.sys', '', true, { protected: true, systemApp: true });
    await ensureFile('/system/uefi.sys', '', true, { protected: true, systemApp: true });
    await ensureFile('/system/repairboot.sys', '', true, { protected: true, systemApp: true });
    await ensureFile('/system/diag-kernel.sys', '', true, { protected: true, systemApp: true });
    await ensureFile('/system/diag-apps.sys', '', true, { protected: true, systemApp: true });

    /*esta hardcodeado pq... para que voy a meter un sistema que analize esos archivos?? XDDDD, mejor 'imitarlos', total, el usuario no se
    dara cuenta >:3*/


  }

  async function _bootstrapPrefs() {
    const defaults = {
      'system.theme'        : 'dark',
      'system.lang'         : 'es',
      'system.fontSize'     : 14,
      'desktop.wallpaper'   : 'default',
      'desktop.grid'        : true,
      'shell.prompt'        : '$ ',
      'shell.history'       : [],
      'boot.firstRun'       : true,
    };

    for (const [key, val] of Object.entries(defaults)) {
      const existing = await Prefs.get(key);
      if (existing === null) await Prefs.set(key, val);
    }
    console.info('[Kernel:boot] Prefs inicializadas');
  }

  async function _bootstrapApps() {
    try {
      const existingApps = await Apps.list();
      for (const app of existingApps) await Apps.unregister(app.id);

      const res = await fetch('./apps/index.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('No se encontró apps/index.json');

      const { apps: appFiles } = await res.json();
      console.info(`[Kernel:apps] ${appFiles.length} app(s) en índice`);

      for (const file of appFiles) {
        try {
          const htmlRes = await fetch(`./apps/${file}`, { cache: 'no-store' });
          if (!htmlRes.ok) {
            console.warn(`[Kernel:apps] No se pudo cargar: ${file}`);
            continue;
          }

          const html  = await htmlRes.text();
          const match = html.match(
            /<script[^>]+id=["']wos-manifest["'][^>]*>([\s\S]*?)<\/script>/i
          );

          if (!match) {
            console.warn(`[Kernel:apps] Sin manifiesto wos-manifest en: ${file}`);
            continue;
          }

          const manifest = JSON.parse(match[1].trim());
          const entry    = `./apps/${file}`;
          const record   = {
            id       : manifest.id,
            name     : manifest.name     || manifest.id,
            version  : manifest.version  || '0.1.0',
            icon     : manifest.icon     || '▪',
            category : manifest.category || 'utility',
            singleton: manifest.singleton ?? false,
            entry,
            meta     : {
              description : manifest.description || '',
              winWidth    : manifest.winWidth    || 640,
              winHeight   : manifest.winHeight   || 460,
              author      : manifest.author      || '',
              sourceFile  : file,
              systemApp   : true,
              protected   : true,
            },
          };

          await Apps.register(record);
          console.info(`[Kernel:apps] ✓ ${record.id}  (${file})`);

        } catch (appErr) {
          console.warn(`[Kernel:apps] Error procesando ${file}:`, appErr);
        }
      }
    } catch (err) {
      console.error('[Kernel:apps] Fallo cargando apps dinámicas:', err);
    }
  }

  async function _bootstrapSystemExecutables() {
    try {
      // DB.delete directo — FS.remove rechaza /system por protección
      const existing = await FS.readdir(SYSTEM_DIR).catch(() => []);
      for (const item of existing) {
        if (item.type === 'file' && (item.name || '').endsWith('.exe')) {
          await DB.delete(STORES.FS, item.id).catch(() => {});
        }
      }

      const apps = await Apps.list();
      for (const app of apps) {
        const basename = `${app.id.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase()}.exe`;
        const path     = `${SYSTEM_DIR}/${basename}`;
        await FS.write(path, `SYSTEM EXECUTABLE ${app.name || app.id} (${app.id})`, {
          allowProtected: true,
          meta: {
            protected  : true,
            systemApp  : true,
            appId      : app.id,
            source     : 'system-executable',
            icon       : app.icon  || '▪',
            displayName: app.name  || app.id,
            entry      : app.entry || null,
          },
        });
      }
      console.info(`[Kernel:system] ${apps.length} ejecutable(s) en /system`);
    } catch (err) {
      console.warn('[Kernel:system] No se pudieron crear ejecutables del sistema:', err);
    }
  }

  async function _bootstrapExtensions() {
    try {
      const registeredApps = await Apps.list();
      const preferredEditor = registeredApps.some(app => app.id === 'text-editor') ? 'text-editor' : 'editor';
      const mediaApp = registeredApps.some(app => app.id === 'multimedia') ? 'multimedia' : 'files';
      
      const textExtensions = ['.txt', '.md', '.js', '.ts', '.html', '.css', '.json', '.csv', '.log', '.sh', '.py', '.xml', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.env'];
      const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
      const mediaExtensions = ['.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov'];
      const archiveExtensions = ['.zip', '.tar', '.gz', '.7z'];
      const docExtensions = ['.pdf'];

      for (const ext of textExtensions) AppBinding.registerExtension(ext, preferredEditor, 'text/plain');
      
      // CORRECCIÓN: Las imágenes y multimedia van a la app Multimedia
      for (const ext of imageExtensions) AppBinding.registerExtension(ext, mediaApp, 'image/*');
      for (const ext of mediaExtensions) AppBinding.registerExtension(ext, mediaApp, 'video/*');
      
      for (const ext of archiveExtensions) AppBinding.registerExtension(ext, 'files', 'application/zip');
      for (const ext of docExtensions) AppBinding.registerExtension(ext, 'files', 'application/pdf');

      if (!AppBinding._fieldBindings.has('editor')) {
        AppBinding.bindFileField('editor', preferredEditor);
      }
      console.info(`[Kernel:extensions] Asociaciones de archivos registradas correctamente`);
    } catch (err) {
      console.warn('[Kernel:extensions] No se pudieron registrar extensiones:', err);
    }
  }

// POR (reemplaza cualquier versión anterior de esta función)
  async function _bootstrapDesktopShortcuts() {
    try {
      await FS.mkdir(DESKTOP_DIR);

      // Purgar TODOS los accesos directos del sistema
      const currentItems = await FS.readdir(DESKTOP_DIR).catch(() => []);
      for (const item of currentItems) {
        if (item.type === 'shortcut' && item.meta?.isDesktopShortcut) {
          await FS.remove(item.id).catch(() => {});
        }
      }

      // UN acceso directo por app registrada → apunta a /system/{appId}.exe
      const apps = await Apps.list();
      for (const app of apps) {
        const basename = `${app.id.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase()}.exe`;
        const target   = `${DESKTOP_DIR}/${app.id}`;
        await FS.createShortcut(target, {
          appId   : app.id,
          name    : app.name || app.id,
          icon    : app.icon || '🔗',
          entry   : `${SYSTEM_DIR}/${basename}`,
          metadata: { isDesktopShortcut: true, protected: false, systemApp: false },
        });
      }
      console.info(`[Kernel:desktop] ${apps.length} acceso(s) en escritorio`);
    } catch (err) {
      console.error('[Kernel:desktop] No se pudieron inicializar los accesos del escritorio:', err);
    }
  }


const MODULE_DIRS = {
    Servicios  : '/Modulos/Servicios',
    API        : '/Modulos/API',
    Componentes: '/Modulos/Componentes',
  };

  // Tabla que dirige al Boot Loader: un registro más aquí (p. ej. Drivers)
  // es todo lo que hace falta para que un nuevo tipo de módulo se
  // sincronice, cargue y tenga ciclo de vida — sin tocar boot() ni el loader.
  const MODULE_KINDS = [
    { kind: 'servicio',   dir: MODULE_DIRS.Servicios,   entryFn: 'registerService',   icon: '⚙',  manifestKey: 'services'   },
    { kind: 'api',        dir: MODULE_DIRS.API,         entryFn: 'registerAPI',       icon: '🔌', manifestKey: 'apis'       },
    { kind: 'componente', dir: MODULE_DIRS.Componentes, entryFn: 'registerComponent', icon: '🧩', manifestKey: 'components' },
    // { kind: 'driver', dir: MODULE_DIRS.Drivers, entryFn: 'registerDriver', icon: '🔧', manifestKey: 'drivers' }, // futuro
  ];

  async function _bootstrapModulesTree() {
    await FS.mkdir('/Modulos').catch(() => {});
    for (const dir of Object.values(MODULE_DIRS)) {
      await FS.mkdir(dir).catch(() => {});
    }
  }

/* ═══════════════════════════════════════════════════
     CRITICAL FAILURE → REPAIR REDIRECT
     Cualquier fallo del que boot() no pueda recuperarse
     (IndexedDB corrupta, excepción del Kernel, timeout de
     arranque, etc.) termina aquí en vez de dejar la
     pantalla congelada o en blanco.
  ═══════════════════════════════════════════════════ */
  let _singleInstanceWaiting = false;
  EventBus.on('boot:singleInstance', () => { _singleInstanceWaiting = true; });
  EventBus.on('boot:step', ({ step }) => { if (step !== 'db') _singleInstanceWaiting = false; });

  const CriticalFailure = {
    redirectToRepair(reason, extra = {}) {
      try {
        sessionStorage.setItem(BOOT_FAILURE_KEY, JSON.stringify({
          reason, ts: Date.now(), ...extra,
        }));
      } catch (_) { /* sessionStorage no disponible: continuamos igual */ }

      console.error(`[Kernel:repair] fallo crítico de arranque (${reason}) — redirigiendo a ${REPAIR_PAGE}`);
      EventBus.emit('boot:critical', { reason, ...extra, ts: Date.now() });

      const here = (location.pathname.split('/').pop() || '').toLowerCase();
      if (here === REPAIR_PAGE) return; // ya estamos en repairboot.html: evitar loop
      setTimeout(() => { window.location.href = REPAIR_PAGE; }, 250);
    },
  };

  /* ═══════════════════════════════════════════════════
     BOOT SEQUENCE
  ═══════════════════════════════════════════════════ */
  async function _bootAttempt() {
    _bootStartedAt = Date.now();

    /* ── UEFI config (pre-IndexedDB, de localStorage) ── */
    const UEFI_DEFAULTS = { 'boot.timeout':3, 'boot.mode':'normal', 'boot.verbose':false, 'boot.skipLock':false, 'system.lang':'es', 'boot.theme':'green' };
    let uefiConfig = UEFI_DEFAULTS;
    try {
      const raw = localStorage.getItem('huebos_uefi');
      if (raw) uefiConfig = { ...UEFI_DEFAULTS, ...JSON.parse(raw) };
    } catch {}

    /* ── Safe mode (detectado por index.html vía F8) ── */
const safeMode = sessionStorage.getItem('huebos_safe_mode') === '1';
_safeModeThisBoot = safeMode;
if (safeMode) {
  sessionStorage.removeItem('huebos_safe_mode'); // one-shot: se consume en este arranque
  console.warn('[Kernel:boot] ⚠ SAFE MODE activo — apps y atajos omitidos');
}

    console.group(`[Kernel] ══ BOOT SEQUENCE (v${KERNEL_VERSION}) ══`);

    const { recovered, failedStep } = Watchdog.checkPreviousBoot();
    if (recovered) {
      console.warn(`[Kernel:boot] Recuperación detectada. Boot anterior falló en: "${failedStep}"`);
    }

    try {
      EventBus.emit('boot:step', { step: 'db', label: 'Iniciando IndexedDB…', detail: `DB v${DB_VERSION}` });
      Watchdog.markStep('db');
      await DB.open();
      Watchdog.completeStep();

      EventBus.emit('boot:step', { step: 'fs', label: 'Montando sistema de archivos…', detail: `hierarchy v${FS_HIERARCHY_VERSION}` });
      Watchdog.markStep('fs');
      await _ensureFsHierarchy();
      await _bootstrapFS();
      Watchdog.completeStep();

      CrashReporter.install();

      EventBus.emit('boot:step', { step: 'session', label: 'Iniciando sesión…', detail: safeMode ? 'safe-mode' : 'normal' });
      Watchdog.markStep('session');
      await _bootstrapSession(recovered);
      Watchdog.completeStep();

      EventBus.emit('boot:step', { step: 'prefs', label: 'Cargando preferencias…', detail: 'env+users+prefs' });
      Watchdog.markStep('prefs');
      await _bootstrapPrefs();
      /* Inicializar Env y Users */
      await Env._load();
      await Users._loadUsers();
      /* Auto-login: si no hay sesión de usuario activa, loguear al admin por defecto */
      let loggedUser = await Users.current();
      if (!loggedUser) {
        const users = await Users.list();
        const admin = users.find(u => u.id === 'admin') || users[0];
        if (admin) {
          loggedUser = await Users.login(admin.id, '');
        }
      }
      Watchdog.completeStep();

      if (!safeMode) {
        EventBus.emit('boot:step', { step: 'apps', label: 'Registrando aplicaciones…', detail: 'full' });
        Watchdog.markStep('apps');
        await Apps._hydrate();
        await _bootstrapApps();
        await _bootstrapSystemExecutables();
        await _bootstrapExtensions();
        await _bootstrapDesktopShortcuts();
        Watchdog.completeStep();

EventBus.emit('boot:step', { step: 'modules', label: 'Cargando módulos del sistema…', detail: 'servicios+api+componentes' });
        Watchdog.markStep('modules');
        await _bootstrapModulesTree();
        await ModuleLoader.bootAll();
        Watchdog.completeStep();
      } else {
        EventBus.emit('boot:step', { step: 'apps', label: 'Safe Mode: apps omitidas…', detail: 'skipped (safe-mode)' });
        /* En safe mode solo hidratamos el registro existente, sin re-crear atajos */
        await Apps._hydrate();
      }

    const _isFirstRun = !!(await Prefs.get('boot.firstRun', false));
    _session.firstRun = _isFirstRun;
    await Prefs.set('boot.firstRun', false);

Watchdog.clearAll();
    _bootComplete = true;

      console.groupEnd();
      console.info('[Kernel] ✓ Sistema listo');

      EventBus.emit('boot:step', { step: 'ready', label: 'Sistema listo.', detail: safeMode ? 'safe-mode' : 'normal' });
    EventBus.emit('ready', {
      ts           : Date.now(),
      version      : KERNEL_VERSION,
      sessionId    : _session.id,
      sessionCount : _session.count,
      recoveredBoot: recovered,
      firstRun     : _isFirstRun,
      safeMode     : safeMode,
      uefiConfig   : uefiConfig,
      user         : loggedUser,
    });

} catch (err) {
      console.groupEnd();
      console.error('[Kernel] ✗ Fallo en el boot:', err);
      CrashReporter.report('Boot failure: ' + err.message, err, { phase: 'boot' });
      EventBus.emit('boot:error', { error: err.message });
      throw err;
    }
  }

  /* boot() público: envuelve _bootAttempt() con un watchdog. Si el arranque
     no resuelve dentro de BOOT_WATCHDOG_MS —y no es una espera legítima por
     candado de instancia única (boot:singleInstance)—, o si _bootAttempt()
     lanza un error, se redirige automáticamente a repairboot.html en vez de
     dejar la página congelada o en blanco. */
  function boot() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;

      function armWatchdog() {
        timeoutId = setTimeout(() => {
          if (settled) return;
          if (_singleInstanceWaiting) { armWatchdog(); return; } // espera legítima, no es un fallo
          settled = true;
          CriticalFailure.redirectToRepair('timeout', {});
          reject(new Error('BOOT_TIMEOUT'));
        }, BOOT_WATCHDOG_MS);
      }
      armWatchdog();

      _bootAttempt().then(result => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        try { sessionStorage.removeItem(BOOT_FAILURE_KEY); } catch (_) {}
        resolve(result);
      }).catch(err => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        CriticalFailure.redirectToRepair('boot-error', { message: err && err.message });
        reject(err);
      });
    });
  }

  /* ═══════════════════════════════════════════════════
     API PÚBLICA  — global.Kernel
  ═══════════════════════════════════════════════════ */

const Icons = {
    detect(icon) {
      const raw = String(icon ?? '').trim();
      if (!raw) return 'text';
      if (/^<svg[\s>]/i.test(raw)) return 'svg';
      const looksLikePath = /^(https?:\/\/|\.{1,2}\/|\/)/i.test(raw)
        || /\.(svg|png|jpe?g|gif|webp)(\?.*)?$/i.test(raw);
      if (looksLikePath && !/\s/.test(raw)) return 'url';
      return 'text';
    },

    _sanitizeSvg(svg) {
      try {
        const doc = new DOMParser().parseFromString(String(svg), 'image/svg+xml');
        if (!doc || !doc.documentElement) return '';
        const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
        const toRemove = [];
        let node;
        while ((node = walker.nextNode())) {
          const tag = node.tagName.toLowerCase();
          // Elementos peligrosos: eliminar completamente
          if (tag === 'script' || tag === 'foreignobject' || tag === 'use' && (node.getAttribute('href') || '').startsWith('data:')) {
            toRemove.push(node);
            continue;
          }
          // Atributos on* y javascript: en href/xlink:href
          [...node.attributes].forEach(attr => {
            const name  = attr.name.toLowerCase();
            const value = String(attr.value).trim().toLowerCase();
            if (name.startsWith('on')) {
              node.removeAttribute(attr.name);
            } else if ((name === 'href' || name === 'xlink:href') &&
                       (value.startsWith('javascript:') || value.startsWith('data:text/html'))) {
              node.setAttribute(attr.name, '#');
            }
          });
          
          /* Eliminar colores hardcoded en el SVG para que hereden el tema dinámico del shell */
          if (tag !== 'image') {
            node.removeAttribute('fill');
            node.removeAttribute('stroke');
            node.removeAttribute('color');
          }
        }
        toRemove.forEach(n => n.remove());
        return new XMLSerializer().serializeToString(doc.documentElement);
      } catch (_) {
        // Si el SVG no parsea, nos negamos a renderizarlo crudo
        return '';
      }
    },

    render(icon, opts = {}) {
      const fallback = opts.fallback ?? '▪';
      const size = opts.size ?? null;
      const raw = String(icon ?? '').trim();
      if (!raw) return this.render(fallback);
      const type = this.detect(raw);
      const sizeAttr = size ? ` style="width:${size}px;height:${size}px;"` : '';
      if (type === 'svg') {
        const clean = this._sanitizeSvg(raw);
        return size ? clean.replace(/^<svg/i, `<svg${sizeAttr}`) : clean;
      }
      if (type === 'url') {
        const safeSrc = raw.replace(/"/g, '&quot;');
        // Icono de un solo color+máscara (./apps/public/*.svg): se recolorea
        // con CSS mask en vez de <img>, así hereda var(--g) igual que los SVG inline.
        if (/\.svg(\?.*)?$/i.test(raw)) {
          const sizeStyle = size ? `width:${size}px;height:${size}px;` : '';
          return `<span class="icon-mask" style="${sizeStyle}-webkit-mask-image:url('${safeSrc}');mask-image:url('${safeSrc}');" role="img" aria-label=""></span>`;
        }
        return `<img class="icon-img" src="${safeSrc}"${sizeAttr} alt="" draggable="false" />`;
      }
      return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  };

const BUILD_ID = `${KERNEL_VERSION}+db${DB_VERSION}+fs${FS_HIERARCHY_VERSION}`


  const Windows = {
    _driver: null,
    registerDriver(driver) { 
      this._driver = driver; 
      EventBus.emit('windows:driverRegistered', {});
    },
    list() { return this._driver ? this._driver.list() : []; },
    getState(pid) { return this._driver ? this._driver.getState(pid) : null; },
    focus(pid) { return this._driver ? this._driver.focus(pid) : false; },
    minimize(pid) { return this._driver ? this._driver.minimize(pid) : false; },
    close(pid) { return this._driver ? this._driver.close(pid) : false; },
  };

  /* Stubs para que el IPC no crashee si las apps los llaman */
  const SystemRegistry = {
    _reg: new Map(),
    register(key, val) { this._reg.set(key, val); EventBus.emit('registry:register', { key }); },
    get(key) { return this._reg.get(key); },
    list() { return [...this._reg.entries()]; },
    unregister(key) { this._reg.delete(key); }
  };

  const Scheduler = {
    _tasks: new Map(),
    addTask(id, fn, interval) { this._tasks.set(id, setInterval(fn, interval)); EventBus.emit('scheduler:taskAdded', { id }); },
    removeTask(id) { clearInterval(this._tasks.get(id)); this._tasks.delete(id); EventBus.emit('scheduler:taskRemoved', { id }); }
  };

  const Kernel = {
  version : KERNEL_VERSION,
  build   : {
    version: KERNEL_VERSION,
    dbVersion: DB_VERSION,
    fsHierarchyVersion: FS_HIERARCHY_VERSION,
    buildId: BUILD_ID,
  },

    on   : EventBus.on.bind(EventBus),
    once : EventBus.once.bind(EventBus),
    emit : EventBus.emit.bind(EventBus),

    db          : DB,
    fs          : FS,
    prefs       : Prefs,
    env         : Env,
    users       : Users,
    apps        : Apps,
    procs       : Procs,
    crash       : CrashReporter,
extensions  : ExtensionManager,
    bindings    : AppBinding,
    icons       : Icons,
    permissions : Permissions,
    security    : Security,
    notifications: Notifications,
    clipboard   : Clipboard,
    modules     : ModuleLoader,
    windows       : Windows,
    systemRegistry: SystemRegistry,
    scheduler     : Scheduler,

    STORES,

    boot,
    repair: CriticalFailure,
    openFile: AppBinding.openFile.bind(AppBinding),

get isReady() {
      return _db !== null;
    },

    get bootComplete() {
      return _bootComplete;
    },

get safeMode() {
  return _safeModeThisBoot;
},

    get uptime() {
      return Date.now() - _bootStartedAt;
    },

    get uptimeSeconds() {
      return Math.floor((Date.now() - _bootStartedAt) / 1000);
    },

    get session() {
      return { ..._session };
    },
  };

  global.Kernel = Kernel;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Kernel.boot());
  } else {
    Kernel.boot();
  }

})(window);