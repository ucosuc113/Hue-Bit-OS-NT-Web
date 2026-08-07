<div align="center">

# HuebOS-NT

Huebos nt is a simulation of an operating system, simulating in a similar way how a kernel, a terminal, apis, services work

### Functions:

* FS System
* Global dynamic windows
* Create apps, with the kernel format

</div>

(I dont know how to make a good readme)

<div align="center">

### Technologies used:

* JS
* HTML
* CSS

### :0 How to run:

#### [enter here papu](https://ucosuc113.github.io/Hue-Bit-OS-NT-Web)

</div>

Project structure.... (I will see how to show this :v)

<pre>
------------------------------------------------------------------------------
HuebOs-NT
|
|-Index.html (bootloader)
|-Kernel.js (it is the kernel :D)
|-Shell.html (graphic shell of the system)
|-Uefi.html (the uefi XD, where you configure how the system loads, and base config before the system itself)
|-RepairBoot.html (if something dies, and the system doesnt want to start, you are sent here, the purgatory where you restore the system in some way or another)
|
|-diag-apps (diagnoses apps)
|-diag-kernel (this diagnoses the kernel :0)
|
|/apps
|  |- termina.html (the one and only terminal)
|  |- files.html (the file explorer :3)
|  |- config.html (preinstalled configuration app)
|  |- task-manager.html (the... task manager...)
|  |- IDE.html (the development environment for... developing)
|  |- Imports.html (imports multimedia files from your device)
|  |- Multimedia.html (the app that runs every compatible multimedia file)
|  |
|  |/public
|  |  |- (all the app icons in svg)
|  |
|  |/lib
|    |- wos-client.js (this is the library that apps use to be able to use the ipc-bridge intercomunicator)
|
|/Modulos
|  |/Servicios
|  |  |- ide-bridge.js (it is a bridge between the ide and the terminal)
|  |  |- import.js (the service in charge of being able to import files and put them into indexedDB)
|  |  |- indexador.js (the file indexer)
|  |  |- installer.js (the one in charge of installing a .hpkg package into an executable app)
|  |  |- ipc-bridge.js (the bridge between the apps, and the shell/kernel)
|  |  |- multimedia.js (the service in charge of running multimedia and binary files correctly yeyyy)
|  |  |- notifiaciones.js (the service in charge of making apps able to have access to system notifications)
|  |  |- scheduler.js (the service that executes all the automatic periodic tasks)
|  |  |- system-registry.js (this dude makes it so apps can check the status of some process or system)
|  |  |- window-registry.js (it is the service in charge of managing the windows independently of how each one operates)
|  |
|  |/API
|     |- windows-api.js (exposes window-registry to the apps through ipc, and controls their permissions)
|
|/public
|  |- (unfortunately, a single folder for one .png of a system icon XD)
------------------------------------------------------------------------------
</pre>

<div align="center">

<img width="1920" height="990" alt="image" src="https://github.com/user-attachments/assets/2816fbf5-eeeb-4b52-b4bb-32e61d0d8b36" />
<img width="1920" height="992" alt="image" src="https://github.com/user-attachments/assets/c8aaaba3-7cd9-4ce0-87e2-7506bbc05f99" />
<img width="1920" height="988" alt="image" src="https://github.com/user-attachments/assets/8415bf9c-6243-415a-86cc-bd2588de9e69" />

</div>

HuebOS-NT is the second generation of the HuebOs concept, if you want to try the original project, [here it is](https://ucosuc113.github.io/Hue-Bit-OS-Web/)

Models used: Sonnet 4.6, Sonnet 5, GLM: 5.2

This project uses the MIT license
