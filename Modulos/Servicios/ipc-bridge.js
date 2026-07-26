function registerService(Kernel) {
  const CHANNEL = 'wos-ipc';
  const _handlers = new Map();   // action -> async (payload, ctx) => result
  const _unsubs   = [];          // limpieza de listeners del EventBus al stop()
  let _listener = null;

  function _isWosMessage(data) {
    return !!data && data.channel === CHANNEL && typeof data.action === 'string';
  }

  async function _handle(event) {
    // Solo aceptamos mensajes del mismo origen: las apps son iframes
    // same-origin (sandbox="allow-scripts allow-same-origin ..."), así
    // que cualquier otro origen se ignora sin excepción.
    if (event.origin !== window.location.origin) return;

    const data = event.data;
    if (!_isWosMessage(data)) return;

    const { action, payload, requestId, appId } = data;
    const source = event.source;
    if (!source) return;

    const reply = (ok, resultOrError) => {
      try {
        source.postMessage({
          channel: CHANNEL,
          requestId,
          ok,
          result: ok ? resultOrError : undefined,
          error : ok ? undefined : String(resultOrError?.message || resultOrError),
        }, window.location.origin);
      } catch (_) { /* el iframe ya no existe: ignorar */ }
    };

    const handler = _handlers.get(action);
    if (!handler) {
      reply(false, new Error(`IPC: acción desconocida "${action}"`));
      return;
    }

    try {
      const result = await handler(payload, { appId: appId || null, sourceWindow: source });
      reply(true, result);
    } catch (err) {
      reply(false, err);
    }
  }

  function on(action, handler) {
    if (typeof handler !== 'function') throw new Error('IPC.on: handler debe ser función');
    if (_handlers.has(action)) {
      console.warn(`[ipc-bridge] acción "${action}" ya tenía handler — se sobrescribe`);
    }
    _handlers.set(action, handler);
    return () => _handlers.delete(action);
  }

  function off(action) {
    _handlers.delete(action);
  }

  function list() {
    return [..._handlers.keys()];
  }

  function broadcast(event, payload) {
    document.querySelectorAll('#wm-layer iframe').forEach(iframe => {
      try {
        iframe.contentWindow?.postMessage(
          { channel: CHANNEL, event, payload },
          window.location.origin
        );
      } catch (_) { /* iframe cross-origin o destruido: ignorar */ }
    });
  }

  return {
    id  : 'ipc-bridge',
    name: 'IPC Bridge',
    icon: '🔗',

    async start() {
      _listener = (e) => { _handle(e); };
      window.addEventListener('message', _listener);

      // Reenvía automáticamente estos eventos del EventBus a todas las
      // apps abiertas, para que reaccionen sin registrar cada una un
      // listener propio del lado del shell.
      const forwarded = ['fs:write', 'fs:remove', 'fs:mkdir', 'fs:move', 'notifications:push', 'prefs:change'];
      forwarded.forEach(ev => {
        const unsub = Kernel.on(ev, payload => broadcast(ev, payload));
        _unsubs.push(unsub);
      });

      Kernel.ipc = { on, off, broadcast, list };
      console.info('[ipc-bridge] instalado — reenviando:', forwarded.join(', '));
    },

    async stop() {
      if (_listener) window.removeEventListener('message', _listener);
      _unsubs.forEach(u => u());
      _unsubs.length = 0;
      _handlers.clear();
      delete Kernel.ipc;
    },
  };
}