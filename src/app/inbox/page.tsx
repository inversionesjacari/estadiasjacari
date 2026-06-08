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

export default function InboxPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [composeText, setComposeText] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingConv, setLoadingConv] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
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

  // ── Render ───────────────────────────────────────────────────────────────

  if (authenticated === null) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <p className="text-muted">Cargando...</p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg p-8">
          <h1 className="font-display text-3xl text-primary mb-2">Inbox</h1>
          <p className="text-muted text-sm mb-6">Acceso privado — Estadías Jacarí</p>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-primary mb-1.5">
                Contraseña
              </label>
              <input
                type="password"
                name="password"
                autoFocus
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                required
              />
            </div>
            {loginError && (
              <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
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
    <div className="h-screen bg-bg flex flex-col overflow-hidden">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="font-display text-xl text-primary">Inbox</h1>
          <p className="text-xs text-muted">Estadías Jacarí · WhatsApp manual</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <a
            href="/inbox/operacion"
            className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 text-muted"
          >
            🛰️ Centro de control
          </a>
          <a
            href="/inbox/conocimiento"
            className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 text-muted"
          >
            🤖 Conocimiento del bot
          </a>
          <button
            onClick={fetchConversations}
            disabled={loadingConv}
            className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 text-muted disabled:opacity-50"
          >
            {loadingConv ? "..." : "Refrescar"}
          </button>
          <button
            onClick={handleLogout}
            className="px-3 py-1.5 text-muted hover:text-primary"
          >
            Salir
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Lista de conversaciones */}
        <aside className="w-80 border-r border-gray-200 bg-white overflow-y-auto">
          {conversations.length === 0 && !loadingConv && (
            <div className="p-6 text-center text-muted text-sm">
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
                className={`px-4 py-3 border-b border-gray-100 cursor-pointer transition flex gap-3 ${
                  selectedPhone === c.phone
                    ? "bg-secondary/10"
                    : "hover:bg-gray-50"
                }`}
              >
                <Avatar
                  name={c.reservation?.guestName ?? c.contactName ?? null}
                  phone={c.phone}
                  size="md"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between mb-0.5 gap-2">
                    <span className="font-semibold text-primary text-sm truncate">
                      {c.reservation?.guestName ?? c.contactName ?? formatPhone(c.phone)}
                    </span>
                    <span className="text-[10px] text-muted whitespace-nowrap">
                      {formatTimeAgo(c.lastAt)}
                    </span>
                  </div>
                  {c.reservation && (
                    <p className="text-[11px] text-secondary mb-0.5">
                      {PROPERTY_NAMES[c.reservation.propertySlug ?? ""] ?? c.reservation.propertySlug}
                      {c.reservation.checkIn && ` · ${c.reservation.checkIn}`}
                    </p>
                  )}
                  <p className="text-xs text-muted truncate">
                    {c.lastDirection === "out" && <span className="text-secondary">Tú: </span>}
                    {c.lastMessage}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {c.escalated && (
                      <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                        ⚠ escalado
                      </span>
                    )}
                    {c.lastMatchedRule && c.lastMatchedRule !== "manual_inbox" && (
                      <span className="text-[10px] bg-secondary/15 text-secondary px-1.5 py-0.5 rounded">
                        🤖 {c.lastMatchedRule}
                      </span>
                    )}
                    {!c.reservation && (
                      <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
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
            <div className="flex-1 flex items-center justify-center text-muted">
              Selecciona una conversación
            </div>
          ) : (
            <>
              {/* Header conversación */}
              {(() => {
                const conv = conversations.find((c) => c.phone === selectedPhone);
                const guestName = conv?.reservation?.guestName ?? conv?.contactName ?? null;
                return (
                  <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-3">
                    <Avatar name={guestName} phone={selectedPhone} size="lg" />
                    <div className="min-w-0">
                      <h2 className="font-semibold text-primary leading-tight">
                        {guestName ?? formatPhone(selectedPhone)}
                      </h2>
                      {/* Solo mostrar el teléfono debajo si arriba estamos
                          mostrando un nombre — sino sería un duplicado. */}
                      {guestName && (
                        <p className="text-xs text-muted">{formatPhone(selectedPhone)}</p>
                      )}
                      {conv?.reservation && (
                        <p className="text-[11px] text-secondary mt-0.5">
                          {PROPERTY_NAMES[conv.reservation.propertySlug ?? ""] ?? conv.reservation.propertySlug}
                          {conv.reservation.checkIn && ` · ${conv.reservation.checkIn}`}
                        </p>
                      )}
                    </div>
                    {conv?.botPaused && (
                      <div className="ml-auto flex items-center gap-2 shrink-0">
                        <span
                          style={{ background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}
                          className="text-[11px] font-medium rounded-full px-2.5 py-1 whitespace-nowrap"
                        >
                          🤖 Bot en pausa
                        </span>
                        <button
                          type="button"
                          onClick={() => { if (selectedPhone) handleResumeBot(selectedPhone); }}
                          className="text-[12px] font-semibold text-white bg-secondary hover:opacity-90 rounded-lg px-3 py-1.5 whitespace-nowrap transition"
                        >
                          Reactivar bot
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Mensajes */}
              <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-6 space-y-3">
                {loadingMsgs && messages.length === 0 && (
                  <p className="text-center text-muted text-sm">Cargando...</p>
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
                          : "bg-white border border-gray-200 text-primary"
                      }`}
                    >
                      <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
                      <p className={`text-[10px] mt-1 flex items-center gap-1 ${m.direction === "out" ? "text-white/70 justify-end" : "text-muted"}`}>
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
                className="bg-white border-t border-gray-200 p-4 flex gap-3 items-end relative"
              >
                {/* Emoji picker — popover por categorías, scrolleable */}
                {emojiOpen && (
                  <div
                    className="absolute bottom-full left-4 mb-2 bg-white border border-gray-200 rounded-xl shadow-lg z-10 overflow-y-auto"
                    style={{ width: "20rem", maxHeight: "18rem" }}
                  >
                    {EMOJI_CATEGORIES.map((cat) => (
                      <div key={cat.label} className="p-2">
                        <p className="text-[10px] uppercase tracking-wide text-muted px-1 mb-1 sticky top-0 bg-white">
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
                              className="text-xl hover:bg-gray-100 rounded p-1 transition"
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

                {/* Botón emoji */}
                <button
                  type="button"
                  onClick={() => setEmojiOpen((v) => !v)}
                  disabled={sending}
                  className="text-2xl text-muted hover:text-primary transition disabled:opacity-50 self-end pb-1"
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
                      if (composeText.trim() && !sending) {
                        handleSend(e as unknown as React.FormEvent<HTMLFormElement>);
                      }
                    }
                  }}
                  placeholder="Escribir mensaje... (Enter para nueva línea, Cmd+Enter para enviar)"
                  rows={1}
                  className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent resize-none overflow-y-auto leading-relaxed"
                  style={{ maxHeight: "200px" }}
                  disabled={sending}
                />

                {/* Botón enviar */}
                <button
                  type="submit"
                  disabled={sending || !composeText.trim()}
                  className="bg-primary text-white font-semibold px-6 py-2.5 rounded-lg hover:bg-primary/90 transition disabled:opacity-50 self-end"
                >
                  {sending ? "..." : "Enviar"}
                </button>
              </form>
            </>
          )}
        </main>
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
