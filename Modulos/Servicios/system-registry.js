/* ═══════════════════════════════════════════════════
   SERVICIO: SYSTEM REGISTRY                  [v1.0.0]
   ═══════════════════════════════════════════════════
   Centraliza TODA la información administrativa del
   sistema en una representación estable y normalizada.

   Es un servicio EXCLUSIVAMENTE DE LECTURA:
     - No abre/cierra ventanas
     - No mata procesos
     - No reinicia módulos
     - No solicita permisos
     - No emite eventos de UI
     - No conoce el DOM

   Su única responsabilidad es construir un snapshot
   consistente del estado del sistema para que cualquier
   aplicación administrativa (Task Manager, IDE, ...)
   consuma un único contrato público en vez de tocar
   directamente los subsistemas internos del Kernel.

   Arquitectura objetivo:

        Aplicaciones (Task Manager, IDE, ...)
                       │
                       ▼
                System Registry
                       │
                       ▼
     Kernel.procs / modules / apps / windows
     Kernel.scheduler / ipc

   API expuesta como Kernel.systemRegistry:
     - list()              → todo, agrupado por type
     - listProcesses()     → solo procesos
     - listModules()       → servicios + apis + componentes
     - listServices()      → solo servicios
     - listApis()          → solo apis
     - listComponents()    → solo componentes
     - listApps()          → aplicaciones registradas
     - listWindows()       → ventanas del WM
     - listScheduler()     → tareas del scheduler
     - listIPC()           → canales IPC registrados
     - getProcess(pid)    → detalle de un proceso
     - getModule(id)      → detalle de un módulo
     - refresh()          → fuerza re-lectura (no-op por
                             ahora: todo es síncrono bajo
                             demanda, pero se mantiene el
                             método para estabilidad del
                             contrato)
   ═══════════════════════════════════════════════════ */

function registerService(Kernel) {
  /* ── Origen canónico de cada categoría ── */
  const SOURCE = {
    SERVICE   : 'Modulos/Servicios',
    API       : 'Modulos/API',
    COMPONENT : 'Modulos/Componentes',
    APP       : 'apps',
    KERNEL    : 'Kernel',
  };

  // hace unos dias, se cumplio la condicional de if (novia === true)... es... hermoso... :3

  /* ── Estados normalizados ──
     Se mapean los estados internos de cada subsistema a
     un vocabulario estable para que las apps no dependan
     de los strings exactos que usa el Kernel. */
  const STATUS = {
    ACTIVE     : 'activo',
    STOPPED    : 'detenido',
    PROTECTED  : 'protegido',
    SUSPENDED  : 'suspendido',
    UNKNOWN    : 'desconocido',
  };

  /* ── Estructura base de un item del registro ──
     Todas las categorías devuelven objetos con esta misma
     forma. Los campos que no apliquen se dejan en null. */
  function _item(type, id, name, status, source, process, metadata) {
    return {
      type,           // 'process' | 'service' | 'api' | 'component' | 'app' | 'window' | 'scheduler' | 'ipc'
      id,             // identificador único dentro de la categoría
      name,           // nombre legible
      status,         // uno de STATUS.*
      source,         // uno de SOURCE.*
      process,        // pid asociado cuando exista, si no null
      metadata,       // objeto libre con detalles específicos
    };
  }

  /* ── Helpers defensivos: cada subsistema puede no estar
     todavía registrado (p. ej. window-registry depende del
     driver del shell). Nunca lanzamos: devolvemos [] y
     dejamos constancia en consola. ── */
  function _safeList(fn, label) {
    try {
      const r = fn();
      return Array.isArray(r) ? r : [];
    } catch (err) {
      console.warn(`[system-registry] no se pudo listar ${label}:`, err?.message || err);
      return [];
    }
  }

  function _safeAsyncList(fn, label) {
    return Promise.resolve()
      .then(fn)
      .then(r => (Array.isArray(r) ? r : []))
      .catch(err => {
        console.warn(`[system-registry] no se pudo listar ${label}:`, err?.message || err);
        return [];
      });
  }

  /* ═══════════════════════════════════════════════════
     PROCESOS
     ═══════════════════════════════════════════════════ */
  function _procStatus(proc) {
    if (!proc) return STATUS.UNKNOWN;
    if (proc.state === 'suspended') return STATUS.SUSPENDED;
    if (proc.protected) return STATUS.PROTECTED;
    if (proc.state === 'zombie') return STATUS.STOPPED;
    return STATUS.ACTIVE;
  }

  function listProcesses() {
    const procs = _safeList(() => Kernel.procs.list(), 'procs');
    return procs.map(p => _item(
      'process',
      String(p.pid),
      p.title || p.appId || `pid-${p.pid}`,
      _procStatus(p),
      SOURCE.APP, // los procesos se originan en apps (o módulos, ver metadata)
      p.pid,
      {
        appId     : p.appId || null,
        parentPid : p.parentPid ?? null,
        cwd       : p.cwd || null,
        icon      : p.icon || null,
        state     : p.state || null,
        protected : !!p.protected,
        spawnedAt : p.spawnedAt || null,
        children  : p.children ? [...p.children] : [],
      }
    ));
  }

  function getProcess(pid) {
    if (pid === undefined || pid === null) return null;
    const num = Number(pid);
    let proc;
    try { proc = Kernel.procs.get(num); } catch { return null; }
    if (!proc) return null;
    return _item(
      'process',
      String(proc.pid),
      proc.title || proc.appId || `pid-${proc.pid}`,
      _procStatus(proc),
      SOURCE.APP,
      proc.pid,
      {
        appId     : proc.appId || null,
        parentPid : proc.parentPid ?? null,
        cwd       : proc.cwd || null,
        icon      : proc.icon || null,
        state     : proc.state || null,
        protected : !!proc.protected,
        spawnedAt : proc.spawnedAt || null,
        children  : proc.children ? [...proc.children] : [],
      }
    );
  }

  /* ═══════════════════════════════════════════════════
     MÓDULOS (servicios / apis / componentes)
     ModuleLoader.list(kind?) → [{kind,id,name,pid,path}]
     ═══════════════════════════════════════════════════ */
  function _moduleType(kind) {
    if (kind === 'servicio')   return 'service';
    if (kind === 'api')        return 'api';
    if (kind === 'componente') return 'component';
    return 'module';
  }

  function _moduleSource(kind) {
    if (kind === 'servicio')   return SOURCE.SERVICE;
    if (kind === 'api')        return SOURCE.API;
    if (kind === 'componente') return SOURCE.COMPONENT;
    return STATUS.UNKNOWN;
  }

  function _moduleStatus(rec) {
    // Un módulo cargado por ModuleLoader está activo mientras
    // tenga pid vivo. Si está protegido lo marcamos como tal.
    let proc = null;
    try { proc = rec.pid != null ? Kernel.procs.get(rec.pid) : null; } catch {}
    if (proc && proc.protected) return STATUS.PROTECTED;
    if (proc) return STATUS.ACTIVE;
    return STATUS.UNKNOWN;
  }

  function _moduleItem(rec) {
    return _item(
      _moduleType(rec.kind),
      rec.id,
      rec.name || rec.id,
      _moduleStatus(rec),
      _moduleSource(rec.kind),
      rec.pid ?? null,
      {
        kind : rec.kind || null,
        path : rec.path || null,
      }
    );
  }

  function listModules() {
    const mods = _safeList(() => Kernel.modules.list(), 'modules');
    return mods.map(_moduleItem);
  }

  function listServices() {
    return listModules().filter(m => m.type === 'service');
  }

  function listApis() {
    return listModules().filter(m => m.type === 'api');
  }

  function listComponents() {
    return listModules().filter(m => m.type === 'component');
  }

  function getModule(id) {
    if (!id) return null;
    const mods = _safeList(() => Kernel.modules.list(), 'modules');
    const rec = mods.find(m => m.id === id);
    return rec ? _moduleItem(rec) : null;
  }

  /* ═══════════════════════════════════════════════════
     APLICACIONES (apps_meta)
     Apps.list() es async (lee IndexedDB).
     ═══════════════════════════════════════════════════ */
  function listApps() {
    return _safeAsyncList(() => Kernel.apps.list(), 'apps').then(apps =>
      apps.map(a => _item(
        'app',
        a.id || a.appId || 'unknown',
        a.name || a.id || 'app',
        STATUS.ACTIVE, // registrada = disponible
        SOURCE.APP,
        null,
        {
          version   : a.version || null,
          icon      : a.icon || null,
          category  : a.category || null,
          singleton : !!a.singleton,
          description: a.description || null,
          registeredAt: a.registeredAt || null,
        }
      ))
    );
  }

  /* ═══════════════════════════════════════════════════
     VENTANAS (window-registry)
     Kernel.windows.list() → [{pid,appId,title,minimized,maximized,focused}]
     ═══════════════════════════════════════════════════ */
  function _windowStatus(w) {
    if (!w) return STATUS.UNKNOWN;
    if (w.minimized) return STATUS.SUSPENDED;
    return STATUS.ACTIVE;
  }

  function listWindows() {
    const wins = _safeList(() => Kernel.windows && Kernel.windows.list(), 'windows');
    return wins.map(w => _item(
      'window',
      String(w.pid ?? w.id ?? 'unknown'),
      w.title || w.appId || 'window',
      _windowStatus(w),
      SOURCE.APP,
      w.pid ?? null,
      {
        appId    : w.appId || null,
        minimized: !!w.minimized,
        maximized: !!w.maximized,
        focused  : !!w.focused,
      }
    ));
  }

  /* ═══════════════════════════════════════════════════
     SCHEDULER
     Kernel.scheduler.list() → [{id,intervalMs,paused,running,lastRun,runCount,lastError}]
     ═══════════════════════════════════════════════════ */
  function _schedulerStatus(t) {
    if (!t) return STATUS.UNKNOWN;
    if (t.paused) return STATUS.SUSPENDED;
    if (t.lastError) return STATUS.UNKNOWN; // sigue activo pero marcamos
    return STATUS.ACTIVE;
  }

  function listScheduler() {
    const tasks = _safeList(() => Kernel.scheduler && Kernel.scheduler.list(), 'scheduler');
    return tasks.map(t => _item(
      'scheduler',
      t.id || 'task',
      t.id || 'task',
      _schedulerStatus(t),
      SOURCE.KERNEL,
      null,
      {
        intervalMs : t.intervalMs || null,
        paused     : !!t.paused,
        running    : !!t.running,
        lastRun    : t.lastRun || 0,
        runCount   : t.runCount || 0,
        lastError  : t.lastError || null,
      }
    ));
  }

  /* ═══════════════════════════════════════════════════
     IPC
     Kernel.ipc.list() → lista de canales/handlers
     (ipc-bridge expone list(); si no existe, [])
     ═══════════════════════════════════════════════════ */
  function listIPC() {
    const channels = _safeList(() => Kernel.ipc && Kernel.ipc.list(), 'ipc');
    return channels.map(c => {
      // ipc-bridge puede devolver strings (nombres de canal)
      // u objetos {action, hasHandler}. Normalizamos ambos.
      const id   = typeof c === 'string' ? c : (c.action || c.id || c.channel);
      const meta = typeof c === 'string' ? {} : c;
      return _item(
        'ipc',
        id,
        id,
        STATUS.ACTIVE,
        SOURCE.KERNEL,
        null,
        {
          hasHandler : meta.hasHandler ?? null,
          registeredAt: meta.registeredAt ?? null,
        }
      );
    });
  }

  /* ═══════════════════════════════════════════════════
     AGREGADO: list() — todo junto, agrupado por type
     ═══════════════════════════════════════════════════ */
  function list() {
    // Las apps son async; para list() síncrono las omitimos y
    // se exponen vía listApps() (que devuelve Promise). El
    // resto de categorías son síncronas.
    return {
      processes : listProcesses(),
      modules   : listModules(),
      services  : listServices(),
      apis      : listApis(),
      components: listComponents(),
      windows   : listWindows(),
      scheduler : listScheduler(),
      ipc       : listIPC(),
      // apps: Promise — usar listApps()
    };
  }

  /* ── refresh(): por ahora todo se lee bajo demanda, así
     que es un no-op. Se mantiene en el contrato para que
     futuras cachés no rompan a las apps que ya llamen a
     refresh() antes de list(). ── */
  function refresh() {
    return Promise.resolve();
  }

  return {
    id  : 'system-registry',
    name: 'System Registry',
    icon: '🗂',

    async start() {
      Kernel.systemRegistry = {
        // constantes públicas (para que las apps no hardcodeen strings)
        STATUS,
        SOURCE,

        // agregado
        list,
        refresh,

        // por categoría
        listProcesses,
        listModules,
        listServices,
        listApis,
        listComponents,
        listApps,        // async → Promise
        listWindows,
        listScheduler,
        listIPC,

        // individuales
        getProcess,
        getModule,
      };
      console.info('[system-registry] instalado (Kernel.systemRegistry)');
    },

    async stop() {
      delete Kernel.systemRegistry;
    },
  };
}
