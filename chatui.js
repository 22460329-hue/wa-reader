import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestWaWebVersion,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import qrcodeTerm from "qrcode-terminal";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { spawn, spawnSync } from "node:child_process";

const logger = pino({ level: "error" }, pino.destination({ dest: "baileys.log", sync: false }));

// =====================================================================
// chatui.js — WhatsApp en la terminal (ver README.md).
//
//   Arriba: ventanas Chats / Contactos / Estados + tu ubicación.
//   Izquierda: lista de la pestaña (nombre / vista previa / hora).
//   Derecha: burbujas estilo WhatsApp + caja de prompt con botón ➤.
//
// Uso:  npm start               (contactos reales)
//       npm run demo            (datos de ejemplo para ver el diseño)
//
//   ↑ / ↓      cambiar de chat (te quedas dentro hasta que cambies tú)
//   Tab        cambiar de pestaña: Chats / Contactos / Estados
//   ← → / Inicio / Fin  mover el cursor en la caja (vacía en Estados: pasar estados)
//   AvPag/RePag o Ctrl+↑/Ctrl+↓  elegir mensaje dentro del chat
//   Supr o Ctrl+D  borrar elegido (tuyo=para todos, ajeno=solo local)
//   Ctrl+O     ver sticker/imagen/video (abre el archivo con tu visor)
//   Ctrl+P     reproducir video/audio/imagen en la terminal con mpv
//   Ctrl+R     responder citando el mensaje elegido (luego Enter envía)
//   Ctrl+F     adjuntar archivo (selector) o escribe /img /video /doc /audio /sticker <ruta> [texto]
//   Estados    ver estados con fotos inline (solo lectura; Ctrl+R responde por chat)
//   texto      escribir (siempre se envía al chat visible en el encabezado)
//   Enter      enviar al chat activo
//   Backspace  borrar
//   Esc        cancelar selección de mensaje, o limpiar entrada
//   Ctrl+C     salir
//
// Una sola instancia a la vez. Usa la sesión en auth_info/.
// =====================================================================

const DATA_DIR = process.env.WA_DATA_DIR || ".";
const STORE_FILE = path.join(DATA_DIR, "store.json");
const LOG_FILE = path.join(DATA_DIR, "incoming.log");
const DUMP_FILE = path.join(DATA_DIR, "msgdump.jsonl");
const QR_FILE = path.join(DATA_DIR, "qr.png");
const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(DATA_DIR, "auth_info");
const MAX_MSGS_PER_CHAT = 200;

const chats = new Map();
const contacts = new Map();
const lidMap = new Map(); // @lid <-> @s.whatsapp.net
const statusMap = new Map(); // autorJid -> { author, name, items: [], lastTs, unread } (estados 24h)
let sock = null;
let connectGen = 0;
let saveTimer = null;
let reconnecting = false;
let connected = false;

// caché de mensajes crudos + contador de reintentos (necesarios para que
// Baileys pueda re-descifrar/reenviar mensajes que fallan al primer intento)
const msgCache = new Map();
const msgRetryCounterCache = {
  _m: new Map(),
  get(k) {
    return this._m.get(k);
  },
  set(k, v) {
    this._m.set(k, v);
    if (this._m.size > 2000) this._m.delete(this._m.keys().next().value);
  },
  del(k) {
    this._m.delete(k);
  },
  flushAll() {
    this._m.clear();
  },
};
function cacheMsg(msg) {
  if (!msg?.key?.id) return;
  msgCache.set(msg.key.id, { key: msg.key, message: msg.message });
  if (msgCache.size > 800) {
    const first = msgCache.keys().next().value;
    if (first) msgCache.delete(first);
  }
}

// ---------------- ANSI / paleta ----------------
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const fg = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const bg = (r, g, b) => `\x1b[48;2;${r};${g};${b}m`;

const BG = [8, 11, 14]; // #080B0E fondo casi negro
const SURFACE = [13, 17, 23]; // #0D1117 negro carbón
const GREEN = [57, 229, 140]; // #39E58C verde terminal
const BLUE = [58, 153, 255]; // #3A99FF azul para selector de emojis
const SEL_BG = [16, 44, 34]; // verde oscuro "translúcido"
const RECV = [208, 215, 226]; // #D0D7E2 gris claro
const MUTED = [130, 145, 168]; // #8291A8 gris azulado
const BORDER = [46, 58, 74]; // líneas finas gris azulado
const B_IN = [31, 44, 52]; // burbuja entrante (gris WhatsApp)
const B_OUT = [0, 92, 75]; // burbuja propia (verde WhatsApp)
const B_TXT = [233, 237, 237]; // texto sobre burbuja

// ---------------- utilidades ----------------
function isEmoji(c) {
  return (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x2600 && c <= 0x27bf) || (c >= 0x1f000 && c <= 0x1f2ff);
}
function vwidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c === 0xfe0f || c === 0x200d) continue;
    w += isEmoji(c) ? 2 : 1;
  }
  return w;
}
function clampPad(s, width, align = "left") {
  s = String(s);
  if (vwidth(s) > width) {
    let out = "";
    for (const ch of s) {
      if (vwidth(out + ch) > width - 1) break;
      out += ch;
    }
    s = out + "…";
  }
  const diff = Math.max(0, width - vwidth(s));
  if (align === "right") return " ".repeat(diff) + s;
  if (align === "center") {
    const l = Math.floor(diff / 2);
    return " ".repeat(l) + s + " ".repeat(diff - l);
  }
  return s + " ".repeat(diff);
}
const cpsArr = (s) => [...String(s)];
function clampCur() {
  const n = cpsArr(ui.input).length;
  if (ui.cursor == null) ui.cursor = n;
  if (ui.cursor < 0) ui.cursor = 0;
  if (ui.cursor > n) ui.cursor = n;
}
function insertAtCursor(s) {
  const a = cpsArr(ui.input);
  clampCur();
  const ins = cpsArr(s);
  ui.input = a.slice(0, ui.cursor).join("") + ins.join("") + a.slice(ui.cursor).join("");
  ui.cursor += ins.length;
}
function backspaceAtCursor() {
  const a = cpsArr(ui.input);
  clampCur();
  if (ui.cursor <= 0) return;
  a.splice(ui.cursor - 1, 1);
  ui.input = a.join("");
  ui.cursor--;
}
function deleteAtCursor() {
  const a = cpsArr(ui.input);
  clampCur();
  if (ui.cursor >= a.length) return;
  a.splice(ui.cursor, 1);
  ui.input = a.join("");
}
function paint(text, { b, color, bgc } = {}) {
  let pre = "";
  if (b) pre += BOLD;
  if (color) pre += fg(...color);
  if (bgc) pre += bg(...bgc);
  return pre + text + RESET;
}
// una celda: recorta/rellena y colorea (siempre con fondo)
function cell(text, w, color, bgc, b, align) {
  return paint(clampPad(text, w, align), { b, color, bgc });
}
function row(segs) {
  return segs.map((s) => cell(s.text ?? "", s.w, s.fg, s.bg ?? BG, s.b, s.align)).join("");
}

// ---------------- modelo ----------------
function alias(jid) {
  return jid ? lidMap.get(jid) : undefined;
}
function chatFor(jid) {
  if (!jid) return undefined;
  return chats.get(jid) || chats.get(alias(jid));
}
function resolveKnown(jid, alt) {
  for (const x of [jid, alt]) {
    if (!x) continue;
    if (x === "status@broadcast") return null;
    if (chats.has(x) || contacts.has(x)) return x;
  }
  return jid || alt || null;
}
function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    for (const c of Object.values(raw.chats || {})) chats.set(c.jid, c);
    for (const [jid, name] of Object.entries(raw.contacts || {})) contacts.set(jid, name);
    if (raw.lidMap) for (const [a, b] of Object.entries(raw.lidMap)) lidMap.set(a, b);
    if (raw.statuses) for (const [a, e] of Object.entries(raw.statuses)) statusMap.set(a, e);
    for (const c of chats.values()) for (const m of c.messages || []) { delete m.dlFail; delete m.dlFailTs; }
    for (const e of statusMap.values()) for (const m of e.items || []) { delete m.dlFail; delete m.dlFailTs; }
  } catch {}
}
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(
      STORE_FILE,
      JSON.stringify({
        chats: Object.fromEntries(chats),
        contacts: Object.fromEntries(contacts),
        lidMap: Object.fromEntries(lidMap),
        statuses: Object.fromEntries(statusMap),
      }),
      () => {},
    );
  }, 400);
}
const MEDIA_DIR = path.join(DATA_DIR, "media");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
function safeDirName(s) {
  const d = String(s ?? "").replace(/[\/\\:*?"<>|\0-\x1f\x7f]/g, "_").replace(/^\.+/, "").trim().replace(/[. ]+$/, "").slice(0, 60);
  return d || "sin-nombre";
}
// Carpeta por contacto/chat: media/<Nombre>/ (desempata con dígitos si dos contactos se llaman igual)
function mediaDirFor(remoteJid, mediaInfo) {
  let ownerJid = remoteJid, name = null;
  if (remoteJid === "status@broadcast" && mediaInfo?.author) {
    ownerJid = mediaInfo.author;
    name = statusMap.get(ownerJid)?.name || contacts.get(ownerJid) || contacts.get(alias(ownerJid));
  }
  if (!name) name = nameFor(remoteJid === "status@broadcast" ? ownerJid : remoteJid);
  const base = safeDirName(name);
  const short = String(ownerJid).split("@")[0].replace(/\D/g, "").slice(-6) || "chat";
  let dir = `${MEDIA_DIR}/${base}`;
  try {
    if (fs.existsSync(`${dir}/.jid`)) {
      const prev = fs.readFileSync(`${dir}/.jid`, "utf8").trim();
      if (prev && prev !== ownerJid) dir = `${MEDIA_DIR}/${base}__${short}`;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/.jid`, ownerJid);
  } catch { dir = MEDIA_DIR; }
  return dir;
}
async function downloadMedia(msgId, mediaInfo) {
  if (!msgId || !mediaInfo || !sock) return null;
  // El mensaje crudo (con directPath/mediaKey) es lo que Baileys necesita.
  // 1) caché en memoria de esta sesión; 2) reconstruido desde store.json.
  let raw = msgCache.get(msgId);
  if (!raw?.message) {
    const inner = {
      url: mediaInfo.url,
      directPath: mediaInfo.directPath,
      mediaKey: mediaInfo.mediaKey,
      mimetype: mediaInfo.mimetype,
      fileSha256: mediaInfo.sha256,
      fileLength: mediaInfo.fileLength,
    };
    const c = mediaInfo.remoteJid ? chatFor(mediaInfo.remoteJid) : null;
    const orig = c?.messages?.find((x) => x.id === msgId) || findStatusItem(msgId);
    raw = {
      key: {
        remoteJid: mediaInfo.remoteJid,
        fromMe: !!orig?.fromMe,
        id: msgId,
        ...(orig?.participant ? { participant: orig.participant } : {}),
      },
      message: { [`${mediaInfo.type}Message`]: inner },
    };
  }
  try {
    const buffer = await downloadMediaMessage(raw, "buffer", {}, {
      logger,
      reuploadRequest: sock.updateMediaMessage,
    });
    const ext = (mediaInfo.mimetype || "").split(";")[0].split("/")[1] || "bin";
    const hash = mediaInfo.sha256
      ? Buffer.from(mediaInfo.sha256).toString("hex").slice(0, 16)
      : `${Date.now()}`;
    const file = `${mediaDirFor(mediaInfo.remoteJid, mediaInfo)}/${hash}.${ext}`;
    fs.writeFileSync(file, buffer);
    return file;
  } catch (e) {
    logLine(`media fail id=${msgId} type=${mediaInfo.type} err=${e.message || e}`);
    return null;
  }
}
// ---------------- imágenes en la terminal (protocolo gráfico de Kitty) ----------------
const IN_TMUX = !!(process.env.TMUX || /^(screen|tmux)/.test(process.env.TERM || ""));
const KITTY_GFX = process.env.WA_GFX === "1" ? true : (!!(process.env.KITTY_WINDOW_ID || process.env.TERM === "xterm-kitty") && !IN_TMUX);
const IMG_ROWS = 10; // alto reservado en celdas para cada foto/video
const gfxIds = new Map(); // archivo -> id de imagen transmitida
let gfxNextId = 1;
let gfxQueue = []; // secuencias de transmisión pendientes del frame actual
// Miniatura PNG (480px) junto al original; null si no se puede (no-kitty, sin ffmpeg…)
const thumbFail = new Set(); // archivos que ya fallaron: no reintentar en la sesión (no trabar el render)
function thumbFor(m) {
  if (!KITTY_GFX || !m?.mediaPath) return null;
  const t = m.media?.type;
  if (t !== "image" && t !== "video" && t !== "sticker") return null;
  if (thumbFail.has(m.mediaPath)) return null;
  const tp = `${m.mediaPath}.thumb.png`;
  try {
    if (fs.existsSync(tp)) return tp;
  } catch { return null; }
  try {
    if (fs.statSync(m.mediaPath).size > 60 * 1024 * 1024) return null; // muy pesado: solo Ctrl+P
  } catch { return null; }
  try {
    const args = t === "video"
      ? ["-y", "-v", "error", "-ss", "1", "-i", m.mediaPath, "-vframes", "1", "-vf", "scale=480:-2", tp]
      : ["-y", "-v", "error", "-i", m.mediaPath, "-vf", "scale=480:-2", tp];
    const r = spawnSync("ffmpeg", args, { stdio: "ignore", timeout: 20000 });
    if (r?.status === 0 && fs.existsSync(tp)) return tp;
  } catch {}
  thumbFail.add(m.mediaPath);
  return null;
}
// Transmite el PNG una vez por sesión; devuelve su id (encola los datos al frame)
function gfxEnsure(file) {
  if (gfxIds.has(file)) return gfxIds.get(file);
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (!buf?.length || buf.length > 5 * 1024 * 1024) return null;
  const id = gfxNextId++;
  const b64 = buf.toString("base64");
  for (let i = 0; i < b64.length; i += 4096) {
    const last = i + 4096 >= b64.length;
    gfxQueue.push(`\x1b_Ga=t,i=${id},f=100,m=${last ? 0 : 1};${b64.slice(i, i + 4096)}\x1b\\`);
  }
  gfxIds.set(file, id);
  return id;
}
// Reintenta descargar lo visible que aún no bajó (fotos viejas al abrir el chat)
const dlInflight = new Set();
let lastEnsure = 0;
function ensureVisibleMedia() {
  if (!sock || !connected || suspended) return;
  const now = Date.now();
  if (now - lastEnsure < 5000) return;
  lastEnsure = now;
  const active = getActive();
  if (!active || String(active.jid).endsWith("@demo")) return;
  const { msgs } = activeMessages(active);
  let running = dlInflight.size;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (running >= 3) break; // máx 3 descargas a la vez (no trabar la terminal)
    const m = msgs[i];
    if (!m?.media || m.mediaPath || !m.id || dlInflight.has(m.id)) continue;
    if (m.dlFail && now - (m.dlFailTs || 0) < 10 * 60 * 1000) continue; // reintentar fallos cada 10 min
    running++;
    dlInflight.add(m.id);
    downloadMedia(m.id, m.media).then((file) => {
      dlInflight.delete(m.id);
      if (file) {
        m.mediaPath = file;
        m.dlFail = false;
        saveStore();
        draw();
      } else {
        m.dlFail = true;
        m.dlFailTs = Date.now();
        draw();
      }
    });
  }
}
const isGroupJid = (jid) => String(jid).endsWith("@g.us");
function ensureChat(jid, name) {
  let c = chats.get(jid);
  if (!c) {
    c = { jid, name: name || null, isGroup: isGroupJid(jid), messages: [], lastTs: 0 };
    chats.set(jid, c);
  }
  if (name) c.name = name;
  return c;
}
function nameFor(jid) {
  if (!jid) return "(ninguno)";
  const c = chats.get(jid) || chats.get(alias(jid));
  if (c?.name) return c.name;
  if (contacts.get(jid)) return contacts.get(jid);
  if (contacts.get(alias(jid))) return contacts.get(alias(jid));
  return String(jid).split("@")[0];
}
function extractText(message) {
  if (!message) return null;
  let m = message;
  for (let i = 0; i < 6 && m; i++) {
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    else if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    else if (m.editedMessage?.message) m = m.editedMessage.message;
    else if (m.protocolMessage?.editedMessage) m = m.protocolMessage.editedMessage;
    else break;
  }
  if (!m) return null;
  const text = (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.buttonsResponseMessage?.selectedDisplayText ??
    m.templateButtonReplyMessage?.selectedDisplayText ??
    m.listResponseMessage?.title ??
    m.interactiveResponseMessage?.body?.text ??
    null
  );
  if (text) return text;
  // placeholders para multimedia sin caption
  if (m.imageMessage) return "[imagen]";
  if (m.videoMessage) return "[video]";
  if (m.documentMessage) return "[documento]";
  if (m.audioMessage) return "[audio]";
  if (m.stickerMessage) return "[sticker]";
  return null;
}
function logRaw(m) {
  try {
    const content = m.message;
    const keys = content ? Object.keys(content).join("|") : "-";
    const conv = content?.conversation;
    const ext = content?.extendedTextMessage?.text;
    fs.appendFileSync(
      LOG_FILE,
      `${new Date().toISOString()} fromMe=${!!m.key?.fromMe} jid=${m.key?.remoteJid} alt=${m.key?.remoteJidAlt || "-"} part=${m.key?.participant || "-"} keys=${keys} stub=${m.messageStubType || "-"} push=${m.pushName || "-"} conv=${JSON.stringify(conv).slice(0, 80)} ext=${JSON.stringify(ext).slice(0, 80)} text=${extractText(content) ? "yes" : "no"}\n`,
    );
    if (keys.includes("conversation") || keys.includes("extendedTextMessage")) {
      fs.appendFileSync(DUMP_FILE, JSON.stringify({ ts: Date.now(), jid: m.key?.remoteJid, fromMe: !!m.key?.fromMe, push: m.pushName, message: content }) + "\n");
    }
  } catch {}
}
function logLine(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [conn] ${msg}\n`);
  } catch {}
}
function getMediaInfo(message) {
  if (!message) return null;
  let m = message;
  for (let i = 0; i < 6 && m; i++) {
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    else if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    else if (m.editedMessage?.message) m = m.editedMessage.message;
    else if (m.protocolMessage?.editedMessage) m = m.protocolMessage.editedMessage;
    else break;
  }
  if (!m) return null;
  if (m.imageMessage) return { type: "image", mimetype: m.imageMessage.mimetype, url: m.imageMessage.url, directPath: m.imageMessage.directPath, sha256: m.imageMessage.fileSha256, mediaKey: m.imageMessage.mediaKey, fileLength: m.imageMessage.fileLength, caption: m.imageMessage.caption };
  if (m.videoMessage) return { type: "video", mimetype: m.videoMessage.mimetype, url: m.videoMessage.url, directPath: m.videoMessage.directPath, sha256: m.videoMessage.fileSha256, mediaKey: m.videoMessage.mediaKey, fileLength: m.videoMessage.fileLength, caption: m.videoMessage.caption };
  if (m.documentMessage) return { type: "document", mimetype: m.documentMessage.mimetype, url: m.documentMessage.url, directPath: m.documentMessage.directPath, sha256: m.documentMessage.fileSha256, mediaKey: m.documentMessage.mediaKey, fileLength: m.documentMessage.fileLength, caption: m.documentMessage.caption, fileName: m.documentMessage.fileName };
  if (m.audioMessage) return { type: "audio", mimetype: m.audioMessage.mimetype, url: m.audioMessage.url, directPath: m.audioMessage.directPath, sha256: m.audioMessage.fileSha256, mediaKey: m.audioMessage.mediaKey, fileLength: m.audioMessage.fileLength };
  if (m.stickerMessage) return { type: "sticker", mimetype: m.stickerMessage.mimetype, url: m.stickerMessage.url, directPath: m.stickerMessage.directPath, sha256: m.stickerMessage.fileSha256, mediaKey: m.stickerMessage.mediaKey, fileLength: m.stickerMessage.fileLength };
  return null;
}
function recordMessage(msg, { live = false } = {}) {
  if (!msg?.message) return null;
  cacheMsg(msg);
  const jid0 = msg.key?.remoteJid;
  const alt = msg.key?.remoteJidAlt;
  if (jid0 && alt && jid0 !== alt) {
    if (jid0.endsWith("@lid")) lidMap.set(jid0, alt);
    if (alt.endsWith("@lid")) lidMap.set(alt, jid0);
  }
  const jid = resolveKnown(jid0, alt);
  if (!jid || jid === "status@broadcast") return null;
  const content = msg.message;
  const text = extractText(content);
  const media = getMediaInfo(content);
  if (!text && !media) return null;
  const fromMe = !!msg.key.fromMe;
  const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) : Date.now() / 1000;
  const c = ensureChat(jid);
  if (!fromMe && !c.isGroup && msg.pushName) c.name = msg.pushName;
  if (msg.key.id && c.messages.some((m) => m.id === msg.key.id)) return c;
  c.lastTs = Math.max(c.lastTs || 0, ts);
  if (!fromMe) c.unread = (c.unread || 0) + 1;
  c.messages.push({ id: msg.key.id, fromMe, text: text || `[${media?.type || "archivo"}]`, ts, name: fromMe ? "tú" : msg.pushName || nameFor(jid), media: media ? { ...media, remoteJid: jid } : media, participant: msg.key?.participant || null, remoteJid: jid });
  if (c.messages.length > MAX_MSGS_PER_CHAT) c.messages.splice(0, c.messages.length - MAX_MSGS_PER_CHAT);
  if (live) saveStore();
  return c;
}
function contactList() {
  const byJid = new Map();
  const repKey = (jid0) => {
    const a = alias(jid0);
    if (byJid.has(jid0)) return jid0;
    if (a && byJid.has(a)) return a;
    return jid0;
  };
  function hasRealName(jid, name) {
    if (!name) return false;
    const plain = String(jid).split("@")[0];
    return name !== plain && !/^[\d\s\-+]+$/.test(name.trim());
  }
  // solo chats con historial real (mensajes o lastTs > 0)
  for (const c of chats.values()) {
    if (!c.jid || c.jid === "status@broadcast") continue;
    if (!hasRealName(c.jid, c.name)) continue;
    if (!c.lastTs && (!c.messages || c.messages.length === 0)) continue;
    const key = repKey(c.jid);
    if (!byJid.has(key)) byJid.set(key, { jid: key, name: c.name || nameFor(c.jid), lastTs: c.lastTs || 0 });
  }
  return [...byJid.values()].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0) || a.name.localeCompare(b.name));
}

// ---------------- estados (status@broadcast) ----------------
const STATUS_TTL = 24 * 3600; // WhatsApp caduca estados a las 24h
const statusJid = (author) => `status:${author}`;
const isStatusJid = (jid) => String(jid).startsWith("status:");
function recordStatus(msg, { live = false } = {}) {
  if (!msg?.message) return null;
  cacheMsg(msg);
  const fromMe = !!msg.key.fromMe;
  const author = msg.key?.participant || msg.key?.remoteJidAlt || (fromMe ? "me" : null);
  if (!author) return null;
  const content = msg.message;
  const text = extractText(content);
  const media = getMediaInfo(content);
  if (!text && !media) return null;
  const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) : Date.now() / 1000;
  let e = statusMap.get(author);
  if (!e) {
    e = { author, name: null, items: [], lastTs: 0, unread: 0 };
    statusMap.set(author, e);
  }
  const nm = msg.pushName || contacts.get(author) || contacts.get(alias(author));
  if (nm && !fromMe) e.name = nm;
  if (fromMe && !e.name) e.name = "tú";
  if (msg.key.id && e.items.some((m) => m.id === msg.key.id)) return e;
  e.lastTs = Math.max(e.lastTs || 0, ts);
  if (!fromMe) e.unread = (e.unread || 0) + 1;
  e.items.push({ id: msg.key.id, fromMe, text: text || `[${media?.type || "archivo"}]`, ts, name: fromMe ? "tú" : e.name || nm || author.split("@")[0], media: media ? { ...media, remoteJid: "status@broadcast", author } : media, participant: author, remoteJid: "status@broadcast" });
  if (e.items.length > 100) e.items.splice(0, e.items.length - 100);
  if (live) saveStore();
  return e;
}
function pruneStatuses() {
  const now = Date.now() / 1000;
  for (const [a, e] of statusMap) {
    e.items = (e.items || []).filter((m) => now - m.ts < STATUS_TTL);
    if (!e.items.length) statusMap.delete(a);
    else e.lastTs = e.items[e.items.length - 1].ts;
  }
}
function statusList() {
  pruneStatuses();
  return [...statusMap.values()]
    .map((e) => ({ jid: statusJid(e.author), name: `📖 ${e.name || e.author.split("@")[0]}`, lastTs: e.lastTs || 0, unread: e.unread || 0, isStatus: true, author: e.author, count: e.items.length }))
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
}
function findStatusItem(msgId) {
  for (const e of statusMap.values()) {
    const m = (e.items || []).find((x) => x.id === msgId);
    if (m) return m;
  }
  return null;
}

// ---------------- demo (para ver el diseño) ----------------
function seedDemo() {
  chats.clear();
  contacts.clear();
  const base = Date.now() / 1000;
  const data = [
    ["Priyanka", [["Hola, ¿cómo vas?", false], ["Todo bien, ¿y tú?", true], ["Nos vemos mañana entonces", false]]],
    ["Amigos", [["¿Salimos el sábado?", false], ["Va, yo llevo las bebidas", true]]],
    ["Familia", [["Ya llegué a casa", false], ["Perfecto, descansa", true], ["Te quiero", false]]],
    ["Luis", [["Te mandé el archivo", false], ["Recibido, gracias", true]]],
    ["Trabajo", [["La reunión es a las 10", false], ["Anotado", true]]],
  ];
  data.forEach(([name, msgs], i) => {
    const jid = `demo${i}@demo`;
    const c = ensureChat(jid, name);
    msgs.forEach(([text, fromMe], k) => {
      const ts = base - (msgs.length - k) * 300 + i * 10;
      c.messages.push({ id: `demo-${i}-${k}`, fromMe, text, ts, name: fromMe ? "tú" : name });
    });
    c.lastTs = c.messages[c.messages.length - 1].ts;
    contacts.set(jid, name);
  });
  // grupo de ejemplo
  const g = ensureChat("demo-grupo@g.us", "Equipo · Proyecto");
  g.isGroup = true;
  [["Ya subí los cambios", false], ["Perfecto, gracias", true], ["Reviso y te digo", false]].forEach(([text, fromMe], k, arr) => {
    const ts = base - (arr.length - k) * 300 + 40;
    g.messages.push({ id: `demo-g-${k}`, fromMe, text, ts, name: fromMe ? "tú" : "Luis" });
  });
  g.lastTs = g.messages[g.messages.length - 1].ts;
  // foto de ejemplo para probar la vista en terminal (Kitty + ffmpeg)
  const demoImg = path.join(MEDIA_DIR, "demo-foto.png");
  try {
    if (KITTY_GFX && !fs.existsSync(demoImg)) {
      spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=480x360:d=1", "-vframes", "1", demoImg], { timeout: 20000, stdio: "ignore" });
    }
    if (fs.existsSync(demoImg)) {
      const c0 = chats.get("demo0@demo");
      const ts = base + 5;
      c0.messages.push({ id: "demo-img-1", fromMe: false, text: "[imagen]", ts, name: "Priyanka", media: { type: "image", mimetype: "image/png", remoteJid: "demo0@demo" }, mediaPath: demoImg, participant: null, remoteJid: "demo0@demo" });
      c0.lastTs = ts;
    }
  } catch {}
  // estado de ejemplo
  statusMap.clear();
  const se = { author: "demostatus@demo", name: "Priyanka", items: [], lastTs: 0, unread: 1 };
  [["Buenos días ☀️", false], ["[imagen]", false]].forEach(([text, fromMe], k, arr) => {
    const ts = base - (arr.length - k) * 600;
    se.items.push({ id: `demo-s-${k}`, fromMe, text, ts, name: "Priyanka", media: k === 1 ? { type: "image", mimetype: "image/png", remoteJid: "status@broadcast", author: "demostatus@demo" } : null, mediaPath: k === 1 ? demoImg : null, participant: "demostatus@demo", remoteJid: "status@broadcast" });
  });
  se.lastTs = se.items[se.items.length - 1].ts;
  statusMap.set(se.author, se);
}

function fetchGroupName(s, jid) {
  const c = chats.get(jid) || chats.get(alias(jid));
  if (!c || c.name || !isGroupJid(jid)) return;
  s.groupMetadata(jid)
    .then((md) => {
      c.name = md.subject || c.name;
      c.participants = md.participants?.length;
      saveStore();
      draw();
    })
    .catch(() => {});
}
function fetchAllGroupNames(s) {
  for (const jid of chats.keys()) if (isGroupJid(jid)) fetchGroupName(s, jid);
}

// ---------------- estado ----------------
const EMOJIS = [
  "😀","😃","😄","😁","😆","😅","😂","🤣","😊","😇",
  "🙂","🙃","😉","😌","😍","🥰","😘","😗","😙","😚",
  "😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔",
  "🤐","🤨","😐","😑","😶","😏","😒","😞","😔","😟",
  "😕","🙁","☹️","😣","😖","😫","😩","🥺","😢","😭",
  "😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨",
  "😰","😥","😓","🤗","🤔","🤭","🤫","🤐","😷","🤒",
  "🤕","🤢","🤮","🤧","🥴","😵","🤯","🤠","🥳","😎",
  "🤓","🧐","😕","😟","🙁","☹️","😮","😯","😲","😳",
  "🥺","😦","😧","😨","😰","😥","😢","😭","😱","😖",
  "😣","😞","😓","😩","😫","🥱","😤","😡","😠","🤬",
  "👍","👎","👌","✌️","🤞","🤟","🤘","🤙","👈","👉",
  "👆","🖕","👇","☝️","👏","🙌","👐","🤲","🤝","🙏",
  "✍️","💅","🤳","💪","🦾","🦿","🦵","🦶","👂","🦻",
  "👃","🧠","🫀","🫁","🦷","🦴","👀","👁️","👅","👄",
  "💋","🩸","🩹","🩺","💊","💉","🩼","🩻","🚬","⚰️",
  "🪦","🪦","💩","👻","💀","☠️","👽","👾","🤖","🎃",
  "😺","😸","😹","😻","😼","😽","🙀","😿","😾","🙌",
  "💯","💢","💥","💫","💦","💨","🕳️","💣","💬","👁️‍🗨️",
  "🗨️","🗯️","💭","💤","💭","💤","zzz","❤️","🧡","💛",
  "💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞",
  "💓","💗","💖","💘","💝","💟","☮️","✝️","☪️","🕉️",
  "☸️","✡️","🔯","🕎","☯️","☦️","🛐","⛎","♈","♉",
  "♊","♋","♌","♍","♎","♏","♐","♑","♒","♓",
  "🔴","🟠","🟡","🟢","🔵","🟣","🟤","⚫","⚪","🟥",
  "🟧","🟨","🟩","🟦","🟪","🟫","⬛","⬜","◼️","◻️",
  "◾","◽","▪️","▫️","🔶","🔷","🔸","🔹","🔺","🔻",
  "💠","🔘","🔳","🔲","🏁","🚩","🎌","🏴","🏳️","🏳️‍🌈",
  "🏳️‍⚧️","🏴‍☠️","🇦🇷","🇧🇴","🇧🇷","🇨🇱","🇨🇴","🇨🇷","🇨🇺","🇩🇴",
  "🇪🇨","🇸🇻","🇬🇹","🇭🇳","🇲🇽","🇳🇮","🇵🇦","🇵🇾","🇵🇪","🇺🇾",
  "🇻🇪","🇪🇸","🇺🇸","🇨🇦","🇫🇷","🇩🇪","🇮🇹","🇯🇵","🇨🇳","🇰🇷"
];
const EMOJI_COLS = 16;
const ui = { 
  sel: 0, selJid: null, top: 0, input: "", toast: "", toastUntil: 0, blink: true,
  emojiOpen: false, emojiSel: 0, emojiPage: 0,
  msgSel: null, // null = sin selección; 0 = último mensaje, 1 = penúltimo, ...
  cursor: null, // posición en la entrada (null = al final)
  msgOff: 0, // scroll de mensajes con rueda/touch (0 = abajo del todo)
  replyTo: null, // { msgId, participant, snippet, to } para responder citando
  delArm: null, // { key, until } confirmación de borrado en dos pasos
  tab: "chats", // chats | contacts | status
};
// Pestañas: Chats (conversaciones), Contactos (agenda, aunque no tengan historial), Estados
const TABS = [
  { id: "chats", label: "Chats" },
  { id: "contacts", label: "Contactos" },
  { id: "status", label: "Estados" },
];
const tabState = {}; // tabId -> { sel, selJid, top } (cada pestaña recuerda dónde estabas)
function switchTab(dir) {
  tabState[ui.tab] = { sel: ui.sel, selJid: ui.selJid, top: ui.top };
  const ids = TABS.map((t) => t.id);
  ui.tab = ids[(ids.indexOf(ui.tab) + dir + ids.length) % ids.length];
  const s = tabState[ui.tab] || {};
  ui.sel = s.sel || 0;
  ui.selJid = s.selJid || null;
  ui.top = s.top || 0;
  ui.msgSel = null;
  ui.replyTo = null;
  ui.delArm = null;
  ui.msgOff = 0;
  setToast(`Pestaña: ${TABS.find((t) => t.id === ui.tab).label} (Tab para cambiar)`);
}
function markRead(jid) {
  if (isStatusJid(jid)) {
    const e = statusMap.get(String(jid).slice("status:".length));
    if (e && e.unread) { e.unread = 0; saveStore(); }
    return;
  }
  const c = chatFor(jid);
  if (c && c.unread) c.unread = 0;
}
// Selección estable por JID: evita que un mensaje nuevo reordene la lista
// y te saque del chat o mande tu texto a otro chat.
function getFlatList() {
  if (ui.tab === "contacts") return contactBookList();
  if (ui.tab === "status") return statusList();
  const all = contactList();
  const persons = all.filter((it) => !isGroupJid(it.jid));
  const groups = all.filter((it) => isGroupJid(it.jid));
  return [...persons, ...groups];
}
// Agenda completa (aunque no tengan historial: sirve para empezar chats nuevos)
function contactBookList() {
  const byJid = new Map();
  const put = (jid, name) => {
    if (!jid || jid === "status@broadcast") return;
    if (isGroupJid(jid) || isStatusJid(jid)) return;
    const a = alias(jid);
    const key = byJid.has(jid) ? jid : (a && byJid.has(a) ? a : jid);
    const prev = byJid.get(key);
    const nm = name || prev?.name;
    const chat = chatFor(jid) || (a ? chatFor(a) : null);
    byJid.set(key, {
      jid: key,
      name: nm || String(key).split("@")[0],
      lastTs: Math.max(prev?.lastTs || 0, chat?.lastTs || 0),
      unread: chat?.unread || 0,
      isContact: true,
    });
  };
  for (const [jid, name] of contacts) put(jid, name);
  for (const c of chats.values()) put(c.jid, c.name);
  return [...byJid.values()].sort((x, y) => x.name.localeCompare(y.name));
}
function getActive(flat) {
  const list = flat || getFlatList();
  if (!list.length) return null;
  if (ui.selJid) {
    const idx = list.findIndex((it) => it.jid === ui.selJid);
    if (idx >= 0) {
      ui.sel = idx;
      return list[idx];
    }
  }
  if (ui.sel < 0) ui.sel = 0;
  if (ui.sel >= list.length) ui.sel = list.length - 1;
  ui.selJid = list[ui.sel]?.jid || null;
  return list[ui.sel] || null;
}
function setSel(idx, flat) {
  const list = flat || getFlatList();
  if (!list.length) { ui.sel = 0; ui.selJid = null; return null; }
  if (idx < 0) idx = 0;
  if (idx >= list.length) idx = list.length - 1;
  ui.sel = idx;
  ui.selJid = list[idx].jid;
  ui.msgOff = 0; // ...y vuelve al fondo del chat
  ui.msgSel = null; // cambiar de chat cancela selección de mensaje
  ui.replyTo = null; // ...y la respuesta pendiente
  ui.delArm = null; // ...y el borrado armado
  return list[idx];
}

// ---------------- helpers de formato ----------------
function hhmm(ts) {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function timeLabel(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff === 0) return hhmm(ts);
  if (diff === 1) return "ayer";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}
const MEDIA_ICON = { "[imagen]": "📷 foto", "[video]": "🎬 video", "[audio]": "🎵 audio", "[documento]": "📄 documento", "[sticker]": "✨ sticker" };
function prettyPreview(text) {
  const t = String(text).replace(/\s+/g, " ");
  return MEDIA_ICON[t] || t;
}
function previewFor(jid) {
  if (isStatusJid(jid)) {
    const e = statusMap.get(String(jid).slice("status:".length));
    const m = e?.items?.[e.items.length - 1];
    if (!m) return "sin estados";
    return `${e.items.length} estado(s) · ` + prettyPreview(m.text);
  }
  const c = chatFor(jid);
  const m = c?.messages?.[c.messages.length - 1];
  if (!m) return "sin mensajes";
  return (m.fromMe ? "tú: " : "") + prettyPreview(m.text);
}
function wrap(text, width) {
  width = Math.max(8, width);
  const words = String(text).split(/\s+/);
  const out = [];
  let cur = "";
  for (const w of words) {
    if (vwidth(cur) + vwidth(w) + 1 > width) {
      if (cur) out.push(cur);
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

// ---------------- render ----------------
function render() {
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;

  let leftW = Math.max(24, Math.min(42, Math.floor(cols * 0.3)));
  const sepH = 1;
  let rightW = cols - leftW - sepH;
  if (rightW < 26) {
    rightW = 26;
    leftW = Math.max(18, Math.min(leftW, cols - sepH - rightW));
  }

  const flat = getFlatList();
  const active = getActive(flat);
  if (active) markRead(active.jid);

  // ---------- panel izquierdo ----------
  const timeW = 6;
  const items = flat.map((it, idx) => ({ kind: "chat", it, ci: idx }));

  const left = [];
  left.push(cell("─".repeat(leftW), leftW, BORDER, BG));
  left.push(cell("─".repeat(leftW), leftW, BORDER, BG));

  const listArea = rows - 3;
  // posición (en líneas) de cada item para el scroll
  let total = 0;
  const itemStart = items.map((it) => {
    const s = total;
    total += it.kind === "header" ? 1 : 2;
    return s;
  });
  const selItem = items.findIndex((it) => it.kind === "chat" && it.ci === ui.sel);
  const selStart = selItem >= 0 ? itemStart[selItem] : 0;
  const selEnd = selItem >= 0 ? itemStart[selItem] + 2 : 0;
  if (selStart < ui.top) ui.top = selStart;
  if (selEnd > ui.top + listArea) ui.top = selEnd - listArea;
  ui.top = Math.max(0, Math.min(ui.top, Math.max(0, total - listArea)));

  const lrows = [];
  items.forEach((it, i) => {
    const s = itemStart[i];
    const h = it.kind === "header" ? 1 : 2;
    if (s + h <= ui.top || s >= ui.top + listArea) return;
    if (it.kind === "header") {
      const label = it.sep ? " ── " + it.text : " " + it.text;
      lrows.push(row([{ text: label, w: leftW, fg: MUTED, bg: BG }]));
    } else {
      const sel = it.ci === ui.sel;
      const bgc = sel ? SEL_BG : BG;
      const nameFg = sel ? GREEN : RECV;
      const unread = it.it.unread || 0;
      const dotW = unread ? 2 : 0;
      lrows.push(row([
        { text: " " + (unread ? "● " : ""), w: 1 + dotW, fg: GREEN, bg: bgc, b: true },
        { text: it.it.name, w: leftW - timeW - 1 - dotW, fg: nameFg, bg: bgc, b: sel },
        { text: timeLabel(it.it.lastTs), w: timeW, fg: MUTED, bg: bgc, align: "right" },
      ]));
      lrows.push(row([{ text: " " + previewFor(it.it.jid), w: leftW, fg: MUTED, bg: bgc }]));
    }
  });
  for (let i = lrows.length; i < listArea; i++) lrows.push(row([{ text: "", w: leftW, bg: BG }]));
  left.push(...lrows.slice(0, listArea));

  // ---------- panel derecho ----------
  const right = [];
  const inputRuleRow = rows - 5;
  const inputRow = rows - 4;
  const msgStart = 3;

  // fila 0: nombre + reloj
  const activeIsStatus = !!active?.isStatus;
  const activeEntry = activeIsStatus ? statusMap.get(active.author) : null;
  right.push(row([
    { text: " " + (active ? (activeIsStatus ? active.name : nameFor(active.jid)) : "—"), w: rightW - 7, fg: GREEN, bg: BG, b: true },
    { text: hhmm(Date.now() / 1000), w: 7, fg: MUTED, bg: BG, align: "right" },
  ]));
  // fila 1: estado (siempre muestra dónde estás para no enviar a otro chat)
  const isGrp = active && isGroupJid(active.jid);
  const baseStatus = activeIsStatus
    ? `estado · ${activeEntry?.items?.length || 0} en 24h · solo lectura`
    : isGrp
      ? "grupo" + (active && chatFor(active.jid)?.participants ? " · " + chatFor(active.jid).participants + " participantes" : "")
      : reconnecting
        ? "reconectando…"
        : connected
          ? "en línea"
          : "conectando…";
  const statusText = () => ui.msgSel != null
    ? `${baseStatus} · ▸ (Supr Ctrl+O Ctrl+P Ctrl+R Esc)`
    : `${baseStatus} · Tab ↑↓ · Ctrl+F 📎 · Ctrl+O · Ctrl+P · Ctrl+R${ui.msgOff > 0 ? " · ↑hist" : ""}`;
  right.push(null); // estado: se rellena abajo ya con el scroll medido
  // fila 2: separador
  right.push(cell("─".repeat(rightW), rightW, BORDER, BG));

  // mensajes
  const msgArea = Math.max(1, inputRuleRow - msgStart);
  const mrows = [];
  const gfxPlaces = []; // { mrowsIdx, id, cols } -> se convierten a filas de terminal tras el slice
  gfxQueue = [];
  const imgCols = Math.max(10, Math.min(rightW - 8, 44));
  const pushMsg = (m, isSel) => {
    const rowBg = isSel ? SEL_BG : BG;
    const t = hhmm(m.ts);
    // stickers: mostrar ruta del archivo para poder verlo/abrirlo
    let dispText = m.text;
    if (m.media?.type === "sticker") {
      dispText = m.mediaPath
        ? `[sticker ✓ ${String(m.mediaPath).split("/").pop()}]`
        : (m.dlFail ? "[sticker ⚠ reintenta Ctrl+O]" : "[sticker ↓ descargando…]");
    }
    // fotos/videos/docs pendientes o fallidos: se ve el estado sin abrir nada
    if (!m.mediaPath && m.media && /^\[(imagen|video|documento|audio)\]$/.test(m.text)) {
      dispText = m.dlFail ? m.text.replace("]", " ⚠]") : m.text.replace("]", " ↓]");
    }
    // foto/video/sticker en Kitty: bloque de imagen dentro del chat + pie con hora
    let inlineId = null;
    if ((m.media?.type === "image" || m.media?.type === "video" || m.media?.type === "sticker") && m.mediaPath) {
      const tp = thumbFor(m);
      if (tp) {
        inlineId = gfxEnsure(tp);
        if (inlineId) {
          dispText = m.media.type === "video" ? "▶ video · Ctrl+P" : "";
        }
      }
    }
    if (inlineId) {
      const mrowsIdx = mrows.length;
      const edgeFg = m.fromMe ? GREEN : MUTED;
      for (let bi = 0; bi < IMG_ROWS; bi++) {
        const bar = isSel && bi === 0 ? "▸" : "│";
        if (m.fromMe) {
          mrows.push(row([
            { text: "", w: rightW - 1, bg: rowBg },
            { text: bar, w: 1, fg: edgeFg, bg: rowBg, b: isSel && bi === 0 },
          ]));
        } else {
          mrows.push(row([
            { text: bar, w: 1, fg: edgeFg, bg: rowBg, b: isSel && bi === 0 },
            { text: "", w: rightW - 1, bg: rowBg },
          ]));
        }
      }
      // las propias a la derecha, como en el móvil
      const pcol = m.fromMe ? leftW + 2 + (rightW - imgCols) : leftW + 3;
      gfxPlaces.push({ mrowsIdx, id: inlineId, cols: imgCols, col: pcol });
    }
    // burbujas estilo WhatsApp: propias verdes a la derecha, ajenas grises a la izquierda
    const maxBW = Math.max(12, Math.min(rightW - 14, 48));
    if (m.fromMe) {
      if (!dispText) {
        // foto sola: solo hora
        mrows.push(row([
          { text: "", w: Math.max(1, rightW - 10), bg: BG },
          { text: (isSel ? "▸ " : "") + t + " ✓", w: 10, fg: MUTED, bg: BG, align: "right" },
        ]));
        return;
      }
      const body = wrap(dispText, maxBW);
      const bw = Math.min(rightW - 10, Math.max(...body.map((ln) => vwidth(ln))) + 2);
      body.forEach((ln, bi) => {
        const last = bi === body.length - 1;
        mrows.push(row([
          { text: last && isSel ? "▸" : "", w: Math.max(1, rightW - bw - 8), fg: GREEN, bg: BG, align: "right", b: isSel },
          { text: ` ${ln} `, w: bw, fg: B_TXT, bg: B_OUT },
          { text: last ? t + " ✓" : "", w: 8, fg: MUTED, bg: BG, align: "right" },
        ]));
      });
    } else {
      if (!dispText) {
        mrows.push(row([
          { text: isSel ? "▸ " : "  ", w: 2, fg: GREEN, bg: BG, b: isSel },
          { text: t, w: 6, fg: MUTED, bg: BG },
          { text: "", w: Math.max(0, rightW - 8), bg: BG },
        ]));
        return;
      }
      const body = wrap(dispText, maxBW);
      const bw = Math.min(rightW - 10, Math.max(...body.map((ln) => vwidth(ln))) + 2);
      body.forEach((ln, bi) => {
        const last = bi === body.length - 1;
        mrows.push(row([
          { text: bi === 0 ? (isSel ? "▸ " : "  ") : "  ", w: 2, fg: GREEN, bg: BG, b: isSel && bi === 0 },
          { text: ` ${ln} `, w: bw, fg: B_TXT, bg: B_IN },
          { text: last ? t : "", w: 6, fg: MUTED, bg: BG },
          { text: "", w: Math.max(0, rightW - 8 - bw), bg: BG },
        ]));
      });
    }
  };
  const dayName = (ts) => {
    const d = new Date(ts * 1000);
    const now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff <= 0) return "HOY";
    if (diff === 1) return "AYER";
    return timeLabel(ts).toUpperCase();
  };
  const dayChip = (day) => {
    const label = ` ${day} `;
    const pad = Math.max(0, Math.floor((rightW - vwidth(label)) / 2));
    return row([
      { text: "", w: pad, bg: BG },
      { text: label, w: vwidth(label), fg: MUTED, bg: SURFACE },
      { text: "", w: Math.max(0, rightW - pad - vwidth(label)), bg: BG },
    ]);
  };
  let lastDay = "";
  if (active) {
    const c = activeIsStatus ? null : chatFor(active.jid);
    const msgs = activeIsStatus ? (activeEntry?.items || []) : (c?.messages || []);
    if (activeIsStatus) {
      // estados: todos de una vez, fotos inline, sin presionar nada
      const items = activeEntry?.items || [];
      if (!items.length) {
        mrows.push(row([{ text: " sin estados", w: rightW, fg: MUTED, bg: BG }]));
      } else {
        mrows.push(row([{ text: ` 📖 ${items.length} estado(s) en 24h`, w: rightW, fg: GREEN, bg: BG, b: true }]));
        const selIdx = ui.msgSel != null ? items.length - 1 - ui.msgSel : -1;
        const slice = items.slice(-80);
        const baseIdx = items.length - slice.length;
        slice.forEach((m, si) => {
          const d = dayName(m.ts);
          if (d !== lastDay) { lastDay = d; mrows.push(dayChip(d)); }
          pushMsg(m, baseIdx + si === selIdx);
        });
      }
    } else {
      const selIdx = ui.msgSel != null ? msgs.length - 1 - ui.msgSel : -1;
      const slice = msgs.slice(-80);
      const baseIdx = msgs.length - slice.length;
      slice.forEach((m, si) => {
          const d = dayName(m.ts);
          if (d !== lastDay) { lastDay = d; mrows.push(dayChip(d)); }
          pushMsg(m, baseIdx + si === selIdx);
        });
    }
  }
  const maxOff = Math.max(0, mrows.length - msgArea);
  ui.msgOff = Math.min(ui.msgOff || 0, maxOff);
  const winEnd = mrows.length - ui.msgOff;
  const winStart = Math.max(0, winEnd - msgArea);
  const shownMsgs = mrows.slice(winStart, winEnd);
  const padTop = Math.max(0, msgArea - shownMsgs.length);
  for (let i = 0; i < padTop; i++) right.push(row([{ text: "", w: rightW, bg: BG }]));
  const msgBase = right.length; // índice en right[] del primer mensaje visible (ya incluye padTop)
  right.push(...shownMsgs);
  // imágenes Kitty: del índice en mrows al nº de fila de terminal (1-based)
  const gfxSeqs = [];
  for (const p of gfxPlaces) {
    const k = p.mrowsIdx - winStart;
    if (k < 0 || k + IMG_ROWS >= shownMsgs.length) continue; // bloque fuera de vista o cortado (no pintar sobre el compositor)
    const termRow = msgBase + k + 3; // +2 barra superior +1 base-1
    const termCol = p.col || leftW + 3; // propias a la derecha, ajenas a la izquierda
    gfxSeqs.push(`\x1b[${termRow};${termCol}H\x1b_Ga=p,i=${p.id},c=${p.cols},r=${IMG_ROWS}\x1b\\`);
  }
  right[1] = row([{ text: " " + statusText(), w: rightW, fg: MUTED, bg: BG }]);
  while (right.length < inputRuleRow) right.push(row([{ text: "", w: rightW, bg: BG }]));

  // caja de prompt estilo OpenCode/WhatsApp: contexto arriba, píldora cerrada, botón enviar
  const sendW = 5;
  const pillW = Math.max(20, rightW - sendW - 1);
  const empty = ui.input.length === 0;
  const destName = active ? (activeIsStatus ? active.name.replace(/^📖 /, "") : nameFor(active.jid)).slice(0, 18) : "—";
  const attName = ui.attach?.file ? path.basename(ui.attach.file).slice(0, 16) : null;
  const ctxLabel = ui.replyTo
    ? `↩ ${ui.replyTo.snippet.slice(0, 28)}`
    : attName ? `📎 ${attName}` : activeIsStatus ? `📖 Solo lectura` : `💬 ${destName}`;
  const topInner = `─ ${ctxLabel} `;
  right.push(row([
    { text: `╭${topInner}${"─".repeat(Math.max(0, pillW - 2 - vwidth(topInner)))}╮`, w: pillW, fg: BORDER, bg: BG },
    { text: "", w: Math.max(0, rightW - pillW), bg: BG },
  ]));

  const textW = Math.max(4, pillW - 9);
  const caretOn = ui.blink;
  let inputSegs, caretInfo;
  if (empty) {
    inputSegs = [
      { text: "Escribe un mensaje…", w: textW, fg: MUTED, bg: BG },
      { text: " ", w: 1, bg: caretOn ? GREEN : BG },
    ];
    caretInfo = { r: rows - 1, c: leftW + 9 + textW, ch: " ", w: 1 };
  } else {
    const vw1 = (ch) => Math.max(1, vwidth(ch));
    const arr = cpsArr(ui.input);
    clampCur();
    let start = arr.length, w = 0;
    while (start > 0 && w + vw1(arr[start - 1]) <= textW) { w += vw1(arr[start - 1]); start--; }
    let end = arr.length;
    if (ui.cursor < start) {
      start = ui.cursor;
      end = ui.cursor + (ui.cursor < arr.length ? 1 : 0);
      let w2 = end > start ? vw1(arr[start]) : 1;
      while (end < arr.length && w2 + vw1(arr[end]) <= textW) { w2 += vw1(arr[end]); end++; }
    }
    const before = arr.slice(start, ui.cursor).join("");
    const chUnder = ui.cursor < end && ui.cursor < arr.length ? arr[ui.cursor] : "";
    const after = arr.slice(ui.cursor + (chUnder ? 1 : 0), end).join("");
    const bw = vwidth(before);
    const cw = chUnder ? vw1(chUnder) : 1;
    const aw = Math.max(0, textW - bw - cw);
    inputSegs = [
      { text: before, w: bw, fg: B_TXT, bg: BG },
      { text: chUnder || " ", w: cw, fg: caretOn ? BG : B_TXT, bg: caretOn ? GREEN : BG, b: caretOn },
      { text: after, w: aw, fg: B_TXT, bg: BG },
    ];
    caretInfo = { r: rows - 1, c: leftW + 9 + bw, ch: chUnder || " ", w: cw };
  }
  right.push(row([
    { text: "│", w: 1, fg: BORDER, bg: BG },
    { text: " 🙂📎 ", w: 6, fg: MUTED, bg: BG },
    ...inputSegs,
    { text: "│", w: 1, fg: BORDER, bg: BG },
    { text: " ", w: 1, bg: BG },
    { text: " ", w: 1, bg: BG },
    { text: "➤", w: 3, fg: BG, bg: GREEN, b: true },
    { text: " ", w: 1, bg: BG },
  ]));
  right.push(row([
    { text: `╰${"─".repeat(pillW - 2)}╯`, w: pillW, fg: BORDER, bg: BG },
    { text: "", w: Math.max(0, rightW - pillW), bg: BG },
  ]));
  ui._caret = caretInfo; // para el parpadeo sin redibujar

  // ---------- overlay selector de emojis ----------
  if (ui.emojiOpen) {
    const perPage = EMOJI_COLS * 6;
    const page = ui.emojiPage;
    const start = page * perPage;
    const end = Math.min(start + perPage, EMOJIS.length);
    const pickerRows = 6 + 2; // 6 filas emojis + header + footer
    const pickerTop = Math.max(3, inputRuleRow - pickerRows + 1); // termina justo sobre la caja
    const label = ` Emojis (pág ${page + 1}/${Math.ceil(EMOJIS.length / perPage)}) 0-9 cambian página `;
    const labelW = rightW;
    // header
    right[pickerTop] = row([{ text: label, w: rightW, fg: GREEN, bg: SURFACE, b: true }]);
    // filas de emojis
    for (let r = 0; r < 6; r++) {
      const lineIdx = pickerTop + 1 + r;
      const cells = [];
      for (let c = 0; c < EMOJI_COLS; c++) {
        const idx = start + r * EMOJI_COLS + c;
        if (idx >= end) { cells.push({ text: "  ", w: 2, bg: SURFACE }); continue; }
        const sel = idx === ui.emojiSel;
        cells.push({ text: " " + EMOJIS[idx] + " ", w: 4, fg: sel ? BLUE : RECV, bg: sel ? SEL_BG : SURFACE, b: sel });
      }
      right[lineIdx] = row(cells);
    }
    // footer hint
    const hint = " ↑↓←→ mover  Enter insertar  Esc/: cerrar  0-9 página ";
    right[pickerTop + 7] = row([{ text: hint, w: rightW, fg: MUTED, bg: SURFACE }]);
  }

  // ---------- overlay selector de archivos ----------
  if (ui.attach?.list) {
    const a = ui.attach;
    const maxRows = 10;
    if (a.sel < a.top) a.top = a.sel;
    if (a.sel >= a.top + maxRows) a.top = a.sel - maxRows + 1;
    const pickerRows = maxRows + 2; // lista + header + footer
    const pickerTop = Math.max(3, inputRuleRow - pickerRows + 1); // termina justo sobre la caja
    right[pickerTop] = row([{ text: ` 📎 ${shortDir(a.dir)}`, w: rightW, fg: GREEN, bg: SURFACE, b: true }]);
    for (let r = 0; r < maxRows; r++) {
      const lineIdx = pickerTop + 1 + r;
      if (lineIdx >= right.length) break;
      const e = a.entries[a.top + r];
      if (!e) { right[lineIdx] = row([{ text: "", w: rightW, bg: SURFACE }]); continue; }
      const sel = a.top + r === a.sel;
      right[lineIdx] = row([
        { text: ` ${sel ? "▸" : " "} ${e.isDir ? "📁" : "📄"} ${e.name}`, w: rightW - 10, fg: sel ? GREEN : (e.isDir ? RECV : MUTED), bg: sel ? SEL_BG : SURFACE, b: sel },
        { text: e.isDir ? "<dir>" : fmtSize(e.size), w: 10, fg: MUTED, bg: sel ? SEL_BG : SURFACE, align: "right" },
      ]);
    }
    right[pickerTop + maxRows + 1] = row([{ text: " ↑↓ elegir  Enter abrir/enviar  ⌫ subir  Esc salir ", w: rightW, fg: MUTED, bg: SURFACE }]);
  }

  // ---------- barra superior: ventanas en recuadros + dónde estás ----------
  const chatsUnread = [...chats.values()].reduce((a, c) => a + (c.unread || 0), 0);
  const statusUnread = [...statusMap.values()].reduce((a, e) => a + (e.unread || 0), 0);
  const tabBadge = { chats: chatsUnread, contacts: 0, status: statusUnread };
  let tabInner = TABS.map((t) => ` ${t.label}${tabBadge[t.id] ? `(${tabBadge[t.id]})` : ""} `);
  let boxesW = tabInner.map((s) => vwidth(s) + 2).reduce((a, b) => a + b, 0) + (TABS.length - 1);
  if (boxesW > cols - 24) {
    // terminal angosta: recuadros sin contadores
    tabInner = TABS.map((t) => ` ${t.label} `);
    boxesW = tabInner.map((s) => vwidth(s) + 2).reduce((a, b) => a + b, 0) + (TABS.length - 1);
  }
  const tabLabel = TABS.find((t) => t.id === ui.tab).label;
  const whereName = active ? (activeIsStatus ? active.name : nameFor(active.jid)) : "—";
  const crumbW = Math.max(1, cols - boxesW);
  const topRow = [], midRow = [];
  TABS.forEach((t, i) => {
    const on = t.id === ui.tab;
    const w = vwidth(tabInner[i]) + 2;
    topRow.push({ text: `╭${"─".repeat(vwidth(tabInner[i]))}╮`, w, fg: on ? GREEN : BORDER, bg: BG, b: on });
    midRow.push({ text: `│${tabInner[i]}│`, w, fg: on ? GREEN : MUTED, bg: on ? SEL_BG : BG, b: on });
    if (i < TABS.length - 1) {
      topRow.push({ text: " ", w: 1, bg: BG });
      midRow.push({ text: " ", w: 1, bg: BG });
    }
  });
  topRow.push({ text: ` ${tabLabel} › ${whereName}`, w: crumbW, fg: RECV, bg: BG, b: true });
  midRow.push({ text: "", w: crumbW, bg: BG });
  const topbar0 = row(topRow);
  const topbar1 = row(midRow);

  // ---------- componer ----------
  const sep = paint("│", { color: BORDER, bgc: BG });
  let out = "\x1b[2J\x1b[H" + topbar0 + "\r\n" + topbar1 + "\r\n";
  for (let i = 0; i < rows - 2; i++) {
    out += (left[i] || cell("", leftW, null, BG)) + sep + (right[i] || cell("", rightW, null, BG)) + "\r\n";
  }
  if (gfxQueue.length || gfxSeqs.length) {
    out += gfxQueue.join("") + gfxSeqs.join("") + `\x1b[${rows + 1};1H`;
  }
  if (ui.toast && Date.now() < ui.toastUntil) {
    out += paint(clampPad("  " + ui.toast, cols), { color: GREEN, bgc: BG, b: true }) + "\r\n";
  }
  process.stdout.write(out);
}
function setToast(msg, ms = 3000) {
  ui.toast = msg;
  ui.toastUntil = Date.now() + ms;
}
function draw() {
  if (suspended) return;
  render();
  ensureVisibleMedia();
}
function caretTick() {
  // parpadeo del cursor sin redibujar todo (evita que las fotos parpadeen)
  const p = ui._caret;
  if (!p || suspended) return;
  process.stdout.write(`\x1b[${p.r};${p.c}H` + (ui.blink ? bg(...GREEN) + fg(...BG) : bg(...BG) + fg(...B_TXT)) + (p.ch || " ") + RESET);
}

// ---------------- teclado ----------------
function cleanup() {
  try {
    process.stdin.setRawMode(false);
  } catch {}
  process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?1049l\x1b[?25h\x1b[0m");
  try {
    sock?.end(undefined);
  } catch {}
  process.exit(0);
}
let mouseBuf = ""; // trozos de secuencias de ratón partidas entre lecturas
function handleWheel(seq) {
  const m = seq.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (!m || m[4] !== "M") return;
  const cb = Number(m[1]);
  if (!(cb & 64)) return; // solo rueda (los chats se cambian con ↑↓)
  const down = (cb & 3) === 1;
  ui.msgOff = Math.max(0, (ui.msgOff || 0) + (down ? -3 : 3));
  draw();
}
function onKey(data) {
  let k = mouseBuf + data.toString("utf8");
  mouseBuf = "";
  k = k.replace(/\x1b\[<\d+(;\d+)*[Mm]/g, (seq) => { handleWheel(seq); return ""; });
  const tail = k.match(/\x1b\[<\d*(;\d*)*$/);
  if (tail && tail[0]) { mouseBuf = tail[0]; k = k.slice(0, -tail[0].length); }
  if (!k) return;
  if (k === "\u0003") return cleanup();

  // --- selector de emojis ---
  if (ui.emojiOpen) {
    const perPage = EMOJI_COLS * 6;
    const totalPages = Math.ceil(EMOJIS.length / perPage);
    if (k === "\u001b" || k === ":") {
      ui.emojiOpen = false;
      ui.emojiSel = 0;
      ui.emojiPage = 0;
    } else if (k === "\u001b[A") {
      ui.emojiSel = Math.max(0, ui.emojiSel - EMOJI_COLS);
    } else if (k === "\u001b[B") {
      ui.emojiSel = Math.min(EMOJIS.length - 1, ui.emojiSel + EMOJI_COLS);
    } else if (k === "\u001b[D") {
      ui.emojiSel = Math.max(0, ui.emojiSel - 1);
    } else if (k === "\u001b[C") {
      ui.emojiSel = Math.min(EMOJIS.length - 1, ui.emojiSel + 1);
    } else if (k === "\r" || k === "\n") {
      insertAtCursor(EMOJIS[ui.emojiSel]);
      ui.emojiOpen = false;
      ui.emojiSel = 0;
      ui.emojiPage = 0;
    } else if (k >= "0" && k <= "9") {
      const page = parseInt(k, 10);
      if (page < totalPages) {
        ui.emojiPage = page;
        ui.emojiSel = page * perPage;
      }
    }
    draw();
    return;
  }

  // --- selector de archivos (Ctrl+F) ---
  if (ui.attach?.list) {
    if (k === "\u001b") ui.attach = null;
    else if (k === "\u001b[A") attMove(-1);
    else if (k === "\u001b[B") attMove(1);
    else if (k === "\r" || k === "\n") { attEnter(); return; }
    else if (k === "\u007f" || k === "\b") attUp();
    draw();
    return;
  }

  // --- navegación normal ---
  // Tab = cambiar de pestaña (Chats / Contactos / Estados)
  // Ctrl+F = adjuntar archivo (selector); o /img /video /doc /audio /sticker <ruta> [texto]
  // AvPag/RePag (o Ctrl+↑/Ctrl+↓) = elegir mensaje dentro del chat actual
  // ← → en Estados = pasar de un estado a otro (visor estilo WhatsApp)
  // Supr (o Ctrl+D) = borrar mensaje elegido (último propio si no hay elección)
  // Ctrl+O = ver sticker/imagen/video del mensaje elegido (lo abre con tu visor)
  // Ctrl+P = reproducir video/audio/imagen en la terminal con mpv
  // Ctrl+R = responder citando al mensaje elegido (Enter envía, Esc cancela)
  // Esc = cancelar respuesta, o selección de mensaje, o limpiar entrada
  if (k === ":") {
    ui.emojiOpen = true;
    ui.emojiSel = 0;
    ui.emojiPage = 0;
  } else if (k === "\t" || k === "\x1b[Z") switchTab(k === "\t" ? 1 : -1);
  else if (k === "\u001b[A") setSel(ui.sel - 1);
  else if (k === "\u001b[B") setSel(ui.sel + 1);
  else if (k === "\u001b[D" || k === "\u001b[C") {
    if (ui.input.length) {
      clampCur();
      ui.cursor += k === "\u001b[C" ? 1 : -1;
      clampCur();
    } else if (getActive()?.isStatus) moveMsgSel(k === "\u001b[D" ? 1 : -1);
  } else if ((k === "\u001b[H" || k === "\u001b[1~" || k === "\u0001") && ui.input.length) ui.cursor = 0;
  else if ((k === "\u001b[F" || k === "\u001b[4~" || k === "\u0005") && ui.input.length) ui.cursor = cpsArr(ui.input).length;
  else if (k === "\u001b[5~" || k === "\u001b[1;5A") moveMsgSel(1);
  else if (k === "\u001b[6~" || k === "\u001b[1;5B") moveMsgSel(-1);
  else if (k === "\u001b[3~" || k === "\u0004") {
    if (ui.input.length) { deleteAtCursor(); }
    else { deleteSelectedMessage(); return; }
  }
  else if (k === "\u000f") { openMediaSelected(); return; }
  else if (k === "\u0010") { playMediaTerminal(); return; }
  else if (k === "\u0012") { setReplyTo(); return; }
  else if (k === "\u0006") { openAttach(); return; }
  else if (k === "\u001b") { if (ui.replyTo) ui.replyTo = null; else if (ui.delArm) ui.delArm = null; else if (ui.attach) ui.attach = null; else if (ui.msgSel != null) ui.msgSel = null; else ui.input = ""; }
  else if (k === "\r" || k === "\n") {
    if (ui.attach?.file) { const cap = ui.input; ui.input = ""; sendAttachment(cap); return; }
    if (ui.input.trim()) { const t = ui.input.trim(); ui.input = ""; handleCommand(t); }
  } else if (k === "\u007f" || k === "\b") backspaceAtCursor();
  else if (k.length === 1 && k >= " ") insertAtCursor(k);
  else if (k.length > 1 && !k.startsWith("\u001b")) insertAtCursor(k.replace(/[\r\n]/g, ""));
  draw();
}

function activeMessages(active) {
  if (!active) return { msgs: [], isStatus: false };
  if (active.isStatus) return { msgs: statusMap.get(active.author)?.items || [], isStatus: true };
  return { msgs: chatFor(active.jid)?.messages || [], isStatus: false };
}

function moveMsgSel(dir) {
  const active = getActive();
  const { msgs } = activeMessages(active);
  const n = msgs.length || 0;
  if (!n) return;
  if (ui.msgSel == null) ui.msgSel = 0;
  else {
    ui.msgSel += dir;
    if (ui.msgSel < 0) ui.msgSel = 0;
    if (ui.msgSel > n - 1) ui.msgSel = n - 1;
  }
}

async function deleteSelectedMessage() {
  const active = getActive();
  if (!active) return;
  const { msgs, isStatus } = activeMessages(active);
  if (!msgs.length) { setToast("Sin mensajes para borrar"); draw(); return; }
  let idx;
  if (ui.msgSel == null) {
    idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].fromMe) { idx = i; break; }
    if (idx < 0) { setToast("No hay mensajes propios para borrar (elige uno con AvPag)"); draw(); return; }
  } else {
    idx = msgs.length - 1 - ui.msgSel;
  }
  const m = msgs[idx];
  if (!m?.id) { setToast("Mensaje sin id, no se puede borrar"); draw(); return; }
  const jid = active.jid;
  if (String(jid).endsWith("@demo")) {
    msgs.splice(idx, 1);
    ui.msgSel = null;
    setToast("Mensaje de ejemplo borrado (local)");
    draw();
    return;
  }
  // borrado en dos pasos: lo propio se revoca PARA TODOS, no hay deshacer
  const armKey = `${jid}:${m.id}`;
  if (!ui.delArm || ui.delArm.key !== armKey || Date.now() > ui.delArm.until) {
    ui.delArm = { key: armKey, until: Date.now() + 5000 };
    setToast(`⚠ Supr otra vez para borrar "${String(m.text).slice(0, 30)}" (Esc cancela)`, 5000);
    draw();
    return;
  }
  ui.delArm = null;
  try {
    if (isStatus) {
      // los estados ajenos no se pueden revocar: solo se ocultan aquí
      setToast("Estado oculto en tu vista");
    } else if (m.fromMe && sock) {
      // borrar para todos (revocar)
      const key = { id: m.id, remoteJid: jid, fromMe: true };
      if (m.participant) key.participant = m.participant;
      await sock.sendMessage(jid, { delete: key });
      setToast("Mensaje borrado para todos");
    } else {
      // ajeno: solo borrado local (WhatsApp no deja revocar lo ajeno)
      setToast("Mensaje ajeno: borrado solo en tu vista");
    }
    msgs.splice(idx, 1);
    ui.msgSel = null;
    saveStore();
  } catch (e) {
    setToast("Error al borrar: " + e.message);
  }
  draw();
}

function pickMediaMessage() {
  const active = getActive();
  if (!active) return null;
  const { msgs } = activeMessages(active);
  if (!msgs.length) { setToast("Sin mensajes"); draw(); return null; }
  // mensaje elegido, o el último con multimedia si no hay elección
  let m = ui.msgSel != null ? msgs[msgs.length - 1 - ui.msgSel] : null;
  if (!m?.media) {
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].media) { m = msgs[i]; break; }
  }
  if (!m?.media) { setToast("Ese mensaje no tiene imagen/video/sticker"); draw(); return null; }
  return m;
}
async function ensureMediaFile(m) {
  if (m.mediaPath) return m.mediaPath;
  setToast("Descargando…");
  draw();
  const file = await downloadMedia(m.id, m.media);
  if (!file) { setToast("No se pudo descargar (el enlace caduca con el tiempo)"); draw(); return null; }
  m.mediaPath = file;
  m.dlFail = false;
  saveStore();
  draw();
  return file;
}
let suspended = false; // true mientras un reproductor externo usa la terminal
function suspendUI() {
  suspended = true;
  process.off("SIGINT", cleanup);
  try { process.stdin.setRawMode(false); } catch {}
  try { process.stdin.removeListener("data", onKey); } catch {}
  try { process.stdin.pause(); } catch {}
  process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?1049l\x1b[?25h\x1b[0m");
}
function resumeUI() {
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
  try { process.stdin.setRawMode(true); } catch {}
  process.stdin.resume();
  process.stdin.on("data", onKey);
  process.on("SIGINT", cleanup);
  suspended = false;
  draw();
}
// Reproduce el video/audio/imagen en la terminal con mpv (q o Esc para salir)
async function playMediaTerminal() {
  const m = pickMediaMessage();
  if (!m) return;
  if (!["video", "audio", "image"].includes(m.media?.type)) {
    setToast("Solo video/audio/imagen se reproducen aquí (documentos con Ctrl+O)");
    draw();
    return;
  }
  const file = await ensureMediaFile(m);
  if (!file) return;
  suspendUI();
  let playErr = null;
  try {
    const vo = (process.env.KITTY_WINDOW_ID || process.env.TERM === "xterm-kitty") ? "kitty" : "tct";
    const res = spawnSync("mpv", [`--vo=${vo}`, "--really-quiet", "--", file], { stdio: "inherit" });
    if (res?.error) playErr = res.error.message;
  } catch (e) {
    playErr = e.message;
  }
  resumeUI();
  setToast(playErr ? `No se pudo reproducir: ${playErr}` : "Reproducción terminada (q para salir del video)");
  draw();
}

async function openMediaSelected() {
  const m = pickMediaMessage();
  if (!m) return;
  const file = await ensureMediaFile(m);
  if (!file) return;
  try {
    const child = spawn("xdg-open", [m.mediaPath], { detached: true, stdio: "ignore" });
    child.unref();
    setToast(`Abriendo ${String(m.mediaPath).split("/").pop()} con tu visor`);
  } catch (e) {
    setToast("No se pudo abrir: " + e.message + " — el archivo está en " + (m.mediaPath || "media/"));
  }
  draw();
}

// Elige el mensaje (AvPag o último) y prepara respuesta citándolo; Enter envía.
function setReplyTo() {
  const active = getActive();
  if (!active) return;
  const { msgs } = activeMessages(active);
  if (!msgs.length) { setToast("Sin mensajes para responder"); draw(); return; }
  const m = ui.msgSel != null ? msgs[msgs.length - 1 - ui.msgSel] : msgs[msgs.length - 1];
  if (!m?.id || String(active.jid).endsWith("@demo")) {
    setToast("Ese mensaje no se puede citar");
    draw();
    return;
  }
  const to = active.isStatus ? active.author : active.jid;
  ui.replyTo = {
    msgId: m.id,
    participant: m.participant || to,
    snippet: String(m.text).replace(/\s+/g, " ").slice(0, 40),
    to,
  };
  setToast(`↩ Respondiendo a: ${ui.replyTo.snippet} (Enter envía, Esc cancela)`);
  draw();
}

// ---------------- adjuntar y enviar archivos ----------------
const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo", webm: "video/webm", "3gp": "video/3gpp",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", opus: "audio/ogg; codecs=opus", aac: "audio/aac",
  pdf: "application/pdf", zip: "application/zip", txt: "text/plain",
};
const MAX_SEND_BYTES = 120 * 1024 * 1024;
function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
function detectKind(file) {
  const e = String(file).split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(e)) return "image";
  if (["mp4", "mov", "mkv", "avi", "webm", "3gp"].includes(e)) return "video";
  if (["mp3", "ogg", "wav", "m4a", "opus", "aac"].includes(e)) return "audio";
  return "doc";
}
function mimeFor(file, kind) {
  const e = String(file).split(".").pop().toLowerCase();
  return MIME_BY_EXT[e] || (kind === "image" ? "image/jpeg" : kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "application/octet-stream");
}
function resolvePath(p) {
  let s = String(p || "").trim();
  if (s.startsWith("~")) s = os.homedir() + s.slice(1);
  return path.resolve(s);
}
function splitArgs(s) {
  const out = [];
  let cur = "", q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ""; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
// Convierte cualquier imagen a sticker webp 512px (como el móvil)
function makeSticker(file, outDir) {
  const out = `${outDir}/sticker-${Date.now()}.webp`;
  const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000", out], { stdio: "ignore", timeout: 30000 });
  if (r?.status === 0 && fs.existsSync(out)) return out;
  return null;
}
async function sendFile(to, file, kind, caption) {
  setToast("📎 enviando…");
  draw();
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error("no es un archivo");
  if (st.size === 0) throw new Error("archivo vacío");
  if (st.size > MAX_SEND_BYTES) throw new Error(`muy pesado (${fmtSize(st.size)}, máx 120M)`);
  const mime = mimeFor(file, kind);
  const cap = (caption || "").trim();
  let payload, disp, mediaType = kind, mediaPath = file, mediaMime = mime;
  if (kind === "image") {
    payload = { image: fs.readFileSync(file), ...(cap ? { caption: cap } : {}) };
    disp = cap || "[imagen]";
  } else if (kind === "video") {
    const gif = /\.gif$/i.test(file);
    payload = { video: fs.readFileSync(file), mimetype: mime, ...(cap ? { caption: cap } : {}), ...(gif ? { gifPlayback: true } : {}) };
    disp = cap || "[video]";
  } else if (kind === "audio") {
    payload = { audio: fs.readFileSync(file), mimetype: mime };
    disp = cap || "[audio]";
  } else if (kind === "sticker") {
    const out = makeSticker(file, mediaDirFor(to));
    if (!out) throw new Error("ffmpeg no pudo convertir a sticker (¿imagen válida?)");
    payload = { sticker: fs.readFileSync(out) };
    disp = "[sticker]";
    mediaType = "sticker";
    mediaPath = out;
    mediaMime = "image/webp";
  } else {
    payload = { document: fs.readFileSync(file), mimetype: mime, fileName: path.basename(file), ...(cap ? { caption: cap } : {}) };
    disp = cap || `[documento] ${path.basename(file)}`;
  }
  let contextInfo = null;
  if (ui.replyTo) {
    const raw = msgCache.get(ui.replyTo.msgId);
    if (!raw?.message) throw new Error("cita caducada: elige de nuevo con AvPag + Ctrl+R");
    to = ui.replyTo.to;
    contextInfo = { stanzaId: ui.replyTo.msgId, participant: ui.replyTo.participant, quotedMessage: raw.message };
    ui.replyTo = null;
  }
  const sent = await sock.sendMessage(to, contextInfo ? { ...payload, contextInfo } : payload);
  cacheMsg(sent);
  const c = ensureChat(to);
  c.lastTs = Date.now() / 1000;
  ui.msgOff = 0;
    c.messages.push({ id: sent?.key?.id, fromMe: true, text: disp, ts: c.lastTs, name: "tú", media: { type: mediaType, mimetype: mediaMime, remoteJid: to }, mediaPath, participant: sent?.key?.participant || null, remoteJid: to });
  if (c.messages.length > MAX_MSGS_PER_CHAT) c.messages.splice(0, c.messages.length - MAX_MSGS_PER_CHAT);
  saveStore();
  return disp;
}
async function sendAttachment(caption) {
  const target = getActive();
  if (!target) return;
  if (target.isStatus && !ui.replyTo) { setToast("Elige un chat para enviar (estados son solo lectura)"); draw(); return; }
  const to = ui.replyTo?.to || (target.isStatus ? target.author : target.jid);
  if (String(to).endsWith("@demo")) { setToast("Contacto de ejemplo: no se envía"); draw(); return; }
  const file = ui.attach?.file;
  ui.attach = null;
  if (!file) return;
  try {
    const disp = await sendFile(to, file, detectKind(file), caption);
    setToast(`📎 enviado: ${disp.slice(0, 40)}`);
  } catch (e) {
    setToast("No se pudo enviar: " + (e.message || e));
  }
  draw();
}
function handleCommand(t) {
  // /img /video /doc /audio /sticker <ruta> [texto...] — lo demás se envía como texto normal
  const m = t.match(/^\/(\S+)(?:\s+(.*))?$/s);
  if (!m) { sendText(t); return; }
  const cmd = m[1].toLowerCase();
  const rest = (m[2] || "").trim();
  const kinds = { img: "image", foto: "image", imagen: "image", video: "video", doc: "doc", archivo: "doc", documento: "doc", audio: "audio", sticker: "sticker", pegatina: "sticker" };
  if (cmd === "help" || cmd === "ayuda") {
    setToast("/img /video /doc /audio /sticker <ruta> [texto] · o Ctrl+F selector");
    draw();
    return;
  }
  const kind = kinds[cmd];
  if (!kind) { sendText(t); return; } // no es comando: texto normal
  const args = splitArgs(rest);
  if (!args.length) {
    setToast(`Uso: /${cmd} <ruta> [texto]`);
    draw();
    return;
  }
  const target = getActive();
  if (!target) return;
  if (target.isStatus && !ui.replyTo) { setToast("Elige un chat para enviar"); draw(); return; }
  const to = ui.replyTo?.to || (target.isStatus ? target.author : target.jid);
  if (String(to).endsWith("@demo")) { setToast("Contacto de ejemplo: no se envía"); draw(); return; }
  const file = resolvePath(args[0]);
  const caption = args.slice(1).join(" ");
  (async () => {
    try {
      const disp = await sendFile(to, file, kind, caption);
      setToast(`📎 enviado: ${disp.slice(0, 40)}`);
    } catch (e) {
      setToast("No se pudo enviar: " + (e.message || e));
    }
    draw();
  })();
}
// ---------------- selector de archivos (Ctrl+F) ----------------
function shortDir(d) {
  const h = os.homedir();
  return d === h ? "~" : d.startsWith(h + "/") ? "~" + d.slice(h.length) : d;
}
function readAttachDir(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    setToast("No se puede leer: " + dir);
    return;
  }
  const list = [{ name: "..", isDir: true, size: 0 }];
  const dirs = [], files = [];
  for (const e of ents) {
    if (e.name.startsWith(".")) continue;
    let size = 0;
    try { size = e.isDirectory() ? 0 : fs.statSync(path.join(dir, e.name)).size; } catch {}
    (e.isDirectory() ? dirs : files).push({ name: e.name, isDir: e.isDirectory(), size });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  ui.attach = { list: true, dir, entries: [...list, ...dirs, ...files], sel: 0, top: 0 };
}
function openAttach() {
  ui.input = "";
  ui.replyTo = null;
  readAttachDir(os.homedir());
  draw();
}
function attMove(d) {
  const a = ui.attach;
  if (!a?.list || !a.entries?.length) return;
  a.sel = Math.max(0, Math.min(a.entries.length - 1, a.sel + d));
}
function attUp() {
  const a = ui.attach;
  if (!a?.list) return;
  readAttachDir(path.dirname(a.dir));
}
function attEnter() {
  const a = ui.attach;
  if (!a?.list) return;
  const e = a.entries[a.sel];
  if (!e) return;
  const full = path.join(a.dir, e.name);
  if (e.isDir) { readAttachDir(full); draw(); return; }
  ui.attach = { file: full }; // paso 2: pedir pie/descripción en la línea de entrada
  ui.input = "";
  setToast(`📎 ${e.name} — escribe pie y Enter para enviar`);
  draw();
}

async function sendText(text) {
  const target = getActive();
  if (!target) return;
  if (target.isStatus && !ui.replyTo) {
    setToast("Los estados son solo lectura — elige uno y pulsa Ctrl+R para responderle por chat");
    draw();
    return;
  }
  if (String(target.jid).endsWith("@demo")) {
    setToast("Contacto de ejemplo: no se envía");
    return;
  }
  try {
    let to = target.isStatus ? target.author : target.jid;
    let contextInfo = null;
    if (ui.replyTo) {
      const raw = msgCache.get(ui.replyTo.msgId);
      if (!raw?.message) {
        ui.input = text; // no se pierde lo escrito
        ui.cursor = null;
        ui.replyTo = null;
        setToast("Ese mensaje ya salió de caché: elígelo de nuevo con AvPag + Ctrl+R");
        draw();
        return;
      }
      to = ui.replyTo.to;
      contextInfo = { stanzaId: ui.replyTo.msgId, participant: ui.replyTo.participant, quotedMessage: raw.message };
      ui.replyTo = null;
    }
    const sent = await sock.sendMessage(to, contextInfo ? { text, contextInfo } : { text });
    cacheMsg(sent);
    const c = ensureChat(to);
    c.lastTs = Date.now() / 1000;
    c.messages.push({ id: sent?.key?.id, fromMe: true, text, ts: c.lastTs, name: "tú", participant: sent?.key?.participant || null, remoteJid: to });
    ui.msgOff = 0;
    if (c.messages.length > MAX_MSGS_PER_CHAT) c.messages.splice(0, c.messages.length - MAX_MSGS_PER_CHAT);
    saveStore();
  } catch (e) {
    setToast("Error al enviar: " + e.message);
  }
  draw();
}

// ---------------- WhatsApp ----------------
function closeSock(s) {
  if (!s) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      s.ev.on("connection.update", (u) => u.connection === "close" && finish());
    } catch {}
    try {
      s.end(undefined);
    } catch {
      finish();
    }
    setTimeout(finish, 2500);
  });
}

// Primera vez (sin sesión): muestra el QR en la pantalla normal hasta vincular.
// Así quien descargue el programa entra directo sin pasos raros.
async function linkFlow() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestWaWebVersion().catch(() => fetchLatestBaileysVersion());
  const s = makeWASocket({
    version,
    logger,
    auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, logger) },
    browser: Browsers.macOS("Chrome"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });
  s.ev.on("creds.update", saveCreds);
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("se acabó el tiempo (5 min), abre de nuevo")), 5 * 60 * 1000);
      s.ev.on("connection.update", async (u) => {
        if (u.qr) {
          process.stdout.write("\x1b[2J\x1b[H");
          console.log("  wa-reader — vincula tu WhatsApp\n");
          console.log("  WhatsApp > ⋮ > Dispositivos vinculados > Vincular dispositivo\n");
          qrcodeTerm.generate(u.qr, { small: true });
          console.log("\n  (también se guardó en qr.png por si tu letra es chica)\n");
          await QRCode.toFile(QR_FILE, u.qr, { margin: 1, width: 320, errorCorrectionLevel: "L" }).catch(() => {});
        }
        if (u.connection === "open") { clearTimeout(to); resolve(); }
        if (u.connection === "close") {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) { clearTimeout(to); reject(new Error("sesión cerrada")); }
        }
      });
    });
  } finally {
    try { s.end(undefined); } catch {}
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function start() {
  const gen = ++connectGen;
  await closeSock(sock);
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestWaWebVersion().catch(() => fetchLatestBaileysVersion());
  const auth = {
    creds: authState.creds,
    keys: makeCacheableSignalKeyStore(authState.keys, logger),
  };
  const s = makeWASocket({
    version,
    logger,
    auth,
    browser: Browsers.macOS("Chrome"),
    syncFullHistory: true,
    markOnlineOnConnect: false,
    msgRetryCounterCache,
    getMessage: async (key) => msgCache.get(key.id)?.message,
  });
  sock = s;
  s.ev.on("creds.update", saveCreds);

  s.ev.on("messaging-history.set", ({ chats: hs = [], contacts: hc = [], messages: hm = [] }) => {
    for (const ct of hc) {
      const nm = ct.name || ct.notify || ct.verifiedName;
      if (ct.id && nm) contacts.set(ct.id, nm);
    }
    for (const c of hs) ensureChat(c.id, c.name || contacts.get(c.id));
    for (const m of hm) {
      if (m.key?.remoteJid === "status@broadcast") recordStatus(m);
      else recordMessage(m);
    }
    saveStore();
    draw();
  });
  const upsertContacts = (cs) => {
    for (const ct of cs) {
      const nm = ct.name || ct.notify || ct.verifiedName;
      if (ct.id && nm) contacts.set(ct.id, nm);
    }
    saveStore();
  };
  s.ev.on("contacts.upsert", upsertContacts);
  s.ev.on("contacts.update", upsertContacts);

  s.ev.on("connection.update", async (u) => {
    if (gen !== connectGen) return;
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      await QRCode.toFile(QR_FILE, qr, {
        margin: 1,
        width: Number(process.env.QR_WIDTH) || 320,
        errorCorrectionLevel: "L",
      }).catch(() => {});
      setToast("Escanea qr.png para vincular (o abre la app de nuevo)", 8000);
      draw();
    }
    if (connection === "open") {
      reconnecting = false;
      connected = true;
      logLine("OPEN");
      draw();
      fetchAllGroupNames(s);
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      connected = false;
      logLine("CLOSE code=" + code);
      if (code === DisconnectReason.loggedOut) cleanup();
      else if (code === DisconnectReason.restartRequired) start();
      else {
        reconnecting = true;
        setTimeout(() => gen === connectGen && start(), 3000);
      }
    }
  });

  s.ev.on("messages.upsert", ({ messages }) => {
    if (gen !== connectGen) return;
    let changed = false;
    for (const m of messages) {
      logRaw(m);
      if (m.key?.remoteJid === "status@broadcast") {
        const st = recordStatus(m, { live: true });
        if (!st) continue;
        changed = true;
        if (!m.key.fromMe) {
          const last = st.items[st.items.length - 1];
          setToast(`📖 Estado de ${st.name || m.pushName || "alguien"}: ${last.text.slice(0, 40)}`);
          if (last.media && (last.media.type === "image" || last.media.type === "video")) {
            downloadMedia(last.id, last.media).then((file) => {
              if (file) {
                last.mediaPath = file;
                saveStore();
                draw();
              } else {
                last.dlFail = true;
                draw();
              }
            });
          }
        }
        continue;
      }
      const rec = recordMessage(m, { live: true });
      if (!rec) continue;
      changed = true;
      if (!m.key.fromMe) {
        const last = rec.messages[rec.messages.length - 1];
        setToast(`🔔 ${nameFor(m.key.remoteJid || m.key.remoteJidAlt)}: ${last.text.slice(0, 40)}`);
        // auto-descargar imagen/video/sticker entrante
        if (last.media && (last.media.type === "image" || last.media.type === "video" || last.media.type === "sticker")) {
          downloadMedia(last.id, last.media).then((file) => {
            if (file) {
              last.mediaPath = file;
              saveStore();
              draw();
            } else {
              last.dlFail = true;
              draw();
            }
          });
        }
      }
    }
    if (changed) draw();
  });
}

// ---------------- arranque ----------------
loadStore();
try {
  fs.writeFileSync(LOG_FILE, "");
} catch {}
if (process.env.DEMO === "1") {
  seedDemo();
} else if (contactList().length === 0) {
  seedDemo();
}

if (process.env.DUMP) {
  process.stdout.columns = Number(process.env.COLS) || 120;
  process.stdout.rows = Number(process.env.ROWS) || 34;
  if (process.env.TAB && ["chats", "contacts", "status"].includes(process.env.TAB)) ui.tab = process.env.TAB;
  if (process.env.SEL) {
    const f = getFlatList();
    const i = f.findIndex((x) => x.jid.includes(process.env.SEL) || String(x.name).includes(process.env.SEL));
    if (i >= 0) setSel(i, f);
  }
  if (process.env.MSGSEL && /^\d+$/.test(process.env.MSGSEL)) ui.msgSel = Number(process.env.MSGSEL);
  if (process.env.INPUT) ui.input = process.env.INPUT;
  if (process.env.CURSOR && /^\d+$/.test(process.env.CURSOR)) ui.cursor = Number(process.env.CURSOR);
  if (process.env.MSGOFF && /^\d+$/.test(process.env.MSGOFF)) ui.msgOff = Number(process.env.MSGOFF);
  if (process.env.ATTACH) readAttachDir(os.homedir());
  draw();
  process.exit(0);
}

// Descarga fresca (sin sesión y sin demo): QR en pantalla para vincular y entrar.
if (!process.env.DEMO && !fs.existsSync(path.join(AUTH_DIR, "creds.json"))) {
  try {
    await linkFlow();
    console.log("¡Vinculado! Entrando a tus chats…");
  } catch (e) {
    console.error("No se pudo vincular:", e.message || e);
    process.exit(1);
  }
}

process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
try {
  process.stdin.setRawMode(true);
} catch {
  process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?1049l");
  console.error("Este programa necesita una terminal interactiva (TTY).");
  process.exit(1);
}
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", onKey);
process.on("SIGINT", cleanup);

let lastToastOn = false;
let lastMinute = -1;
const blinkTimer = setInterval(() => {
  ui.blink = !ui.blink;
  const toastOn = !!(ui.toast && Date.now() < ui.toastUntil);
  const minute = Math.floor(Date.now() / 60000);
  if (toastOn || lastToastOn || minute !== lastMinute) {
    // redibujo completo solo si hay algo nuevo (las fotos ya no parpadean)
    lastToastOn = toastOn;
    lastMinute = minute;
    draw();
  } else {
    caretTick();
  }
}, 550);
blinkTimer.unref?.();

if (!KITTY_GFX) setToast(IN_TMUX ? "En tmux las fotos no salen: sal de tmux o pon allow-passthrough on (o WA_GFX=1)" : "Tu terminal no muestra fotos inline (usa Kitty, o Ctrl+O para verlas)", 8000);
draw();
start().catch((err) => {
  process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?1049l");
  console.error("Error al iniciar:", err);
  process.exit(1);
});
