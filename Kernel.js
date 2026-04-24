/**
 * ╔══════════════════════════════════════════════════════╗
 * ║               W E B O S  —  K E R N E L             ║
 * ║              kernel.js  ·  FASE 1 · v0.1.0          ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Responsabilidades:
 *   - IndexedDB (stores: fs, prefs, social, apps_meta)
 *   - Kernel.db.*   → acceso raw a stores
 *   - Kernel.fs.*   → abstracción de sistema de archivos
 *   - Kernel.on/emit → event bus interno
 *   - Kernel.apps   → registro de aplicaciones
 *   - Kernel.procs  → administrador de procesos (stub)
 *   - Boot sequence → emite 'ready' al terminar
 */

;(function (global) {
  'use strict';

  /* ═══════════════════════════════════════════════════
     CONSTANTES
  ═══════════════════════════════════════════════════ */
  const DB_NAME    = 'webos_db';
  const DB_VERSION = 1;

  const STORES = {
    FS        : 'fs',
    PREFS     : 'prefs',
    SOCIAL    : 'social',
    APPS_META : 'apps_meta',
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
     * @returns {Function} unsub – llama para desuscribir
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
    /** Abre / inicializa la base de datos. */
    open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          Object.values(STORES).forEach(name => {
            if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name, { keyPath: 'id' });
              console.info(`[Kernel:db] store creado: ${name}`);
            }
          });
        };

        req.onsuccess = (e) => {
          _db = e.target.result;
          console.info('[Kernel:db] IndexedDB lista');
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
     * @param {Object} record  – debe incluir { id, ...data }
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
      // Elimina slashes dobles y trailing slash (excepto root '/')
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

      // Asegurar que el padre exista
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

      // Asegurar que el directorio padre exista
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
      const { content, ...stat } = node; // no exponer contenido en stat
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
     * @param {boolean} [opts.recursive=false]  si true, elimina recursivamente
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

      // Si es directorio, mover todos los hijos
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
    _registry: {},   // cache en memoria

    /**
     * Registra (o actualiza) una aplicación.
     * @param {Object} manifest
     * @returns {Promise<void>}
     */
    async register(manifest) {
      if (!manifest.id) throw new Error('Apps.register: manifest debe tener id');
      const record = {
        ...manifest,
        registeredAt: Date.now(),
      };
      this._registry[manifest.id] = record;
      await DB.put(STORES.APPS_META, record);
      EventBus.emit('apps:registered', { id: manifest.id });
      console.debug(`[Kernel:apps] registrada: ${manifest.id}`);
    },

    /**
     * Obtiene el manifest de una app.
     * @param {string} id
     * @returns {Promise<Object|null>}
     */
    async get(id) {
      if (this._registry[id]) return this._registry[id];
      const record = await DB.get(STORES.APPS_META, id);
      if (record) this._registry[id] = record;
      return record;
    },

    /**
     * Lista todas las apps registradas.
     * @returns {Promise<Array<Object>>}
     */
    async list() {
      return DB.list(STORES.APPS_META);
    },

    /**
     * Desregistra una app.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async unregister(id) {
      delete this._registry[id];
      await DB.delete(STORES.APPS_META, id);
      EventBus.emit('apps:unregistered', { id });
    },

    /** Carga el registry desde DB al cache en memoria. */
    async _hydrate() {
      const all = await DB.list(STORES.APPS_META);
      all.forEach(app => { this._registry[app.id] = app; });
    },
  };

  /* ═══════════════════════════════════════════════════
     ADMINISTRADOR DE PROCESOS  (stub)
  ═══════════════════════════════════════════════════ */

  /**
   * Esquema de un proceso:
   * {
   *   pid    : number
   *   appId  : string
   *   title  : string
   *   state  : 'running' | 'suspended' | 'zombie'
   *   window : null | HTMLElement   (lo gestionará el WM en fases futuras)
   *   spawnedAt: number
   * }
   */

  const Procs = (() => {
    let _nextPid = 1;
    const _table = {};   // { [pid]: process }

    return {
      /**
       * Lanza (registra) un proceso.
       * @param {string} appId
       * @param {Object} [opts]
       * @returns {Object} proceso creado
       */
      spawn(appId, opts = {}) {
        const pid = _nextPid++;
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

      /**
       * Termina un proceso.
       * @param {number} pid
       */
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

      /**
       * Suspende un proceso.
       * @param {number} pid
       */
      suspend(pid) {
        if (_table[pid]) {
          _table[pid].state = 'suspended';
          EventBus.emit('procs:suspend', { pid });
        }
      },

      /**
       * Reanuda un proceso suspendido.
       * @param {number} pid
       */
      resume(pid) {
        if (_table[pid]) {
          _table[pid].state = 'running';
          EventBus.emit('procs:resume', { pid });
        }
      },

      /**
       * Lista todos los procesos activos.
       * @returns {Array<Object>}
       */
      list() {
        return Object.values(_table);
      },

      /**
       * Obtiene un proceso por PID.
       * @param {number} pid
       * @returns {Object|undefined}
       */
      get(pid) {
        return _table[pid];
      },

      /** Cuenta de procesos activos. */
      get count() { return Object.keys(_table).length; },
    };
  })();

  /* ═══════════════════════════════════════════════════
     BOOT SEQUENCE
  ═══════════════════════════════════════════════════ */

  /**
   * Inicializa el sistema de archivos mínimo si es la primera vez.
   */
  async function _bootstrapFS() {
    // Crear directorios base
    await FS.mkdir('/');
    await FS.mkdir('/home');
    await FS.mkdir('/home/docs');
    await FS.mkdir('/home/apps');
    await FS.mkdir('/home/media');
    await FS.mkdir('/tmp');
    await FS.mkdir('/sys');

    // Archivo de bienvenida
    const alreadyBooted = await FS.exists('/home/docs/readme.txt');
    if (!alreadyBooted) {
      await FS.write('/home/docs/readme.txt', [
        '╔══════════════════════════════════════════╗',
        '║         W E B O S  —  v0.1.0            ║',
        '╚══════════════════════════════════════════╝',
        '',
        'Bienvenido a WebOS.',
        '',
        'Este es tu espacio de trabajo personal.',
        'Todos los archivos se almacenan localmente',
        'en tu navegador mediante IndexedDB.',
        '',
        'Directorios disponibles:',
        '  /home       → tu espacio personal',
        '  /home/docs  → documentos',
        '  /home/apps  → datos de aplicaciones',
        '  /home/media → imágenes y media',
        '  /tmp        → archivos temporales',
        '  /sys        → configuración del sistema',
        '',
        'Kernel version: 0.1.0',
        `Boot time: ${new Date().toISOString()}`,
      ].join('\n'));
      console.info('[Kernel:boot] FS inicial creado');
    }
  }

  /**
   * Escribe las preferencias por defecto si no existen.
   */
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

  /**
   * Registra las apps del sistema.
   */
async function _bootstrapApps() {
    try {
      const existingApps = await Apps.list();
      for (const app of existingApps) {
        await Apps.unregister(app.id);
      }

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
          const entry = `./apps/${file}`;

          // Construir el objeto de registro normalizado
          const record = {
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

  /**
   * Secuencia principal de arranque.
   * Exporta Kernel al global antes de terminar.
   */
  async function boot() {
    console.group('[Kernel] ══ BOOT SEQUENCE ══');

    try {
      // 1. Abrir base de datos
      EventBus.emit('boot:step', { step: 'db', label: 'Iniciando IndexedDB…' });
      await DB.open();

      // 2. Bootstrap FS
      EventBus.emit('boot:step', { step: 'fs', label: 'Montando sistema de archivos…' });
      await _bootstrapFS();

      // 3. Preferencias
      EventBus.emit('boot:step', { step: 'prefs', label: 'Cargando preferencias…' });
      await _bootstrapPrefs();

      // 4. Apps
      EventBus.emit('boot:step', { step: 'apps', label: 'Registrando aplicaciones…' });
      await Apps._hydrate();
      await _bootstrapApps();

      // 5. Marcar primer boot hecho
      await Prefs.set('boot.firstRun', false);
      await Prefs.set('boot.lastBoot', Date.now());

      console.groupEnd();
      console.info('[Kernel] ✓ Sistema listo');

      // 6. Señal de sistema listo
      EventBus.emit('boot:step', { step: 'ready', label: 'Sistema listo.' });
      EventBus.emit('ready', { ts: Date.now(), version: '0.1.0' });

    } catch (err) {
      console.groupEnd();
      console.error('[Kernel] ✗ Fallo en el boot:', err);
      EventBus.emit('boot:error', { error: err.message });
      throw err;
    }
  }

  /* ═══════════════════════════════════════════════════
     API PÚBLICA  — global.Kernel
  ═══════════════════════════════════════════════════ */

  const Kernel = {
    version : '0.1.0',

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

    // Stores disponibles (para acceso externo)
    STORES,

    /** Arranca el kernel. Devuelve Promise. */
    boot,

    /** Devuelve true si el kernel ya está listo. */
    get isReady() {
      return _db !== null;
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