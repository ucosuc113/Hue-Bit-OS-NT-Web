<div align="center">

# HuebOS-NT

Huebos nt es una simulacion de sistema operativo, simulando de manera similar como funciona un kernel, una terminal, apis, servicios

### Funciones:

- Sistema FS
- Ventanas dinamicas globales
- Crear apps, con el formato de kernel

</div>
  
(no se crear un buen readme)

<div align="center">

### Tecnologias usadas:

- JS
- HTML
- CSS


### :0 Como correr:

#### [ingresa aca papu](https://ucosuc113.github.io/Hue-Bit-OS-NT-Web)

</div>

Estructura del proyecto.... (vere como mostrar esto :v)

<pre>
------------------------------------------------------------------------------
HuebOs-NT
|
|-Index.html (bootloader)
|-Kernel.js (es el kernel :D)
|-Shell.html (shell grafica del sistema)
|-Uefi.html (la uefi XD, donde se configura como carga el sistema, y config base antes del mismo sistema)
|-RepairBoot.html (si algo muere, y el sistema no quiere iniciar, eres enviado aca, el purgatorio donde restableces el sistema de alguna u otra manera)
|
|-diag-apps (diagnostica apps)
|-diag-kernel (este diagnostica el kernel :0)
|
|/apps
|  |- termina.html (la unica e inigualable terminal)
|  |- files.html (el explorador de archivos :3)
|  |- config.html (app de configuracion preinstalada)
|  |- task-manager.html (el... administrador de tareas...)
|  |- IDE.html (el entorno de desarrollo para... desarrollar)
|  |- Imports.html (importa archivos multimedia desde tu dispositivo)
|  |- Multimedia.html (la app que corre todo archivo multimedia compatible)
|  |
|  |/public
|  |  |- (todos los iconos de las apps en svg)
|  |
|  |/lib
|    |- wos-client.js (esta es la libreria que usan las apps para poder usar el intercomunicador de ipc-bridge)
|
|/Modulos
|  |/Servicios
|  |  |- ide-bridge.js (es un puente entre el ide y la terminal)
|  |  |- import.js (el servicio encargado en poder importar archivos y meterlos al indexedDB)
|  |  |- indexador.js (el indexador de archivos)
|  |  |- installer.js (el encargado en instalar un paquete .hpkg en una app ejecutable)
|  |  |- ipc-bridge.js (el puente entre las apps, y el shell/kernel)
|  |  |- multimedia.js (el servicio encargado en correr los archivos multimedia y binarios correctamente yeyyy)
|  |  |- notifiaciones.js (el servicio encargado en que las apps puedan tener acceso a las notificaciones del sistema)
|  |  |- scheduler.js (el servicio que ejecuta todas las tareas automaticas periodicas)
|  |  |- system-registry.js (este we hace que las apps puedan consultar el estado de algun proceso o sistema)
|  |  |- window-registry.js (es el servicio que se encarga en manejar las ventanas de manera independiente de como opere cada una)
|  |
|  |/API
|     |- windows-api.js (expone window-registry a las apps mediante el ipc, y controla sus permisos)
|
|/public
  |- (lamentable, una sola carpeta para un .png de icono del sistema XD)
------------------------------------------------------------------------------
</pre>

<div align="center">

<img width="1920" height="990" alt="image" src="https://github.com/user-attachments/assets/2816fbf5-eeeb-4b52-b4bb-32e61d0d8b36" />
<img width="1920" height="992" alt="image" src="https://github.com/user-attachments/assets/c8aaaba3-7cd9-4ce0-87e2-7506bbc05f99" />
<img width="1920" height="988" alt="image" src="https://github.com/user-attachments/assets/8415bf9c-6243-415a-86cc-bd2588de9e69" />

</div>

HuebOS-NT es la segunda generacion del concepto HuebOs, si quieres probar el proyecto original, [aca esta](https://ucosuc113.github.io/Hue-Bit-OS-Web/)

Modelos usados: Sonnet 4.6, Sonnet 5, GLM: 5.2

Este proyecto utiliza la licencia MIT
