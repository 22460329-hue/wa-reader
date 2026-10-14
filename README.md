# wa-reader

WhatsApp en la terminal (TUI) para Linux. Lee y responde mensajes desde tu número personal, con estética de terminal oscura, fotos dentro del chat y pestañas para Chats, Contactos y Estados. Sin navegador: usa [Baileys](https://github.com/WhiskeySockets/Baileys) (WebSocket puro).

## Características

- 💬 **Chats, Contactos y Estados** en pestañas (`Tab`), con recuadros y tu ubicación siempre visible
- 🫧 Burbujas estilo WhatsApp, chip de fecha (HOY/AYER) y caja de prompt con botón `➤`
- 🖼️ **Fotos y stickers dentro del chat** (terminal Kitty), miniaturas de video
- 📎 **Enviar** fotos, videos, documentos, audios y stickers (`Ctrl+F` o `/img /video /doc /audio /sticker <ruta>`)
- ↩️ Responder citando (`Ctrl+R`), borrar en 2 pasos (`Supr`), ver en visor externo (`Ctrl+O`) o reproducir en terminal (`Ctrl+P` con mpv)
- 📁 Descargas organizadas por contacto en `media/<Nombre>/`
- ⌨️ Rueda del ratón / touch para subir y bajar por los mensajes

## Requisitos

- Node.js ≥ 18
- Terminal con truecolor. Para fotos dentro del chat: [Kitty](https://sw.kovidgoyal.net/kitty/).
- Opcional: `mpv` (video en terminal), `ffmpeg` (miniaturas y stickers), visor de imágenes (`xdg-open`).

## Instalación

```bash
git clone https://github.com/22460329-hue/wa-reader.git
cd wa-reader
npm install
```

En Arch Linux también habrá paquete AUR (`wa-reader`): `yay -S wa-reader` y arranca con el comando `wa-reader` (guarda tus datos en `~/.local/share/wa-reader`).

## Uso

```bash
npm start
# o: node chatui.js
```

La primera vez sale el **QR en la pantalla**: escanéalo desde WhatsApp (⋮ > Dispositivos vinculados > Vincular dispositivo) y entras directo a tus chats. La sesión queda guardada (en `auth_info/` o `~/.local/share/wa-reader/`) para no escanear de nuevo.

```bash
# Probar la interfaz sin vincular (datos de ejemplo)
DEMO=1 npm start
```

## Controles

| Tecla | Acción |
|-------|--------|
| `↑` `↓` | Cambiar de chat (la selección no se mueve sola al llegar mensajes) |
| `Tab` / `Shift+Tab` | Pestañas: Chats / Contactos / Estados |
| Rueda / touch | Subir y bajar por los mensajes (`↑hist` = estás arriba) |
| Escribir + `Enter` | Enviar al chat visible en la caja |
| `←` `→` `Inicio` `Fin` | Mover el cursor en la caja (editar en medio del texto) |
| `Ctrl+R` | Responder citando el mensaje elegido (`AvPag` o el último) |
| `AvPag` `RePag` o `Ctrl+↑` `Ctrl+↓` | Elegir mensaje dentro del chat |
| `Supr` o `Ctrl+D` | Con texto: borra letra; vacía: borra mensaje en 2 pasos (tuyo = para todos) |
| `Ctrl+O` | Abrir foto/video/sticker en tu visor |
| `Ctrl+P` | Reproducir video/audio/imagen en la terminal (mpv, `q` para salir) |
| `Ctrl+F` | Adjuntar archivo (selector → pie opcional → `Enter`) |
| `/img /video /doc /audio /sticker <ruta> [texto]` | Enviar archivo directo |
| `:` | Emojis (`Enter` inserta, `Esc` cierra, `0-9` páginas) |
| `Esc` | Cancelar (respuesta, borrado, adjunto, selección) o limpiar entrada |
| `Ctrl+C` | Salir |

## Notas

- ⚠️ Cliente no oficial: usarlo viola los Términos de WhatsApp y tu número podría ser sancionado. Úsalo bajo tu responsabilidad.
- Solo **una instancia** a la vez (otra sesión la reemplaza).
- WhatsApp no reenvía historial a sesiones vinculadas: verás mensajes y estados nuevos desde que lo abras.
- Los enlaces de fotos viejas caducan: lo nuevo se descarga solo; lo viejo muestra `↓`/`⚠` y se reintenta al abrir el chat.
- `auth_info/` y `store.json` son sensibles: están en `.gitignore`, no los subas.

## Actualizar

Con git (conserva tu sesión y tus chats):

```bash
cd wa-reader
git pull
npm install
```

Con AUR: `yay -Su` como cualquier programa.

## Licencia

MIT — ver [LICENSE](LICENSE).
