"use client";
//
// /inbox/reservas — Dashboard de Reservas activas.
//
// Da visibilidad de cada reserva confirmada/pendiente que aún no terminó:
// quién es, cuándo entra/sale, su WhatsApp, el estado del pago y —lo importante—
// qué mensajes ya salieron (instrucciones, huésped, limpieza, seguridad). Resuelve
// el dolor de "no sabemos a quién le toca seguimiento".
//
// Las reservas de Airbnb reciben los avisos del día-de en automático (cron
// whatsapp-operations, solo source='airbnb'). Las directas (WhatsApp/web) se
// disparan a mano desde acá con los botones, tras verificar el pago completo.
//
// Lee /api/inbox/reservations-confirmed cada 30s. Protegido con la cookie del inbox.
//

import { useEffect, useState, useCallback } from "react";
import { getProperty } from "@/data/properties";

interface Reservation {
  id: number;
  property_slug: string;
  check_in: string;
  check_out: string;
  guest_name: string | null;
  guest_phone: string | null;
  guest_count: number | null;
  amount_usd: number | null;
  source: string;
  status: string;
  created_at: string;
  notified_at: string | null;
  checkin_reminder_sent_at: string | null;
  whatsapp_sent_at: string | null;
  wa_arrival_guest_sent_at: string | null;
  wa_arrival_cleaning_sent_at: string | null;
  wa_arrival_security_sent_at: string | null;
  wa_departure_guest_sent_at: string | null;
  wa_departure_cleaning_sent_at: string | null;
  wa_phone_capture_sent_at: string | null;
  tr_amount: number | null;
  tr_expected_hnl: number | null;
  tr_currency: string | null;
  tr_decision: string | null;
}

type TemplateName =
  | "checkin_dia_huesped"
  | "checkin_dia_limpieza"
  | "checkin_dia_seguridad"
  | "checkout_dia_huesped"
  | "checkout_dia_limpieza";

interface ActionDef {
  template: TemplateName;
  label: string;
  sentKey: keyof Reservation;
}

const ARRIVAL_ACTIONS: ActionDef[] = [
  { template: "checkin_dia_huesped", label: "Huésped", sentKey: "wa_arrival_guest_sent_at" },
  { template: "checkin_dia_limpieza", label: "Limpieza", sentKey: "wa_arrival_cleaning_sent_at" },
  { template: "checkin_dia_seguridad", label: "Seguridad", sentKey: "wa_arrival_security_sent_at" },
];

const DEPARTURE_ACTIONS: ActionDef[] = [
  { template: "checkout_dia_huesped", label: "Huésped", sentKey: "wa_departure_guest_sent_at" },
  { template: "checkout_dia_limpieza", label: "Limpieza", sentKey: "wa_departure_cleaning_sent_at" },
];

const SOURCE_META: Record<string, { label: string; emoji: string; cls: string }> = {
  airbnb: { label: "Airbnb", emoji: "🅰️", cls: "text-rose-300 border-rose-500/40 bg-rose-500/10" },
  website: { label: "Web", emoji: "🌐", cls: "text-cyan-300 border-cyan-500/40 bg-cyan-500/10" },
  whatsapp_bot: { label: "WhatsApp", emoji: "💬", cls: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" },
  whatsapp_transfer: { label: "Transferencia", emoji: "🏦", cls: "text-amber-300 border-amber-500/40 bg-amber-500/10" },
};

function sourceMeta(source: string) {
  return SOURCE_META[source] ?? { label: source, emoji: "•", cls: "text-slate-300 border-white/15 bg-white/5" };
}

/** Destinatario real del template, para el diálogo de confirmación. */
function recipientOf(template: TemplateName, guestName: string): string {
  switch (template) {
    case "checkin_dia_limpieza":
    case "checkout_dia_limpieza":
      return "el personal de limpieza";
    case "checkin_dia_seguridad":
      return "seguridad";
    default:
      return guestName;
  }
}

const MONTHS_ES = [
  "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic",
];

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS_ES[m - 1]}`;
}

/** Días desde hoy hasta `iso` (0 = hoy, 1 = mañana, negativo = pasó). */
function daysUntil(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return 0;
  const target = Date.UTC(y, m - 1, d);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

function stayLabel(r: Reservation): { text: string; cls: string } {
  const inDays = daysUntil(r.check_in);
  const outDays = daysUntil(r.check_out);
  if (inDays <= 0 && outDays >= 0) {
    return { text: outDays === 0 ? "Sale hoy" : "Hospedado", cls: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" };
  }
  if (inDays === 0) return { text: "Llega HOY", cls: "text-amber-200 border-amber-400/50 bg-amber-400/15 font-bold" };
  if (inDays === 1) return { text: "Llega mañana", cls: "text-amber-200 border-amber-400/40 bg-amber-400/10" };
  if (inDays > 1) return { text: `Llega en ${inDays} días`, cls: "text-slate-300 border-white/15 bg-white/5" };
  return { text: "Finalizada", cls: "text-slate-500 border-white/10 bg-white/5" };
}

function paymentBadge(r: Reservation): { text: string; cls: string; sub?: string } {
  if (r.status === "confirmed") {
    return { text: "Pagado", cls: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" };
  }
  // pending
  if (r.tr_decision === "auto_confirmed") {
    const sub =
      r.tr_amount != null && r.tr_expected_hnl != null
        ? `L ${Math.round(r.tr_amount).toLocaleString("es-HN")} de L ${Math.round(r.tr_expected_hnl).toLocaleString("es-HN")}`
        : undefined;
    return { text: "Depósito 50%", cls: "text-amber-300 border-amber-500/40 bg-amber-500/10", sub };
  }
  return { text: "Por verificar", cls: "text-rose-300 border-rose-500/40 bg-rose-500/10" };
}

export default function ReservasPage() {
  const [authed, setAuthed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [propFilter, setPropFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [soonOnly, setSoonOnly] = useState(false);
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [actionMsg, setActionMsg] = useState<Record<string, string>>({});

  const fetchReservations = useCallback(async (): Promise<void> => {
    try {
      const resp = await fetch("/api/inbox/reservations-confirmed", { credentials: "include" });
      if (resp.status === 401) {
        setAuthed(false);
        return;
      }
      const data = (await resp.json()) as { ok: boolean; reservations?: Reservation[] };
      if (data.ok) {
        setReservations(data.reservations ?? []);
        setAuthed(true);
      }
    } catch (err) {
      console.error("fetchReservations error", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReservations();
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetchReservations();
    };
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [fetchReservations]);

  const sendMessage = useCallback(
    async (id: number, template: TemplateName, alreadySent: boolean, to: string): Promise<void> => {
      const key = `${id}:${template}`;
      if (sending[key]) return;
      const confirmMsg = alreadySent
        ? `Este mensaje ya se envió. ¿Reenviar a ${to}?`
        : `¿Enviar este WhatsApp ahora a ${to}?`;
      if (!window.confirm(confirmMsg)) return;
      setSending((s) => ({ ...s, [key]: true }));
      setActionMsg((m) => ({ ...m, [key]: "" }));
      try {
        const resp = await fetch("/api/inbox/reservation-send-message", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reservationId: id, template, force: alreadySent }),
        });
        if (resp.status === 401) {
          setAuthed(false);
          return;
        }
        const data = (await resp.json().catch(() => ({}))) as {
          ok?: boolean;
          skipped?: boolean;
          error?: string;
          results?: { ok: boolean; error?: string }[];
        };
        if (data.ok && !data.skipped) {
          setActionMsg((m) => ({ ...m, [key]: "✓ enviado" }));
          fetchReservations();
        } else if (data.skipped) {
          setActionMsg((m) => ({ ...m, [key]: "ya enviado" }));
        } else {
          const err = data.results?.find((x) => !x.ok)?.error || data.error || "falló";
          setActionMsg((m) => ({ ...m, [key]: err.slice(0, 120) }));
        }
      } catch {
        setActionMsg((m) => ({ ...m, [key]: "error de red" }));
      } finally {
        setSending((s) => ({ ...s, [key]: false }));
      }
    },
    [sending, fetchReservations],
  );

  // ── Filtros ──────────────────────────────────────────────────────────────
  const slugsPresent = Array.from(new Set(reservations.map((r) => r.property_slug)));
  const filtered = reservations.filter((r) => {
    if (propFilter && r.property_slug !== propFilter) return false;
    if (soonOnly && daysUntil(r.check_in) > 7) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const hay = `${r.guest_name ?? ""} ${r.guest_phone ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // ── Resumen ──────────────────────────────────────────────────────────────
  const arrivingToday = reservations.filter((r) => daysUntil(r.check_in) === 0).length;
  const noPhone = reservations.filter((r) => !r.guest_phone).length;
  const toVerify = reservations.filter((r) => r.status === "pending" && r.tr_decision !== "auto_confirmed").length;

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#070b16] text-slate-200 flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-lg mb-3">Sesión expirada</p>
          <a href="/inbox" className="inline-flex px-4 py-2 border border-cyan-500/40 rounded-lg text-cyan-300 hover:bg-cyan-500/10">
            Iniciar sesión en el inbox
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#070b16] text-slate-200" style={{ backgroundImage: "radial-gradient(circle at 20% 0%, rgba(34,211,238,0.06), transparent 40%), radial-gradient(circle at 90% 10%, rgba(45,212,191,0.05), transparent 35%)" }}>
      {/* Header */}
      <header className="border-b border-white/10 px-5 py-3 flex items-center justify-between sticky top-0 z-10 bg-[#070b16]/80 backdrop-blur">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">📅 Reservas</h1>
          <p className="text-[12px] text-slate-400">
            {reservations.length} activas · {arrivingToday} llegan hoy
            {noPhone > 0 ? ` · ${noPhone} sin número` : ""}
            {toVerify > 0 ? ` · ${toVerify} por verificar` : ""}
          </p>
        </div>
        <a href="/inbox" className="px-3 py-1.5 border border-white/15 rounded-lg hover:bg-white/5 text-slate-300 text-sm">← Inbox</a>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-5">
        {/* Filtros */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar nombre o teléfono…"
            className="flex-1 min-w-[180px] px-3 py-2 bg-white/[0.04] border border-white/10 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
          />
          <select
            value={propFilter}
            onChange={(e) => setPropFilter(e.target.value)}
            className="px-3 py-2 bg-white/[0.04] border border-white/10 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50"
          >
            <option value="">Todas las propiedades</option>
            {slugsPresent.map((slug) => (
              <option key={slug} value={slug}>
                {getProperty(slug)?.name ?? slug}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setSoonOnly((v) => !v)}
            className={`px-3 py-2 rounded-lg text-sm border ${soonOnly ? "border-amber-400/50 bg-amber-400/15 text-amber-200" : "border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.07]"}`}
          >
            Próximas 7 días
          </button>
        </div>

        {loading && reservations.length === 0 ? (
          <p className="text-center text-slate-500 py-16">Cargando reservas…</p>
        ) : filtered.length === 0 ? (
          <p className="text-center text-slate-500 py-16">
            {reservations.length === 0 ? "No hay reservas activas. 🌴" : "Ninguna reserva coincide con el filtro."}
          </p>
        ) : (
          <div className="space-y-3">
            {filtered.map((r) => (
              <ReservationCard
                key={r.id}
                r={r}
                sending={sending}
                actionMsg={actionMsg}
                onSend={sendMessage}
              />
            ))}
          </div>
        )}

        <p className="text-[11px] text-slate-600 text-center mt-6 leading-relaxed">
          Airbnb recibe los avisos del día-de en automático. Las reservas directas (Web / WhatsApp)
          las disparás vos con los botones, tras verificar el pago completo.
        </p>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tarjeta de una reserva
// ─────────────────────────────────────────────────────────────────────────────

function ReservationCard({
  r,
  sending,
  actionMsg,
  onSend,
}: {
  r: Reservation;
  sending: Record<string, boolean>;
  actionMsg: Record<string, string>;
  onSend: (id: number, template: TemplateName, alreadySent: boolean, to: string) => void;
}) {
  const prop = getProperty(r.property_slug);
  const sm = sourceMeta(r.source);
  const stay = stayLabel(r);
  const pay = paymentBadge(r);
  const phoneDigits = r.guest_phone ? r.guest_phone.replace(/\D/g, "") : "";
  const instructionsSent = Boolean(r.checkin_reminder_sent_at || r.whatsapp_sent_at);

  const renderActions = (defs: ActionDef[]) =>
    defs.map((a) => {
      const key = `${r.id}:${a.template}`;
      const sent = Boolean(r[a.sentKey]);
      const busy = Boolean(sending[key]);
      const msg = actionMsg[key];
      const to = recipientOf(a.template, r.guest_name || "el huésped");
      return (
        <div key={a.template} className="flex flex-col">
          <button
            type="button"
            disabled={busy}
            onClick={() => onSend(r.id, a.template, sent, to)}
            title={sent ? "Ya enviado — clic para reenviar" : "Enviar ahora"}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition disabled:opacity-50 ${
              sent
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                : "border-white/15 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]"
            }`}
          >
            {busy ? "…" : sent ? `✓ ${a.label}` : a.label}
          </button>
          {msg && <span className="text-[9px] text-slate-400 mt-0.5 max-w-[120px] truncate" title={msg}>{msg}</span>}
        </div>
      );
    });

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      {/* Fila 1: nombre + propiedad + badges */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-white truncate">{r.guest_name || "Huésped sin nombre"}</h3>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${sm.cls}`}>{sm.emoji} {sm.label}</span>
          </div>
          <p className="text-[12px] text-slate-400 mt-0.5">
            {prop?.name ?? r.property_slug}
            {prop?.city ? ` · ${prop.city}` : ""}
            {r.guest_count ? ` · ${r.guest_count} huésp.` : ""}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-[10px] px-2 py-0.5 rounded-full border ${stay.cls}`}>{stay.text}</span>
          <span className={`text-[10px] px-2 py-0.5 rounded-full border ${pay.cls}`}>{pay.text}</span>
          {pay.sub && <span className="text-[9px] text-slate-500">{pay.sub}</span>}
        </div>
      </div>

      {/* Fila 2: fechas + teléfono */}
      <div className="flex items-center gap-4 mt-3 text-[12px] flex-wrap">
        <span className="text-slate-300">
          <span className="text-slate-500">Entra</span> {fmtDate(r.check_in)} <span className="text-slate-600">→</span>{" "}
          <span className="text-slate-500">sale</span> {fmtDate(r.check_out)}
        </span>
        {r.guest_phone ? (
          <span className="flex items-center gap-2">
            <span className="font-mono text-slate-300">{r.guest_phone}</span>
            <a
              href={`/inbox?c=${phoneDigits}`}
              className="text-[11px] text-cyan-300 border border-cyan-500/30 rounded px-1.5 py-0.5 hover:bg-cyan-500/10"
            >
              Abrir chat
            </a>
          </span>
        ) : (
          <span className="text-[11px] text-rose-300 border border-rose-500/40 bg-rose-500/10 rounded px-1.5 py-0.5">
            ⚠ Sin número{r.source === "airbnb" ? " (esperando respuesta del huésped)" : ""}
          </span>
        )}
      </div>

      {/* Fila 3: estado de mensajes + acciones */}
      <div className="mt-3 pt-3 border-t border-white/5 space-y-2">
        {/* Instrucciones T-1 (automático, solo lectura) */}
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-slate-500 w-16 shrink-0">Llegada</span>
          <span
            className={`px-2 py-0.5 rounded border ${
              instructionsSent
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-white/10 bg-white/[0.03] text-slate-500"
            }`}
            title="Instrucciones T-1 día (correo + WhatsApp con PDF) — automático"
          >
            {instructionsSent ? "✓ Instrucciones" : "Instrucciones"}
          </span>
          <div className="flex gap-1.5 flex-wrap">{renderActions(ARRIVAL_ACTIONS)}</div>
        </div>
        {/* Salida */}
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-slate-500 w-16 shrink-0">Salida</span>
          <div className="flex gap-1.5 flex-wrap">{renderActions(DEPARTURE_ACTIONS)}</div>
        </div>
      </div>
    </div>
  );
}
