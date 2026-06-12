"use client";
//
// /inbox — Dashboard web para gestionar conversaciones WhatsApp.
// Reemplaza la app WhatsApp Business que se pierde al migrar el número al
// Cloud API. Auth con password (env var INBOX_PASSWORD verificada server-side
// vía /api/inbox/login).
//
// MVP:
//   - Lista de conversaciones (refresh cada 10s)
//   - Vista de detalle con historial completo
//   - Input para responder
//   - Indicador visual de mensajes escalados (bot pidió humano)
//   - Sin "leído/no leído" todavía
//
// Para una página estática Next.js exportada (output: 'export'), todo el flow
// de auth es client-side: el cookie se setea desde el endpoint pero esta página
// solo lo lee implícitamente al hacer fetch. Si los fetch devuelven 401, la
// página muestra el form de login.
//

import { useEffect, useState, useRef, useCallback } from "react";

interface Conversation {
  phone: string;
  lastMessage: string;
  lastDirection: "in" | "out";
  lastAt: string;
  messageCount: number;
  lastMatchedRule: string | null;
  escalated: boolean;
  botPaused: boolean;
  dismissed: boolean;
  state: string | null;
  lastOutAt: string | null;
  lastOutRule: string | null;
  contactName: string | null;
  reservation: {
    id: number;
    guestName: string | null;
    propertySlug: string | null;
    checkIn: string | null;
    checkOut: string | null;
  } | null;
}

interface Message {
  id: number;
  direction: "in" | "out";
  fromPhone: string;
  toPhone: string;
  body: string;
  matchedRule: string | null;
  escalated: boolean;
  status: string | null;
  createdAt: string;
  mediaType?: "image" | "audio" | "video" | "document" | "sticker" | null;
  mediaUrl?: string | null;
  mediaMime?: string | null;
  mediaFilename?: string | null;
}

// Respuesta rápida (plantilla) que el operador inserta en el composer con un clic.
interface QuickReply {
  id: number;
  title: string;
  content: string;
  sortOrder: number;
  active: number;
}

// API response shapes — todas siguen el patrón { ok: boolean, ... }
interface ConversationsResponse {
  ok: boolean;
  conversations?: Conversation[];
  error?: string;
}
interface MessagesResponse {
  ok: boolean;
  messages?: Message[];
  error?: string;
}
interface LoginResponse {
  ok: boolean;
  error?: string;
}
interface SendResponse {
  ok: boolean;
  messageId?: string;
  error?: string;
}

const PROPERTY_NAMES: Record<string, string> = {
  "villa-b11-palma-real": "Villa B11 — Palma Real",
  "casa-brisa": "Casa Brisa",
  "casa-marea": "Casa Marea",
  "centro-morazan": "Centro Morazán",
  "casa-lara-townhouse": "Casa Lara Townhouse",
  "la-florida": "La Florida",
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de presentación
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formatea un E.164 sin '+' a algo más legible:
 *   "50498074023" → "+504 9807-4023"
 *   "16465894168" → "+1 (646) 589-4168"
 *
 * Heurística simple por código de país. Para números que no matchean ningún
 * patrón conocido, retorna `+<dígitos>`.
 */
function formatPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  // Honduras +504 + 8 dígitos
  if (digits.startsWith("504") && digits.length === 11) {
    return `+504 ${digits.slice(3, 7)}-${digits.slice(7)}`;
  }
  // USA/Canadá +1 + 10 dígitos
  if (digits.startsWith("1") && digits.length === 11) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  // México +52 + 10 dígitos
  if (digits.startsWith("52") && digits.length === 12) {
    return `+52 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return `+${digits}`;
}

/** Normaliza texto para búsqueda: sin acentos, en minúsculas. */
function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Iniciales para el avatar (max 2 chars). */
function getInitials(name: string | null, phone: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  // Sin nombre → últimos 2 dígitos del teléfono
  return phone.slice(-2);
}

/**
 * Color de avatar determinístico por phone hash — el mismo número siempre
 * muestra el mismo color. Paleta tipo Material — colores planos suaves.
 */
const AVATAR_COLORS = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-lime-600",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-cyan-500",
  "bg-sky-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-fuchsia-500",
  "bg-pink-500",
];

function getAvatarColor(phone: string): string {
  let h = 0;
  for (let i = 0; i < phone.length; i++) h = (h * 31 + phone.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// ─────────────────────────────────────────────────────────────────────────────
// Avisos (sonido + notificación del navegador)
// ─────────────────────────────────────────────────────────────────────────────
// Tipos de evento que pueden sonar. El operador prende/apaga cada uno desde el
// botón 🔔 del header. Las preferencias viven en localStorage (por máquina).

type NotifKind = "guest" | "needsYou" | "escalated" | "botReplied";

interface NotifSettings {
  master: boolean; // interruptor general (también gobierna el permiso de notificación)
  guest: boolean; // 💬 cualquier mensaje entrante de un cliente
  needsYou: boolean; // ⏸ cliente escribió y el bot está en pausa
  escalated: boolean; // ⚠ el bot escaló a humano
  botReplied: boolean; // 🤖 el bot respondió (confirmación de vida) — default off
}

const DEFAULT_NOTIF: NotifSettings = {
  master: true,
  guest: true,
  needsYou: true,
  escalated: true,
  botReplied: false,
};

const NOTIF_LABELS: Record<NotifKind, string> = {
  guest: "💬 Mensaje nuevo",
  needsYou: "⏸ Te necesita",
  escalated: "⚠ Escalada",
  botReplied: "🤖 El bot respondió",
};

// AudioContext único, creado de forma perezosa (los navegadores lo bloquean
// hasta que hay un gesto del usuario; el botón "Probar sonido" / los toggles
// sirven de gesto).
let _audioCtx: AudioContext | null = null;

/** Beep corto generado con Web Audio (sin assets). Tono distinto por tipo para
 *  distinguir de oído "de huéspedes" vs "del bot". Best-effort: si el navegador
 *  bloquea el audio, falla en silencio. */
function playBeep(kind: NotifKind): void {
  try {
    if (typeof window === "undefined") return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!_audioCtx) _audioCtx = new AC();
    const ctx = _audioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const tone: Record<NotifKind, { f: number; d: number }> = {
      guest: { f: 660, d: 0.12 }, // huésped: nota media corta
      needsYou: { f: 880, d: 0.18 }, // te necesita: más aguda
      escalated: { f: 990, d: 0.24 }, // escalada: la más urgente
      botReplied: { f: 440, d: 0.08 }, // bot: grave y breve
    };
    const { f, d } = tone[kind];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = f;
    // Envolvente para evitar el "click" de encendido/apagado abrupto.
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + d);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + d + 0.02);
  } catch {
    /* el sonido es best-effort */
  }
}

/** Pide permiso de notificación si todavía no se decidió. Requiere gesto. */
function requestNotifPermission(): void {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  } catch {
    /* navegador sin Notification API */
  }
}

/** Fila de toggle (interruptor tipo pill) para el panel de avisos. */
function NotifToggle({
  label,
  checked,
  onChange,
  bold,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  bold?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      className="w-full flex items-center justify-between gap-2 py-1.5 text-left"
    >
      <span className={`text-[12px] ${bold ? "font-semibold" : ""} text-primary dark:text-slate-100`}>
        {label}
      </span>
      <span
        className={`w-9 h-5 rounded-full relative transition shrink-0 ${checked ? "bg-secondary" : "bg-gray-300 dark:bg-slate-600"}`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}

/**
 * Set curado de emojis para el picker — los más útiles para gestión de
 * alquileres temporales. 40 emojis ordenados por frecuencia esperada de uso:
 *   - Saludos/agradecimientos
 *   - Reservas/check-in/check-out
 *   - Lugar (playa, casa, etc.)
 *   - Indicadores de confirmación
 */
// Emojis organizados por categoría para el picker del inbox.
const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: "Caras",
    emojis: [
      "😀","😃","😄","😁","😆","😅","😂","🤣","😊","😇","🙂","🙃","😉","😌",
      "😍","🥰","😘","😗","😋","😛","😜","🤪","😎","🤓","🥳","😏","😴","🤗",
      "😅","🤔","🫡","😬","🥺","😢","😭","😤","😮","😅","😑","😐","🙄","😴",
    ],
  },
  {
    label: "Gestos",
    emojis: [
      "👋","🤚","🖐️","✋","👌","🤌","🤏","✌️","🤞","🫰","🤙","👍","👎","👊",
      "✊","🙌","👏","🙏","🤝","💪","🫶","☝️","👆","👇","👉","👈","🤟","🫵",
    ],
  },
  {
    label: "Corazones",
    emojis: [
      "❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💖","💗","💓","💕","💞",
      "💟","❣️","💔","💝","💘",
    ],
  },
  {
    label: "Viaje y playa",
    emojis: [
      "🏝️","🌴","🌊","☀️","🌞","🌙","🏖️","🌅","🌄","⛱️","🏊","🏄","🚗","✈️",
      "🛬","🗺️","📍","🧳","🌎","🏔️","🐢","🐠","🐚","🌺","🌸","🌅","⛵","🛥️",
    ],
  },
  {
    label: "Casa",
    emojis: [
      "🏡","🏠","🔑","🛏️","🛋️","🚿","🛁","🍳","☕","🧹","🧼","📺","🛜","📶",
      "🔌","🅿️","🚪","🪑","🌡️","🧺","🔥","❄️","🪟","🧴",
    ],
  },
  {
    label: "Símbolos",
    emojis: [
      "✅","❌","⚠️","✨","🎉","🎊","💯","🔥","⭐","🌟","💫","💬","📞","📧",
      "📅","🕒","💵","💳","🧾","🇭🇳","❗","❓","➡️","🆗","🙏","💰","📲","🔔",
    ],
  },
];

/** Avatar circular con iniciales sobre color sólido determinístico. */
function Avatar({
  name,
  phone,
  size = "md",
}: {
  name: string | null;
  phone: string;
  size?: "sm" | "md" | "lg";
}) {
  const initials = getInitials(name, phone);
  const color = getAvatarColor(phone);
  const sizeClass =
    size === "lg"
      ? "w-11 h-11 text-base"
      : size === "sm"
        ? "w-8 h-8 text-[11px]"
        : "w-10 h-10 text-sm";
  return (
    <div
      className={`${sizeClass} ${color} rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0`}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

/** Checks de WhatsApp para mensajes salientes: ✓ enviado, ✓✓ entregado, ✓✓ azul leído. */
function MessageStatus({ status }: { status: string | null }) {
  if (!status || status === "sent") {
    return <span title="Enviado">✓</span>;
  }
  if (status === "delivered") {
    return <span title="Entregado">✓✓</span>;
  }
  if (status === "read") {
    return <span className="text-sky-300" title="Leído">✓✓</span>;
  }
  if (status === "failed") {
    return <span className="text-red-200" title="No se pudo entregar">⚠ falló</span>;
  }
  return null;
}

// Etiquetas que el webhook pone como `body` cuando el media no trae caption.
// Si el body es solo una de estas, no la mostramos como texto (ya se ve el archivo).
const AUTO_MEDIA_LABELS = new Set([
  "📷 Imagen", "🎤 Nota de voz", "🎥 Video", "📄 Documento", "🌟 Sticker", "[multimedia]",
]);

// Renderiza el adjunto de un mensaje: imagen, nota de voz (reproducible),
// video o documento. La fuente (`mediaUrl`) ya viene resuelta del backend
// (URL pública directa para fotos del bot, o proxy /api/inbox/media para Meta).
function MediaAttachment({ msg }: { msg: Message }) {
  const url = msg.mediaUrl;
  if (!url) return null;
  if (msg.mediaType === "image" || msg.mediaType === "sticker") {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="block mb-1">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="adjunto" loading="lazy" className="rounded-lg max-h-72 w-auto object-cover" />
      </a>
    );
  }
  if (msg.mediaType === "audio") {
    // Las notas de voz de WhatsApp son ogg/opus (Safari no las reproduce inline);
    // el link de descarga es el respaldo para cualquier navegador.
    return (
      <div className="my-1">
        <audio controls preload="none" src={url} className="w-56 max-w-full h-10" />
        <a href={url} target="_blank" rel="noopener noreferrer" className="block text-[11px] underline opacity-70 mt-0.5">
          ⬇ descargar nota de voz
        </a>
      </div>
    );
  }
  if (msg.mediaType === "video") {
    return <video controls preload="metadata" src={url} className="rounded-lg max-h-72 w-auto my-1" />;
  }
  if (msg.mediaType === "document") {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 underline my-1 text-sm">
        📄 {msg.mediaFilename || "Documento"}
      </a>
    );
  }
  return null;
}

// ── Columna derecha: Pendientes / Seguimiento ─────────────────────────────────
// Agrupa las conversaciones que requieren acción para que nada se cuelgue.
// Prioridad (cada chat cae en UN solo grupo): pausa → escalada → pago → sin responder.
const PAY_STATES = new Set([
  "awaiting_transfer_proof",
  "awaiting_paypal_capture",
  "awaiting_payment_method",
]);
const PAY_LABEL: Record<string, string> = {
  awaiting_transfer_proof: "Esperando comprobante",
  awaiting_paypal_capture: "Esperando pago PayPal",
  awaiting_payment_method: "Eligiendo forma de pago",
};

function minutesSince(iso: string): number {
  try {
    const d = new Date(iso.includes("Z") ? iso : iso + "Z");
    return (Date.now() - d.getTime()) / 60000;
  } catch {
    return 0;
  }
}

function PendienteGroup({ label, count, color, children }: { label: string; count: number; color: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-gray-100 dark:border-slate-800">
      <p className={`text-[10px] font-bold uppercase tracking-wide mb-2 ${color}`}>{label} ({count})</p>
      {children}
    </div>
  );
}

function PendienteItem({
  conv, subtitle, accent, onSelect, onDismiss, active,
}: {
  conv: Conversation; subtitle: string; accent: string; onSelect: (phone: string) => void; onDismiss: (phone: string) => void; active: boolean;
}) {
  const name = conv.reservation?.guestName ?? conv.contactName ?? formatPhone(conv.phone);
  return (
    <div className={`relative rounded-lg border px-2.5 py-2 mb-1.5 last:mb-0 transition hover:brightness-95 ${accent} ${active ? "ring-2 ring-secondary/40" : ""}`}>
      <button type="button" onClick={() => onSelect(conv.phone)} className="w-full text-left pr-5">
        <div className="flex justify-between items-baseline gap-2">
          <span className="text-[12px] font-semibold text-primary dark:text-slate-100 truncate">{name}</span>
          <span className="text-[10px] text-muted dark:text-slate-400 whitespace-nowrap">{formatTimeAgo(conv.lastAt)}</span>
        </div>
        <p className="text-[11px] text-muted dark:text-slate-400 truncate">{subtitle}</p>
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDismiss(conv.phone); }}
        className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded text-muted dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-black/5 dark:hover:bg-white/10 text-[11px] leading-none"
        title="Descartar de Pendientes (reaparece si el cliente vuelve a escribir)"
        aria-label="Descartar de Pendientes"
      >
        ✕
      </button>
    </div>
  );
}

/** Traduce el motivo por el que una conversación quedó pendiente (la regla que la
 *  escaló/pausó) a un texto claro — como un empleado diciendo por qué te pide apoyo. */
function motivoPendiente(rule: string | null | undefined): string {
  switch (rule) {
    case "call_requested":            return "📞 Pidió que lo llamen";
    case "payment_reported":          return "💳 Dice que ya pagó — verificá";
    case "transfer_proof_received":   return "💳 Mandó comprobante — verificá";
    case "existing_guest_escalation": return "🏠 Huésped con reserva — pide soporte";
    case "out_of_scope_redirect":     return "❓ Consulta fuera del alcance del bot";
    case "paypal_usd_requested":      return "💵 Quiere pagar en USD (PayPal)";
    case "escalar_humano":            return "🙋 Pidió hablar con una persona";
    case "manual_inbox":              return "✍️ Vos tomaste esta conversación";
    case "bot_glitch_silent":         return "⚠️ El bot no pudo seguir solo";
    default:                          return "Necesita tu atención";
  }
}

// Pull-to-refresh: lluvia de código estilo Matrix (canvas) sobre una franja oscura.
// Corre el rAF solo mientras está "active" (jalando o actualizando); se limpia al
// desmontar. Letras teal-verde con cabeza brillante + estela.
function MatrixRain({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !parent || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const fs = 12;
    const chars = "アイウエオカキクケコサシスセソタチツテトナニヌネ0123456789ﾊﾋﾌﾍﾎ".split("");
    const w = parent.clientWidth || 320;
    const h = parent.clientHeight || 96;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#070b14";
    ctx.fillRect(0, 0, w, h);
    const cols = Math.ceil(w / fs);
    const drops = Array.from({ length: cols }, () => Math.random() * (h / fs));
    const rand = () => chars[(Math.random() * chars.length) | 0];
    let raf = 0;
    const draw = () => {
      ctx.fillStyle = "rgba(7, 11, 20, 0.12)"; // estela: cuanto más baja, más larga
      ctx.fillRect(0, 0, w, h);
      ctx.font = `${fs}px monospace`;
      for (let i = 0; i < cols; i++) {
        const x = i * fs;
        const y = drops[i] * fs;
        ctx.fillStyle = "#1aa589"; ctx.fillText(rand(), x, y - fs * 2);
        ctx.fillStyle = "#2ee6a0"; ctx.fillText(rand(), x, y - fs);
        ctx.fillStyle = "#eafff6"; ctx.fillText(rand(), x, y); // cabeza brillante
        if (y > h && Math.random() > 0.975) drops[i] = 0;
        drops[i] += 0.5;
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return <canvas ref={canvasRef} className="block w-full h-full" />;
}

// Reparte las conversaciones en las 4 categorías de "Pendientes" (lo usan tanto
// la columna de escritorio como el overlay de celular y el badge del header).
function splitPendientes(conversations: Conversation[]): {
  paused: Conversation[]; escalated: Conversation[]; awaitingPay: Conversation[]; unanswered: Conversation[]; total: number;
} {
  const paused: Conversation[] = [];
  const escalated: Conversation[] = [];
  const awaitingPay: Conversation[] = [];
  const unanswered: Conversation[] = [];
  for (const c of conversations) {
    if (c.dismissed) continue; // descartado con ✕ → fuera de Pendientes hasta que el cliente vuelva a escribir
    if (c.botPaused) paused.push(c);
    else if (c.escalated) escalated.push(c);
    else if (c.state && PAY_STATES.has(c.state)) awaitingPay.push(c);
    // "Sin responder" solo entre 30 min y 24 h: pasada la ventana de WhatsApp ya
    // no es accionable (no se puede mandar texto libre) → sale del panel solo.
    else if ((!c.lastOutAt || c.lastAt > c.lastOutAt) && minutesSince(c.lastAt) > 30 && minutesSince(c.lastAt) < 24 * 60) unanswered.push(c);
  }
  return { paused, escalated, awaitingPay, unanswered, total: paused.length + escalated.length + awaitingPay.length + unanswered.length };
}

function PendientesColumn({
  conversations, onSelect, onDismiss, selectedPhone, variant = "sidebar", onClose,
}: {
  conversations: Conversation[]; onSelect: (phone: string) => void; onDismiss: (phone: string) => void; selectedPhone: string | null;
  variant?: "sidebar" | "overlay"; onClose?: () => void;
}) {
  const { paused, escalated, awaitingPay, unanswered, total } = splitPendientes(conversations);

  return (
    <aside className={variant === "overlay"
      ? "flex flex-col h-full w-full bg-[#fbfcfc] dark:bg-slate-900 overflow-y-auto"
      : "hidden lg:flex flex-col w-72 border-l border-gray-200 dark:border-slate-700 bg-[#fbfcfc] dark:bg-slate-900 overflow-y-auto shrink-0"}>
      <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 sticky top-0 bg-[#fbfcfc] dark:bg-slate-900 z-10 flex items-start justify-between gap-2">
        <div>
          <h3 className="font-bold text-primary dark:text-slate-100 text-sm flex items-center gap-1.5">
            📌 Pendientes
            {total > 0 && <span className="text-[10px] font-bold text-white bg-secondary rounded-full px-1.5 py-0.5">{total}</span>}
          </h3>
          <p className="text-[11px] text-muted dark:text-slate-400">{total === 0 ? "todo al día 🌴" : "lo que requiere tu atención"}</p>
        </div>
        {variant === "overlay" && onClose && (
          <button type="button" onClick={onClose} aria-label="Cerrar Pendientes" className="shrink-0 -mt-0.5 px-2 py-1 text-xl leading-none text-muted dark:text-slate-400 hover:text-primary dark:hover:text-slate-100 rounded-lg">✕</button>
        )}
      </div>

      {paused.length > 0 && (
        <PendienteGroup label="⏸ En pausa · te esperan" count={paused.length} color="text-amber-700 dark:text-amber-400">
          {paused.map((c) => (
            <PendienteItem key={c.phone} conv={c} subtitle={motivoPendiente(c.lastOutRule)} accent="border-amber-200 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-950/40" onSelect={onSelect} onDismiss={onDismiss} active={selectedPhone === c.phone} />
          ))}
        </PendienteGroup>
      )}
      {escalated.length > 0 && (
        <PendienteGroup label="⚠ Escaladas" count={escalated.length} color="text-rose-700 dark:text-rose-400">
          {escalated.map((c) => (
            <PendienteItem key={c.phone} conv={c} subtitle={motivoPendiente(c.lastOutRule)} accent="border-rose-200 dark:border-rose-800/50 bg-rose-50 dark:bg-rose-950/40" onSelect={onSelect} onDismiss={onDismiss} active={selectedPhone === c.phone} />
          ))}
        </PendienteGroup>
      )}
      {awaitingPay.length > 0 && (
        <PendienteGroup label="💳 Esperando pago" count={awaitingPay.length} color="text-emerald-700 dark:text-emerald-400">
          {awaitingPay.map((c) => (
            <PendienteItem key={c.phone} conv={c} subtitle={`${PAY_LABEL[c.state ?? ""] ?? "En pago"}${c.reservation?.propertySlug ? ` · ${PROPERTY_NAMES[c.reservation.propertySlug] ?? c.reservation.propertySlug}` : ""}`} accent="border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800" onSelect={onSelect} onDismiss={onDismiss} active={selectedPhone === c.phone} />
          ))}
        </PendienteGroup>
      )}
      {unanswered.length > 0 && (
        <PendienteGroup label="🕐 Sin responder >30 min" count={unanswered.length} color="text-sky-700 dark:text-sky-400">
          {unanswered.map((c) => (
            <PendienteItem key={c.phone} conv={c} subtitle={c.lastMessage} accent="border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800" onSelect={onSelect} onDismiss={onDismiss} active={selectedPhone === c.phone} />
          ))}
        </PendienteGroup>
      )}

      {total === 0 && (
        <div className="flex-1 flex items-center justify-center px-6 text-center">
          <p className="text-muted dark:text-slate-400 text-sm">No hay nada pendiente.<br />Todo bajo control. 🌴</p>
        </div>
      )}
    </aside>
  );
}

export default function InboxPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [composeText, setComposeText] = useState("");
  const [sending, setSending] = useState(false);
  // Archivo adjunto que César va a enviar (imagen/video). El composeText hace de
  // caption opcional. El envío real va por /api/inbox/send-media (multipart).
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [loadingConv, setLoadingConv] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pendientesOpen, setPendientesOpen] = useState(false); // panel Pendientes en celular (overlay)
  const [menuOpen, setMenuOpen] = useState(false); // menú ⋯ del header en celular

  // ── Pull-to-refresh (jalar la lista hacia abajo para actualizar) ───────────
  const [pull, setPull] = useState(0);
  const [pulling, setPulling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);
  const pullCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => { pullRef.current = pull; }, [pull]);
  useEffect(() => { refreshingRef.current = refreshing; }, [refreshing]);

  // ── Avisos, no leídos, buscador y plantillas ───────────────────────────────
  const [notif, setNotif] = useState<NotifSettings>(DEFAULT_NOTIF);
  const [notifOpen, setNotifOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [quickOpen, setQuickOpen] = useState(false);
  // Snapshot de la última lista de conversaciones, para detectar novedades entre
  // polls (null = todavía no hubo primera carga → no disparar avisos al abrir).
  const prevConvSnapshotRef = useRef<Map<string, { lastAt: string; dir: string; escalated: boolean; paused: boolean }> | null>(null);
  // Espejos en ref para leer el valor más reciente desde el effect de detección
  // sin re-suscribirlo en cada cambio.
  const notifRef = useRef(notif);
  const selectedPhoneRef = useRef<string | null>(null);
  useEffect(() => { notifRef.current = notif; }, [notif]);
  useEffect(() => { selectedPhoneRef.current = selectedPhone; }, [selectedPhone]);

  // Tema día/noche del inbox. Persiste en localStorage y aplica la clase `dark`
  // al <html> (Tailwind darkMode:'class'). Solo afecta al inbox en la práctica:
  // las páginas públicas no usan variantes dark:.
  const [darkMode, setDarkMode] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setDarkMode(localStorage.getItem("inbox-theme") === "dark");
  }, []);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("dark", darkMode);
    try { localStorage.setItem("inbox-theme", darkMode ? "dark" : "light"); } catch { /* ignore */ }
    // La barra de estado del celu (PWA) combina con el header: blanco de día,
    // slate-800 de noche. Sin esto se ve una "línea" navy arriba que no pega.
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", darkMode ? "#1e293b" : "#ffffff");
  }, [darkMode]);

  // Cargar preferencias de avisos + estado de "visto" desde localStorage (1 vez).
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem("inbox-notif");
      if (raw) setNotif({ ...DEFAULT_NOTIF, ...(JSON.parse(raw) as Partial<NotifSettings>) });
      const seen = localStorage.getItem("inbox-lastSeen");
      if (seen) setLastSeen(JSON.parse(seen) as Record<string, string>);
    } catch { /* ignore */ }
  }, []);
  // Persistir preferencias de avisos al cambiarlas.
  useEffect(() => {
    try { localStorage.setItem("inbox-notif", JSON.stringify(notif)); } catch { /* ignore */ }
  }, [notif]);

  // Marca una conversación como vista hasta el timestamp `at` (no leídos).
  const markSeen = useCallback((phone: string, at: string) => {
    setLastSeen((prev) => {
      if (prev[phone] && prev[phone] >= at) return prev;
      const next = { ...prev, [phone]: at };
      try { localStorage.setItem("inbox-lastSeen", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  // Preview local del archivo adjunto (object URL revocado al cambiar/limpiar).
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!mediaFile || !mediaFile.type.startsWith("image/")) { setMediaPreview(null); return; }
    const url = URL.createObjectURL(mediaFile);
    setMediaPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [mediaFile]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * Marca al cambiar de conversación → fuerza scroll al final una vez,
   * después se desactiva hasta que vos vuelvas a estar cerca del fondo.
   * Evita que el refresh cada 10s te tire al final si estás leyendo arriba.
   */
  const forceScrollOnNextLoadRef = useRef(true);
  const prevMessageCountRef = useRef(0);

  // ── Auto-grow del textarea según contenido (max 200px = ~8 líneas) ────────
  function autoGrowTextarea(el: HTMLTextAreaElement | null): void {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  // ── Insertar texto en la posición del cursor del textarea ─────────────────
  function insertAtCursor(text: string): void {
    const el = composeRef.current;
    if (!el) {
      setComposeText((prev) => prev + text);
      return;
    }
    const start = el.selectionStart ?? composeText.length;
    const end = el.selectionEnd ?? composeText.length;
    const next = composeText.slice(0, start) + text + composeText.slice(end);
    setComposeText(next);
    // Re-posicionar cursor después del texto insertado, en siguiente tick
    setTimeout(() => {
      if (composeRef.current) {
        const pos = start + text.length;
        composeRef.current.focus();
        composeRef.current.setSelectionRange(pos, pos);
        autoGrowTextarea(composeRef.current);
      }
    }, 0);
  }

  // ── Auth check inicial ───────────────────────────────────────────────────
  const fetchConversations = useCallback(async (): Promise<void> => {
    setLoadingConv(true);
    try {
      const resp = await fetch("/api/inbox/conversations", { credentials: "include" });
      if (resp.status === 401) {
        setAuthenticated(false);
        return;
      }
      const data = (await resp.json()) as ConversationsResponse;
      if (data.ok && data.conversations) {
        setConversations(data.conversations);
        setAuthenticated(true);
      }
    } catch (err) {
      console.error("fetchConversations error", err);
    } finally {
      setLoadingConv(false);
    }
  }, []);

  // Cargar las respuestas rápidas (plantillas) del operador.
  const fetchQuickReplies = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/inbox/quick-replies", { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { ok: boolean; replies?: QuickReply[] };
      if (data.ok) setQuickReplies(data.replies ?? []);
    } catch { /* las plantillas son opcionales; si fallan, el composer sigue */ }
  }, []);

  // Reactivar el bot para una conversación pausada (handoff a humano).
  const handleResumeBot = useCallback(async (phone: string): Promise<void> => {
    try {
      await fetch("/api/inbox/bot-resume", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      fetchConversations();
    } catch (err) {
      console.error("handleResumeBot error", err);
    }
  }, [fetchConversations]);

  // Pausar el bot a mano: el humano toma el control de la conversación.
  // (Responder un mensaje NO pausa el bot — eso es una decisión explícita.)
  const handlePauseBot = useCallback(async (phone: string): Promise<void> => {
    try {
      await fetch("/api/inbox/bot-pause", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      fetchConversations();
    } catch (err) {
      console.error("handlePauseBot error", err);
    }
  }, [fetchConversations]);

  // "Que el bot retome": encola el chat para que el cron de auto-recuperación
  // reprocese el último mensaje y el bot responda solo (útil si quedó mudo por un
  // crash del LLM). Seguro de apretar: el cron lo descarta si ya hubo respuesta.
  const handleBotRetry = useCallback(async (phone: string): Promise<void> => {
    try {
      const res = await fetch("/api/inbox/bot-retry-now", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      window.alert(data.ok
        ? "✅ Listo. El bot va a retomar este chat en 1-2 min (si nadie lo atendió a mano)."
        : `No se pudo: ${data.error ?? "error"}`);
      fetchConversations();
    } catch (err) {
      console.error("handleBotRetry error", err);
    }
  }, [fetchConversations]);

  // Descartar un chat de la columna "Pendientes" (botón ✕). Reaparece si el
  // cliente vuelve a escribir (un mensaje más nuevo que el descarte).
  const handleDismiss = useCallback(async (phone: string): Promise<void> => {
    try {
      await fetch("/api/inbox/pendiente-dismiss", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      fetchConversations();
    } catch (err) {
      console.error("handleDismiss error", err);
    }
  }, [fetchConversations]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Cargar las plantillas una vez que hay sesión.
  useEffect(() => {
    if (authenticated) fetchQuickReplies();
  }, [authenticated, fetchQuickReplies]);

  // ── Pull-to-refresh: ref-callback que engancha los listeners táctiles cuando
  // la lista se MONTA (más confiable que un useEffect dependiente del timing del
  // render). non-passive en touchmove para frenar el rebote de iOS. ──────────
  const attachPull = useCallback((el: HTMLElement | null) => {
    if (pullCleanupRef.current) { pullCleanupRef.current(); pullCleanupRef.current = null; }
    if (!el) return;
    let startY = 0;
    let active = false;
    const onStart = (e: TouchEvent) => {
      if (el.scrollTop < 2 && !refreshingRef.current) { startY = e.touches[0].clientY; active = true; setPulling(true); }
      else { active = false; }
    };
    const onMove = (e: TouchEvent) => {
      if (!active) return;
      if (el.scrollTop > 2) { active = false; setPull(0); setPulling(false); return; }
      const dy = e.touches[0].clientY - startY;
      if (dy > 0) { if (e.cancelable) e.preventDefault(); setPull(Math.min(110, dy * 0.5)); }
      else { setPull(0); }
    };
    const onEnd = () => {
      if (!active) return;
      active = false;
      setPulling(false);
      if (pullRef.current >= 60 && !refreshingRef.current) {
        setRefreshing(true);
        setPull(96);
        fetchConversations().finally(() => { setRefreshing(false); setPull(0); });
      } else { setPull(0); }
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    pullCleanupRef.current = () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [fetchConversations]);

  // ── Polling cada 10s ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!authenticated) return;
    const id = setInterval(() => {
      fetchConversations();
      if (selectedPhone) loadMessages(selectedPhone);
    }, 10000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, selectedPhone]);

  // ── Avisos: detectar novedades entre polls y sonar / notificar ─────────────
  // Corre cada vez que cambia la lista de conversaciones. Compara contra el
  // snapshot previo; la primera carga solo inicializa (no dispara).
  useEffect(() => {
    const snap = new Map<string, { lastAt: string; dir: string; escalated: boolean; paused: boolean }>();
    for (const c of conversations) {
      snap.set(c.phone, { lastAt: c.lastAt, dir: c.lastDirection, escalated: c.escalated, paused: c.botPaused });
    }
    const prev = prevConvSnapshotRef.current;
    prevConvSnapshotRef.current = snap;
    if (!prev) return; // primera carga → solo inicializa el snapshot
    const s = notifRef.current;
    if (!s.master) return;

    const focused = typeof document !== "undefined" && document.hasFocus();
    const openPhone = selectedPhoneRef.current;
    const events: { conv: Conversation; kind: NotifKind }[] = [];
    for (const c of conversations) {
      const before = prev.get(c.phone);
      const advanced = !before || c.lastAt > before.lastAt;
      if (!advanced) continue;
      let kind: NotifKind | null = null;
      if (c.lastDirection === "in") {
        if (c.botPaused) kind = "needsYou";
        else if (c.escalated) kind = "escalated";
        else kind = "guest";
      } else if (c.lastDirection === "out" && c.lastOutRule !== "manual_inbox") {
        kind = "botReplied";
      }
      if (!kind || !s[kind]) continue;
      if (focused && openPhone === c.phone) continue; // ya lo estás viendo
      events.push({ conv: c, kind });
    }
    if (events.length === 0) return;
    // Un solo beep por ciclo: el del evento más urgente.
    const order: Record<NotifKind, number> = { needsYou: 0, escalated: 1, guest: 2, botReplied: 3 };
    events.sort((a, b) => order[a.kind] - order[b.kind]);
    playBeep(events[0].kind);
    // Notificaciones del navegador (máx 3; el resto lo cubre el contador del título).
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      for (const ev of events.slice(0, 3)) {
        const name = ev.conv.reservation?.guestName ?? ev.conv.contactName ?? formatPhone(ev.conv.phone);
        const body = ev.kind === "botReplied" ? name : `${name}: ${ev.conv.lastMessage}`;
        try {
          const n = new Notification(NOTIF_LABELS[ev.kind], { body, tag: ev.conv.phone });
          n.onclick = () => { window.focus(); selectConversation(ev.conv.phone); n.close(); };
        } catch { /* ignore */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations]);

  // ── Mensajes de una conversación ─────────────────────────────────────────
  async function loadMessages(phone: string): Promise<void> {
    setLoadingMsgs(true);
    try {
      const resp = await fetch(`/api/inbox/messages?phone=${encodeURIComponent(phone)}`, {
        credentials: "include",
      });
      if (resp.status === 401) {
        setAuthenticated(false);
        return;
      }
      const data = (await resp.json()) as MessagesResponse;
      if (data.ok && data.messages) {
        // Decisión de auto-scroll — solo en estos casos:
        //   1. Forzado (primera carga de la conversación o después de enviar)
        //   2. Llegó mensaje nuevo Y estabas cerca del final (< 100px)
        // Si estás leyendo arriba, NO te bajamos — respetamos tu scroll.
        const container = messagesContainerRef.current;
        const hasNewMessages = data.messages.length > prevMessageCountRef.current;
        const isNearBottom = container
          ? container.scrollHeight - container.scrollTop - container.clientHeight < 100
          : true;
        const shouldScroll =
          forceScrollOnNextLoadRef.current || (hasNewMessages && isNearBottom);

        setMessages(data.messages);
        prevMessageCountRef.current = data.messages.length;
        // La conversación abierta queda "leída" hasta su mensaje más nuevo.
        const newest = data.messages[data.messages.length - 1];
        if (newest) markSeen(phone, newest.createdAt);

        if (shouldScroll) {
          setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({
              behavior: forceScrollOnNextLoadRef.current ? "auto" : "smooth",
            });
            forceScrollOnNextLoadRef.current = false;
          }, 100);
        }
      }
    } catch (err) {
      console.error("loadMessages error", err);
    } finally {
      setLoadingMsgs(false);
    }
  }

  function selectConversation(phone: string): void {
    setSelectedPhone(phone);
    // Cambio de conversación → fuerza scroll al final una vez
    forceScrollOnNextLoadRef.current = true;
    prevMessageCountRef.current = 0;
    // Marcar como leída al abrirla (no leídos).
    const c = conversations.find((x) => x.phone === phone);
    if (c) markSeen(phone, c.lastAt);
    loadMessages(phone);
  }

  // ── Link mágico: abrir directo un chat desde ?c=<teléfono> ──────────────────
  // Las alertas de WhatsApp al equipo traen un botón "Abrir en inbox" que apunta
  // a /inbox?c=50488390145. Al entrar (ya con sesión) abrimos ese chat solo y
  // limpiamos el query para que un refresh no lo vuelva a forzar.
  const deepLinkedRef = useRef(false);
  useEffect(() => {
    if (!authenticated || deepLinkedRef.current || typeof window === "undefined") return;
    const c = new URLSearchParams(window.location.search).get("c");
    if (c && /^\d{8,15}$/.test(c)) {
      deepLinkedRef.current = true;
      selectConversation(c);
      try { window.history.replaceState(null, "", "/inbox"); } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);

  // ── Login ────────────────────────────────────────────────────────────────
  async function handleLogin(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setLoginError(null);
    const form = e.currentTarget;
    const formData = new FormData(form);
    const password = String(formData.get("password") ?? "");
    if (!password) {
      setLoginError("Contraseña vacía");
      return;
    }
    try {
      const resp = await fetch("/api/inbox/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await resp.json()) as LoginResponse;
      if (data.ok) {
        setAuthenticated(true);
        fetchConversations();
      } else {
        setLoginError(data.error ?? "Error desconocido");
      }
    } catch (err) {
      setLoginError("Error de red: " + (err as Error).message);
    }
  }

  async function handleLogout(): Promise<void> {
    await fetch("/api/inbox/logout", { method: "POST", credentials: "include" });
    setAuthenticated(false);
    setConversations([]);
    setMessages([]);
    setSelectedPhone(null);
  }

  // ── Enviar mensaje ───────────────────────────────────────────────────────
  async function handleSend(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    // Si hay un archivo adjunto, el envío va por la ruta de media (el texto del
    // composer se usa como caption).
    if (mediaFile) {
      await handleSendMedia();
      return;
    }
    if (!selectedPhone || !composeText.trim() || sending) return;
    setSending(true);
    try {
      const resp = await fetch("/api/inbox/send", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: selectedPhone, text: composeText.trim() }),
      });
      const data = (await resp.json()) as SendResponse;
      if (data.ok) {
        setComposeText("");
        // Reset altura del textarea (sino queda con el tamaño del mensaje viejo)
        if (composeRef.current) {
          composeRef.current.style.height = "auto";
        }
        setEmojiOpen(false);
        // Después de enviar SÍ queremos saltar al final (estás participando
        // activamente en la conversación).
        forceScrollOnNextLoadRef.current = true;
        loadMessages(selectedPhone);
        fetchConversations();
      } else {
        alert("Error al enviar: " + (data.error ?? "desconocido"));
      }
    } catch (err) {
      alert("Error de red: " + (err as Error).message);
    } finally {
      setSending(false);
    }
  }

  // ── Adjuntar y enviar imagen/video ────────────────────────────────────────
  const MAX_IMAGE_MB = 5;
  const MAX_VIDEO_MB = 16;

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0];
    e.target.value = ""; // permite re-elegir el mismo archivo después
    if (!f) return;
    const isImage = f.type.startsWith("image/");
    const isVideo = f.type.startsWith("video/");
    if (!isImage && !isVideo) {
      alert("Solo se pueden enviar imágenes o videos.");
      return;
    }
    const maxMb = isImage ? MAX_IMAGE_MB : MAX_VIDEO_MB;
    if (f.size > maxMb * 1024 * 1024) {
      alert(`El archivo es muy grande (${(f.size / 1048576).toFixed(1)}MB). Máximo ${maxMb}MB para ${isImage ? "imágenes" : "videos"}.`);
      return;
    }
    setMediaFile(f);
  }

  async function handleSendMedia(): Promise<void> {
    if (!selectedPhone || !mediaFile || sending) return;
    setSending(true);
    try {
      const fd = new FormData();
      fd.append("phone", selectedPhone);
      fd.append("file", mediaFile);
      if (composeText.trim()) fd.append("caption", composeText.trim());
      const resp = await fetch("/api/inbox/send-media", {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      const data = (await resp.json()) as SendResponse;
      if (data.ok) {
        setMediaFile(null);
        setComposeText("");
        if (composeRef.current) composeRef.current.style.height = "auto";
        setEmojiOpen(false);
        forceScrollOnNextLoadRef.current = true;
        loadMessages(selectedPhone);
        fetchConversations();
      } else {
        alert("Error al enviar: " + (data.error ?? "desconocido"));
      }
    } catch (err) {
      alert("Error de red: " + (err as Error).message);
    } finally {
      setSending(false);
    }
  }

  // ── Derivados: no leídos + filtro de búsqueda ──────────────────────────────
  // Una conversación está "no leída" si lo último es del cliente (in) y es más
  // nuevo que la última vez que la abriste.
  const isUnread = (c: Conversation): boolean =>
    c.lastDirection === "in" && (!lastSeen[c.phone] || c.lastAt > lastSeen[c.phone]);
  const unreadTotal = conversations.reduce((n, c) => (isUnread(c) ? n + 1 : n), 0);

  const filteredConversations = (() => {
    const q = search.trim();
    if (!q) return conversations;
    const nq = normalizeText(q);
    const digits = q.replace(/\D/g, "");
    return conversations.filter((c) => {
      const name = c.reservation?.guestName ?? c.contactName ?? "";
      const prop = c.reservation?.propertySlug
        ? PROPERTY_NAMES[c.reservation.propertySlug] ?? c.reservation.propertySlug
        : "";
      const textHit = normalizeText(`${name} ${c.lastMessage} ${prop}`).includes(nq);
      const phoneHit = digits.length >= 2 && c.phone.includes(digits);
      return textHit || phoneHit;
    });
  })();

  // Contador de no leídos en el título de la pestaña (awareness aunque estés en
  // otra pestaña).
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = unreadTotal > 0 ? `(${unreadTotal}) Inbox · Estadías Jacarí` : "Inbox · Estadías Jacarí";
  }, [unreadTotal]);

  // ── Render ───────────────────────────────────────────────────────────────

  if (authenticated === null) {
    return (
      <div className="min-h-screen bg-bg dark:bg-slate-950 flex items-center justify-center">
        <p className="text-muted dark:text-slate-400">Cargando...</p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-bg dark:bg-slate-950 flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg p-8">
          <h1 className="font-display text-3xl text-primary dark:text-slate-100 mb-2">Inbox</h1>
          <p className="text-muted dark:text-slate-400 text-sm mb-6">Acceso privado — Estadías Jacarí</p>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-primary dark:text-slate-100 mb-1.5">
                Contraseña
              </label>
              <input
                type="password"
                name="password"
                autoFocus
                className="w-full px-4 py-2.5 border border-gray-300 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                required
              />
            </div>
            {loginError && (
              <p className="text-red-600 dark:text-red-300 text-sm bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 rounded-lg px-3 py-2">
                {loginError}
              </p>
            )}
            <button
              type="submit"
              className="w-full bg-primary text-white font-semibold py-2.5 rounded-lg hover:bg-primary/90 transition"
            >
              Entrar
            </button>
          </form>
        </div>
      </div>
    );
  }

  const pendCount = splitPendientes(conversations).total;

  return (
    <div className="h-screen bg-bg dark:bg-slate-950 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 px-3 sm:px-4 py-2.5 sm:py-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="font-display text-xl text-primary dark:text-slate-100 leading-tight">Inbox</h1>
          <p className="hidden sm:block text-xs text-muted dark:text-slate-400">Estadías Jacarí · WhatsApp manual</p>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-3 text-sm">
          {/* Pendientes — solo en celular (en escritorio está la columna fija a la derecha) */}
          <button
            type="button"
            onClick={() => setPendientesOpen(true)}
            className="lg:hidden relative px-2.5 py-1.5 border border-gray-300 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-muted dark:text-slate-400"
            aria-label="Pendientes"
            title="Pendientes"
          >
            📌
            {pendCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] text-[10px] font-bold text-white bg-secondary rounded-full px-1 py-0.5 leading-none">{pendCount}</span>
            )}
          </button>
          {/* Avisos: sonido + notificación, configurable por tipo */}
          <div className="relative">
            <button
              onClick={() => setNotifOpen((o) => !o)}
              className="px-3 py-1.5 border border-gray-300 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-muted dark:text-slate-400"
              aria-label="Avisos y sonido"
              title="Avisos y sonido"
            >
              {notif.master ? "🔔" : "🔕"}
            </button>
            {notifOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setNotifOpen(false)} />
                <div className="fixed left-2 right-2 top-16 w-auto sm:absolute sm:left-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-72 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-lg z-20 p-3 text-left">
                  <p className="text-xs font-bold text-primary dark:text-slate-100 mb-1">🔔 Avisos y sonido</p>
                  <NotifToggle
                    label="Avisos activados"
                    checked={notif.master}
                    bold
                    onChange={() => {
                      setNotif((s) => ({ ...s, master: !s.master }));
                      if (!notif.master) requestNotifPermission();
                    }}
                  />
                  <div className={`mt-0.5 ${notif.master ? "" : "opacity-40 pointer-events-none"}`}>
                    <NotifToggle label="💬 Mensajes de huéspedes" checked={notif.guest} onChange={() => setNotif((s) => ({ ...s, guest: !s.guest }))} />
                    <NotifToggle label="⏸ Te necesita (pausa / sin responder)" checked={notif.needsYou} onChange={() => setNotif((s) => ({ ...s, needsYou: !s.needsYou }))} />
                    <NotifToggle label="⚠ Escaladas" checked={notif.escalated} onChange={() => setNotif((s) => ({ ...s, escalated: !s.escalated }))} />
                    <NotifToggle label="🤖 Bot respondió" checked={notif.botReplied} onChange={() => setNotif((s) => ({ ...s, botReplied: !s.botReplied }))} />
                  </div>
                  <button
                    type="button"
                    onClick={() => { requestNotifPermission(); playBeep("guest"); }}
                    className="mt-2 w-full text-[12px] font-semibold text-primary dark:text-slate-100 border border-gray-300 dark:border-slate-600 rounded-lg py-1.5 hover:bg-gray-50 dark:hover:bg-slate-700"
                  >
                    🔊 Probar sonido
                  </button>
                  {typeof Notification !== "undefined" && Notification.permission === "denied" && (
                    <p className="mt-2 text-[10px] text-amber-700 dark:text-amber-400 leading-snug">
                      Las notificaciones están bloqueadas en el navegador. El sonido igual funciona; para ver pop-ups, permitilas en los ajustes del sitio.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => setDarkMode((d) => !d)}
            className="px-3 py-1.5 border border-gray-300 dark:border-slate-600 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 dark:hover:bg-slate-800 text-muted dark:text-slate-400"
            aria-label="Cambiar tema día/noche"
            title={darkMode ? "Modo día" : "Modo noche"}
          >
            {darkMode ? "☀️" : "🌙"}
          </button>
          {/* Secundarios: inline en escritorio; en celular van al menú ⋯ */}
          <a
            href="/inbox/operacion"
            className="hidden lg:inline-flex items-center px-3 py-1.5 border border-gray-300 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-muted dark:text-slate-400 whitespace-nowrap"
          >
            🛰️ Centro de control
          </a>
          <a
            href="/inbox/conocimiento"
            className="hidden lg:inline-flex items-center px-3 py-1.5 border border-gray-300 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-muted dark:text-slate-400 whitespace-nowrap"
          >
            🤖 Conocimiento del bot
          </a>
          <button
            onClick={fetchConversations}
            disabled={loadingConv}
            className="hidden lg:inline-flex items-center px-3 py-1.5 border border-gray-300 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-muted dark:text-slate-400 disabled:opacity-50 whitespace-nowrap"
          >
            {loadingConv ? "..." : "Refrescar"}
          </button>
          <button
            onClick={handleLogout}
            className="hidden lg:inline-flex items-center px-3 py-1.5 text-muted dark:text-slate-400 hover:text-primary dark:text-slate-100"
          >
            Salir
          </button>
          {/* Menú ⋯ — solo celular (en escritorio los botones de arriba van inline) */}
          <div className="relative lg:hidden">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              className="px-2.5 py-1.5 border border-gray-300 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-muted dark:text-slate-400 text-lg leading-none"
              aria-label="Más opciones"
              title="Más"
            >
              ⋯
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-lg z-20 py-1">
                  <a href="/inbox/operacion" className="block px-4 py-2.5 text-sm text-primary dark:text-slate-100 hover:bg-gray-50 dark:hover:bg-slate-700">🛰️ Centro de control</a>
                  <a href="/inbox/conocimiento" className="block px-4 py-2.5 text-sm text-primary dark:text-slate-100 hover:bg-gray-50 dark:hover:bg-slate-700">🤖 Conocimiento del bot</a>
                  <button type="button" onClick={handleLogout} className="block w-full text-left px-4 py-2.5 text-sm text-rose-600 dark:text-rose-400 hover:bg-gray-50 dark:hover:bg-slate-700 border-t border-gray-100 dark:border-slate-700">Salir</button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Lista de conversaciones */}
        <aside ref={attachPull} className={`${selectedPhone ? "hidden lg:block" : "block"} w-full lg:w-80 lg:shrink-0 border-r border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-y-auto overscroll-y-contain`}>
          {/* Buscador */}
          <div className="sticky top-0 z-10 bg-white dark:bg-slate-800 px-3 py-2 border-b border-gray-100 dark:border-slate-800">
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted dark:text-slate-400 text-sm pointer-events-none">🔍</span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nombre o teléfono…"
                className="w-full pl-8 pr-7 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-900 text-primary dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted dark:text-slate-400 hover:text-primary dark:hover:text-slate-100 text-sm"
                  aria-label="Limpiar búsqueda"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Pull-to-refresh: lluvia de código estilo Matrix en franja oscura (solo celular) */}
          <div
            className="lg:hidden overflow-hidden flex items-end"
            style={{ height: pull, transition: pulling ? "none" : "height 0.25s ease", background: "#070b14" }}
          >
            {(pull > 4 || refreshing) && (
              <div className="w-full" style={{ height: 96 }}>
                <MatrixRain active={pull > 4 || refreshing} />
              </div>
            )}
          </div>
          {/* Loader cool: barra de progreso futurista + filas fantasma con shimmer (solo en la carga inicial; los refrescos automáticos no titilan) */}
          {conversations.length === 0 && loadingConv && (
            <>
              <div className="jacari-progress-bar" />
              <ul>
                {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                  <li key={i} className="px-4 py-3 border-b border-gray-100 dark:border-slate-800 flex gap-3 items-center">
                    <div className="w-10 h-10 rounded-full jacari-skeleton shrink-0" />
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="h-3 jacari-skeleton rounded" style={{ width: `${52 + (i % 3) * 12}%` }} />
                      <div className="h-2.5 jacari-skeleton rounded" style={{ width: `${72 - (i % 4) * 10}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {conversations.length === 0 && !loadingConv && (
            <div className="p-6 text-center text-muted dark:text-slate-400 text-sm">
              No hay conversaciones todavía.
              <br />
              Aparecerán cuando los huéspedes escriban.
            </div>
          )}
          {conversations.length > 0 && filteredConversations.length === 0 && (
            <div className="p-6 text-center text-muted dark:text-slate-400 text-sm">
              Nada coincide con “{search}”.
            </div>
          )}
          <ul>
            {filteredConversations.map((c) => {
              const unread = isUnread(c);
              return (
              <li
                key={c.phone}
                onClick={() => selectConversation(c.phone)}
                className={`px-4 py-3 border-b border-gray-100 dark:border-slate-800 border-l-4 cursor-pointer transition flex gap-3 ${
                  c.botPaused ? "border-l-amber-400" : "border-l-transparent"
                } ${
                  selectedPhone === c.phone
                    ? "bg-secondary/10"
                    : c.botPaused
                      ? "bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-100/70 dark:hover:bg-amber-900/40"
                      : "hover:bg-gray-50 dark:hover:bg-slate-800"
                }`}
              >
                <Avatar
                  name={c.reservation?.guestName ?? c.contactName ?? null}
                  phone={c.phone}
                  size="md"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between mb-0.5 gap-2">
                    <span className="flex items-center gap-1.5 min-w-0">
                      {unread && <span className="w-2 h-2 rounded-full bg-secondary shrink-0" title="No leído" />}
                      <span className={`${unread ? "font-bold" : "font-semibold"} text-primary dark:text-slate-100 text-sm truncate`}>
                        {c.reservation?.guestName ?? c.contactName ?? formatPhone(c.phone)}
                      </span>
                    </span>
                    <span className="text-[10px] text-muted dark:text-slate-400 whitespace-nowrap">
                      {formatTimeAgo(c.lastAt)}
                    </span>
                  </div>
                  {c.reservation && (
                    <p className="text-[11px] text-secondary mb-0.5">
                      {PROPERTY_NAMES[c.reservation.propertySlug ?? ""] ?? c.reservation.propertySlug}
                      {c.reservation.checkIn && ` · ${c.reservation.checkIn}`}
                    </p>
                  )}
                  <p className="text-xs text-muted dark:text-slate-400 truncate">
                    {c.lastDirection === "out" && <span className="text-secondary">Tú: </span>}
                    {c.lastMessage}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {c.botPaused && (
                      <span className="text-[10px] font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-700/50 px-1.5 py-0.5 rounded">
                        ⏸ Bot en pausa
                      </span>
                    )}
                    {c.escalated && (
                      <span className="text-[10px] bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 px-1.5 py-0.5 rounded">
                        ⚠ escalado
                      </span>
                    )}
                    {c.lastMatchedRule && c.lastMatchedRule !== "manual_inbox" && (
                      <span className="text-[10px] bg-secondary/15 text-secondary px-1.5 py-0.5 rounded">
                        🤖 {c.lastMatchedRule}
                      </span>
                    )}
                  </div>
                </div>
              </li>
              );
            })}
          </ul>
        </aside>

        {/* Detalle de conversación */}
        <main className={`${selectedPhone ? "flex" : "hidden lg:flex"} flex-1 flex-col min-w-0`}>
          {!selectedPhone ? (
            <div className="flex-1 flex items-center justify-center text-muted dark:text-slate-400">
              Selecciona una conversación
            </div>
          ) : (
            <>
              {/* Header conversación */}
              {(() => {
                const conv = conversations.find((c) => c.phone === selectedPhone);
                const guestName = conv?.reservation?.guestName ?? conv?.contactName ?? null;
                const paused = conv?.botPaused ?? false;
                return (
                  <>
                    <div className="bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 px-4 sm:px-6 py-3 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setSelectedPhone(null)}
                        className="lg:hidden -ml-1 shrink-0 px-1.5 py-1 text-2xl leading-none text-primary dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg"
                        aria-label="Volver a la lista de chats"
                        title="Volver a los chats"
                      >
                        ←
                      </button>
                      <Avatar name={guestName} phone={selectedPhone} size="lg" />
                      <div className="min-w-0">
                        <h2 className="font-semibold text-primary dark:text-slate-100 leading-tight">
                          {guestName ?? formatPhone(selectedPhone)}
                        </h2>
                        {/* Solo mostrar el teléfono debajo si arriba estamos
                            mostrando un nombre — sino sería un duplicado. */}
                        {guestName && (
                          <p className="text-xs text-muted dark:text-slate-400">{formatPhone(selectedPhone)}</p>
                        )}
                        {conv?.reservation && (
                          <p className="text-[11px] text-secondary mt-0.5">
                            {PROPERTY_NAMES[conv.reservation.propertySlug ?? ""] ?? conv.reservation.propertySlug}
                            {conv.reservation.checkIn && ` · ${conv.reservation.checkIn}`}
                          </p>
                        )}
                      </div>
                    </div>
                    {/* Barra de estado del bot — ancho completo (verde = activo / ámbar = en pausa) */}
                    <div
                      className="w-full flex flex-wrap items-center justify-between gap-2 px-4 sm:px-6 py-2 border-b"
                      style={paused
                        ? { background: "#fef3c7", borderColor: "#fcd34d" }
                        : { background: "#dcfce7", borderColor: "#86efac" }}
                    >
                      <span
                        className="flex items-center gap-2 text-[13px] font-bold whitespace-nowrap"
                        style={{ color: paused ? "#92400e" : "#166534" }}
                      >
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${paused ? "" : "animate-pulse"}`}
                          style={{ background: paused ? "#d97706" : "#16a34a" }}
                        />
                        {paused ? "⏸ Bot en pausa · le respondés vos" : "🤖 Bot activo · responde solo"}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        {!paused && (
                          <button
                            type="button"
                            onClick={() => { if (selectedPhone) handleBotRetry(selectedPhone); }}
                            className="text-[12px] font-semibold text-slate-700 bg-white/80 border border-slate-300 hover:bg-white rounded-lg px-3 py-1 whitespace-nowrap transition"
                            title="Reprocesa el último mensaje: si el bot quedó mudo por un crash, lo retoma solo en 1-2 min"
                          >
                            🔄 Que el bot retome
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => { if (selectedPhone) (paused ? handleResumeBot : handlePauseBot)(selectedPhone); }}
                          className={paused
                            ? "text-[12px] font-semibold text-white bg-secondary hover:opacity-90 rounded-lg px-3 py-1 whitespace-nowrap transition"
                            : "text-[12px] font-semibold text-green-900/70 bg-white/70 border border-green-300 hover:bg-white rounded-lg px-3 py-1 whitespace-nowrap transition"}
                        >
                          {paused ? "Reactivar bot" : "Pausar bot"}
                        </button>
                      </div>
                    </div>
                  </>
                );
              })()}

              {/* Mensajes */}
              <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-3">
                {loadingMsgs && messages.length === 0 && (
                  <p className="text-center text-muted dark:text-slate-400 text-sm">Cargando...</p>
                )}
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[70%] rounded-2xl px-4 py-2 ${
                        m.direction === "out"
                          ? "bg-secondary text-white"
                          : "bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-primary dark:text-slate-100"
                      }`}
                    >
                      {m.mediaType && <MediaAttachment msg={m} />}
                      {m.body && !AUTO_MEDIA_LABELS.has(m.body) && (
                        <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
                      )}
                      <p className={`text-[10px] mt-1 flex items-center gap-1 ${m.direction === "out" ? "text-white/70 justify-end" : "text-muted dark:text-slate-400"}`}>
                        <span>{formatDate(m.createdAt)}</span>
                        {m.matchedRule && m.matchedRule !== "manual_inbox" && <span>· 🤖 {m.matchedRule}</span>}
                        {m.escalated && <span>· ⚠</span>}
                        {m.direction === "out" && <MessageStatus status={m.status} />}
                      </p>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Composer */}
              <form
                onSubmit={handleSend}
                className="bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 p-3 sm:p-4 flex gap-2 sm:gap-3 items-end relative"
              >
                {/* Emoji picker — popover por categorías, scrolleable */}
                {emojiOpen && (
                  <div
                    className="absolute bottom-full left-4 mb-2 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-lg z-10 overflow-y-auto"
                    style={{ width: "20rem", maxHeight: "18rem" }}
                  >
                    {EMOJI_CATEGORIES.map((cat) => (
                      <div key={cat.label} className="p-2">
                        <p className="text-[10px] uppercase tracking-wide text-muted dark:text-slate-400 px-1 mb-1 sticky top-0 bg-white dark:bg-slate-800">
                          {cat.label}
                        </p>
                        <div className="grid grid-cols-8 gap-1">
                          {cat.emojis.map((e, i) => (
                            <button
                              key={`${cat.label}-${i}`}
                              type="button"
                              onClick={() => {
                                insertAtCursor(e);
                                // no cerramos: permite insertar varios seguidos
                              }}
                              className="text-xl hover:bg-gray-100 dark:hover:bg-slate-700 rounded p-1 transition"
                              aria-label={`Insertar ${e}`}
                            >
                              {e}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Respuestas rápidas (plantillas) */}
                {quickOpen && (
                  <div className="absolute bottom-full left-4 mb-2 w-80 max-h-72 overflow-y-auto bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-lg z-10">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800">
                      <p className="text-[10px] uppercase tracking-wide text-muted dark:text-slate-400">Respuestas rápidas</p>
                      <a href="/inbox/conocimiento" className="text-[10px] underline text-secondary">Editar</a>
                    </div>
                    {quickReplies.length === 0 ? (
                      <p className="px-3 py-4 text-sm text-muted dark:text-slate-400">
                        No hay plantillas todavía. Crealas en{" "}
                        <a href="/inbox/conocimiento" className="underline text-secondary">Conocimiento del bot</a>.
                      </p>
                    ) : (
                      quickReplies.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => { insertAtCursor(r.content); setQuickOpen(false); }}
                          className="w-full text-left px-3 py-2 border-b border-gray-100 dark:border-slate-700 last:border-b-0 hover:bg-gray-50 dark:hover:bg-slate-700 transition"
                        >
                          <p className="text-[12px] font-semibold text-primary dark:text-slate-100">{r.title}</p>
                          <p className="text-[11px] text-muted dark:text-slate-400 line-clamp-2 whitespace-pre-wrap">{r.content}</p>
                        </button>
                      ))
                    )}
                  </div>
                )}

                {/* Preview del archivo adjunto (imagen/video a enviar) */}
                {mediaFile && (
                  <div className="absolute bottom-full left-0 right-0 mb-2 mx-4 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-lg p-2 flex items-center gap-3 z-10">
                    {mediaPreview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={mediaPreview} alt="preview" className="h-14 w-14 rounded object-cover shrink-0" />
                    ) : (
                      <div className="h-14 w-14 rounded bg-gray-100 dark:bg-slate-700 flex items-center justify-center text-2xl shrink-0">🎥</div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-primary dark:text-slate-100 truncate">{mediaFile.name}</p>
                      <p className="text-[11px] text-muted dark:text-slate-400">
                        {(mediaFile.size / 1048576).toFixed(1)} MB · se enviará al cliente{composeText.trim() ? " con tu texto de pie" : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setMediaFile(null)}
                      disabled={sending}
                      className="text-muted dark:text-slate-400 hover:text-red-500 transition text-xl px-2 self-start disabled:opacity-50"
                      aria-label="Quitar archivo"
                    >
                      ✕
                    </button>
                  </div>
                )}

                {/* Input file oculto + botón adjuntar */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,video/mp4,video/3gpp"
                  className="hidden"
                  onChange={onPickFile}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sending}
                  className="text-2xl text-muted dark:text-slate-400 hover:text-primary dark:hover:text-slate-100 transition disabled:opacity-50 self-end pb-1"
                  aria-label="Adjuntar imagen o video"
                  title="Adjuntar imagen o video"
                >
                  📎
                </button>

                {/* Botón emoji */}
                <button
                  type="button"
                  onClick={() => { setEmojiOpen((v) => !v); setQuickOpen(false); }}
                  disabled={sending}
                  className="text-2xl text-muted dark:text-slate-400 hover:text-primary dark:text-slate-100 transition disabled:opacity-50 self-end pb-1"
                  aria-label="Abrir selector de emojis"
                >
                  😊
                </button>

                {/* Botón respuestas rápidas */}
                <button
                  type="button"
                  onClick={() => { setQuickOpen((v) => !v); setEmojiOpen(false); }}
                  disabled={sending}
                  className="text-2xl text-muted dark:text-slate-400 hover:text-primary dark:hover:text-slate-100 transition disabled:opacity-50 self-end pb-1"
                  aria-label="Respuestas rápidas"
                  title="Respuestas rápidas"
                >
                  💬
                </button>

                {/* Textarea con auto-grow */}
                <textarea
                  ref={composeRef}
                  value={composeText}
                  onChange={(e) => {
                    setComposeText(e.target.value);
                    autoGrowTextarea(e.target);
                  }}
                  onKeyDown={(e) => {
                    // Cmd/Ctrl+Enter → enviar (atajo power-user)
                    // Enter solo → nueva línea (comportamiento natural del textarea)
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      if ((composeText.trim() || mediaFile) && !sending) {
                        handleSend(e as unknown as React.FormEvent<HTMLFormElement>);
                      }
                    }
                  }}
                  placeholder={mediaFile ? "Pie de foto (opcional)…" : "Escribir mensaje…"}
                  rows={1}
                  className="flex-1 px-4 py-2.5 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-900 text-primary dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-500 text-base focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent resize-none overflow-y-auto leading-relaxed"
                  style={{ maxHeight: "200px" }}
                  disabled={sending}
                />

                {/* Botón enviar */}
                <button
                  type="submit"
                  disabled={sending || (!composeText.trim() && !mediaFile)}
                  className="bg-primary text-white font-semibold px-4 sm:px-6 py-2.5 rounded-lg hover:bg-primary/90 transition disabled:opacity-50 self-end shrink-0"
                >
                  {sending ? "..." : mediaFile ? "Enviar 📎" : "Enviar"}
                </button>
              </form>
            </>
          )}
        </main>

        {/* Columna derecha: pendientes / seguimiento (solo en pantallas anchas) */}
        <PendientesColumn
          conversations={conversations}
          onSelect={selectConversation}
          onDismiss={handleDismiss}
          selectedPhone={selectedPhone}
        />

        {/* Pendientes en celular: overlay a pantalla completa (la columna de arriba es hidden lg:flex) */}
        {pendientesOpen && (
          <div className="lg:hidden fixed inset-0 z-30 bg-[#fbfcfc] dark:bg-slate-900 flex flex-col">
            <PendientesColumn
              variant="overlay"
              onClose={() => setPendientesOpen(false)}
              conversations={conversations}
              onSelect={(p) => { setPendientesOpen(false); selectConversation(p); }}
              onDismiss={handleDismiss}
              selectedPhone={selectedPhone}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Formateo de fechas
// ─────────────────────────────────────────────────────────────────────────────

function formatTimeAgo(iso: string): string {
  try {
    const d = new Date(iso.includes("Z") ? iso : iso + "Z");
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "ahora";
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d`;
    return d.toLocaleDateString("es-MX", { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso.includes("Z") ? iso : iso + "Z");
    return d.toLocaleString("es-MX", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
