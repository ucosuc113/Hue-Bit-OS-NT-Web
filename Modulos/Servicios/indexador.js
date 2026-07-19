function registerService(Kernel) {
  let _timer = null;
  let _debounce = null;
  const ROOTS = ['/home'];

  async function walk(path, out) {
    let entries = [];
    try { entries = await Kernel.fs.readdir(path); } catch (e) { return; }
    for (const e of entries) {
      out.push({ path: e.id, name: e.name, type: e.type, size: e.size || 0, mtime: e.mtime || 0 });
      if (e.type === 'dir') await walk(e.id, out);
    }
  }

  async function buildIndex() {
    const out = [];
    for (const root of ROOTS) await walk(root, out);
    await Kernel.prefs.set('index.files', out);
    await Kernel.prefs.set('index.updatedAt', Date.now());
    Kernel.emit('index:updated', { count: out.length, ts: Date.now() });
    return out;
  }

  function scheduleRebuild(delay) {
    clearTimeout(_debounce);
    _debounce = setTimeout(function () { buildIndex().catch(function () {}); }, delay || 1500);
  }

  return {
    id: 'svc.indexador',
    name: 'Indexador de archivos',
    icon: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>',

    async start(Kernel) {
      await buildIndex();
      const offW  = Kernel.on('fs:write',  function () { scheduleRebuild(); });
      const offM  = Kernel.on('fs:mkdir',  function () { scheduleRebuild(); });
      const offR  = Kernel.on('fs:remove', function () { scheduleRebuild(); });
      const offMv = Kernel.on('fs:move',   function () { scheduleRebuild(); });
      this._unsub = [offW, offM, offR, offMv];
      _timer = setInterval(function () { buildIndex().catch(function () {}); }, 30 * 60 * 1000);
    },

    async stop() {
      if (_timer) clearInterval(_timer);
      clearTimeout(_debounce);
      (this._unsub || []).forEach(function (fn) { if (typeof fn === 'function') fn(); });
    },
  };
}