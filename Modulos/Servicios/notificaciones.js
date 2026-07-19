function registerService(Kernel) {
  let _pruneTimer = null;
  let _offCrash = null;

  return {
    id: 'svc.notificaciones',
    name: 'Notificaciones',
    icon: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v3M12 17.5v3"/><path d="M18 10a6 6 0 00-12 0c0 4.5-2 6-2 6h16s-2-1.5-2-6z"/></svg>',

    async start(Kernel) {
      _offCrash = Kernel.on('crash:logged', function (report) {
        Kernel.notifications.push({
          title: 'Fallo del sistema detectado',
          body: (report && report.message) || 'Se registro un nuevo reporte de fallo.',
          icon: '⚠',
          category: 'system',
        });
      });

      _pruneTimer = setInterval(function () {
        Kernel.notifications.prune({ olderThanDays: 14, onlyRead: true }).catch(function () {});
      }, 6 * 60 * 60 * 1000);

      const isFirstRun = await Kernel.prefs.get('boot.firstRun', false);
      if (isFirstRun) {
        Kernel.notifications.push({
          title: 'Bienvenido a HUEBOS',
          body: 'El Centro de Notificaciones esta activo.',
          icon: '👋',
          category: 'system',
        });
      }
    },

    async stop() {
      if (_pruneTimer) clearInterval(_pruneTimer);
      if (typeof _offCrash === 'function') _offCrash();
    },
  };
}