# Revisión de compatibilidad

Base: `server (6).js` y `package.json` adjuntos. Se conservan las salas y eventos
Socket.IO, autenticación Apple/Google, JWT, guardado cloud, Supabase, filtros de
nombres, administración y rankings. No se cambian monedas, inventario,
productos, compras ni datos guardados.

## Cambios concretos

- Montaje de `/api/memory/*` en el mismo listener HTTP y puerto `PORT`.
- Memory importa `memory-core.js` y `roster-migration.js` directamente;
  no depende de los recursos gráficos de `www`.
- Reglas 6: presentación inicial sincronizada, puzzles privados, 2–8 jugadores,
  espectadores, emojis y vidas conservan las reglas del cliente entregado.
- CORS de Memory admite los orígenes nativos de Capacitor. Se pueden añadir
  orígenes exactos en `MEMORY_ALLOWED_ORIGINS`, separados por comas.
- Un fallo de inicialización/guardado de Memory no derriba las rutas anteriores.
  Un JSON de datos inválido no se reemplaza por una base vacía.
- Los personajes retirados se normalizan al entrar/cambiar en el lobby.
  No se reescriben los derechos de compra almacenados en Cloud Save.
- Bind explícito `0.0.0.0`, usando el mismo `PORT` de Render.
- Cliente: Memory hereda la URL de `NET_CONFIG` y verifica el health antes de
  conectarse. Puede esperar hasta 75 segundos por Render; solo repite GET de
  health, no compras ni acciones de juego. Volver atrás cancela esa espera.

El servidor original ya reenvía `sp` e `it` del splash; ese relay queda intacto.
Los cinco segundos de Don't Blink y el tiempo para resolver no se consumen
mientras se muestran los participantes.

## Límites existentes

- Cloud Save no sincroniza los récords detallados de Memory entre dispositivos.
  El ranking global conserva su persistencia en Supabase cuando está configurado.
- El cliente principal usa el rejoin legacy. El servidor conserva esa
  compatibilidad; no se introduce una migración unilateral de protocolo.
- Los archivos locales de Render se pierden al reiniciar/desplegar sin disco
  persistente. Esto no afecta las tablas de Supabase existentes.
- Se verificó HTTP local y la lógica original mediante dependencias simuladas.
  Socket.IO real, OAuth, base de datos productiva y despliegue deben verificarse
  en el servicio real después de subir estos archivos.

Fuentes: [puerto de Render](https://render.com/docs/web-services#port-binding),
[almacenamiento y suspensión](https://render.com/docs/free).
