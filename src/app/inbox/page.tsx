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
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
        setMessages(data.messages);
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }, 100);
      }
    } catch (err) {
      console.error("loadMessages error", err);
    } finally {
      setLoadingMsgs(false);
    }
  }

  function selectConversation(phone: string): void {
    setSelectedPhone(phone);
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
    <div className="min-h-screen bg-bg flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="font-display text-xl text-primary">Inbox</h1>
          <p className="text-xs text-muted">Estadías Jacarí · WhatsApp manual</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
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
                className={`px-4 py-3 border-b border-gray-100 cursor-pointer transition ${
                  selectedPhone === c.phone
                    ? "bg-secondary/10"
                    : "hover:bg-gray-50"
                }`}
              >
                <div className="flex items-baseline justify-between mb-1">
                  <span className="font-semibold text-primary text-sm">
                    {c.reservation?.guestName ?? `+${c.phone}`}
                  </span>
                  <span className="text-[10px] text-muted">{formatTimeAgo(c.lastAt)}</span>
                </div>
                {c.reservation && (
                  <p className="text-[11px] text-secondary mb-1">
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
              <div className="bg-white border-b border-gray-200 px-6 py-3">
                <h2 className="font-semibold text-primary">
                  {conversations.find((c) => c.phone === selectedPhone)?.reservation?.guestName ?? `+${selectedPhone}`}
                </h2>
                <p className="text-xs text-muted">+{selectedPhone}</p>
              </div>

              {/* Mensajes */}
              <div className="flex-1 overflow-y-auto p-6 space-y-3">
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
                      <p className={`text-[10px] mt-1 ${m.direction === "out" ? "text-white/70" : "text-muted"}`}>
                        {formatDate(m.createdAt)}
                        {m.matchedRule && m.matchedRule !== "manual_inbox" && ` · 🤖 ${m.matchedRule}`}
                        {m.escalated && " · ⚠"}
                      </p>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Composer */}
              <form
                onSubmit={handleSend}
                className="bg-white border-t border-gray-200 p-4 flex gap-3"
              >
                <input
                  type="text"
                  value={composeText}
                  onChange={(e) => setComposeText(e.target.value)}
                  placeholder="Escribir mensaje..."
                  className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                  disabled={sending}
                />
                <button
                  type="submit"
                  disabled={sending || !composeText.trim()}
                  className="bg-primary text-white font-semibold px-6 py-2.5 rounded-lg hover:bg-primary/90 transition disabled:opacity-50"
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
