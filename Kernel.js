/**
 * ╔══════════════════════════════════════════════════════╗
 * ║               W E B O S  —  K E R N E L             ║
 * ║           Kernel.js  ·  ALPHA 1.0 · v0.2.0          ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Responsabilidades:
 *   - IndexedDB (stores: fs, prefs, social, apps_meta, crashes)
 *   - Kernel.db.*      → acceso raw a stores
 *   - Kernel.fs.*      → abstracción de sistema de archivos
 *   - Kernel.on/emit   → event bus interno
 *   - Kernel.apps      → registro de aplicaciones
 *   - Kernel.procs     → administrador de procesos (stub)
 *   - Kernel.crash.*   → crash reporter                [Alpha 1.0]
 *   - Kernel.uptime    → ms desde el boot              [Alpha 1.0]
 *   - Kernel.session   → info de sesión actual          [Alpha 1.0]
 *   - Boot sequence    → emite 'ready' al terminar
 *   - Migration system → onupgradeneeded por versión   [Alpha 1.0]
 *   - Watchdog         → detecta boots fallidos         [Alpha 1.0]
 *
 * Changelog Alpha 1.0:
 *   - DB_VERSION 1 → 2  (añade store 'crashes')
 *   - Sistema de migraciones por versión de DB
 *   - Watchdog de boot con detección de fallo previo
 *   - CrashReporter: captura window:error + unhandledrejection
 *   - Session tracker: uptime real, sessionCount, sessionId
 */

;(function (global) {
  'use strict';

  /* ═══════════════════════════════════════════════════
     CONSTANTES
  ═══════════════════════════════════════════════════ */
  const DB_NAME    = 'webos_db';
  const DB_VERSION = 2;           // Alpha 1.0: era 1

  const STORES = {
    FS        : 'fs',
    PREFS     : 'prefs',
    SOCIAL    : 'social',
    APPS_META : 'apps_meta',
    CRASHES   : 'crashes',        // Alpha 1.0
  };

  /* ═══════════════════════════════════════════════════
     MIGRATION SYSTEM                          [Alpha 1.0]
     Cada clave es la versión destino.
     La función recibe (db, transaction) y aplica
     los cambios de schema necesarios para llegar
     a esa versión desde la anterior.
  ═══════════════════════════════════════════════════ */
  const MIGRATIONS = {

    /**
     * v1 → v2: Añade el store 'crashes'.
     * El store 'fs', 'prefs', 'social' y 'apps_meta'
     * ya existen desde v1 y no requieren cambios.
     */
    2: (db /*, tx */) => {
      if (!db.objectStoreNames.contains(STORES.CRASHES)) {
        db.createObjectStore(STORES.CRASHES, { keyPath: 'id' });
        console.info('[Kernel:db] migración v2: store "crashes" creado');
      }
    },

    /**
     * Plantilla para futuras migraciones.
     * Descomenta y ajusta cuando se necesite:
     *
     * 3: (db, tx) => {
     *   // Ejemplo: añadir índice al store 'fs' por campo 'parent'
     *   if (!db.objectStoreNames.contains('sessions')) {
     *     db.createObjectStore('sessions', { keyPath: 'id' });
     *   }
     * },
     */
  };

  /* ═══════════════════════════════════════════════════
     EVENT BUS
  ═══════════════════════════════════════════════════ */
  const _listeners = {};

  const EventBus = {
    /**
     * Suscribe un handler a un evento.
     * @param {string}   event
     * @param {Function} handler
     * @returns {Function} unsub — llama para desuscribir
     */
    on(event, handler) {
      if (!_listeners[event]) _listeners[event] = [];
      _listeners[event].push(handler);
      return () => {
        _listeners[event] = _listeners[event].filter(h => h !== handler);
      };
    },

    /**
     * Emite un evento con payload opcional.
     * @param {string} event
     * @param {*}      payload
     */
    emit(event, payload) {
      const now = Date.now();
      console.debug(`[Kernel:emit] ${event}`, payload ?? '');
      (_listeners[event] || []).forEach(h => {
        try { h(payload, now); }
        catch (err) { console.error(`[Kernel:emit] handler error on "${event}"`, err); }
      });
    },

    /** Suscribe handler que se ejecuta sólo una vez. */
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
    /** Abre / inicializa la base de datos y aplica migraciones. */
    open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (e) => {
          const db         = e.target.result;
          const oldVersion = e.oldVersion;   // 0 en instalación limpia

          // 1. Crear stores base que no existan (instalación limpia o stores nuevos)
          Object.values(STORES).forEach(name => {
            if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name, { keyPath: 'id' });
              console.info(`[Kernel:db] store creado: ${name}`);
            }
          });

          // 2. Ejecutar migraciones desde oldVersion + 1 hasta DB_VERSION
          for (let v = oldVersion + 1; v <= DB_VERSION; v++) {
            if (MIGRATIONS[v]) {
              try {
                MIGRATIONS[v](db, e.target.transaction);
                console.info(`[Kernel:db] ✓ migración v${v} aplicada`);
              } catch (migErr) {
                console.error(`[Kernel:db] ✗ migración v${v} falló:`, migErr);
                // No rechazamos: preferimos un sistema arriba con un store faltante
                // a un sistema que no arranca. El CrashReporter lo registrará luego.
              }
            }
          }
        };

        req.onsuccess = (e) => {
          _db = e.target.result;
          console.info(`[Kernel:db] IndexedDB lista (v${DB_VERSION})`);
          resolve(_db);
        };

        req.onerror = (e) => {
          console.error('[Kernel:db] Error al abrir IndexedDB', e.target.error);
          reject(e.target.error);
        };
      });
    },

    /**
     * Lee un registro de un store.
     * @param {string} store
     * @param {string} id
     * @returns {Promise<*>}
     */
    get(store, id) {
      return new Promise((resolve, reject) => {
        const tx  = _db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(id);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror   = () => reject(req.error);
      });
    },

    /**
     * Escribe (put) un registro. El objeto debe tener `id`.
     * @param {string} store
     * @param {Object} record — debe incluir { id, ...data }
     * @returns {Promise<void>}
     */
    put(store, record) {
      return new Promise((resolve, reject) => {
        const tx  = _db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).put(record);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });
    },

    /**
     * Elimina un registro.
     * @param {string} store
     * @param {string} id
     * @returns {Promise<void>}
     */
    delete(store, id) {
      return new Promise((resolve, reject) => {
        const tx  = _db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).delete(id);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });
    },

    /**
     * Lista todos los registros de un store.
     * @param {string} store
     * @returns {Promise<Array>}
     */
    list(store) {
      return new Promise((resolve, reject) => {
        const tx      = _db.transaction(store, 'readonly');
        const req     = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    },

    /**
     * Lista todos los IDs (keys) de un store.
     * @param {string} store
     * @returns {Promise<Array<string>>}
     */
    keys(store) {
      return new Promise((resolve, reject) => {
        const tx      = _db.transaction(store, 'readonly');
        const req     = tx.objectStore(store).getAllKeys();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    },

    /**
     * Limpia todos los registros de un store.
     * @param {string} store
     * @returns {Promise<void>}
     */
    clear(store) {
      return new Promise((resolve, reject) => {
        const tx  = _db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).clear();
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });
    },

    /**
     * Cierra la conexión activa con IndexedDB.
     * Necesario antes de llamar indexedDB.deleteDatabase() para evitar
     * que la solicitud quede bloqueada (onblocked) indefinidamente.
     */
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

  /**
   * Esquema de un nodo FS:
   * {
   *   id       : string  (path normalizado, ej. '/home/docs/readme.txt')
   *   type     : 'dir' | 'file'
   *   name     : string  (componente final del path)
   *   parent   : string  (path del directorio padre, '' para root)
   *   content  : string  (sólo si type === 'file')
   *   ctime    : number  (timestamp creación)
   *   mtime    : number  (timestamp última modificación)
   *   size     : number  (bytes de content o 0 si dir)
   *   meta     : Object  (campo libre para extensiones)
   * }
   */

  const FS = {
    /* ── helpers internos ── */

    _normalize(path) {
      let p = path.replace(/\/+/g, '/');
      if (p !== '/' && p.endsWith('/')) p = p.slice(0, -1);
      return p;
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

    /* ── API pública ── */

    /**
     * Crea un directorio (y sus padres si no existen).
     * @param {string} path
     * @returns {Promise<Object>} nodo creado
     */
    async mkdir(path) {
      path = this._normalize(path);
      const existing = await DB.get(STORES.FS, path);
      if (existing) {
        if (existing.type === 'dir') return existing;
        throw new Error(`FS.mkdir: existe un archivo en '${path}'`);
      }

      const parent = this._dirname(path);
      if (parent && parent !== path) {
        await this.mkdir(parent);
      }

      const now  = Date.now();
      const node = {
        id      : path,
        type    : 'dir',
        name    : this._basename(path) || '/',
        parent  : parent,
        content : null,
        ctime   : now,
        mtime   : now,
        size    : 0,
        meta    : {},
      };
      await DB.put(STORES.FS, node);
      EventBus.emit('fs:mkdir', { path });
      console.debug(`[Kernel:fs] mkdir ${path}`);
      return node;
    },

    /**
     * Escribe un archivo (lo crea o sobreescribe).
     * @param {string} path
     * @param {string} content
     * @returns {Promise<Object>} nodo
     */
    async write(path, content = '') {
      path = this._normalize(path);
      const parent = this._dirname(path);

      if (parent) await this.mkdir(parent);

      const existing = await DB.get(STORES.FS, path);
      const now      = Date.now();
      const node     = {
        id      : path,
        type    : 'file',
        name    : this._basename(path),
        parent  : parent,
        content : content,
        ctime   : existing ? existing.ctime : now,
        mtime   : now,
        size    : new Blob([content]).size,
        meta    : existing?.meta ?? {},
      };
      await DB.put(STORES.FS, node);
      EventBus.emit('fs:write', { path, size: node.size });
      console.debug(`[Kernel:fs] write ${path} (${node.size}B)`);
      return node;
    },

    /**
     * Lee el contenido de un archivo.
     * @param {string} path
     * @returns {Promise<string>}
     */
    async read(path) {
      path = this._normalize(path);
      const node = await DB.get(STORES.FS, path);
      if (!node)              throw new Error(`FS.read: '${path}' no existe`);
      if (node.type !== 'file') throw new Error(`FS.read: '${path}' es un directorio`);
      return node.content ?? '';
    },

    /**
     * Stat de un nodo (sin devolver contenido para archivos grandes).
     * @param {string} path
     * @returns {Promise<Object|null>}
     */
    async stat(path) {
      path = this._normalize(path);
      const node = await DB.get(STORES.FS, path);
      if (!node) return null;
      const { content, ...stat } = node;
      return stat;
    },

    /**
     * Lista el contenido de un directorio.
     * @param {string} path
     * @returns {Promise<Array<Object>>}  array de stats de hijos
     */
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

    /**
     * Elimina un archivo o directorio vacío.
     * @param {string} path
     * @param {Object} [opts]
     * @param {boolean} [opts.recursive=false]
     * @returns {Promise<void>}
     */
    async remove(path, { recursive = false } = {}) {
      path = this._normalize(path);
      const node = await DB.get(STORES.FS, path);
      if (!node) throw new Error(`FS.remove: '${path}' no existe`);

      if (node.type === 'dir' && !recursive) {
        const children = await this.readdir(path);
        if (children.length > 0)
          throw new Error(`FS.remove: directorio '${path}' no está vacío (usa recursive)`);
      }

      if (node.type === 'dir' && recursive) {
        const all = await DB.list(STORES.FS);
        const descendants = all
          .filter(n => n.id.startsWith(path + '/') || n.id === path)
          .map(n => n.id);
        for (const id of descendants) await DB.delete(STORES.FS, id);
      } else {
        await DB.delete(STORES.FS, path);
      }

      EventBus.emit('fs:remove', { path });
      console.debug(`[Kernel:fs] remove ${path}`);
    },

    /**
     * Mueve / renombra un nodo.
     * @param {string} src
     * @param {string} dst
     * @returns {Promise<void>}
     */
    async move(src, dst) {
      src = this._normalize(src);
      dst = this._normalize(dst);
      const node = await DB.get(STORES.FS, src);
      if (!node) throw new Error(`FS.move: '${src}' no existe`);

      if (node.type === 'dir') {
        const all = await DB.list(STORES.FS);
        const affected = all.filter(n => n.id === src || n.id.startsWith(src + '/'));
        for (const n of affected) {
          const newId = dst + n.id.slice(src.length);
          await DB.delete(STORES.FS, n.id);
          await DB.put(STORES.FS, {
            ...n,
            id     : newId,
            name   : newId === dst ? this._basename(dst) : n.name,
            parent : this._dirname(newId),
            mtime  : Date.now(),
          });
        }
      } else {
        await DB.delete(STORES.FS, src);
        await DB.put(STORES.FS, {
          ...node,
          id     : dst,
          name   : this._basename(dst),
          parent : this._dirname(dst),
          mtime  : Date.now(),
        });
      }

      EventBus.emit('fs:move', { src, dst });
      console.debug(`[Kernel:fs] move ${src} → ${dst}`);
    },

    /**
     * Verifica si existe un path.
     * @param {string} path
     * @returns {Promise<boolean>}
     */
    async exists(path) {
      return (await DB.get(STORES.FS, this._normalize(path))) !== null;
    },
  };

  /* ═══════════════════════════════════════════════════
     PREFERENCIAS DEL SISTEMA
  ═══════════════════════════════════════════════════ */

  const Prefs = {
    /**
     * Lee una preferencia. Devuelve defaultValue si no existe.
     * @param {string} key
     * @param {*}      defaultValue
     * @returns {Promise<*>}
     */
    async get(key, defaultValue = null) {
      const record = await DB.get(STORES.PREFS, key);
      return record !== null ? record.value : defaultValue;
    },

    /**
     * Escribe una preferencia.
     * @param {string} key
     * @param {*}      value
     * @returns {Promise<void>}
     */
    async set(key, value) {
      await DB.put(STORES.PREFS, { id: key, value, mtime: Date.now() });
      EventBus.emit('prefs:change', { key, value });
    },

    /**
     * Elimina una preferencia.
     * @param {string} key
     * @returns {Promise<void>}
     */
    async delete(key) {
      await DB.delete(STORES.PREFS, key);
      EventBus.emit('prefs:delete', { key });
    },

    /**
     * Devuelve todas las preferencias como objeto plano.
     * @returns {Promise<Object>}
     */
    async all() {
      const records = await DB.list(STORES.PREFS);
      return Object.fromEntries(records.map(r => [r.id, r.value]));
    },
  };

  /* ═══════════════════════════════════════════════════
     REGISTRO DE APLICACIONES
  ═══════════════════════════════════════════════════ */

  /**
   * Esquema de una app registrada:
   * {
   *   id       : string   (slug único, ej. 'text-editor')
   *   name     : string   (nombre display)
   *   version  : string
   *   entry    : string   (URL o path del HTML de la app)
   *   icon     : string   (emoji o URL)
   *   category : string   ('system' | 'utility' | 'media' | 'social' | ...)
   *   singleton: boolean  (sólo una instancia permitida)
   *   meta     : Object
   * }
   */

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
     ADMINISTRADOR DE PROCESOS  (stub)
  ═══════════════════════════════════════════════════ */

  const Procs = (() => {
    let _nextPid = 1;
    const _table = {};

    return {
      spawn(appId, opts = {}) {
        const pid  = _nextPid++;
        const proc = {
          pid,
          appId,
          title     : opts.title || appId,
          state     : 'running',
          window    : null,
          spawnedAt : Date.now(),
          ...opts,
        };
        _table[pid] = proc;
        EventBus.emit('procs:spawn', { pid, appId });
        console.debug(`[Kernel:procs] spawn pid=${pid} app=${appId}`);
        return proc;
      },

      kill(pid) {
        const proc = _table[pid];
        if (!proc) {
          console.warn(`[Kernel:procs] kill: pid=${pid} no encontrado`);
          return;
        }
        proc.state = 'zombie';
        delete _table[pid];
        EventBus.emit('procs:kill', { pid });
        console.debug(`[Kernel:procs] kill pid=${pid}`);
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

      list() {
        return Object.values(_table);
      },

      get(pid) {
        return _table[pid];
      },

      get count() { return Object.keys(_table).length; },
    };
  })();

  /* ═══════════════════════════════════════════════════
     WATCHDOG                                  [Alpha 1.0]
     Detecta si el boot anterior falló a mitad.
     Usa sessionStorage (síncrono, disponible antes de
     que IndexedDB esté abierto, se limpia entre sesiones
     de navegador — comportamiento correcto para un watchdog).
  ═══════════════════════════════════════════════════ */

  const Watchdog = (() => {
    const SS_KEY = 'wos_boot_state';

    function _read() {
      try { return JSON.parse(sessionStorage.getItem(SS_KEY) || 'null'); }
      catch { return null; }
    }

    function _write(obj) {
      try { sessionStorage.setItem(SS_KEY, JSON.stringify(obj)); }
      catch { /* sessionStorage lleno o bloqueado: continuar sin watchdog */ }
    }

    return {
      /**
       * Llama al inicio del boot, antes de abrir la DB.
       * Si el boot anterior quedó marcado como 'started' en algún
       * paso, significa que terminó de forma anormal.
       * @returns {{ recovered: boolean, failedStep: string|null }}
       */
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

      /**
       * Marca el inicio de un paso de boot.
       * Si el proceso muere aquí, checkPreviousBoot lo detectará.
       * @param {string} step  identificador del paso (ej. 'db', 'fs', 'apps')
       */
      markStep(step) {
        _write({ step, status: 'started', ts: Date.now() });
      },

      /**
       * Marca el paso actual como completado exitosamente.
       */
      completeStep() {
        const prev = _read();
        if (prev) _write({ ...prev, status: 'done' });
      },

      /**
       * Limpia el estado del watchdog al finalizar el boot correctamente.
       */
      clearAll() {
        try { sessionStorage.removeItem(SS_KEY); }
        catch { /* ignorar */ }
      },
    };
  })();

  /* ═══════════════════════════════════════════════════
     CRASH REPORTER                            [Alpha 1.0]
     Captura errores globales no manejados y los persiste
     en /sys/crashes/ con metadata completa.
     Máximo MAX_CRASHES reportes; los más viejos se purgan.
  ═══════════════════════════════════════════════════ */

  const CrashReporter = (() => {
    const MAX_CRASHES   = 20;
    const CRASHES_DIR   = '/sys/crashes';
    let   _installed    = false;

    /** Genera un ID único para el reporte. */
    function _uid() {
      return 'crash_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    }

    /** Persiste el reporte en FS y emite evento. */
    async function _persist(report) {
      try {
        await FS.write(`${CRASHES_DIR}/${report.id}.json`, JSON.stringify(report, null, 2));

        // Purgar reportes si superamos el límite
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
        // No podemos hacer nada si el FS tampoco funciona; al menos logueamos
        console.error('[Kernel:crash] No se pudo persistir el reporte:', writeErr);
      }
    }

    /** Construye y guarda un reporte de error. */
    function _capture(source, message, stack, extra = {}) {
      if (!_installed) return;

      const report = {
        id          : _uid(),
        ts          : Date.now(),
        source,
        message     : String(message || 'sin mensaje'),
        stack       : String(stack   || ''),
        url         : location.href,
        userAgent   : navigator.userAgent,
        kernelVersion: '0.2.0',
        ...extra,
      };

      console.error(`[Kernel:crash] ${source}: ${report.message}`);
      _persist(report);
    }

    return {
      /**
       * Instala los listeners globales de error.
       * Llamar sólo después de que el FS esté listo.
       */
      install() {
        if (_installed) return;
        _installed = true;

        // Errores síncronos no capturados
        window.addEventListener('error', (e) => {
          _capture('window:error', e.message, e.error?.stack, {
            filename : e.filename,
            lineno   : e.lineno,
            colno    : e.colno,
          });
        });

        // Promesas rechazadas sin .catch()
        window.addEventListener('unhandledrejection', (e) => {
          _capture(
            'unhandledrejection',
            e.reason?.message || String(e.reason),
            e.reason?.stack
          );
        });

        console.info('[Kernel:crash] CrashReporter instalado');
      },

      /**
       * Reporta un error manualmente desde cualquier parte del sistema.
       * @param {string} message
       * @param {Error}  [error]
       * @param {Object} [extra]
       */
      report(message, error, extra = {}) {
        _capture('manual', message, error?.stack, extra);
      },

      /**
       * Lista los reportes existentes (stats, sin contenido).
       * @returns {Promise<Array<Object>>}
       */
      async list() {
        try {
          return await FS.readdir(CRASHES_DIR);
        } catch {
          return [];
        }
      },

      /**
       * Lee el contenido completo de un reporte.
       * @param {string} id  — el campo `id` del reporte (sin extensión .json)
       * @returns {Promise<Object|null>}
       */
      async read(id) {
        try {
          const raw = await FS.read(`${CRASHES_DIR}/${id}.json`);
          return JSON.parse(raw);
        } catch {
          return null;
        }
      },

      /**
       * Borra todos los reportes de crashes.
       * @returns {Promise<void>}
       */
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
     Registra el instante real de boot y lleva cuenta
     de cuántas veces ha arrancado el sistema.
  ═══════════════════════════════════════════════════ */

  // Se inicializa al comienzo de boot(), antes de cualquier await.
  let _bootStartedAt = Date.now();

  // Info de sesión actual, se popula en _bootstrapSession().
  let _session = {
    id           : null,
    count        : 0,
    startedAt    : _bootStartedAt,
    recoveredBoot: false,
  };

  /**
   * Inicializa y persiste los datos de sesión.
   * @param {boolean} recoveredBoot
   */
  async function _bootstrapSession(recoveredBoot = false) {
    const sessionId    = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const prevCount    = await Prefs.get('boot.sessionCount', 0);
    const sessionCount = prevCount + 1;

    _session = {
      id           : sessionId,
      count        : sessionCount,
      startedAt    : _bootStartedAt,
      recoveredBoot,
    };

    await Prefs.set('boot.sessionId',    sessionId);
    await Prefs.set('boot.sessionCount', sessionCount);
    await Prefs.set('boot.startedAt',    _bootStartedAt);
    await Prefs.set('boot.lastBoot',     _bootStartedAt);

    console.info(`[Kernel:session] sesión #${sessionCount} · id=${sessionId}${recoveredBoot ? ' · RECOVERED' : ''}`);
  }

  /* ═══════════════════════════════════════════════════
     BOOT HELPERS
  ═══════════════════════════════════════════════════ */

  async function _bootstrapFS() {
    await FS.mkdir('/');
    await FS.mkdir('/home');
    await FS.mkdir('/home/docs');
    await FS.mkdir('/home/apps');
    await FS.mkdir('/home/media');
    await FS.mkdir('/tmp');
    await FS.mkdir('/sys');
    await FS.mkdir('/sys/crashes');   // Alpha 1.0: directorio para crash reports

    const alreadyBooted = await FS.exists('/home/docs/readme.txt');
    if (!alreadyBooted) {
      await FS.write('/home/docs/readme.txt', [
        '╔══════════════════════════════════════════╗',
        '║         W E B O S  —  v0.2.0            ║',
        '║              Alpha 1.0                   ║',
        '╚══════════════════════════════════════════╝',
        '',
        'Bienvenido a WebOS.',
        '',
        'Este es tu espacio de trabajo personal.',
        'Todos los archivos se almacenan localmente',
        'en tu navegador mediante IndexedDB.',
        '',
        'Directorios disponibles:',
        '  /home        → tu espacio personal',
        '  /home/docs   → documentos',
        '  /home/apps   → datos de aplicaciones',
        '  /home/media  → imágenes y media',
        '  /tmp         → archivos temporales',
        '  /sys         → configuración del sistema',
        '  /sys/crashes → reportes de errores del sistema',
        '',
        'Kernel version : 0.2.0 (Alpha 1.0)',
        `Boot time      : ${new Date().toISOString()}`,
      ].join('\n'));
      console.info('[Kernel:boot] FS inicial creado');
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

  /* ═══════════════════════════════════════════════════
     BOOT SEQUENCE
  ═══════════════════════════════════════════════════ */

  async function boot() {
    // El timestamp de boot se captura aquí, antes de cualquier await,
    // para que Kernel.uptime sea preciso desde el primer instante.
    _bootStartedAt = Date.now();

    console.group('[Kernel] ══ BOOT SEQUENCE (Alpha 1.0) ══');

    // ── Watchdog: detectar boot fallido anterior ──────────────────
    const { recovered, failedStep } = Watchdog.checkPreviousBoot();
    if (recovered) {
      console.warn(`[Kernel:boot] Recuperación detectada. Boot anterior falló en: "${failedStep}"`);
    }

    try {
      // 1. Abrir base de datos (con migraciones automáticas)
      EventBus.emit('boot:step', { step: 'db', label: 'Iniciando IndexedDB…' });
      Watchdog.markStep('db');
      await DB.open();
      Watchdog.completeStep();

      // 2. Bootstrap FS
      EventBus.emit('boot:step', { step: 'fs', label: 'Montando sistema de archivos…' });
      Watchdog.markStep('fs');
      await _bootstrapFS();
      Watchdog.completeStep();

      // 3. Crash Reporter — instalar ahora que el FS está disponible
      //    Cualquier error a partir de este punto queda registrado en /sys/crashes/
      CrashReporter.install();

      // 4. Session tracker
      EventBus.emit('boot:step', { step: 'session', label: 'Iniciando sesión…' });
      Watchdog.markStep('session');
      await _bootstrapSession(recovered);
      Watchdog.completeStep();

      // 5. Preferencias
      EventBus.emit('boot:step', { step: 'prefs', label: 'Cargando preferencias…' });
      Watchdog.markStep('prefs');
      await _bootstrapPrefs();
      Watchdog.completeStep();

      // 6. Apps
      EventBus.emit('boot:step', { step: 'apps', label: 'Registrando aplicaciones…' });
      Watchdog.markStep('apps');
      await Apps._hydrate();
      await _bootstrapApps();
      Watchdog.completeStep();

      // 7. Marcar estado del sistema
      await Prefs.set('boot.firstRun', false);

      // Boot completado sin errores: limpiar watchdog
      Watchdog.clearAll();

      console.groupEnd();
      console.info('[Kernel] ✓ Sistema listo');

      // Señal de sistema listo
      EventBus.emit('boot:step', { step: 'ready', label: 'Sistema listo.' });
      EventBus.emit('ready', {
        ts           : Date.now(),
        version      : '0.2.0',
        sessionId    : _session.id,
        sessionCount : _session.count,
        recoveredBoot: recovered,
      });

    } catch (err) {
      console.groupEnd();
      console.error('[Kernel] ✗ Fallo en el boot:', err);

      // El watchdog ya tiene el paso que falló marcado como 'started'.
      // En el próximo boot, checkPreviousBoot() lo detectará.
      // Intentar loguear el crash si el FS ya estaba operativo.
      CrashReporter.report('Boot failure: ' + err.message, err, { phase: 'boot' });

      EventBus.emit('boot:error', { error: err.message });
      throw err;
    }
  }

  /* ═══════════════════════════════════════════════════
     API PÚBLICA  — global.Kernel
  ═══════════════════════════════════════════════════ */

  const Kernel = {
    version : '0.2.0',

    // Event Bus
    on   : EventBus.on.bind(EventBus),
    once : EventBus.once.bind(EventBus),
    emit : EventBus.emit.bind(EventBus),

    // Subsistemas
    db    : DB,
    fs    : FS,
    prefs : Prefs,
    apps  : Apps,
    procs : Procs,

    // Alpha 1.0: nuevos subsistemas
    crash : CrashReporter,

    // Stores disponibles (para acceso externo)
    STORES,

    /** Arranca el kernel. Devuelve Promise. */
    boot,

    /** Devuelve true si el kernel ya está listo. */
    get isReady() {
      return _db !== null;
    },

    /**
     * Milisegundos transcurridos desde que inició el boot.
     * Valor real, no fabricado. [Alpha 1.0]
     */
    get uptime() {
      return Date.now() - _bootStartedAt;
    },

    /**
     * Segundos enteros de uptime. [Alpha 1.0]
     */
    get uptimeSeconds() {
      return Math.floor((Date.now() - _bootStartedAt) / 1000);
    },

    /**
     * Información de la sesión actual. [Alpha 1.0]
     * { id, count, startedAt, recoveredBoot }
     */
    get session() {
      return { ..._session };
    },
  };

  // Exponer globalmente
  global.Kernel = Kernel;

  // Auto-boot cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Kernel.boot());
  } else {
    Kernel.boot();
  }

})(window);