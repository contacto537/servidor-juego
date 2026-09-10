# Water Escape + Memory Run: instalación

1. Descomprime este ZIP **fuera de Mygame**.
2. Sube su contenido a la raíz de tu repositorio del servidor en GitHub,
   reemplazando los archivos del mismo nombre. `server.js` queda junto a
   `package.json`: no crees otra carpeta llamada `server`.
3. Conserva tu **package-lock.json** y las variables existentes en Render.
4. Despliega el último commit en tu servicio actual de Render.

Se conservan los comandos habituales: `npm install` para instalar y `npm start`
(o `node server.js`) para arrancar. El `package.json` y las dependencias son
exactamente los que adjuntaste. No hay dependencias nuevas.

La comprobación de Memory es:
`https://servidor-juego-9xj5.onrender.com/api/memory/health`
Debe responder JSON con `ok: true`, `version: 6` y `rulesVersion: 6`.

## En tu juego

Usa el nuevo `www.zip`: renombra tu carpeta anterior como respaldo, crea `www`
y extrae ahí el contenido. Deben quedar `Mygame/www/index.html` y
`Mygame/www/assets/`. Ejecuta `npx cap sync android`, o `npx cap sync ios` en tu
Mac, y compila en Android Studio o Xcode.

El `memory-server.zip` anterior queda sustituido por este paquete.
`character-replacement-source.zip` es solo respaldo: guárdalo fuera de Mygame
y del repositorio del servidor.

## Pruebas y datos

`npm test` ejecuta las pruebas incluidas sin servicios externos. La carpeta
`test` es para verificar el servidor y no se copia a `Mygame/www`.

No se cambia Supabase ni se modifican sus tablas, claves o registros existentes.
El ranking global de Memory sigue usando tu `/top?mode=memory` existente.
Memory usa `data/memory.json` para sesiones y registros propios. Si ya tienes
`MEMORY_DATA_FILE`, conserva su valor y su archivo. Para conservar ese archivo
entre reinicios de Render debe estar en un disco persistente; el disco local
normal de Render es temporal. Las salas y partidas activas están en memoria y
se reinician al desplegar. No subas `data/`, credenciales ni `node_modules`.

Se probó HTTP local con simulaciones de Socket.IO, Supabase y JOSE. Esta entrega
no se desplegó ni se ejecutó contra tu base de datos real. `REVIEW.md` explica
los cambios y límites.

Referencias: [Render: despliegue](https://render.com/docs/web-services),
[Render: suspensión y archivos temporales](https://render.com/docs/free),
[Capacitor: sync](https://capacitorjs.com/docs/cli/commands/sync).
