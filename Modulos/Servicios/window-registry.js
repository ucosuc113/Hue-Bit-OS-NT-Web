/* ═══════════════════════════════════════════════════
   SERVICIO: WINDOW REGISTRY                   [v1.0.0]
   ═══════════════════════════════════════════════════
   Saca la "API de ventanas" de adentro de shell.html sin
   duplicar el estado del WM. El WM (DOM real, drag, resize,
   z-index...) sigue viviendo en shell.html — este servicio
   es solo la fachada estable que el resto del sistema
   consulta, delegando en un "driver" que el shell registra
   una vez al arrancar.

   Por qué un driver y no reimplementar el WM aquí:
   el WM manipula el DOM directamente (createWindow, drag,
   resize...) y eso solo puede vivir donde está el DOM real
   (shell.html). Si en Fase 4 se reescribe shell.html, solo
   hay que volver a registrar el driver — el resto del
   sistema (Task Manager, IDE, apps) no se entera del cambio.

   Integración necesaria en shell.html (una sola vez, cuando
   el shell ya tiene su WM listo):

     Kernel.windows.registerDriver({
       list()          { ...forma [{pid,appId,title,minimized,maximized,focused}] },
       getState(pid)   { ...detalle de una ventana o null },
       focus(pid)      { ...true/false },
       minimize(pid)   { ...true/false },
       close(pid)      { ...true/false },
     });

   API expuesta como Kernel.windows:
     - registerDriver(driver) / unregisterDriver()
     - list() / getState(pid)
     - focus(pid) / minimize(pid) / close(pid)
     - notifyChange(detail?)  → el driver la llama para avisar
       que algo cambió; emite 'windows:changed' en el EventBus
   ═══════════════════════════════════════════════════ */

function registerService(Kernel) {
  let _driver = null;

  function registerDriver(driver) {
    const required = ['list', 'focus', 'minimize', 'close'];
    for (const m of required) {
      if (typeof driver?.[m] !== 'function') {
        throw new Error(`windows.registerDriver: el driver debe implementar "${m}()"`);
      }
    }
    _driver = driver;
    Kernel.emit('windows:driverReady', {});
    console.info('[window-registry] driver registrado por el shell');
  }

  function unregisterDriver() {
    _driver = null;
  }

  function _requireDriver() {
    if (!_driver) throw new Error('windows: no hay driver de ventanas registrado (¿el shell ya inició?)');
    return _driver;
  }

  function list() {
    return _driver ? _driver.list() : [];
  }

  function getState(pid) {
    if (!_driver) return null;
    return _driver.getState ? _driver.getState(pid) : null;
  }

  function focus(pid)    { return _requireDriver().focus(pid); }
  function minimize(pid) { return _requireDriver().minimize(pid); }
  function close(pid)    { return _requireDriver().close(pid); }

  function notifyChange(detail = {}) {
    Kernel.emit('windows:changed', detail);
  }

  return {
    id  : 'window-registry',
    name: 'Registro de Ventanas',
    icon: '🪟',

    async start() {
      Kernel.windows = { registerDriver, unregisterDriver, list, getState, focus, minimize, close, notifyChange };
      console.info('[window-registry] instalado (esperando driver del shell)');
    },

    async stop() {
      _driver = null;
      delete Kernel.windows;
    },
  };
}