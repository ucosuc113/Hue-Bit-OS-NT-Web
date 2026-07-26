function registerService(Kernel) {
  const { fs } = Kernel;

  const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'];
  const VID_EXTS = ['.mp4', '.webm', '.ogg', '.mov', '.mkv'];
  const AUD_EXTS = ['.mp3', '.wav', '.flac', '.aac', '.m4a'];

  const MultimediaService = {
    id: 'multimedia',
    name: 'Multimedia Service',
    icon: '🎬',

    async start(Kernel, { pid }) {
      Kernel.multimedia = this;
      console.info('[Service:Multimedia] Servicio Multimedia iniciado (PID ' + pid + ')');
    },

    async stop() {
      delete Kernel.multimedia;
    },

    detectType(path) {
      const ext = '.' + (path.split('.').pop() || '').toLowerCase();
      if (IMG_EXTS.includes(ext)) return 'image';
      if (VID_EXTS.includes(ext)) return 'video';
      if (AUD_EXTS.includes(ext)) return 'audio';
      return 'unknown';
    },

    async load(path) {
      if (!path) throw new Error('Multimedia.load requiere una ruta');
      
      const type = this.detectType(path);
      if (type === 'unknown') throw new Error('Formato multimedia no soportado');

      const node = await fs.stat(path);
      if (!node) throw new Error(`El archivo no existe: ${path}`);
      if (node.type === 'dir') throw new Error('La ruta es un directorio');

      // Lee el blob del VFS y crea una URL temporal para el DOM
      const blob = await fs.readBlob(path);
      const mime = node.mime || (type === 'image' ? 'image/*' : type === 'video' ? 'video/*' : 'audio/*');
      
      const typedBlob = new Blob([blob], { type: mime });
      const url = URL.createObjectURL(typedBlob);

      return { type, url, mime, name: node.name, path };
    },

    async listMedia(dirPath = '/home/media') {
      try {
        const entries = await fs.readdir(dirPath);
        return entries.filter(e => this.detectType(e.name) !== 'unknown');
      } catch (e) {
        return [];
      }
    }
  };

  return MultimediaService;
}