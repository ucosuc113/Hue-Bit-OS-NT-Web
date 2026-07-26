function registerService(Kernel) {
  const _tasks = new Map(); // id -> { fn, intervalMs, timerId, paused, running, lastRun, runCount, lastError }

  function schedule(id, fn, intervalMs, opts = {}) {
    if (typeof fn !== 'function') throw new Error('scheduler.schedule: fn debe ser función');
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('scheduler.schedule: intervalMs inválido');
    if (_tasks.has(id)) throw new Error(`scheduler.schedule: ya existe una tarea "${id}"`);

    const task = {
      fn, intervalMs, timerId: null,
      paused: false, running: false,
      lastRun: 0, runCount: 0, lastError: null,
    };
    _tasks.set(id, task);
    _arm(id);
    if (opts.runOnStart !== false) _tick(id);
    console.debug(`[scheduler] tarea registrada: "${id}" cada ${intervalMs}ms`);
    return id;
  }

  function _arm(id) {
    const task = _tasks.get(id);
    if (!task || task.paused) return;
    task.timerId = setTimeout(() => _tick(id), task.intervalMs);
  }

  async function _tick(id) {
    const task = _tasks.get(id);
    if (!task || task.paused) return;
    if (task.running) { _arm(id); return; } // evita solapamiento

    task.running = true;
    try {
      await task.fn();
      task.lastError = null;
    } catch (err) {
      task.lastError = err?.message || String(err);
      console.error(`[scheduler] tarea "${id}" falló:`, err);
      Kernel.crash.report(`Scheduler: tarea "${id}" falló`, err, { taskId: id });
    } finally {
      task.running = false;
      task.lastRun = Date.now();
      task.runCount++;
      _arm(id);
    }
  }

  function runNow(id) {
    if (!_tasks.has(id)) return false;
    _tick(id);
    return true;
  }

  function pause(id) {
    const task = _tasks.get(id);
    if (!task) return false;
    task.paused = true;
    if (task.timerId) clearTimeout(task.timerId);
    Kernel.emit('scheduler:pause', { id });
    return true;
  }

  function resume(id) {
    const task = _tasks.get(id);
    if (!task) return false;
    if (!task.paused) return true;
    task.paused = false;
    _arm(id);
    Kernel.emit('scheduler:resume', { id });
    return true;
  }

  function cancel(id) {
    const task = _tasks.get(id);
    if (!task) return false;
    if (task.timerId) clearTimeout(task.timerId);
    _tasks.delete(id);
    return true;
  }

  function list() {
    return [..._tasks.entries()].map(([id, t]) => ({
      id,
      intervalMs: t.intervalMs,
      paused    : t.paused,
      running   : t.running,
      lastRun   : t.lastRun,
      runCount  : t.runCount,
      lastError : t.lastError,
    }));
  }

  return {
    id  : 'scheduler',
    name: 'Scheduler',
    icon: '⏱',

    async start() {
      Kernel.scheduler = { schedule, runNow, pause, resume, cancel, list };
      console.info('[scheduler] instalado');
    },

    async stop() {
      [..._tasks.keys()].forEach(cancel);
      delete Kernel.scheduler;
    },
  };
}