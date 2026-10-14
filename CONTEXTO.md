# Contexto del Proyecto: wa-reader

> Documento portable para retomar el proyecto en otro chat o herramienta.
> Actualizado: 2026-10-14 · Idioma: español

## 1. Resumen

Cliente de WhatsApp **100 % en la terminal** (TUI) para Linux: lee y responde mensajes del número personal con **Baileys** (WebSocket puro, sin navegador). Pestañas Chats / Contactos / Estados con recuadros arriba y ubicación `Ventana › Chat`; burbujas estilo WhatsApp, chip HOY/AYER, caja de prompt con botón ➤; fotos/stickers inline (Kitty), videos con miniatura + mpv; envío de archivos, respuesta citando (incluye historias), borrado en 2 pasos, clic de ratón + rueda, fotos de perfil e iniciales de color.

**Estado actual:** funcional en uso diario. Repo público `github.com/22460329-hue/wa-reader` (master, tag `v1.0.0`). AUR listo en `packaging/` sin publicar. Trabajo local SIN subir (órdenes vigentes).

## 2. Stack y tecnologías

| Área | Tecnología / versión |
|------|----------------------|
| Lenguaje | Node.js ≥ 18 (ESM, un solo archivo) |
| Framework WhatsApp | `@whiskeysockets/baileys` 7.0.0-rc14 |
| Logging | `pino` (errores a `baileys.log`) |
| QR | `qrcode` (`qr.png`) + `qrcode-terminal` (QR en pantalla al vincular) |
| Terminal | ANSI truecolor 24-bit, raw mode, alt screen, ratón SGR 1000+1006 |
| Imágenes inline | Kitty graphics protocol (`a=t`/`a=p`/`a=d`), miniaturas ffmpeg, dimensiones ffprobe |
| Externos opcionales | `mpv` (video en terminal, `--vo=kitty`/`tct`), `ffmpeg`, visor vía `xdg-open` |

## 3. Estructura

```text
wa-reader/
├── chatui.js                  # ÚNICO archivo funcional (~2400 líneas: TUI, socket, modelo, render, teclas, media)
├── package.json               # scripts: start / demo ; engines node>=18 ; license MIT
├── package-lock.json
├── README.md / LICENSE (MIT) / .gitignore
├── CONTEXTO.md                # este documento
├── packaging/aur/             # PKGBUILD + .SRCINFO + wa-reader.sh (launcher con WA_DATA_DIR)
├── auth_info/                 # Sesión Baileys (SENSIBLE, gitignored)
├── store.json                 # chats, contactos, mensajes, lidMap, statuses (SENSIBLE, gitignored)
├── media/                     # <Nombre>/ por contacto + avatars/ (gitignored)
├── incoming.log               # messages.upsert + fallos `media fail` (gitignored)
├── baileys.log                # errores Baileys (gitignored)
├── msgdump.jsonl              # dump crudo multimedia (gitignored)
└── qr.png                     # QR de vinculación (gitignored)
```

## 4. Cómo ejecutar

### Requisitos
- Node.js ≥ 18, terminal truecolor con TTY real.
- Fotos inline: **Kitty** (sin tmux, o `WA_GFX=1` con passthrough). En otra terminal: texto + `Ctrl+O`.
- Opcional: `mpv`, `ffmpeg`/`ffprobe`, `xdg-open`.
- Primera vez: escanear QR que sale en pantalla (`linkFlow()` si no hay `auth_info/creds.json`).

### Instalación
```bash
git clone https://github.com/22460329-hue/wa-reader.git
cd wa-reader
npm install
```

### Ejecución / comandos principales
```bash
npm start            # o: node chatui.js (contactos reales)
npm run demo         # DEMO=1: datos de ejemplo sin vincular

# Volcado estático para depuración (sin TTY) + ganchos de prueba:
DEMO=1 DUMP=1 COLS=100 ROWS=26 node chatui.js
DUMP=1 TAB=status|chats|contacts SEL=texto MSGSEL=n MSGOFF=n INPUT=txt CURSOR=n CLICK=x,y ATTACH=1 TOAST=txt node chatui.js
```

**Controles:**
| Tecla | Acción |
|-------|--------|
| `↑` `↓` o clic | Cambiar de chat (selección fijada por JID: no te saca ni desvía envíos) |
| `Tab` / `Shift+Tab` o clic | Pestañas Chats / Contactos / Estados (cada una recuerda selección) |
| Clic | Chats, pestañas, elegir mensaje (2.º clic en foto la abre), iconos 🙂📎, enviar con ➤ |
| Rueda / touch | Subir/bajar mensajes (`↑hist` = estás arriba; Shift para copiar) |
| Escribir + `Enter` | Enviar (en Estados responde a su última historia por su chat) |
| `←` `→` `Inicio` `Fin` `Ctrl+A/E` | Mover cursor en la caja (vacía en Estados: elegir estado) |
| `Backspace` / `Supr` (con texto) | Borrar atrás / adelante en el cursor |
| `AvPag` `RePag` / `Ctrl+↑` `Ctrl+↓` | Elegir mensaje en el chat |
| `Supr` / `Ctrl+D` (caja vacía) | Borrar en 2 pasos (armar + confirmar; `Esc` cancela; propio = para todos) |
| `Ctrl+R` | Responder citando lo elegido (cita reconstruida si salió de caché) |
| `Alt+R` (en su chat) | Responder a su última historia sin ir a Estados |
| `Ctrl+O` / `Ctrl+P` | Abrir en visor / reproducir en terminal con mpv (`q` sale) |
| `Ctrl+F` | Adjuntar (selector → pie → `Enter`); `/img /video /doc /audio /sticker <ruta> [texto]` directo |
| `:` | Emojis (`Enter` inserta en cursor, `Esc` cierra, `0-9` páginas) |
| `Esc` | Cancela en orden: respuesta, borrado, adjunto, selección; si no, limpia entrada |
| `Ctrl+C` | Salir (restaura terminal y desactiva ratón) |

## 5. Puntos de entrada y archivos clave

| Archivo | Rol |
|---------|-----|
| `chatui.js` | Todo: `linkFlow` (QR fresco), `start` (socket+eventos), modelo (`recordMessage`/`recordStatus`), render (topbar/burbujas/compositor/overlays/gfx), teclado+ratón, `downloadMedia` (crudo+`directPath`+reupload), `thumbFor` async, `openMediaSelected`/`playMediaTerminal`, `sendFile`/`sendText`, adjuntos, stickers ffmpeg |
| `store.json` | chats, contacts, lidMap, statuses (con `media`, `mediaPath`, `dim`, `dlFail`) |
| `media/<Nombre>/` + `media/avatars/` | Descargas por contacto; `.jpg`+`.s.png` de perfil; `.thumb.png` de vistas |
| `incoming.log` / `baileys.log` | Diagnóstico (`media fail id=…`, decrypt errors de grupos) |
| `packaging/aur/` | `PKGBUILD` (sha256 real del tag), `.SRCINFO`, `wa-reader.sh` (datos en `~/.local/share/wa-reader`) |

## 6. Configuración

| Variable | Descripción | Obligatoria |
|----------|-------------|-------------|
| `WA_DATA_DIR` | Datos (sesión, store, media, logs). Default `.` | No |
| `WA_AUTH_DIR` | Sesión (default `<DATA_DIR>/auth_info`) | No |
| `WA_GFX` | `1` = fuerza inline (tmux con passthrough) | No |
| `WA_FULLDRAW` | `1` = `2J` siempre (diagnóstico; con parpadeo) | No |
| `DEMO` / `DUMP` / `COLS` / `ROWS` / `QR_WIDTH` | Demo, volcado, tamaño simulado, ancho QR (320) | No |
| `SEL` `TAB` `MSGSEL` `MSGOFF` `INPUT` `CURSOR` `CLICK` `ATTACH` `TOAST` | Solo `DUMP` (ver §4) | No |

> Sin secretos en archivos: la sesión vive en `auth_info/`. No hay `.env`.

## 7. Estado y trabajo en curso

- **Rama / último commit:** `master` limpio en `github.com/22460329-hue/wa-reader`, tag `v1.0.0`. Local con cambios SIN commitear (topbar reescrita, `WA_FULLDRAW`, `TOAST`, `buildQuote`, `Alt+R`, clic) — **no subir sin aviso**.
- **Pendientes / próximos pasos:**
  - Publicar AUR (requiere llave SSH del dueño en su cuenta).
  - (por confirmar) Topbar invisible en vivo para el dueño pese a DUMP perfecto: bytes verificados en 3 pestañas, 26 líneas exactas, datos reales. Hipótesis abiertas: proceso vivo desactualizado o fuente/fuente-terminal. Gancho `TOAST` agregado para pruebas.
  - (opcional) `notify-send` al recibir mensaje en otro chat.
- **Limitaciones conocidas:**
  - Sin reenvío de historial a sesiones vinculadas; enlaces de fotos viejas caducan (`↓`→`⚠`, reintento `Ctrl+O`/auto).
  - Una instancia a la vez (440 `connectionReplaced`).
  - Cuota gfx del terminal 320MB LRU: refresco 25 s + keepalive 25 s + re-transmit al navegar.
  - Lo propio borrado "para todos" no se recupera.

## 8. Convenciones y notas

- **Paleta:** `BG #080B0E`, `SURFACE #0D1117`, `GREEN #39E58C`, `BLUE #3A99FF`, `RECV #D0D7E2`, `MUTED #8291A8`, `BORDER #2E3A4A`, `SEL_BG #102C22`, burbujas `B_OUT #005C4B` / `B_IN #1F2C34` / texto `#E9EDEF`, iniciales `AV_COLORS` (8).
- **Render bajo demanda:** blink solo redibuja con aviso/reloj; si no, `caretTick` (1 celda); keepalive 25 s si hay fotos.
- **Regla de oro de filas:** ningún texto con `\n` llega a una fila (`cleanName` en nombres, `setToast` limpia avisos, `wrap`/`replace` en mensajes). Una fila partida = scroll = menú fuera. Verificado con 11 mensajes reales con `\n`.
- **Layout exacto:** siempre `rows` líneas (con aviso se omite la última fila); `ELK` al final de cada línea; `2J` solo al redimensionar/navegar/primer frame; `a=d` conserva datos, `gfxIds.clear()` en frames con `2J`.
- **Selección estable por JID** (`selJid`); scroll mensajes `msgOff` recortado; borrado armado `delArm` 5 s; citas `buildQuote`; LID↔PN en `lidMap`.
- **Ratón SGR 1006:** rueda = mensajes; clic = chats/pestañas/mensajes/iconos/➤; respuestas gfx `ESC_G` se ignoran sin redibujar; Shift para copiar.
- **Auto-guardado** `store.json` con debounce 400 ms; `dlFail` se limpia al cargar.
- **Commits:** los hace el dueño (`jjceja`-handle `22460329-hue`, noreply). Tokens usados ya: revocar en `github.com/settings/tokens`.

## 9. Advertencias

- **Riesgo de ban:** cliente no oficial, viola ToS de WhatsApp. Proyecto solo-puente, sin afiliación con WhatsApp/Meta (ver README aviso legal).
- **`auth_info/` y `store.json` son sensibles** (gitignored). Verificado 2026-10-14: **ningún token/secreto** en archivos versionados.
- **`baileys.log` e `incoming.log` crecen**; `msgdump.jsonl` puede ser grande.
- **Re-vinculado para historial completo:** borrar `auth_info/` + `store.json` y re-escanear.
- **Node 24+:** warning `sonic boom is not ready yet` al cerrar (inofensivo, solo DUMP).
