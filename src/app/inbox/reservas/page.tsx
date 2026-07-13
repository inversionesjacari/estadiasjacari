"use client";
//
// /inbox/reservas — Dashboard de Reservas activas.
//
// Da visibilidad de cada reserva confirmada/pendiente que aún no terminó:
// quién es, cuándo entra/sale, su WhatsApp, el estado del pago y —lo importante—
// el checklist puntual de mensajes: QUÉ salió, a QUÉ hora exacta y qué FALLÓ
// (con el motivo). Resuelve el dolor de "no sé si al huésped le llegó su aviso".
//
// TODA reserva confirmada recibe los avisos en automático (cron
// whatsapp-operations, sin filtro de source desde RECORDATORIOS-0712):
// limpieza 6 PM víspera, seguridad 7 AM, huésped 10 AM, limpieza salida 11:30 AM,
// más las instrucciones T-1 (checkin-reminders, 6 PM). Los botones de acá son
// para adelantar o reenviar a mano (y para las 'pending' que el cron no toca).
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
  checkin_reminder_error?: string | null;
  whatsapp_sent_at: string | null;
  whatsapp_error?: string | null;
  wa_arrival_guest_sent_at: string | null;
  wa_arrival_guest_error?: string | null;
  wa_arrival_cleaning_sent_at: string | null;
  wa_arrival_cleaning_error?: string | null;
  wa_arrival_security_sent_at: string | null;
  wa_arrival_security_error?: string | null;
  wa_departure_guest_sent_at: string | null;
  wa_departure_guest_error?: string | null;
  wa_departure_cleaning_sent_at: string | null;
  wa_departure_cleaning_error?: string | null;
  wa_phone_capture_sent_at: string | null;
  // De schema/0041 — pueden faltar si la migración aún no corrió (fallback API).
  wa_eve_cleaning_sent_at?: string | null;
  wa_eve_cleaning_error?: string | null;
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
  | "checkout_dia_limpieza"
  | "limpieza_aviso_entrada";

interface ActionDef {
  template: TemplateName;
  label: string;
  sentKey: keyof Reservation;
  errorKey: keyof Reservation;
  title?: string;
}

const ARRIVAL_ACTIONS: ActionDef[] = [
  {
    template: "limpieza_aviso_entrada",
    label: "Limp. víspera",
    sentKey: "wa_eve_cleaning_sent_at",
    errorKey: "wa_eve_cleaning_error",
    title: "Aviso a limpieza la víspera 6 PM (automático)",
  },
  {
    template: "checkin_dia_seguridad",
    label: "Seguridad",
    sentKey: "wa_arrival_security_sent_at",
    errorKey: "wa_arrival_security_error",
    title: "Aviso a seguridad 7 AM del día de entrada (automático)",
  },
  {
    template: "checkin_dia_huesped",
    label: "Huésped",
    sentKey: "wa_arrival_guest_sent_at",
    errorKey: "wa_arrival_guest_error",
    title: "Bienvenida al huésped 10 AM del día de entrada (automático)",
  },
  {
    template: "checkin_dia_limpieza",
    label: "Limp. día",
    sentKey: "wa_arrival_cleaning_sent_at",
    errorKey: "wa_arrival_cleaning_error",
    title: "Aviso a limpieza el MISMO día — solo manual (respaldo si la víspera falló)",
  },
];

const DEPARTURE_ACTIONS: ActionDef[] = [
  {
    template: "checkout_dia_huesped",
    label: "Huésped",
    sentKey: "wa_departure_guest_sent_at",
    errorKey: "wa_departure_guest_error",
    title: "Despedida al huésped 10 AM del día de salida (automático)",
  },
  {
    template: "checkout_dia_limpieza",
    label: "Limpieza",
    sentKey: "wa_departure_cleaning_sent_at",
    errorKey: "wa_departure_cleaning_error",
    title: "Aviso a limpieza 11:30 AM del día de salida (automático)",
  },
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
    case "limpieza_aviso_entrada":
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

/**
 * Timestamp de envío → hora HONDURAS legible ("12 jul, 6:02 p. m.").
 * D1 guarda datetime('now') = UTC "YYYY-MM-DD HH:MM:SS" (sin zona); también
 * entra un ISO con T/Z (los crons que escriben toISOString).
 */
function fmtSentAtHn(ts: string): string {
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  const d = new Date(/[Z+]/.test(iso.slice(10)) ? iso : `${iso}Z`);
  if (isNaN(d.getTime())) return ts;
  return new Intl.DateTimeFormat("es-HN", {
    timeZone: "America/Tegucigalpa",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
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
          TODA reserva confirmada recibe los avisos en automático: instrucciones + limpieza a las
          6 pm de la víspera, seguridad 7 am, huésped 10 am, y limpieza de salida 11:30 am.
          Los botones son para adelantar o reenviar a mano (las pendientes de pago no se automatizan).
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

  const renderActions = (defs: ActionDef[]) =>
    defs.map((a) => {
      const key = `${r.id}:${a.template}`;
      const sentAt = (r[a.sentKey] as string | null | undefined) ?? null;
      const sent = Boolean(sentAt);
      const sendError = !sent ? ((r[a.errorKey] as string | null | undefined) ?? null) : null;
      const busy = Boolean(sending[key]);
      const msg = actionMsg[key];
      const to = recipientOf(a.template, r.guest_name || "el huésped");
      return (
        <div key={a.template} className="flex flex-col">
          <button
            type="button"
            disabled={busy}
            onClick={() => onSend(r.id, a.template, sent, to)}
            title={
              sent
                ? `Enviado ${fmtSentAtHn(sentAt!)} — clic para reenviar${a.title ? ` · ${a.title}` : ""}`
                : sendError
                  ? `⚠ Último intento FALLÓ: ${sendError} — clic para reintentar`
                  : `Enviar ahora${a.title ? ` · ${a.title}` : ""}`
            }
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition disabled:opacity-50 ${
              sent
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                : sendError
                  ? "border-rose-500/50 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                  : "border-white/15 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]"
            }`}
          >
            {busy ? "…" : sent ? `✓ ${a.label}` : sendError ? `⚠ ${a.label}` : a.label}
          </button>
          {msg ? (
            <span className="text-[9px] text-slate-400 mt-0.5 max-w-[120px] truncate" title={msg}>{msg}</span>
          ) : sent ? (
            <span className="text-[9px] text-slate-500 mt-0.5">{fmtSentAtHn(sentAt!)}</span>
          ) : sendError ? (
            <span className="text-[9px] text-rose-400/80 mt-0.5 max-w-[120px] truncate" title={sendError}>falló — ver detalle</span>
          ) : null}
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

      {/* Fila 3: checklist puntual de mensajes + acciones */}
      <div className="mt-3 pt-3 border-t border-white/5 space-y-2">
        {/* Instrucciones T-1 (automático, solo lectura) — correo y WhatsApp por separado */}
        <div className="flex items-start gap-2 text-[11px]">
          <span className="text-slate-500 w-16 shrink-0 pt-1">Llegada</span>
          <div className="flex gap-1.5 flex-wrap items-start">
            <StatusChip
              label="📧 Instr."
              sentAt={r.checkin_reminder_sent_at}
              error={r.checkin_reminder_error ?? null}
              what="Correo #2 con instrucciones de check-in (automático, 6 PM de la víspera)"
            />
            <StatusChip
              label="📱 PDF"
              sentAt={r.whatsapp_sent_at}
              error={r.whatsapp_error ?? null}
              what="WhatsApp con PDF de instrucciones (automático, 6 PM de la víspera)"
            />
            {renderActions(ARRIVAL_ACTIONS)}
          </div>
        </div>
        {/* Salida */}
        <div className="flex items-start gap-2 text-[11px]">
          <span className="text-slate-500 w-16 shrink-0 pt-1">Salida</span>
          <div className="flex gap-1.5 flex-wrap items-start">{renderActions(DEPARTURE_ACTIONS)}</div>
        </div>
      </div>
    </div>
  );
}

/** Chip de solo-lectura con hora exacta de envío o el error del último intento. */
function StatusChip({
  label,
  sentAt,
  error,
  what,
}: {
  label: string;
  sentAt: string | null | undefined;
  error: string | null;
  what: string;
}) {
  const sent = Boolean(sentAt);
  const failed = !sent && Boolean(error);
  return (
    <div className="flex flex-col">
      <span
        className={`px-2 py-0.5 rounded border ${
          sent
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            : failed
              ? "border-rose-500/50 bg-rose-500/10 text-rose-300"
              : "border-white/10 bg-white/[0.03] text-slate-500"
        }`}
        title={sent ? `${what} — enviado ${fmtSentAtHn(sentAt!)}` : failed ? `${what} — ⚠ FALLÓ: ${error}` : `${what} — aún no enviado`}
      >
        {sent ? `✓ ${label}` : failed ? `⚠ ${label}` : label}
      </span>
      {sent ? (
        <span className="text-[9px] text-slate-500 mt-0.5">{fmtSentAtHn(sentAt!)}</span>
      ) : failed ? (
        <span className="text-[9px] text-rose-400/80 mt-0.5 max-w-[120px] truncate" title={error ?? undefined}>falló — ver detalle</span>
      ) : null}
    </div>
  );
}
