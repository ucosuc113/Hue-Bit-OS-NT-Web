function registerService(Kernel) {
  return {
    id: 'installer',
    name: 'Instalador de Paquetes',
    icon: '📦',
    
    async start() {
      // Registrar la extensión .hpkg para que el Kernel sepa que existe un handler
      Kernel.extensions.register('.hpkg', 'installer');
      
      // Exponer la función de instalación en el objeto global del Kernel
      Kernel.installer = {
        async install(path) {
          const FS = Kernel.fs;
          const Apps = Kernel.apps;
          
          try {
            const raw = await FS.read(path);
            const pkg = JSON.parse(raw);
            
            if (pkg.huebos_package !== 1 || !pkg.manifest || !pkg.files) {
              throw new Error('Formato de paquete .hpkg inválido');
            }
            
            const appId = pkg.manifest.id;
            const appDir = `/home/apps/${appId}`;
            
            // 1. Extraer archivos originales
            await FS.mkdir(appDir);
            for (const [relPath, content] of Object.entries(pkg.files)) {
              await FS.write(`${appDir}/${relPath}`, content);
            }

            if(pkg.files_binary) {
              for (const [relPath, b64] of Object.entries(pkg.files_binary)) {
                const blob = await (await fetch(`data:application/octet-stream;base64,${b64}`)).blob();
                await FS.writeBinary(`${appDir}/${relPath}`, blob);
              }
            }
            
            // 2. Crear un bundle embebido para evitar 404
            let entryFile = pkg.manifest.entry || 'index.html';
            let entryHtml = pkg.files[entryFile] || '<h1>App sin index.html</h1>';
            
            // Inlinear JS y CSS
            for (const [relPath, content] of Object.entries(pkg.files)) {
              if (relPath === entryFile) continue;
              
              const escPath = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              
              // Reemplazar <script src="...">
              const scriptRegex = new RegExp(`<script[^>]*src=["'](\\.\\/)?${escPath}["'][^>]*>\\s*</script>`, 'gi');
              entryHtml = entryHtml.replace(scriptRegex, `<script>\n${content}\n</script>`);
              
              // Reemplazar <link href="...">
              const linkRegex = new RegExp(`<link[^>]*href=["'](\\.\\/)?${escPath}["'][^>]*>`, 'gi');
              entryHtml = entryHtml.replace(linkRegex, `<style>\n${content}\n</style>`);
            }
            
            // El shell reinyecta el wos-client real dentro de launchApp
            // justo antes de </head>. Aquí solo eliminamos el <script src>
            // del paquete para que no genere un 404 innecesario.
            entryHtml = entryHtml.replace(
              /<script[^>]*src=["'](\.\/)?lib\/wos-client\.js["'][^>]*>\s*<\/script>/gi,
              ''
            );
            
            
            const bundlePath = `${appDir}/bundle.html`;
            await FS.write(bundlePath, entryHtml);

            // sabias que los hipopotamos sueltan leche rosa? :p, si lo sabias?, bueno, me la pela >:D
            
            // 3. Registrar la app
            const appRecord = {
              id: appId,
              name: pkg.manifest.name || appId,
              version: pkg.manifest.version || '1.0.0',
              icon: pkg.manifest.icon || '📦',
              category: pkg.manifest.category || 'utility',
              singleton: pkg.manifest.singleton ?? false,
              entry: bundlePath,
              meta: {
                description: pkg.manifest.description || '',
                winWidth: pkg.manifest.winWidth || 640,
                winHeight: pkg.manifest.winHeight || 460,
                author: pkg.manifest.author || '',
                systemApp: false,
                protected: false,
                isVfs: true,
              },
            };
            await Apps.register(appRecord);
            
            // 4. Crear el .exe en el Escritorio
            const exePath = `/home/desktop/${appId}.exe`;
            await FS.write(exePath, `USER EXECUTABLE ${appId}`, {
              meta: {
                protected: false,
                systemApp: false,
                appId: appId,
                source: 'system-executable',
                icon: appRecord.icon,
                displayName: appRecord.name,
                entry: bundlePath,
              }
            });
            
            // 5. Lanzar la app
            Kernel.emit('shell:launch', { appId });
            Kernel.emit('fs:write', { path: exePath });
            Kernel.emit('toast', { msg: `App ${appId} instalada`, type: 'ok' });
            return true;
          } catch (err) {
            console.error('[Installer] Error instalando .hpkg:', err);
            Kernel.emit('toast', { msg: `Error instalando: ${err.message}`, type: 'error' });
            return false;
          }
        }
      };
      
      console.info('[Kernel:modules] ✓ Servicio Installer iniciado');
    },
    
    async stop() {
      delete Kernel.installer;
    }
  };
}