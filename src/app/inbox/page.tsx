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

function PendientesColumn({
  conversations, onSelect, onDismiss, selectedPhone,
}: {
  conversations: Conversation[]; onSelect: (phone: string) => void; onDismiss: (phone: string) => void; selectedPhone: string | null;
}) {
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
  const total = paused.length + escalated.length + awaitingPay.length + unanswered.length;

  return (
    <aside className="hidden lg:flex flex-col w-72 border-l border-gray-200 dark:border-slate-700 bg-[#fbfcfc] dark:bg-slate-900 overflow-y-auto shrink-0">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 sticky top-0 bg-[#fbfcfc] dark:bg-slate-900 z-10">
        <h3 className="font-bold text-primary dark:text-slate-100 text-sm flex items-center gap-1.5">
          📌 Pendientes
          {total > 0 && <span className="text-[10px] font-bold text-white bg-secondary rounded-full px-1.5 py-0.5">{total}</span>}
        </h3>
        <p className="text-[11px] text-muted dark:text-slate-400">{total === 0 ? "todo al día 🌴" : "lo que requiere tu atención"}</p>
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
  }, [darkMode]);
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
    loadMessages(phone);
  }

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

  return (
    <div className="h-screen bg-bg dark:bg-slate-950 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="font-display text-xl text-primary dark:text-slate-100">Inbox</h1>
          <p className="text-xs text-muted dark:text-slate-400">Estadías Jacarí · WhatsApp manual</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <button
            onClick={() => setDarkMode((d) => !d)}
            className="px-3 py-1.5 border border-gray-300 dark:border-slate-600 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 dark:hover:bg-slate-800 text-muted dark:text-slate-400"
            aria-label="Cambiar tema día/noche"
            title={darkMode ? "Modo día" : "Modo noche"}
          >
            {darkMode ? "☀️" : "🌙"}
          </button>
          <a
            href="/inbox/operacion"
            className="px-3 py-1.5 border border-gray-300 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-muted dark:text-slate-400"
          >
            🛰️ Centro de control
          </a>
          <a
            href="/inbox/conocimiento"
            className="px-3 py-1.5 border border-gray-300 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-muted dark:text-slate-400"
          >
            🤖 Conocimiento del bot
          </a>
          <button
            onClick={fetchConversations}
            disabled={loadingConv}
            className="px-3 py-1.5 border border-gray-300 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-muted dark:text-slate-400 disabled:opacity-50"
          >
            {loadingConv ? "..." : "Refrescar"}
          </button>
          <button
            onClick={handleLogout}
            className="px-3 py-1.5 text-muted dark:text-slate-400 hover:text-primary dark:text-slate-100"
          >
            Salir
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Lista de conversaciones */}
        <aside className="w-80 border-r border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 dark:bg-slate-800 overflow-y-auto">
          {conversations.length === 0 && !loadingConv && (
            <div className="p-6 text-center text-muted dark:text-slate-400 text-sm">
              No hay conversaciones todavía.
              <br />
              Aparecerán cuando los huéspedes escriban.
            </div>
          )}
          <ul>
            {conversations.map((c) => (
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
                    <span className="font-semibold text-primary dark:text-slate-100 text-sm truncate">
                      {c.reservation?.guestName ?? c.contactName ?? formatPhone(c.phone)}
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
                    {!c.reservation && (
                      <span className="text-[10px] bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 px-1.5 py-0.5 rounded">
                        sin reserva
                      </span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </aside>

        {/* Detalle de conversación */}
        <main className="flex-1 flex flex-col">
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
                    <div className="bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 px-6 py-3 flex items-center gap-3">
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
                      className="w-full flex items-center justify-between gap-3 px-6 py-2 border-b"
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
              <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-6 space-y-3">
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
                className="bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 p-4 flex gap-3 items-end relative"
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
                  onClick={() => setEmojiOpen((v) => !v)}
                  disabled={sending}
                  className="text-2xl text-muted dark:text-slate-400 hover:text-primary dark:text-slate-100 transition disabled:opacity-50 self-end pb-1"
                  aria-label="Abrir selector de emojis"
                >
                  😊
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
                  placeholder={mediaFile ? "Texto de pie de foto (opcional)…" : "Escribir mensaje... (Enter para nueva línea, Cmd+Enter para enviar)"}
                  rows={1}
                  className="flex-1 px-4 py-2.5 border border-gray-300 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent resize-none overflow-y-auto leading-relaxed"
                  style={{ maxHeight: "200px" }}
                  disabled={sending}
                />

                {/* Botón enviar */}
                <button
                  type="submit"
                  disabled={sending || (!composeText.trim() && !mediaFile)}
                  className="bg-primary text-white font-semibold px-6 py-2.5 rounded-lg hover:bg-primary/90 transition disabled:opacity-50 self-end"
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
