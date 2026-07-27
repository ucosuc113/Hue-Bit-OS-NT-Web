function registerService(Kernel) {
  let _driver = null;

  function registerDriver(driver) {
    const required = ['list', 'focus', 'minimize', 'close'];
    for (const m of required) {
      if (typeof driver?.[m] !== 'function') {
        throw new Error(`windows.registerDriver: el driver debe implementar "${m}()"`);
      }

      // DOM mis 2 bolas.... esa madre me causo dolores de cabeza, junto a FS y DB...
    }
    _driver = driver;
    Kernel.emit('windows:driverReady', {});
    console.info('[window-registry] driver registrado por el shell');
  }

  function unregisterDriver() {
    _driver = null;
  }

  // olvidalo, (novia === true) paso a ser false... pipipipo

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