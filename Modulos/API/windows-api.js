/* ═══════════════════════════════════════════════════
   API: WINDOWS API                            [v1.0.0]
   ═══════════════════════════════════════════════════
   Capa delgada sin estado propio: traduce acciones IPC
   (window.list, windows.focus, ...) a llamadas sobre
   Kernel.windows (servicio window-registry), verificando
   permiso por app antes de mutar nada.

   Depende de que ya estén instalados (ambos son servicios,
   que cargan antes que cualquier API en el orden del
   ModuleLoader):
     - ipc-bridge     → Kernel.ipc
     - window-registry → Kernel.windows

   Acciones IPC expuestas a las apps:
     windows.list                    → sin permiso (solo lectura)
     windows.getState  { pid }       → sin permiso (solo lectura)
     windows.focus     { pid }       → requiere 'windows.manage'
     windows.minimize  { pid }       → requiere 'windows.manage'
     windows.close     { pid }       → requiere 'windows.manage'

   Nota: 'windows.manage' es un permiso de app (no necesita
   existir en Permissions.PERMS — Permissions.appHas solo
   comprueba membresía en el array 'granted' de esa app).
   Una app pide el permiso con
     Kernel.permissions.requestAppPermission(appId, 'windows.manage')
   y el usuario lo concede desde Configuración (pendiente
   de UI, no de esta API).
   ═══════════════════════════════════════════════════ */

function registerAPI(Kernel) {
  const PERM = 'windows.manage';

  async function _authorize(appId) {
    if (!appId) return true; // llamada interna del propio shell, sin appId
    const ok = await Kernel.permissions.appHas(appId, PERM);
    if (!ok) throw new Error(`windows-api: la app "${appId}" no tiene permiso "${PERM}"`);
    return true;
  }

  const ACTIONS = ['windows.list', 'windows.getState', 'windows.focus', 'windows.minimize', 'windows.close'];

  return {
    id  : 'windows-api',
    name: 'API de Ventanas',
    icon: '🔌',

    async start() {
      if (!Kernel.ipc) { console.warn('[windows-api] ipc-bridge no disponible — la API no se expone a apps'); return; }
      if (!Kernel.windows) { console.warn('[windows-api] window-registry no disponible'); return; }

      Kernel.ipc.on('windows.list', async () => Kernel.windows.list());

      Kernel.ipc.on('windows.getState', async (payload) => Kernel.windows.getState(payload?.pid));

      Kernel.ipc.on('windows.focus', async (payload, ctx) => {
        await _authorize(ctx.appId);
        return Kernel.windows.focus(payload?.pid);
      });

      Kernel.ipc.on('windows.minimize', async (payload, ctx) => {
        await _authorize(ctx.appId);
        return Kernel.windows.minimize(payload?.pid);
      });

      Kernel.ipc.on('windows.close', async (payload, ctx) => {
        await _authorize(ctx.appId);
        return Kernel.windows.close(payload?.pid);
      });

      console.info('[windows-api] acciones registradas:', ACTIONS.join(', '));
    },

    async stop() {
      if (Kernel.ipc) ACTIONS.forEach(a => Kernel.ipc.off(a));
    },
  };
}