"use client";
//
// /inbox/reservas — Dashboard de Reservas activas.
//
// Objetivo (César, 2026-07-13): que de un vistazo se vea QUÉ necesita acción
// HOY o MAÑANA, con el resto visible pero atenuado. Cada aviso comunica su
// ESTADO (enviado + hora / falló / programado / retenido por pago), no solo un
// label, y cada reserva muestra cuánto se pagó y cuánto falta.
//
// Estructura: 3 secciones por urgencia —
//   ⚠ Necesitan tu atención  (algo falló, o llega pronto sin pago/sin número)
//   Hoy y mañana             (cards completas)
//   Próximas                 (condensadas, expandibles)
//
// TODA reserva confirmada recibe los avisos en automático (cron
// whatsapp-operations, sin filtro de source): limpieza 6 pm víspera, seguridad
// 7 am, huésped 10 am, limpieza salida 11:30 am, instrucciones T-1 6 pm. Los
// botones son para adelantar/reenviar a mano y para las 'pending' que el cron
// no toca. Lee /api/inbox/reservations-confirmed cada 30s. Cookie del inbox.
//
// CHATVIVO (César, 2026-07-16): "enviado" dejó de significar "Meta lo aceptó".
// Cada chip refleja la ENTREGA real (✓ aceptado / ✓✓ entregado / ✓✓ leído / ⚠
// falló — incluso el fallo ASÍNCRONO que antes quedaba verde), el motivo exacto
// del fallo sale en hover (title) y con un TAP (la PWA no tiene hover), y cada
// envío registrado linkea 💬 al hilo en vivo del inbox con su destinatario REAL
// (huésped o STAFF — el deep-link /inbox?c= abre números que nunca escribieron
// y el chat se refresca solo cada 10 s). ⏰ "no salió a su hora" ya no se
// disfraza de "pendiente".
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
  total_hnl?: number | null;
  paid_hnl?: number | null;
  /** Solo con rol staff: estado del pago SIN montos (lo calcula el servidor en
   *  _lib/inbox-roles.ts, que ya borró total/pagado antes de mandar la fila). */
  pay_state?: "paid" | "deposit" | "unpaid" | "verify" | "cancelled" | "refunded";
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
  // De schema/0043 — foto de identidad del huésped (garita Villa B11).
  security_id_key?: string | null;
  security_id_captured_at?: string | null;
  tr_amount: number | null;
  tr_expected_hnl: number | null;
  tr_currency: string | null;
  tr_decision: string | null;
  // CHATVIVO: entrega real por envío (whatsapp_messages vía wa-log). Puede faltar
  // (API vieja / query falló) → el dashboard cae a las columnas wa_* de siempre.
  wa?: WaEntry[];
}

// Un envío real registrado: destinatario (huésped o STAFF), entrega que reporta
// Meta (sent→delivered→read→failed) y, si falló, el motivo YA legible + el crudo.
interface WaEntry {
  rule: string;
  to: string; // E.164 sin '+' → link directo /inbox?c=<to> al hilo en vivo
  status: string | null;
  at: string;
  reason: string | null;
  detail: string | null;
}

type TemplateName =
  | "checkin_dia_huesped"
  | "checkin_dia_limpieza"
  | "checkin_dia_seguridad"
  | "checkout_dia_huesped"
  | "checkout_dia_limpieza"
  | "limpieza_aviso_entrada";

// Un "touchpoint" = un mensaje del ciclo de vida de la reserva, con cuándo se
// dispara y con qué columna de idempotencia se marca. `template` null = solo
// lectura (las instrucciones T-1 las manda checkin-reminders, no hay reenvío
// manual acá). `auto` false = el cron NO lo manda (respaldo manual).
interface Touchpoint {
  key: string;
  icon: string;
  label: string;
  sentKey: keyof Reservation;
  errorKey: keyof Reservation;
  template: TemplateName | null;
  /** matched_rule con el que wa-log registró este envío (null = email, sin hilo WA). */
  waRule: string | null;
  side: "arrival" | "departure";
  offsetDays: number; // relativo a check_in (arrival) o check_out (departure)
  time: string; // etiqueta de hora HN
  /** Hora HN (decimal) a la que el cron dispara — para detectar "no salió" el MISMO día. */
  fireHour?: number;
  when: string; // "víspera" | "día" | "salida" | "respaldo"
  auto: boolean;
  needsPhone?: boolean; // va al huésped → sin # no se puede
  heldByPayment?: boolean; // solo sale con pago TOTAL (instrucciones)
  toGuest?: boolean; // destinatario = huésped → link al chat aun sin envío registrado
}

const ARRIVAL_TOUCHPOINTS: Touchpoint[] = [
  { key: "instr_email", icon: "📧", label: "Instrucciones", sentKey: "checkin_reminder_sent_at", errorKey: "checkin_reminder_error", template: null, waRule: null, side: "arrival", offsetDays: -1, time: "6:00 pm", fireHour: 18, when: "víspera", auto: true, heldByPayment: true },
  { key: "instr_pdf", icon: "📱", label: "PDF instrucciones", sentKey: "whatsapp_sent_at", errorKey: "whatsapp_error", template: null, waRule: "checkin_reminder", side: "arrival", offsetDays: -1, time: "6:00 pm", fireHour: 18, when: "víspera", auto: true, needsPhone: true, heldByPayment: true, toGuest: true },
  { key: "eve_clean", icon: "🧹", label: "Limpieza · víspera", sentKey: "wa_eve_cleaning_sent_at", errorKey: "wa_eve_cleaning_error", template: "limpieza_aviso_entrada", waRule: "tpl_limpieza_aviso_entrada", side: "arrival", offsetDays: -1, time: "6:05 pm", fireHour: 18.1, when: "víspera", auto: true },
  { key: "security", icon: "🛡️", label: "Seguridad", sentKey: "wa_arrival_security_sent_at", errorKey: "wa_arrival_security_error", template: "checkin_dia_seguridad", waRule: "tpl_checkin_dia_seguridad", side: "arrival", offsetDays: 0, time: "7:00 am", fireHour: 7, when: "día", auto: true },
  { key: "guest_arr", icon: "👋", label: "Bienvenida huésped", sentKey: "wa_arrival_guest_sent_at", errorKey: "wa_arrival_guest_error", template: "checkin_dia_huesped", waRule: "tpl_checkin_dia_huesped", side: "arrival", offsetDays: 0, time: "10:00 am", fireHour: 10, when: "día", auto: true, needsPhone: true, toGuest: true },
  { key: "day_clean", icon: "🧹", label: "Limpieza · día", sentKey: "wa_arrival_cleaning_sent_at", errorKey: "wa_arrival_cleaning_error", template: "checkin_dia_limpieza", waRule: "tpl_checkin_dia_limpieza", side: "arrival", offsetDays: 0, time: "", when: "respaldo", auto: false },
];

const DEPARTURE_TOUCHPOINTS: Touchpoint[] = [
  { key: "guest_dep", icon: "👋", label: "Despedida huésped", sentKey: "wa_departure_guest_sent_at", errorKey: "wa_departure_guest_error", template: "checkout_dia_huesped", waRule: "tpl_checkout_dia_huesped", side: "departure", offsetDays: 0, time: "10:00 am", fireHour: 10, when: "salida", auto: true, needsPhone: true, toGuest: true },
  { key: "dep_clean", icon: "🧹", label: "Limpieza · salida", sentKey: "wa_departure_cleaning_sent_at", errorKey: "wa_departure_cleaning_error", template: "checkout_dia_limpieza", waRule: "tpl_checkout_dia_limpieza", side: "departure", offsetDays: 0, time: "11:30 am", fireHour: 11.5, when: "salida", auto: true },
];

const ALL_TOUCHPOINTS = [...ARRIVAL_TOUCHPOINTS, ...DEPARTURE_TOUCHPOINTS];

const SOURCE_META: Record<string, { label: string; emoji: string; cls: string }> = {
  airbnb: { label: "Airbnb", emoji: "🅰️", cls: "text-rose-300 border-rose-500/40 bg-rose-500/10" },
  website: { label: "Web", emoji: "🌐", cls: "text-cyan-300 border-cyan-500/40 bg-cyan-500/10" },
  whatsapp_bot: { label: "WhatsApp", emoji: "💬", cls: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" },
  whatsapp_transfer: { label: "Transferencia", emoji: "🏦", cls: "text-amber-300 border-amber-500/40 bg-amber-500/10" },
};

function sourceMeta(source: string) {
  return SOURCE_META[source] ?? { label: source, emoji: "•", cls: "text-slate-300 border-white/15 bg-white/5" };
}

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

const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS_ES[m - 1]}`;
}

/** Lempiras sin decimales: 2500 → "L 2,500". */
function fmtL(n: number): string {
  return `L ${Math.round(n).toLocaleString("es-HN")}`;
}

/** Suma n días a una fecha YYYY-MM-DD (calendario puro, sin zona). */
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
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

/** Hora decimal ACTUAL en Honduras (UTC-6 fijo, sin DST). Ej.: 14.5 = 2:30 pm. */
function hnHourNow(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Tegucigalpa",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (h === 24 ? 0 : h) + m / 60;
}

/** "YYYY-MM-DD HH:MM:SS" (sqlite, UTC) o ISO → epoch ms. null si no parsea. */
function parseUtcMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  const ms = Date.parse(/[Z+]/.test(iso.slice(10)) ? iso : `${iso}Z`);
  return isNaN(ms) ? null : ms;
}

/** Dígitos para el deep-link /inbox?c= — número local HN de 8 dígitos gana su 504
 *  (si no, el hilo real —que Meta guarda en E.164— no matchea y el chat sale vacío). */
function phoneDigitsE164(raw: string): string {
  const d = raw.replace(/\D/g, "");
  return d.length === 8 ? `504${d}` : d;
}

/** Timestamp de envío → hora HONDURAS legible ("12 jul, 6:02 p. m."). */
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

// ── Pago ─────────────────────────────────────────────────────────────────────

type PayState = "paid" | "deposit" | "unpaid" | "verify";

interface PayInfo {
  state: PayState;
  total: number | null;
  paid: number | null;
  saldo: number | null;
  needsMoney: boolean; // ¿falta plata por cobrar/verificar?
  hint?: string;
}

/**
 * Estado del pago. Prioriza el libro real en Lempiras (total_hnl/paid_hnl que
 * César edita en /inbox/registro). Sin ese libro: PayPal confirmado = pagado de
 * verdad; transferencia/manual sin total = "definí el total"; resto = verificar.
 * (Mismo criterio que /inbox/registro para no contradecirse.)
 */
function paymentInfo(r: Reservation): PayInfo {
  // Rol staff: los montos ni llegaron, así que NO se puede re-derivar el estado
  // acá (una reserva pagada por transferencia se leería como "por verificar").
  // El servidor ya lo resolvió con los números reales.
  if (r.pay_state) {
    const state: PayState =
      r.pay_state === "paid" ? "paid"
      : r.pay_state === "deposit" ? "deposit"
      : r.pay_state === "unpaid" ? "unpaid"
      : "verify";
    return {
      state,
      total: null,
      paid: null,
      saldo: null,
      needsMoney: state !== "paid",
      hint: state === "paid" ? undefined : "El cobro lo confirma César",
    };
  }
  if (r.total_hnl != null) {
    const total = r.total_hnl;
    const paid = r.paid_hnl ?? 0;
    const saldo = Math.max(0, total - paid);
    if (paid >= total) return { state: "paid", total, paid, saldo: 0, needsMoney: false };
    if (paid > 0) return { state: "deposit", total, paid, saldo, needsMoney: true };
    return { state: "unpaid", total, paid: 0, saldo: total, needsMoney: true };
  }
  // PayPal (web/airbnb/bot) confirmado → cobrado de verdad por la plataforma.
  if (r.status === "confirmed" && r.source !== "whatsapp_transfer" && r.source !== "manual") {
    return { state: "paid", total: null, paid: null, saldo: null, needsMoney: false };
  }
  // Transferencia/manual con depósito pero SIN total cargado → no afirmar "pagado".
  if (r.tr_amount != null) {
    return { state: "deposit", total: null, paid: null, saldo: null, needsMoney: true, hint: "Definí el total en Registro para ver el saldo" };
  }
  return { state: "verify", total: null, paid: null, saldo: null, needsMoney: true, hint: "Cargá el pago en Registro" };
}

// ── Estado por touchpoint ────────────────────────────────────────────────────

type TpLevel = "done" | "failed" | "held" | "nophone" | "imminent" | "scheduled" | "pending" | "overdue";

interface TpState {
  level: TpLevel;
  sentAt?: string;
  error?: string;
  errorDetail?: string; // el crudo exacto de Meta (tooltip / tap)
  when?: string; // texto de cuándo sale
  /** Entrega agregada que reporta Meta: la MENOS avanzada entre destinatarios. */
  delivery?: "sent" | "delivered" | "read";
  /** Envíos reales registrados (con el teléfono del destinatario → link al chat). */
  recipients?: WaEntry[];
}

const DELIVERY_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

function touchpointState(r: Reservation, tp: Touchpoint, pay: PayInfo): TpState {
  // 1) La ENTREGA REAL manda (whatsapp_messages vía wamid): detecta el fallo
  //    asíncrono que las columnas wa_* no ven (Meta acepta y rechaza después).
  const entries = tp.waRule && r.wa ? r.wa.filter((w) => w.rule === tp.waRule) : [];
  const okE = entries.filter((e) => e.status !== "failed");
  const failedE = entries.filter((e) => e.status === "failed");
  // Un fallo a un destinatario VIEJO (número corregido, contacto de staff rotado)
  // se considera resuelto si hay un envío OK MÁS NUEVO de la misma regla — si no,
  // el chip quedaba ⚠ para siempre sin forma de limpiarlo. El >= conserva el caso
  // batch real (2 contactos, uno ok y uno falla en el mismo segundo → falla gana).
  const newestOkAt = okE.reduce<string | null>((acc, e) => (!acc || e.at > acc ? e.at : acc), null);
  const activeFailed = newestOkAt ? failedE.filter((e) => e.at >= newestOkAt) : failedE;
  if (activeFailed.length > 0) {
    return {
      level: "failed",
      error: activeFailed[0].reason ?? "falló",
      errorDetail: activeFailed[0].detail ?? undefined,
      sentAt: activeFailed[0].at,
      recipients: entries,
    };
  }
  if (okE.length > 0) {
    const worst = okE.reduce<"sent" | "delivered" | "read">((acc, e) => {
      const s = e.status && DELIVERY_RANK[e.status] ? (e.status as "sent" | "delivered" | "read") : "sent";
      return DELIVERY_RANK[s] < DELIVERY_RANK[acc] ? s : acc;
    }, "read");
    return { level: "done", sentAt: newestOkAt ?? okE[0].at, delivery: worst, recipients: entries };
  }

  // 2) Sin registro de envío → columnas de siempre (legacy / email).
  const sentAt = (r[tp.sentKey] as string | null | undefined) ?? null;
  if (sentAt) return { level: "done", sentAt };
  const error = (r[tp.errorKey] as string | null | undefined) ?? null;
  if (error) return { level: "failed", error };
  if (tp.heldByPayment && pay.state !== "paid") return { level: "held" };
  if (tp.needsPhone && !r.guest_phone) return { level: "nophone" };
  if (!tp.auto) return { level: "pending" }; // respaldo manual, sin agenda
  const base = tp.side === "departure" ? r.check_out : r.check_in;
  const fireDate = addDays(base, tp.offsetDays);
  const d = daysUntil(fireDate);
  // "No salió a su hora" por HORA de Honduras, no por día calendario: el aviso de
  // las 10 am que no salió se marca HOY a las 11 (cuando todavía se puede actuar),
  // no mañana. +1 h de gracia para no marcar mientras el cron aún puede disparar.
  const late = d < 0 || (d === 0 && tp.fireHour != null && hnHourNow() >= tp.fireHour + 1);
  if (late) {
    // Si el hito pasó ANTES de que la reserva existiera (reserva de último minuto,
    // víspera ya vencida al confirmarse), no es una falla del cron: no aplicó.
    const createdMs = parseUtcMs(r.created_at);
    const [fy, fm, fd] = fireDate.split("-").map(Number);
    const fireMs = tp.fireHour != null && fy ? Date.UTC(fy, fm - 1, fd) + (tp.fireHour + 6) * 3600000 : null;
    if (createdMs != null && fireMs != null && fireMs < createdMs) {
      return { level: "pending", when: "no aplicó — la reserva entró después" };
    }
    return { level: "overdue", when: `${tp.when} ${tp.time}`.trim() };
  }
  const whenTxt = d === 0 ? `hoy ${tp.time}` : d === 1 ? `mañana ${tp.time}` : `${tp.when} · ${tp.time}`;
  return { level: d <= 1 ? "imminent" : "scheduled", when: whenTxt.trim() };
}

// ── Clasificación / urgencia ─────────────────────────────────────────────────

interface Analysis {
  pay: PayInfo;
  states: Record<string, TpState>;
  attention: string[]; // razones por las que necesita acción hoy
  bucket: "accion" | "hoymanana" | "proximas";
  stayText: string;
  stayCls: string;
  requiresId: boolean;
}

// Propiedades cuya garita pide la foto de identidad del huésped (Fase 2).
// Espejo del SECURITY_ENRICHED_SLUGS del backend.
const REQUIRES_ID = new Set<string>(["villa-b11-palma-real"]);

function analyze(r: Reservation): Analysis {
  const pay = paymentInfo(r);
  const states: Record<string, TpState> = {};
  for (const tp of ALL_TOUCHPOINTS) states[tp.key] = touchpointState(r, tp, pay);

  const inDays = daysUntil(r.check_in);
  const outDays = daysUntil(r.check_out);
  const arrivingSoon = inDays >= 0 && inDays <= 1; // hoy/mañana → dispara atención
  // Ventana de "cards completas": lo que entra o sale en los próximos días (no
  // solo hoy/mañana — César 2026-07-13). El resto va condensado a "Próximas".
  const SOON_DAYS = 3;
  const arrivingWindow = inDays >= 0 && inDays <= SOON_DAYS;
  const departingWindow = outDays >= 0 && outDays <= SOON_DAYS;

  const requiresId = REQUIRES_ID.has(r.property_slug);
  const attention: string[] = [];
  const anyFailed = ALL_TOUCHPOINTS.some((tp) => states[tp.key].level === "failed");
  if (anyFailed) attention.push("un aviso falló");
  if (arrivingSoon && !r.guest_phone) attention.push("sin número del huésped");
  if (arrivingSoon && pay.needsMoney) {
    attention.push(pay.state === "verify" ? "pago por verificar" : "saldo por cobrar");
  }
  if (requiresId && arrivingSoon && !r.security_id_key) attention.push("falta la ID del huésped");

  // Estado de estadía (para el badge)
  let stayText: string, stayCls: string;
  if (inDays <= 0 && outDays >= 0) {
    stayText = outDays === 0 ? "Sale hoy" : "Hospedado";
    stayCls = "text-emerald-300 border-emerald-500/40 bg-emerald-500/10";
  } else if (inDays === 0) {
    stayText = "Llega HOY";
    stayCls = "text-amber-200 border-amber-400/50 bg-amber-400/15 font-bold";
  } else if (inDays === 1) {
    stayText = "Llega mañana";
    stayCls = "text-amber-200 border-amber-400/40 bg-amber-400/10";
  } else if (inDays > 1) {
    stayText = `Llega en ${inDays} días`;
    stayCls = "text-slate-300 border-white/15 bg-white/5";
  } else {
    stayText = "Finalizada";
    stayCls = "text-slate-500 border-white/10 bg-white/5";
  }

  const bucket: Analysis["bucket"] =
    attention.length > 0 ? "accion" : arrivingWindow || departingWindow ? "hoymanana" : "proximas";

  return { pay, states, attention, bucket, stayText, stayCls, requiresId };
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ReservasPage() {
  const [authed, setAuthed] = useState(true);
  // Esta pantalla ya no consulta el rol: los montos no le llegan al empleado
  // (el servidor manda `pay_state` en su lugar) y la card entera —incluido el
  // texto de cancelar— se adapta con ese dato. Preguntar el rol por fetch era
  // un flag que fallaba a "dueño" si la llamada se caía; el dato del servidor
  // no tiene esa ventana.
  const [loading, setLoading] = useState(true);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [propFilter, setPropFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [actionMsg, setActionMsg] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [cancelling, setCancelling] = useState<Record<number, boolean>>({});
  const [cancelMsg, setCancelMsg] = useState<Record<number, string>>({});

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
    async (id: number, template: TemplateName, alreadySent: boolean, to: string, failedReason?: string | null): Promise<void> => {
      const key = `${id}:${template}`;
      if (sending[key]) return;
      // Si el último intento FALLÓ, el diálogo lo dice con su motivo — nunca
      // afirmar "ya se envió" sobre un mensaje que no llegó (revisión 16-jul).
      const confirmMsg = failedReason
        ? `El último intento FALLÓ: ${failedReason}\n\n¿Reintentar el envío a ${to}?`
        : alreadySent
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

  // ── Foto de identidad del huésped (garita Villa B11) ───────────────────────
  const [idBusy, setIdBusy] = useState<Record<number, boolean>>({});
  const [idMsg, setIdMsg] = useState<Record<number, string>>({});

  const uploadId = useCallback(
    async (id: number, file: File): Promise<void> => {
      if (idBusy[id]) return;
      setIdBusy((s) => ({ ...s, [id]: true }));
      setIdMsg((m) => ({ ...m, [id]: "" }));
      try {
        const form = new FormData();
        form.append("reservationId", String(id));
        form.append("file", file);
        const resp = await fetch("/api/inbox/reservation-id", { method: "POST", credentials: "include", body: form });
        if (resp.status === 401) {
          setAuthed(false);
          return;
        }
        const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (data.ok) {
          setIdMsg((m) => ({ ...m, [id]: "✓ ID cargada" }));
          fetchReservations();
        } else {
          setIdMsg((m) => ({ ...m, [id]: (data.error || "falló").slice(0, 140) }));
        }
      } catch {
        setIdMsg((m) => ({ ...m, [id]: "error de red" }));
      } finally {
        setIdBusy((s) => ({ ...s, [id]: false }));
      }
    },
    [idBusy, fetchReservations],
  );

  const removeId = useCallback(
    async (id: number): Promise<void> => {
      if (idBusy[id]) return;
      if (!window.confirm("¿Quitar la foto de identidad de esta reserva?")) return;
      setIdBusy((s) => ({ ...s, [id]: true }));
      try {
        const resp = await fetch(`/api/inbox/reservation-id?id=${id}`, { method: "DELETE", credentials: "include" });
        if (resp.status === 401) {
          setAuthed(false);
          return;
        }
        setIdMsg((m) => ({ ...m, [id]: "" }));
        fetchReservations();
      } catch {
        setIdMsg((m) => ({ ...m, [id]: "error de red" }));
      } finally {
        setIdBusy((s) => ({ ...s, [id]: false }));
      }
    },
    [idBusy, fetchReservations],
  );

  // ── Cancelar reserva (libera fechas, el huésped pierde lo pagado) ──────────
  const cancelReservation = useCallback(
    async (r: Reservation): Promise<void> => {
      if (cancelling[r.id]) return;
      const pay = paymentInfo(r);
      // `pay_state` llega EXACTAMENTE cuando el servidor borró los montos
      // (redactMoney). Ramificar por ese hecho —y no por el flag `isStaff`, que
      // se resuelve por fetch y cae a false si falla— garantiza que el texto sin
      // números y la fila sin números nunca se desincronicen.
      const plata = r.pay_state != null
        ? pay.state === "unpaid"
          ? "ℹ️ Esta reserva no tiene pago registrado; solo se liberan las fechas."
          : pay.state === "deposit"
            ? "💰 El huésped pierde el depósito que hizo (no se reembolsa)."
            : pay.state === "paid"
              ? "💰 El huésped pierde lo que pagó (no se reembolsa)."
              : "💰 Lo que el huésped haya pagado lo pierde, no se reembolsa."
        : pay.state === "paid"
          ? "💰 El huésped pierde lo que pagó (no se reembolsa)."
          : pay.paid && pay.paid > 0
            ? `💰 El huésped pierde los L ${Math.round(pay.paid).toLocaleString("es-HN")} que pagó (no se reembolsa).`
            : pay.state === "deposit"
              ? "💰 El huésped hizo un depósito (por transferencia): lo pierde, no se reembolsa. Definí el total en Registro para el monto exacto."
              : "ℹ️ No hay pago cargado; solo se liberan las fechas.";
      const msg = `¿Cancelar la reserva de ${r.guest_name || "este huésped"}?\n\n✅ Se liberan las fechas para volver a rentarlas.\n${plata}\n\nDeja de recibir avisos. Se puede reactivar desde el Registro si fue un error.`;
      if (!window.confirm(msg)) return;
      setCancelling((s) => ({ ...s, [r.id]: true }));
      setCancelMsg((m) => ({ ...m, [r.id]: "" }));
      try {
        const resp = await fetch("/api/inbox/reservation-cancel", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: r.id, action: "cancel" }),
        });
        if (resp.status === 401) { setAuthed(false); return; }
        const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (data.ok) {
          fetchReservations(); // la card desaparece (queda fuera de confirmed/pending)
        } else {
          setCancelMsg((m) => ({ ...m, [r.id]: (data.error || "no se pudo cancelar").slice(0, 160) }));
        }
      } catch {
        setCancelMsg((m) => ({ ...m, [r.id]: "error de red" }));
      } finally {
        setCancelling((s) => ({ ...s, [r.id]: false }));
      }
    },
    [cancelling, fetchReservations],
  );

  // ── Filtros ──────────────────────────────────────────────────────────────
  const slugsPresent = Array.from(new Set(reservations.map((r) => r.property_slug)));
  const filtered = reservations.filter((r) => {
    if (propFilter && r.property_slug !== propFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const hay = `${r.guest_name ?? ""} ${r.guest_phone ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // ── Clasificar en secciones ────────────────────────────────────────────────
  const rows = filtered
    .map((r) => ({ r, a: analyze(r) }))
    .sort((x, y) => x.r.check_in.localeCompare(y.r.check_in));
  const accion = rows.filter((x) => x.a.bucket === "accion");
  const hoyManana = rows.filter((x) => x.a.bucket === "hoymanana");
  const proximas = rows.filter((x) => x.a.bucket === "proximas");

  const arrivingToday = reservations.filter((r) => daysUntil(r.check_in) === 0).length;

  const shared = { sending, actionMsg, onSend: sendMessage, idBusy, idMsg, onUploadId: uploadId, onRemoveId: removeId, cancelling, cancelMsg, onCancel: cancelReservation };

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
            {accion.length > 0 ? (
              <span className="text-rose-300"> · {accion.length} necesitan atención</span>
            ) : null}
          </p>
        </div>
        <a href="/inbox" className="px-3 py-1.5 border border-white/15 rounded-lg hover:bg-white/5 text-slate-300 text-sm">← Inbox</a>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-5">
        {/* Filtros */}
        <div className="flex flex-wrap items-center gap-2 mb-5">
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
        </div>

        {loading && reservations.length === 0 ? (
          <p className="text-center text-slate-500 py-16">Cargando reservas…</p>
        ) : filtered.length === 0 ? (
          <p className="text-center text-slate-500 py-16">
            {reservations.length === 0 ? "No hay reservas activas. 🌴" : "Ninguna reserva coincide con el filtro."}
          </p>
        ) : (
          <div className="space-y-7">
            {/* ⚠ Necesitan atención */}
            {accion.length > 0 && (
              <section>
                <SectionTitle emoji="⚠️" text="Necesitan tu atención" count={accion.length} tone="rose" />
                <div className="space-y-3">
                  {accion.map(({ r, a }) => (
                    <FullCard key={r.id} r={r} a={a} highlight {...shared} />
                  ))}
                </div>
              </section>
            )}

            {/* Hoy y mañana */}
            {hoyManana.length > 0 && (
              <section>
                <SectionTitle emoji="📆" text="Próximos días" count={hoyManana.length} tone="amber" />
                <div className="space-y-3">
                  {hoyManana.map(({ r, a }) => (
                    <FullCard key={r.id} r={r} a={a} {...shared} />
                  ))}
                </div>
              </section>
            )}

            {/* Próximas (condensadas) */}
            {proximas.length > 0 && (
              <section>
                <SectionTitle emoji="🗓️" text="Próximas" count={proximas.length} tone="slate" />
                <div className="space-y-2">
                  {proximas.map(({ r, a }) =>
                    expanded[r.id] ? (
                      <FullCard key={r.id} r={r} a={a} onCollapse={() => setExpanded((e) => ({ ...e, [r.id]: false }))} {...shared} />
                    ) : (
                      <CompactCard key={r.id} r={r} a={a} onExpand={() => setExpanded((e) => ({ ...e, [r.id]: true }))} />
                    ),
                  )}
                </div>
              </section>
            )}
          </div>
        )}

        <p className="text-[11px] text-slate-600 text-center mt-8 leading-relaxed">
          Toda reserva confirmada recibe los avisos en automático: limpieza 6 pm de la víspera, seguridad 7 am,
          huésped 10 am, limpieza de salida 11:30 am. Los botones son para adelantar o reenviar a mano
          (las pendientes de pago no se automatizan). En los avisos de WhatsApp: ✓ Meta lo aceptó · ✓✓ entregado ·
          ✓✓ leído · ⚠ falló (tocá el chip rojo para ver el motivo exacto y reintentar; con mouse, el hover también
          lo muestra) · ⏰ no salió a su hora (el cron no lo disparó) · 💬 abre el chat en vivo con ese
          destinatario — también con limpieza y la garita.
        </p>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function SectionTitle({ emoji, text, count, tone }: { emoji: string; text: string; count: number; tone: "rose" | "amber" | "slate" }) {
  const dot = tone === "rose" ? "text-rose-300" : tone === "amber" ? "text-amber-200" : "text-slate-400";
  return (
    <h2 className={`text-[13px] font-semibold ${dot} mb-2 flex items-center gap-2 uppercase tracking-wide`}>
      <span>{emoji}</span>
      <span>{text}</span>
      <span className="text-slate-500 font-normal normal-case">· {count}</span>
    </h2>
  );
}

// ── Panel de pago ────────────────────────────────────────────────────────────

function PaymentPanel({ pay }: { pay: PayInfo }) {
  if (pay.state === "paid") {
    return (
      <div className="flex items-center gap-2 text-[12px]">
        <span className="text-emerald-300">💰 Pagado</span>
        {pay.total != null && <span className="text-slate-500">· {fmtL(pay.total)}</span>}
      </div>
    );
  }
  const hasNumbers = pay.total != null && pay.paid != null;
  const pct = hasNumbers && pay.total! > 0 ? Math.min(100, Math.round((pay.paid! / pay.total!) * 100)) : 0;
  const barCls = pay.state === "deposit" ? "bg-amber-400" : "bg-rose-400";
  const labelCls = pay.state === "verify" || pay.state === "unpaid" ? "text-rose-300" : "text-amber-300";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[12px]">
        <span className={labelCls}>
          💰{" "}
          {hasNumbers
            ? `Pagó ${fmtL(pay.paid!)} de ${fmtL(pay.total!)}`
            : pay.state === "deposit"
              ? "Depósito recibido"
              : "Por verificar"}
        </span>
        {hasNumbers && pay.saldo! > 0 && <span className="text-rose-300 font-semibold">falta {fmtL(pay.saldo!)}</span>}
      </div>
      {hasNumbers && (
        <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div className={`h-full ${barCls}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {pay.hint && <p className="text-[10px] text-slate-500">{pay.hint}</p>}
    </div>
  );
}

// ── Pill de estado de un touchpoint ──────────────────────────────────────────

/** "✓" aceptado · "✓✓" entregado · "✓✓ leído" — lo que reporta Meta por wamid. */
function deliveryTicks(d?: "sent" | "delivered" | "read"): string {
  if (d === "read") return "✓✓ leído";
  if (d === "delivered") return "✓✓";
  return "✓";
}

const DELIVERY_TITLE: Record<string, string> = {
  sent: "Meta ACEPTÓ el envío (✓). Aún no confirma la entrega al teléfono.",
  delivered: "ENTREGADO al teléfono del destinatario (✓✓).",
  read: "LEÍDO por el destinatario (✓✓ azul en WhatsApp).",
};

/** Etiqueta humana del destinatario según la regla del envío (para los links 💬). */
function chatRoleOf(rule: string | null): string {
  if (!rule) return "";
  if (rule.includes("limpieza")) return "limpieza";
  if (rule.includes("seguridad")) return "garita";
  return "";
}

function TouchpointPill({
  tp,
  st,
  r,
  busy,
  msg,
  onSend,
}: {
  tp: Touchpoint;
  st: TpState;
  r: Reservation;
  busy: boolean;
  msg?: string;
  onSend: (id: number, template: TemplateName, alreadySent: boolean, to: string, failedReason?: string | null) => void;
}) {
  // Detalle del fallo expandible con un TAP (el hover no existe en la PWA/touch).
  const [showErr, setShowErr] = useState(false);
  const canSend = tp.template != null;
  const to = tp.template ? recipientOf(tp.template, r.guest_name || "el huésped") : "";
  const clickable = canSend && st.level !== "held";
  const alreadySent = st.level === "done" || (st.level === "failed" && Boolean(st.sentAt));
  const failed = st.level === "failed";
  const doSend = clickable
    ? () => onSend(r.id, tp.template!, alreadySent, to, failed ? (st.error ?? "motivo desconocido") : undefined)
    : undefined;
  // En FALLADO el tap del chip EXPANDE el motivo (target grande, sin riesgo de
  // reenviar por error a las 3 am); el reintento es un botón explícito adentro.
  const handle = failed ? () => setShowErr((v) => !v) : doSend;

  // Hilos de WhatsApp para "constatar en vivo": los destinatarios REALES de los
  // envíos registrados; si aún no hay registro y el mensaje va al huésped, su #.
  const role = chatRoleOf(tp.waRule);
  const chatTargets: { phone: string; status: string | null }[] = [];
  for (const e of st.recipients ?? []) {
    const digits = phoneDigitsE164(e.to);
    if (digits && !chatTargets.some((t) => t.phone === digits)) chatTargets.push({ phone: digits, status: e.status });
  }
  if (chatTargets.length === 0 && tp.toGuest && r.guest_phone) {
    const digits = phoneDigitsE164(r.guest_phone);
    if (digits) chatTargets.push({ phone: digits, status: null });
  }

  // (borde/fondo/texto, contenido principal, subtexto)
  let cls = "border-white/12 bg-white/[0.03] text-slate-400";
  let head = `${tp.icon} ${tp.label}`;
  let sub: string | null = null;
  let subCls = "text-slate-500";

  switch (st.level) {
    case "done":
      cls = "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
      head = `✓ ${tp.icon} ${tp.label}`;
      sub = st.sentAt ? `${st.delivery ? `${deliveryTicks(st.delivery)} ` : ""}${fmtSentAtHn(st.sentAt)}` : "enviado";
      subCls = st.delivery === "sent" ? "text-emerald-400/60" : "text-emerald-400/80";
      break;
    case "failed":
      cls = "border-rose-500/50 bg-rose-500/10 text-rose-300";
      head = `⚠ ${tp.icon} ${tp.label}`;
      sub = st.error ?? "falló";
      subCls = "text-rose-400/80";
      break;
    case "held":
      cls = "border-amber-500/30 bg-amber-500/[0.07] text-amber-300/90";
      head = `⏸ ${tp.icon} ${tp.label}`;
      sub = "retenido: falta pago";
      subCls = "text-amber-400/70";
      break;
    case "nophone":
      cls = "border-white/12 bg-white/[0.03] text-slate-500";
      head = `${tp.icon} ${tp.label}`;
      sub = "sin # del huésped";
      break;
    case "imminent":
      cls = "border-amber-400/40 bg-amber-400/[0.08] text-amber-200/90";
      head = `● ${tp.icon} ${tp.label}`;
      sub = st.when ?? null;
      subCls = "text-amber-300/70";
      break;
    case "scheduled":
      cls = "border-white/12 bg-white/[0.02] text-slate-400";
      head = `○ ${tp.icon} ${tp.label}`;
      sub = st.when ?? null;
      break;
    case "overdue":
      // Ámbar fuerte, NO rojo: "el cron no lo disparó" es accionable pero no es
      // un fallo confirmado de Meta — el rojo queda reservado al ⚠ real para que
      // un billing 131042 no se entierre entre relojitos (revisión 16-jul).
      cls = "border-amber-500/50 bg-amber-500/[0.09] text-amber-200";
      head = `⏰ ${tp.icon} ${tp.label}`;
      sub = clickable ? "no salió — enviar ahora" : "no salió a su hora";
      subCls = "text-amber-300/80";
      break;
    case "pending":
      cls = "border-white/12 bg-white/[0.02] text-slate-400";
      head = `${tp.icon} ${tp.label}`;
      sub = st.when ?? (tp.auto ? "pendiente" : "manual");
      break;
  }

  const failTitle = st.error
    ? `Razón exacta: ${st.error}${st.errorDetail ? ` — ${st.errorDetail}` : ""} · Tocá el chip para ver el detalle${clickable ? " y reintentar" : ""}`
    : "";
  const title =
    st.level === "done"
      ? `${st.delivery ? DELIVERY_TITLE[st.delivery] : "Enviado"} ${st.sentAt ? fmtSentAtHn(st.sentAt) : ""}${clickable ? " — clic para reenviar" : ""}`
      : st.level === "failed"
        ? failTitle
        : st.level === "held"
          ? "Las instrucciones solo salen con el pago TOTAL (política de la casa)"
          : st.level === "overdue"
            ? `Debió salir ${st.when ?? "a su hora"} y no hay registro de envío ni error: el cron no lo disparó (worker inerte o hito apagado).${clickable ? " Clic para enviarlo ahora." : ""}`
            : clickable
              ? `${tp.auto ? "Sale solo" : "Envío manual"} — clic para enviar ahora`
              : tp.icon + " " + tp.label;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        disabled={busy || (!clickable && !failed)}
        onClick={handle}
        title={title}
        className={`text-left px-2.5 py-1 rounded-md text-[11px] font-medium border transition ${cls} ${
          clickable || failed ? "hover:brightness-125 cursor-pointer" : "cursor-default"
        } disabled:opacity-60`}
      >
        {busy ? "…" : head}
      </button>
      {msg ? (
        <span className="text-[9px] text-slate-400 mt-0.5 max-w-[130px] truncate" title={msg}>{msg}</span>
      ) : null}
      {sub ? (
        <span className={`text-[9px] mt-0.5 max-w-[130px] truncate ${subCls}`} title={title}>{sub}</span>
      ) : null}
      {showErr && st.error ? (
        <span className="text-[10px] text-rose-200/90 mt-1 max-w-[240px] whitespace-normal break-words border border-rose-500/30 bg-rose-500/[0.08] rounded p-1.5">
          {st.error}
          {st.errorDetail ? <span className="text-rose-300/70"> — {st.errorDetail}</span> : null}
          <span className="flex gap-2 mt-1.5">
            {doSend ? (
              <button
                type="button"
                disabled={busy}
                onClick={doSend}
                className="text-[10px] px-1.5 py-1 rounded border border-rose-400/50 text-rose-100 hover:bg-rose-500/20 disabled:opacity-50"
              >
                🔄 Reintentar envío
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                try {
                  void navigator.clipboard?.writeText(`${st.error}${st.errorDetail ? ` — ${st.errorDetail}` : ""}`);
                } catch { /* clipboard no disponible */ }
              }}
              className="text-[10px] px-1.5 py-1 rounded border border-white/20 text-slate-300 hover:bg-white/10"
            >
              copiar
            </button>
          </span>
        </span>
      ) : null}
      {chatTargets.length > 0 ? (
        <span className="flex gap-2 mt-1.5 flex-wrap">
          {chatTargets.map((t) => (
            <a
              key={t.phone}
              href={`/inbox?c=${t.phone}`}
              title={`Ver el chat en vivo con ${role ? `${role} ` : ""}+${t.phone}${t.status ? ` (${t.status === "failed" ? "falló" : t.status})` : ""}`}
              className="text-[9px] text-cyan-300/90 hover:text-cyan-200 py-1 -my-1 px-1 -mx-1"
            >
              💬 {chatTargets.length > 1 ? `${role || "chat"} …${t.phone.slice(-4)}` : role || "ver chat"}
            </a>
          ))}
        </span>
      ) : null}
    </div>
  );
}

// ── Card completa ────────────────────────────────────────────────────────────

interface CardShared {
  sending: Record<string, boolean>;
  actionMsg: Record<string, string>;
  onSend: (id: number, template: TemplateName, alreadySent: boolean, to: string, failedReason?: string | null) => void;
  idBusy: Record<number, boolean>;
  idMsg: Record<number, string>;
  onUploadId: (id: number, file: File) => void;
  onRemoveId: (id: number) => void;
  cancelling: Record<number, boolean>;
  cancelMsg: Record<number, string>;
  onCancel: (r: Reservation) => void;
}

function CardHeader({ r, a }: { r: Reservation; a: Analysis }) {
  const prop = getProperty(r.property_slug);
  const sm = sourceMeta(r.source);
  const phoneDigits = r.guest_phone ? phoneDigitsE164(r.guest_phone) : "";
  return (
    <>
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
        <span className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${a.stayCls}`}>{a.stayText}</span>
      </div>

      <div className="flex items-center gap-4 mt-2.5 text-[12px] flex-wrap">
        <span className="text-slate-300">
          <span className="text-slate-500">Entra</span> {fmtDate(r.check_in)} <span className="text-slate-600">→</span>{" "}
          <span className="text-slate-500">sale</span> {fmtDate(r.check_out)}
        </span>
        {r.guest_phone ? (
          <span className="flex items-center gap-2">
            <span className="font-mono text-slate-300">{r.guest_phone}</span>
            <a href={`/inbox?c=${phoneDigits}`} className="text-[11px] text-cyan-300 border border-cyan-500/30 rounded px-1.5 py-0.5 hover:bg-cyan-500/10">
              Abrir chat
            </a>
          </span>
        ) : (
          <span className="text-[11px] text-rose-300 border border-rose-500/40 bg-rose-500/10 rounded px-1.5 py-0.5">
            ⚠ Sin número{r.source === "airbnb" ? " (esperando respuesta del huésped)" : ""}
          </span>
        )}
      </div>
    </>
  );
}

function FullCard({
  r,
  a,
  highlight,
  onCollapse,
  sending,
  actionMsg,
  onSend,
  idBusy,
  idMsg,
  onUploadId,
  onRemoveId,
  cancelling,
  cancelMsg,
  onCancel,
}: { r: Reservation; a: Analysis; highlight?: boolean; onCollapse?: () => void } & CardShared) {
  const renderPills = (defs: Touchpoint[]) =>
    defs.map((tp) => {
      const key = `${r.id}:${tp.template}`;
      return (
        <TouchpointPill
          key={tp.key}
          tp={tp}
          st={a.states[tp.key]}
          r={r}
          busy={tp.template ? Boolean(sending[key]) : false}
          msg={tp.template ? actionMsg[key] : undefined}
          onSend={onSend}
        />
      );
    });

  return (
    <div className={`rounded-2xl border p-4 ${highlight ? "border-rose-500/40 bg-rose-500/[0.04]" : "border-white/10 bg-white/[0.03]"}`}>
      <CardHeader r={r} a={a} />

      {/* Por qué necesita atención */}
      {a.attention.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {a.attention.map((why) => (
            <span key={why} className="text-[10px] px-2 py-0.5 rounded-full border border-rose-500/40 bg-rose-500/10 text-rose-200">
              {why}
            </span>
          ))}
        </div>
      )}

      {/* Pago */}
      <div className="mt-3">
        <PaymentPanel pay={a.pay} />
      </div>

      {/* Identidad para la garita (solo propiedades que la piden, ej. Villa B11) */}
      {a.requiresId && (
        <div className="mt-3">
          <IdBlock
            r={r}
            busy={Boolean(idBusy[r.id])}
            msg={idMsg[r.id]}
            onUpload={onUploadId}
            onRemove={onRemoveId}
          />
        </div>
      )}

      {/* Avisos */}
      <div className="mt-3 pt-3 border-t border-white/5 space-y-2.5">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">Llegada</div>
          <div className="flex gap-1.5 flex-wrap items-start">{renderPills(ARRIVAL_TOUCHPOINTS)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">Salida</div>
          <div className="flex gap-1.5 flex-wrap items-start">{renderPills(DEPARTURE_TOUCHPOINTS)}</div>
        </div>
      </div>

      {/* Pie: cancelar reserva (libera fechas) + colapsar */}
      <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {/* También el staff (César, 17-ago): el huésped avisa que cancela y
              las fechas tienen que quedar libres el mismo día. El monto no le
              viaja y la cancelación queda firmada con su nombre. */}
          <button
            type="button"
            disabled={Boolean(cancelling[r.id])}
            onClick={() => onCancel(r)}
            className="text-[11px] text-rose-300/90 border border-rose-500/30 rounded px-2 py-1 hover:bg-rose-500/10 disabled:opacity-50"
            title="Cancelar la reserva y liberar las fechas (el huésped pierde lo pagado)"
          >
            {cancelling[r.id] ? "cancelando…" : "🚫 Cancelar reserva"}
          </button>
          {cancelMsg[r.id] ? (
            <span className="text-[10px] text-rose-300 truncate max-w-[160px]" title={cancelMsg[r.id]}>{cancelMsg[r.id]}</span>
          ) : null}
        </div>
        {onCollapse && (
          <button type="button" onClick={onCollapse} className="text-[11px] text-slate-500 hover:text-slate-300 shrink-0">
            ▴ Ocultar detalle
          </button>
        )}
      </div>
    </div>
  );
}

// ── Foto de identidad del huésped (garita) ───────────────────────────────────

function IdBlock({
  r,
  busy,
  msg,
  onUpload,
  onRemove,
}: {
  r: Reservation;
  busy: boolean;
  msg?: string;
  onUpload: (id: number, file: File) => void;
  onRemove: (id: number) => void;
}) {
  const has = Boolean(r.security_id_key);
  return (
    <div className="flex items-center gap-2 flex-wrap text-[11px]">
      <span className="text-slate-500">🪪 Identidad para la garita:</span>
      {has ? (
        <>
          <a
            href={`/api/inbox/reservation-id?id=${r.id}`}
            target="_blank"
            rel="noreferrer"
            className="px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
          >
            ✓ cargada — ver
          </a>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRemove(r.id)}
            className="px-2 py-0.5 rounded border border-white/15 text-slate-400 hover:bg-white/5 disabled:opacity-50"
          >
            quitar
          </button>
        </>
      ) : (
        <label
          className={`px-2 py-0.5 rounded border ${
            busy
              ? "border-white/10 text-slate-500 cursor-default"
              : "border-amber-400/40 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20 cursor-pointer"
          }`}
        >
          {busy ? "subiendo…" : "📎 Subir ID (JPG/PNG)"}
          <input
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(r.id, f);
              e.currentTarget.value = "";
            }}
          />
        </label>
      )}
      {msg && (
        <span className="text-[10px] text-slate-400 max-w-[220px] truncate" title={msg}>
          {msg}
        </span>
      )}
    </div>
  );
}

// ── Card condensada (Próximas) ───────────────────────────────────────────────

function CompactCard({ r, a, onExpand }: { r: Reservation; a: Analysis; onExpand: () => void }) {
  const prop = getProperty(r.property_slug);
  const sm = sourceMeta(r.source);

  // Resumen de avisos: prioriza problemas; si no, cuántos programados/enviados.
  const failed = ALL_TOUCHPOINTS.filter((tp) => a.states[tp.key].level === "failed").length;
  const overdue = ALL_TOUCHPOINTS.filter((tp) => a.states[tp.key].level === "overdue").length;
  const done = ALL_TOUCHPOINTS.filter((tp) => a.states[tp.key].level === "done").length;
  let avisos: { text: string; cls: string };
  if (failed > 0) avisos = { text: `⚠ ${failed} falló`, cls: "text-rose-300" };
  else if (overdue > 0) avisos = { text: `⏰ ${overdue} no salió`, cls: "text-amber-300" };
  else if (done > 0) avisos = { text: `✓ ${done} enviados`, cls: "text-emerald-300/80" };
  else avisos = { text: "avisos programados", cls: "text-slate-500" };

  // El saldo pendiente manda: si algo se debe, se ve SIEMPRE (César 2026-07-13).
  const payChip =
    a.pay.saldo != null && a.pay.saldo > 0
      ? { text: `falta ${fmtL(a.pay.saldo)}`, cls: "text-amber-300 font-semibold" }
      : a.pay.state === "paid"
        ? { text: a.pay.total != null ? `Pagado ${fmtL(a.pay.total)}` : "Pagado", cls: "text-emerald-300/80" }
        : a.pay.state === "verify"
          ? { text: "por verificar", cls: "text-rose-300/80" }
          : { text: "depósito · falta definir total", cls: "text-amber-300/80" };

  return (
    <button
      type="button"
      onClick={onExpand}
      className="w-full text-left rounded-xl border border-white/8 bg-white/[0.015] px-3.5 py-2.5 hover:bg-white/[0.04] transition"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <span className="text-sm font-medium text-slate-200 truncate">{r.guest_name || "Huésped sin nombre"}</span>
          <span className={`text-[9px] px-1 py-0.5 rounded border shrink-0 ${sm.cls}`}>{sm.emoji}</span>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded-full border shrink-0 text-slate-400 border-white/10 bg-white/5">{a.stayText}</span>
      </div>
      <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-500 flex-wrap">
        <span className="truncate">{prop?.name ?? r.property_slug}</span>
        <span className="text-slate-700">·</span>
        <span>{fmtDate(r.check_in)}→{fmtDate(r.check_out)}</span>
        <span className="text-slate-700">·</span>
        <span className={payChip.cls}>{payChip.text}</span>
        <span className="text-slate-700">·</span>
        <span className={avisos.cls}>{avisos.text}</span>
        {!r.guest_phone && <span className="text-rose-300/80">· sin #</span>}
        <span className="ml-auto text-slate-600">ver ▾</span>
      </div>
    </button>
  );
}
