;(function (global) {
  'use strict';

  /* ═══════════════════════════════════════════════════
     CONSTANTES
  ═══════════════════════════════════════════════════ */
  const DB_NAME    = 'huebos_db';
  const DB_VERSION = 3;           // v0.3.0: añade binary_blobs

  const STORES = {
    FS           : 'fs',
    PREFS        : 'prefs',
    SOCIAL       : 'social',
    APPS_META    : 'apps_meta',
    CRASHES      : 'crashes',        // Alpha 1.0
    BINARY_BLOBS : 'binary_blobs',   // v0.3.0
  };

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
    open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

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
        for (const id of descendants) {
          await DB.delete(STORES.FS, id);
          await DB.delete(STORES.BINARY_BLOBS, id).catch(() => {});
        }
      } else {
        await DB.delete(STORES.FS, path);
        if (node.encoding === 'binary') {
          await DB.delete(STORES.BINARY_BLOBS, path).catch(() => {});
        }
      }

      EventBus.emit('fs:remove', { path });
      console.debug(`[Kernel:fs] remove ${path}`);
    },

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

    async exists(path) {
      return (await DB.get(STORES.FS, this._normalize(path))) !== null;
    },

    /* ── FS Binario (v0.3.0) ── */

    async writeBinary(path, data, mime = 'application/octet-stream') {
      path = this._normalize(path);
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
    await FS.mkdir('/sys/crashes');

    const alreadyBooted = await FS.exists('/home/docs/readme.txt');
    if (!alreadyBooted) {
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
        '  /home/apps   → datos de aplicaciones',
        '  /home/media  → imágenes y media (binarios)',
        '  /tmp         → archivos temporales',
        '  /sys         → configuración del sistema',
        '  /sys/crashes → reportes de errores del sistema',
        '',
        'Kernel version : 0.3.0 (Alpha 2.0)',
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
    _bootStartedAt = Date.now();

    console.group('[Kernel] ══ BOOT SEQUENCE (v0.3.0) ══');

    const { recovered, failedStep } = Watchdog.checkPreviousBoot();
    if (recovered) {
      console.warn(`[Kernel:boot] Recuperación detectada. Boot anterior falló en: "${failedStep}"`);
    }

    try {
      EventBus.emit('boot:step', { step: 'db', label: 'Iniciando IndexedDB…' });
      Watchdog.markStep('db');
      await DB.open();
      Watchdog.completeStep();

      EventBus.emit('boot:step', { step: 'fs', label: 'Montando sistema de archivos…' });
      Watchdog.markStep('fs');
      await _bootstrapFS();
      Watchdog.completeStep();

      CrashReporter.install();

      EventBus.emit('boot:step', { step: 'session', label: 'Iniciando sesión…' });
      Watchdog.markStep('session');
      await _bootstrapSession(recovered);
      Watchdog.completeStep();

      EventBus.emit('boot:step', { step: 'prefs', label: 'Cargando preferencias…' });
      Watchdog.markStep('prefs');
      await _bootstrapPrefs();
      Watchdog.completeStep();

      EventBus.emit('boot:step', { step: 'apps', label: 'Registrando aplicaciones…' });
      Watchdog.markStep('apps');
      await Apps._hydrate();
      await _bootstrapApps();
      Watchdog.completeStep();

      await Prefs.set('boot.firstRun', false);

      Watchdog.clearAll();

      console.groupEnd();
      console.info('[Kernel] ✓ Sistema listo');

      EventBus.emit('boot:step', { step: 'ready', label: 'Sistema listo.' });
      EventBus.emit('ready', {
        ts           : Date.now(),
        version      : '0.3.0',
        sessionId    : _session.id,
        sessionCount : _session.count,
        recoveredBoot: recovered,
      });

    } catch (err) {
      console.groupEnd();
      console.error('[Kernel] ✗ Fallo en el boot:', err);
      CrashReporter.report('Boot failure: ' + err.message, err, { phase: 'boot' });
      EventBus.emit('boot:error', { error: err.message });
      throw err;
    }
  }

  /* ═══════════════════════════════════════════════════
     API PÚBLICA  — global.Kernel
  ═══════════════════════════════════════════════════ */
  const Kernel = {
    version : '0.3.0',

    on   : EventBus.on.bind(EventBus),
    once : EventBus.once.bind(EventBus),
    emit : EventBus.emit.bind(EventBus),

    db    : DB,
    fs    : FS,
    prefs : Prefs,
    apps  : Apps,
    procs : Procs,
    crash : CrashReporter,

    STORES,

    boot,

    get isReady() {
      return _db !== null;
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