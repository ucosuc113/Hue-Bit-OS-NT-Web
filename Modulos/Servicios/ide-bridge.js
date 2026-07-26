function registerService(Kernel) {
  const _commands = new Map();
  const _instanceId = Math.random().toString(36).slice(2, 8);

  console.debug(`[DEBUG-BRIDGE] registerService() ejecutándose. instanceId=${_instanceId} | window===window.parent: ${window === window.parent} | window.parent.IDEBridge ya existía: ${!!window.parent.IDEBridge}`);

  const IDEBridge = {
    id: 'ide-bridge',
    _instanceId,

    registerCommand(spec) {
      if (!spec || !spec.name) throw new Error('IDEBridge: spec requiere name');
      _commands.set(spec.name.toLowerCase(), spec);
      console.debug(`[DEBUG-BRIDGE] registerCommand('${spec.name}') en instanceId=${_instanceId} | total comandos ahora: ${_commands.size}`);
    },

    unregisterCommand(name) {
      _commands.delete(String(name).toLowerCase());
    },

    getCommand(name) {
      const key = String(name).toLowerCase();
      const found = _commands.get(key) || null;
      console.debug(`[DEBUG-BRIDGE] getCommand('${name}') en instanceId=${_instanceId} | encontrado: ${!!found} | claves disponibles: [${Array.from(_commands.keys()).join(', ')}]`);
      return found;
    },

    listCommands() {
      return Array.from(_commands.values());
    },

    clearCommands() {
      console.debug(`[DEBUG-BRIDGE] clearCommands() en instanceId=${_instanceId} (tenía ${_commands.size} comando(s))`);
      _commands.clear();
    }
  };

  // Exponer globalmente para que iframes (IDE y Terminal) puedan acceder
  window.parent.IDEBridge = IDEBridge;
  console.debug(`[DEBUG-BRIDGE] window.parent.IDEBridge asignado. instanceId=${_instanceId}`);

  return {
    id: 'ide-bridge',
    name: 'IDE Terminal Bridge',
    icon: '🔗',
    start() {
      console.info(`[IDEBridge] Servicio puente IDE ↔ Terminal iniciado. instanceId=${_instanceId}`);
    },
    stop() {
      console.debug(`[DEBUG-BRIDGE] stop() — borrando window.parent.IDEBridge. instanceId=${_instanceId}`);
      delete window.parent.IDEBridge;
    }
  };
}