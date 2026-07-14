;(function (global) {
  'use strict';

  /* ═══════════════════════════════════════════════════
     CONSTANTES
  ═══════════════════════════════════════════════════ */
  const DB_NAME    = 'huebos_db';
  const DB_VERSION = 3;           // v0.3.0: añade binary_blobs
  const KERNEL_VERSION = '0.4.0'; // v0.4.0: UEFI + Env + Users + Safe Mode

  const STORES = {
    FS           : 'fs',
    PREFS        : 'prefs',
    SOCIAL       : 'social',
    APPS_META    : 'apps_meta',
    CRASHES      : 'crashes',        // Alpha 1.0
    BINARY_BLOBS : 'binary_blobs',   // v0.3.0
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
     MIGRATION SYSTEM                          [Alpha 1.0]
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

  };  // ← ESTE ERA EL CIERRE QUE FALTABA

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

      const parts = p.split('/').filter(Boolean);
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
      // (evita que un archivo reemplace una carpeta, o viceversa, dejando huérfanos)
      const finalTarget = await DB.get(STORES.FS, target);
      if (finalTarget && finalTarget.type !== node.type) {
        throw new Error(`FS.move: ya existe '${target}' y es de tipo distinto (${finalTarget.type})`);
      }

      // El directorio padre del destino debe existir de verdad, no se crea solo
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
      }

      EventBus.emit('fs:move', { src: source, dst: target });
      console.debug(`[Kernel:fs] move ${source} → ${target}`);
    },

    async exists(path) {
      return (await DB.get(STORES.FS, this._normalize(path))) !== null;
    },

    /* ── FS Binario (v0.3.0) ── */

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

  /* ═══════════════════════════════════════════════════
     VARIABLES DE ENTORNO  (v0.4.0 — Env)
     Persistidas en prefs con prefijo "env.".
  ═══════════════════════════════════════════════════ */
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

  /* ═══════════════════════════════════════════════════
     GESTIÓN DE USUARIOS  (v0.4.0 — Users)
     Multiusuario simple: un usuario activo, datos en prefs.
  ═══════════════════════════════════════════════════ */
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
        password: opts.password || '',
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
      if (effectivePwd && effectivePwd !== password) {
        throw new Error('Users.login: contraseña incorrecta');
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
      list[idx].password = newPassword || '';
      await Prefs.set('users.list', list);
      await Prefs.set('security.password', newPassword || '');
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

  /* ═══════════════════════════════════════════════════
     ADMINISTRADOR DE PROCESOS  (v0.3.0)
  ═══════════════════════════════════════════════════ */
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

      kill(pid) {
        const proc = _table[pid];
        if (!proc) {
          console.warn(`[Kernel:procs] kill: pid=${pid} no encontrado`);
          return false;
        }

        for (const childPid of [...proc.children]) {
          this.kill(childPid);
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

  /* ═══════════════════════════════════════════════════
     WATCHDOG                                  [Alpha 1.0]
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
     CRASH REPORTER                            [Alpha 1.0]
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
        kernelVersion: '0.3.0',
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
     SESSION TRACKER                           [Alpha 1.0]
  ═══════════════════════════════════════════════════ */
  let _bootStartedAt = Date.now();
  let _safeModeThisBoot = false;

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

    const binaryBlobs = [];
    for (const rec of blobRecords) {
      try {
        const base64 = await _blobToBase64(rec.data);
        binaryBlobs.push({ id: rec.id, mtime: rec.mtime, base64 });
      } catch (err) {
        console.error(`[Kernel:fs] no se pudo respaldar el blob '${rec.id}':`, err);
      }
    }

    const snapshot = {
      exportedAt: new Date().toISOString(),
      reason: 'fs.hierarchyVersion mismatch — backup automático antes de limpiar',
      fs: fsRecords,
      binaryBlobs,
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
    console.warn(`[Kernel:fs] backup descargado antes de reinicializar (${fsRecords.length} nodos, ${binaryBlobs.length} binarios)`);
  } catch (err) {
    console.error('[Kernel:fs] no se pudo generar el backup antes de reinicializar:', err);
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
  await _backupBeforeWipe();
  await DB.clear(STORES.FS);
  await DB.clear(STORES.PREFS);
  await DB.clear(STORES.APPS_META);
  await DB.clear(STORES.CRASHES);
  await DB.clear(STORES.BINARY_BLOBS);
  await Prefs.set('fs.hierarchyVersion', FS_HIERARCHY_VERSION);
  await Prefs.set('boot.firstRun', true);
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

    await ensureFile('/system/index.sys', '<!-- sistema index -->', true, { protected: true, systemApp: true });
    await ensureFile('/system/shell.sys', '<!-- sistema shell -->', true, { protected: true, systemApp: true });

    try {
      await FS.write('/home/docs/readme.txt', [
        '╔══════════════════════════════════════════╗',
        '║         H U E B O S  —  v0.3.0          ║',
        '║              Alpha 2.0                   ║',
        '╚══════════════════════════════════════════╝',
        '',
        'Bienvenido a HUEBOS.',
        '',
        'Este es tu espacio de trabajo personal.',
        'Todos los archivos se almacenan localmente',
        'en tu navegador mediante IndexedDB.',
        '',
        'Novedades v0.3.0:',
        '  - FS binario: Blob/ArrayBuffer (imágenes, audio)',
        '  - Árbol de procesos parent/child real',
        '  - Terminal integrada nativa en el shell',
        '',
        'Directorios disponibles:',
        '  /home        → tu espacio personal',
        '  /home/docs   → documentos',
        '  /home/media  → imágenes y media (binarios)',
        '  /home/downloads → descargas',
        `  ${DESKTOP_DIR} → escritorio real del sistema`,
        `  ${SYSTEM_DIR} → sistema protegido`,
        `  ${TEMP_DIR} → archivos temporales`,
        '',
        'Kernel version : 0.4.0 (UEFI Firmware)',
        `Boot time      : ${new Date().toISOString()}`,
      ].join('\n'));
      console.info('[Kernel:boot] FS inicial creado');
    } catch (err) {
      console.warn('[Kernel:repair] no se pudo restaurar el contenido base:', err.message);
    }

    if (repaired.length) {
      console.info(`[Kernel:repair] estructura restaurada: ${repaired.join(', ')}`);
    }
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

      const res = await fetch('./apps/index.json');
      if (!res.ok) throw new Error('No se encontró apps/index.json');

      const { apps: appFiles } = await res.json();
      console.info(`[Kernel:apps] ${appFiles.length} app(s) en índice`);

      for (const file of appFiles) {
        try {
          const htmlRes = await fetch(`./apps/${file}`);
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
      const textExtensions = ['.txt', '.md', '.js', '.ts', '.html', '.css', '.json', '.csv', '.log', '.sh', '.py', '.xml', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.env'];
      const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
      const mediaExtensions = ['.mp3', '.mp4', '.wav', '.ogg'];
      const archiveExtensions = ['.zip', '.tar', '.gz', '.7z'];
      const docExtensions = ['.pdf'];

      for (const ext of textExtensions) AppBinding.registerExtension(ext, preferredEditor, 'text/plain');
      for (const ext of imageExtensions) AppBinding.registerExtension(ext, preferredEditor, 'image/*');
      for (const ext of mediaExtensions) AppBinding.registerExtension(ext, preferredEditor, 'audio/*');
      for (const ext of archiveExtensions) AppBinding.registerExtension(ext, 'files', 'application/zip');
      for (const ext of docExtensions) AppBinding.registerExtension(ext, 'files', 'application/pdf');

      if (!AppBinding._fieldBindings.has('editor')) {
        AppBinding.bindFileField('editor', preferredEditor);
      }
      console.info(`[Kernel:extensions] ${textExtensions.length + imageExtensions.length + mediaExtensions.length + archiveExtensions.length + docExtensions.length} extensiones registradas`);
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
      } else {
        EventBus.emit('boot:step', { step: 'apps', label: 'Safe Mode: apps omitidas…', detail: 'skipped (safe-mode)' });
        /* En safe mode solo hidratamos el registro existente, sin re-crear atajos */
        await Apps._hydrate();
      }

    const _isFirstRun = !!(await Prefs.get('boot.firstRun', false));
    _session.firstRun = _isFirstRun;
    await Prefs.set('boot.firstRun', false);

    Watchdog.clearAll();

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
  const Kernel = {
    version : KERNEL_VERSION,

    on   : EventBus.on.bind(EventBus),
    once : EventBus.once.bind(EventBus),
    emit : EventBus.emit.bind(EventBus),

    db         : DB,
    fs         : FS,
    prefs      : Prefs,
    env        : Env,
    users      : Users,
    apps       : Apps,
    procs      : Procs,
    crash      : CrashReporter,
    extensions : ExtensionManager,
    bindings   : AppBinding,

    STORES,

    boot,
    repair: CriticalFailure,
    openFile: AppBinding.openFile.bind(AppBinding),

    get isReady() {
      return _db !== null;
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