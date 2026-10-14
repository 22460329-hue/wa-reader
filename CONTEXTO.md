# Contexto del Proyecto: wa-reader

> Documento portable para retomar el proyecto en otro chat o herramienta.
> Generado: 2026-10-09 · Idioma: español

## 1. Resumen

Cliente de WhatsApp que corre **100 % en la terminal** (TUI) para Linux. Permite leer y responder mensajes desde el número personal del usuario usando la librería **Baileys** (WebSocket puro, sin navegador). La interfaz está inspirada en la estética clásica de terminales Unix/Linux: fondo negro casi absoluto (`#080B0E`), verde terminal (`#39E58C`) para elementos activos/enviados, gris claro para recibidos y gris azulado para metadatos.

**Estado actual:** funcional — diseño estilo WhatsApp (burbujas, chip HOY/AYER, compositor con píldora y botón ➤ que siempre dice a quién escribes), borrado en 2 pasos, conexión estable, recepción de mensajes arreglada (infraestructura de reintentos + `getMessage`), fotos inline en la terminal sin parpadeo (Kitty graphics + miniaturas ffmpeg; videos con miniatura y `Ctrl+P`), estados de descarga visibles (`↓` bajando / `⚠` falló con reintento `Ctrl+O` + auto-reintento al abrir el chat), respuesta citando con `Ctrl+R`, descarga automática de imágenes/video/stickers a `media/<Nombre>/` (usa `downloadMediaMessage` de Baileys con el mensaje crudo + `directPath`, con reintento de re-subida; fallos en `incoming.log`), selector de emojis y de archivos, envío de fotos/videos/docs/audios/stickers (`Ctrl+F` o `/img /video /doc /audio /sticker`), lista de contactos filtrada y clasificación Chats / Contactos / Estados.

## 2. Stack y tecnologías

| Área | Tecnología / versión |
|------|----------------------|
| Lenguaje | Node.js (ESM) |
| Framework WhatsApp | `@whiskeysockets/baileys` 7.0.0-rc14 |
| Logging | `pino` (errores a `baileys.log`) |
| QR | `qrcode` (genera `qr.png`) |
| Terminal | ANSI truecolor (24-bit), raw mode, alt screen |

## 3. Estructura

```text
wa-reader/
├── auth_info/                 # Sesión WhatsApp persistente (NO borrar salvo re-vincular)
│   └── app-state-sync-key-*.json
├── media/                     # Descargas por contacto: media/<Nombre>/ (estados van a la carpeta de su autor)
├── node_modules/
├── chatui.js                  # ÚNICO archivo funcional (TUI completo)
├── package.json
├── package-lock.json
├── store.json                 # Chats, contactos, mensajes, lidMap persistidos
├── incoming.log               # Log de eventos messages.upsert (diagnóstico)
├── baileys.log                # Errores de Baileys (descifrado, conexión)
├── msgdump.jsonl              # Dump crudo de mensajes con multimedia (debug)
└── qr.png                     # Código QR para vincular (se regenera si no hay sesión)
```

## 4. Cómo ejecutar

### Requisitos
- Node.js ≥ 18 (ESM)
- Terminal con soporte truecolor y raw mode (TTY real)
- Sesión WhatsApp ya vinculada en `auth_info/` (o escanear QR la primera vez)

### Instalación
```bash
cd /home/ceja/wa-reader
npm install
```

### Ejecución / comandos principales
```bash
# Modo normal (contactos reales)
node chatui.js

# Modo demo (contactos de ejemplo: Priyanka, Amigos, Familia, Luis, Trabajo + 1 grupo)
DEMO=1 node chatui.js

# Volcado de pantalla para depuración (sin TTY)
DUMP=1 COLS=120 ROWS=34 node chatui.js
DEMO=1 DUMP=1 COLS=110 ROWS=30 node chatui.js
```

**Controles:**
| Tecla | Acción |
|-------|--------|
| `↑` `↓` | Cambiar de chat (selección fijada por JID: los mensajes nuevos ya no te sacan ni desvían el envío) |
| Rueda del ratón / touch | Sube y baja por los mensajes del chat (los chats se cambian con botones; `↑hist` = estás arriba; para copiar texto usa Shift) |
| `Tab` / `Shift+Tab` | Cambiar de pestaña: Chats / Contactos / Estados (recuadros arriba; la activa en verde con no-leídos; la barra dice `Ventana › Chat`) |
| `←` `→` (en Estados) | Pasar de un estado a otro (visor foto por foto, sin salir de la terminal) |
| `AvPag` `RePag` o `Ctrl+↑` `Ctrl+↓` | Elegir mensaje dentro del chat activo |
| `Supr` o `Ctrl+D` | Borrar en 2 pasos: armar (`⚠ Supr otra vez`) y confirmar; `Esc` cancela (lo propio se revoca para todos, sin deshacer) |
| `Ctrl+O` | Ver sticker/imagen/video del mensaje elegido (descarga si falta y lo abre con tu visor) |
| `Ctrl+P` | Reproducir video/audio/imagen en la terminal con mpv (`q` para salir) |
| `Ctrl+R` | Responder citando el mensaje elegido con `AvPag` (o el último); `Enter` envía, `Esc` cancela |
| `Ctrl+F` | Adjuntar archivo (selector con vista de carpetas → pie opcional → `Enter` envía) |
| `/img /video /doc /audio /sticker <ruta> [texto]` | Enviar archivo directo (ruta con comillas si tiene espacios; `/sticker` crea sticker webp) |
| Sección `Estados 24h` | Todos los estados del contacto de una vez, fotos inline sin teclas; solo lectura, se borran solos a las 24 h |
| Pestaña `Contactos` | Agenda completa aunque no tengan historial, para empezar chats nuevos |
| `:` | Abrir/cerrar selector de emojis |
| `↑` `↓` `←` `→` (en selector) | Navegar emojis |
| `Enter` (en selector) | Insertar emoji y cerrar |
| `Esc` / `:` (en selector) | Cerrar sin insertar |
| `0`–`9` (en selector) | Cambiar página de emojis |
| Escribir + `Enter` | Enviar mensaje |
| `Backspace` | Borrar |
| `Esc` (en chat sin selección) | Limpiar entrada |
| `Esc` (con mensaje elegido) | Cancelar selección de mensaje |
| `Ctrl+C` | Salir |

## 5. Puntos de entrada y archivos clave

| Archivo | Rol |
|---------|-----|
| `chatui.js` | **Único punto de entrada**; contiene TUI, conexión WhatsApp, modelo de datos, render, teclado, descarga de media, selector de emojis |
| `store.json` | Persistencia de chats, contactos, mensajes, mapeo LID↔PN |
| `auth_info/` | Credenciales y estado de sesión de Baileys (clave para no re-vincular) |
| `incoming.log` | Log línea a línea de `messages.upsert` (ver recepción) |
| `baileys.log` | Errores internos de Baileys (descifrado, reintentos, conexión) |
| `media/` | Archivos multimedia descargados (`<hash>.jpg|mp4|pdf...`) |

## 6. Configuración

| Variable | Descripción | Obligatoria |
|----------|-------------|-------------|
| `DEMO` | `1` = usa contactos de ejemplo; vacío/ausente = contactos reales | No |
| `DUMP` | Cualquier valor = vuelca un frame estático y sale (para tests) | No |
| `COLS` | Ancho terminal simulado en `DUMP` (default 100) | No |
| `ROWS` | Alto terminal simulado en `DUMP` (default 30) | No |
| `QR_WIDTH` | Ancho en px del `qr.png` generado (default 320) | No |

> Sin valores secretos: la sesión vive en `auth_info/`. No hay `.env`.

## 7. Estado y trabajo en curso

- **Rama / último commit:** (no es repo git; trabajo directo en archivos)
- **Pendientes / próximos pasos:**
  - (opcional) Re-vincular una vez (`rm -rf auth_info store.json`) para traer historial completo y nombres de todos los contactos
  - (opcional) Notificación sonora o `notify-send` al recibir mensaje en otro chat
- **Limitaciones conocidas:**
  - WhatsApp **no reenvía historial** a dispositivos ya vinculados; solo llegan mensajes nuevos tras el vinculado
  - Solo **una instancia a la vez** (código 440 `connectionReplaced` si hay dos)
  - Emojis requieren terminal con fuentes que los rendericen (Noto Color Emoji, etc.)
  - No hay visor gráfico en la TUI; las imágenes se guardan en `media/` y se abre con herramienta externa

## 8. Convenciones y notas

- **Paleta fija** (truecolor ANSI):
  - `BG` `#080B0E` — fondo
  - `SURFACE` `#0D1117` — superficies/paneles
  - `GREEN` `#39E58C` — verde terminal (nombres, enviados, activo)
  - `BLUE` `#3A99FF` — azul selector emojis (cursor)
  - `RECV` `#D0D7E2` — gris claro (recibidos)
  - `MUTED` `#8291A8` — gris azulado (horas, estado, placeholder)
  - `BORDER` `#2E3A4A` — líneas finas
  - `SEL_BG` `#102C22` — selección (verde oscuro translúcido)
- **Sin dependencias pesadas** fuera de `node_modules/`
- **Limpieza al salir:** `cleanup()` restaura terminal (`\x1b[?1049l\x1b[?25h\x1b[0m`), cierra socket
- **Auto-guardado:** `store.json` se escribe con debounce 400 ms tras cambios

## 9. Advertencias

- **Riesgo de ban:** Cliente no oficial → viola ToS de WhatsApp. El usuario aceptó el riesgo.
- **`auth_info/` y `store.json` son sensibles:** contienen claves de sesión y mensajes. No subir a repos públicos.
- **`baileys.log` e `incoming.log` crecen:** rotar o limpiar periódicamente si se usa en producción.
- **`msgdump.jsonl`** se genera solo en modo debug (tiene `message` completo); puede ser grande.
- **Re-vinculado necesario para historial completo:** si faltan contactos/chats antiguos, borrar `auth_info/` y `store.json` y volver a escanear QR.
- **Node 24+:** `pino.destination({sync:false})` lanza warning `sonic boom is not ready yet` al cerrar; inofensivo.