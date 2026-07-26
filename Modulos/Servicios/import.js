function registerService(Kernel) {
  const { fs } = Kernel;

  const TEXT_EXTS = ['.txt', '.md', '.js', '.ts', '.html', '.css', '.json', '.csv', '.log', '.sh', '.py', '.xml', '.yaml', '.yml', '.ini', '.cfg'];
  const IMG_EXTS  = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'];
  const VID_EXTS  = ['.mp4', '.webm', '.ogg', '.mov', '.mkv'];
  const AUD_EXTS  = ['.mp3', '.wav', '.flac', '.aac', '.m4a'];

  const ImportService = {
    id: 'import',
    name: 'Import Service',
    icon: '📥',

    async start(Kernel, { pid }) {
      // Exponemos el servicio en el objeto Kernel para que el IPC del Shell lo encuentre
      Kernel.import = this;
      console.info('[Service:Import] Servicio de Importación iniciado (PID ' + pid + ')');
    },

    async stop() {
      delete Kernel.import;
    },

    /**
     * Método principal de la API pública.
     * Recibe un objeto File nativo, lo procesa y lo guarda en el VFS.
     */
    async ingest(file) {
      if (!file || !(file instanceof Blob)) {
        throw new Error('Import.ingest requiere un objeto File/Blob válido');
      }

      const name = file.name || `import_${Date.now()}`;
      const ext = '.' + (name.split('.').pop() || '').toLowerCase();
      let targetDir = '/home/downloads';
      let category = 'binary';

      // 1. Detección automática de tipo
      if (IMG_EXTS.includes(ext)) { targetDir = '/home/media'; category = 'image'; }
      else if (VID_EXTS.includes(ext)) { targetDir = '/home/media'; category = 'video'; }
      else if (AUD_EXTS.includes(ext)) { targetDir = '/home/media'; category = 'audio'; }
      else if (TEXT_EXTS.includes(ext)) { targetDir = '/home/docs'; category = 'text'; }

      // 2. Adaptación de metadatos internos
      const meta = {
        imported: true,
        originalMime: file.type || 'application/octet-stream',
        originalSize: file.size,
        category: category,
        importedAt: Date.now()
      };

      // 3. Escritura en el VFS (adaptando el formato)
      await fs.mkdir(targetDir).catch(() => {}); // Asegurar que el directorio exista
      const targetPath = `${targetDir}/${name}`;

      if (category === 'text') {
        const textContent = await file.text();
        await fs.write(targetPath, textContent, { meta });
      } else {
        // writeBinary no acepta meta en la firma actual, pero la conserva si el archivo ya existe.
        await fs.writeBinary(targetPath, file, file.type || 'application/octet-stream');
      }

      // CORRECCIÓN AQUÍ: Usar Kernel.emit en lugar de EventBus.emit
      Kernel.emit('import:success', { path: targetPath, category });
      
      return { success: true, path: targetPath, category };
    }
  };

  return ImportService;
}