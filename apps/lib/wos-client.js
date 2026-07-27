;(function (global) {
  'use strict';

  const TARGET = window.parent;
  const ORIGIN = window.location.origin === 'null' ? '*' : window.location.origin;
  const TIMEOUT = 5000;

  const _pending = new Map();
  let _seq = 0;

  window.addEventListener('message', (event) => {
    // Permitimos '*' si el iframe está sandboxed sin allow-same-origin
    if (ORIGIN !== '*' && event.origin !== window.location.origin) return;
    
    const msg = event.data;
    if (msg && msg.type === 'wos:response' && _pending.has(msg.id)) {
      const { resolve, reject, timer } = _pending.get(msg.id);
      clearTimeout(timer);
      _pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    }
  });

  function request(channel, method, args = []) {
    return new Promise((resolve, reject) => {
      const id = `req_${++_seq}`;
      const timer = setTimeout(() => {
        if (_pending.has(id)) {
          _pending.delete(id);
          reject(new Error(`WOS Timeout: ${channel}.${method}`));
        }
      }, TIMEOUT);

      _pending.set(id, { resolve, reject, timer });

      TARGET.postMessage({
        type: 'wos:call',
        id,
        channel,
        method,
        args
      }, ORIGIN);
    });
  }

  global.WOS = new Proxy({
    call: request,
    get launch() { return (...args) => request('shell', 'launch', args); },
    get toast() { return (...args) => request('shell', 'toast', args); },
    get confirm() { return (...args) => request('shell', 'confirm', args); },
    get prompt() { return (...args) => request('shell', 'prompt', args); },
    get closeWindow() { return (...args) => request('shell', 'closeWindow', args); },
    get minimizeWindow() { return (...args) => request('shell', 'minimizeWindow', args); },
    get focusWindow() { return (...args) => request('shell', 'focusWindow', args); },
    get setWindowTitle() { return (...args) => request('shell', 'setWindowTitle', args); }
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return new Proxy({}, {
        get(_, method) {
          return (...args) => request(prop, method, args);
        }
      });
    }
  });

})(window);