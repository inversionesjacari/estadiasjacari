"use client";
//
// /inbox/operacion — Centro de Control (operación en tiempo real).
// Estilo "command center": tema oscuro, glow neón, números mono, diagrama vivo.
// Lee /api/inbox/metrics cada 10s. Protegido con la cookie de sesión del inbox.
//

import { useEffect, useState, useCallback, useRef, type ReactNode } from "react";
import { BRAND_PATHS, BRAND_FILL, GOOGLE_G, JACARI_PATH, ROBOT_PATH } from "./brand-logos";

const PROPERTY_NAMES: Record<string, string> = {
  "villa-b11-palma-real": "Villa B11",
  "casa-brisa": "Casa Brisa",
  "casa-marea": "Casa Marea",
  "centro-morazan": "Centro Morazán",
  "casa-lara-townhouse": "Casa Lara",
  "la-florida": "La Florida",
  "las-gemelas-tela": "Las Gemelas (Brisa + Marea)",
};

const SOURCE_NAMES: Record<string, string> = {
  website: "Sitio web",
  whatsapp_bot: "Bot WhatsApp (tarjeta)",
  whatsapp_transfer: "Transferencia",
  airbnb: "Airbnb",
  airbnb_ical: "Airbnb",
  manual: "Manual",
};

const REFERRER_NAMES: Record<string, string> = {
  "(directo)": "Directo / sin origen",
  // Referrers (document.referrer)
  "instagram.com": "Instagram",
  "l.instagram.com": "Instagram",
  "facebook.com": "Facebook",
  "l.facebook.com": "Facebook",
  "m.facebook.com": "Facebook",
  "lm.facebook.com": "Facebook",
  "l.wl.co": "WhatsApp",
  "google.com": "Google",
  "www.google.com": "Google",
  "t.co": "X / Twitter",
  "bing.com": "Bing",
  "duckduckgo.com": "DuckDuckGo",
  "linkedin.com": "LinkedIn",
  "youtube.com": "YouTube",
  "tiktok.com": "TikTok",
  "wa.me": "WhatsApp",
  "api.whatsapp.com": "WhatsApp",
  // UTM sources (los pone la pauta → atribución confiable)
  instagram: "Instagram",
  ig: "Instagram",
  facebook: "Facebook",
  fb: "Facebook",
  meta: "Meta (FB/IG)",
  google: "Google",
  tiktok: "TikTok",
  whatsapp: "WhatsApp",
  email: "Email",
};

// Emoji por origen para que el panel se lea de un vistazo.
const SOURCE_ICON: Record<string, string> = {
  "Directo / sin origen": "❓", Directo: "🔗", Instagram: "📸", Facebook: "👍",
  "Meta (FB/IG)": "📱", Google: "🔎", "X / Twitter": "𝕏", Bing: "🔎",
  DuckDuckGo: "🦆", LinkedIn: "💼", YouTube: "▶️", TikTok: "🎵",
  WhatsApp: "💬", Email: "✉️",
};

// Nombre legible de una ruta del sitio: "/" → Inicio, /propiedades/<slug> → nombre.
function pageLabel(path: string): string {
  if (path === "/") return "Inicio";
  if (path === "/propiedades") return "Todas las propiedades";
  const m = path.match(/^\/propiedades\/(.+)$/);
  if (m) return PROPERTY_NAMES[m[1]] ?? m[1].replace(/-/g, " ");
  return path;
}
function sourceLabel(ref: string): string {
  return REFERRER_NAMES[ref] ?? ref.replace(/^www\./, "");
}
const MES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
function monthLabel(prefix: string): string {
  const [y, mo] = prefix.split("-").map(Number);
  return `${MES_ES[(mo || 1) - 1]} ${y}`;
}
// Desplaza un prefijo YYYY-MM por delta meses (para el selector ‹ ›).
function shiftMonth(prefix: string, delta: number): string {
  const [y, mo] = prefix.split("-").map(Number);
  const d = new Date(Date.UTC(y || 2026, (mo || 1) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const fmtHnl = (n: number) => `L ${Math.round(n).toLocaleString("en-US")}`;

// Registro de cambios / mejoras del sistema (curado a mano; lo más nuevo arriba).
// Se muestra al final del Centro de Control como bitácora visible del equipo.
const CHANGELOG: { date: string; items: string[] }[] = [
  {
    date: "15 jun 2026",
    items: [
      "Bot: las fechas ahora las resuelve CÓDIGO, no la IA — un parser determinístico entiende “mañana”, “17 de julio”, “4 noches” y nunca acepta una fecha pasada (mata la clase de bug que más nos hizo afinar). Blindado con una suite de 47 tests que corre antes de cada deploy.",
      "Centro de Control: panel nuevo 📊 Categorías de fallo — muestra agrupado dónde falla el bot (tipo de problema del QA, trazas técnicas, y por qué regla escala a humano) para arreglar la categoría más grande primero, en vez de chat por chat.",
      "Registro de reservas: las reservas por transferencia ahora se guardan en Lempiras (antes salían en $); y una reserva sin el pago cargado deja de decir “Pagado” en falso — muestra “Falta cargar pago” hasta que cargues total y pagado con 💲 Pago.",
      "Inbox: una reserva de la web sin chat (pagada por PayPal, como un huésped de EE.UU.) ya no muestra “Bot activo” — ahora dice “Sin mensajes aún”, para no confundir.",
    ],
  },
  {
    date: "13 jun 2026",
    items: [
      "Centro de Control: panel nuevo 🏘️ Métricas por propiedad — ocupación % del mes por casa (reservas directas + Airbnb vía iCal) e ingresos directos del mes, con totales. Por fin se ve, de un vistazo, qué propiedades están llenas y cuánto generan en directo.",
    ],
  },
  {
    date: "9 jun 2026",
    items: [
      "Inbox: ahora se ven las notas de voz 🎧, imágenes y comprobantes de pago que mandan los clientes (antes se descartaban). Las fotos que manda el bot se ven como imágenes. Y podés adjuntar y enviar tus propias imágenes/videos al cliente con el botón 📎.",
      "Tráfico web: tablero rediseñado — visitas de hoy vs ayer, visitantes únicos, “en vivo ahora”, tendencia de los últimos 7 días, páginas con nombres legibles (Casa Brisa en vez de /propiedades/casa-brisa) y de dónde llegan incluyendo el tráfico directo con su %.",
    ],
  },
  {
    date: "8 jun 2026",
    items: [
      "Bot: cuando un humano toma la conversación (responde a mano o aprieta “Pausar bot”) el bot se pausa y queda en tu control; se reactiva a mano con “Reactivar bot”. Ahora con indicador BIEN visible del estado — verde “responde solo” / ámbar “en pausa, le respondés vos” — en la cabecera y en la lista de conversaciones, para saber de un vistazo si el bot está respondiendo o no.",
      "Inbox: la barra de estado del bot ahora ocupa TODO el ancho de la conversación (verde activo / ámbar en pausa) — imposible de no ver. Y nueva columna “Pendientes / Seguimiento” a la derecha que agrupa los chats que requieren acción: en pausa (te esperan), escalados, esperando pago/comprobante y sin responder hace +30 min — clic para abrir el chat. Aprovecha el espacio y evita que se cuelgue alguien.",
      "Bot: reglas de alcance — solo ofrece nuestras propiedades; lo que está fuera de alcance lo redirige al WhatsApp directo; dejó de inventar ubicaciones.",
      "Bot: aviso por email + etiqueta “escalado” en el inbox cada vez que escala.",
      "Bot: ante un glitch técnico ya no manda un mensaje raro ni promete un humano — se queda callado y se recupera en el siguiente mensaje.",
      "QA del bot: panel que analiza las conversaciones con IA, detecta fallos (inventos, frustración, ventas perdidas…) y sugiere el fix. Botón “Analizar ahora”, revisión diaria, botón “Resuelto” por hallazgo (incremental: lo resuelto no reaparece) y el tiempo de cada caso.",
      "Bot: blindado contra inventar datos bancarios — cuando piden la cuenta para transferir, manda los datos EXACTOS del sistema (antes había alucinado un número de cuenta falso).",
      "Transferencias: corregido el titular de la cuenta BAC en Lempiras → “Inversiones Jacarí S. de R.L.” (tal cual aparece en el banco).",
      "Seguimiento: el bot ahora también hace nudge si quedó pendiente la transferencia o el pago con el link de PayPal (antes solo seguía las cotizaciones a medias).",
      "Bot: el redirect fuera de alcance ahora sale en el idioma del cliente y de forma fija (antes le respondió en español a un cliente que escribía en inglés).",
      "Bot: arreglado un bug de estado — al hacer una pregunta después de la cotización, ya no “olvida” que ya cotizó (mantiene el estado), así el seguimiento automático sale correcto.",
      "Ingresos: captura del ingreso de Airbnb en vivo vía PayPal (Transaction Search), separado del directo.",
      "Diagrama: rediseño — zona “ORIGEN”, logos de marca (Google a 4 colores, Jacarí, BAC), Airbnb como canal con “Viajeros”, dinero consolidado y líneas más nítidas.",
      "KPIs: cada tarjeta muestra Hoy / 7 días / 30 días.",
    ],
  },
  {
    date: "7 jun 2026",
    items: [
      "Centro de Control creado: KPIs, embudo de ventas, salud de sistemas, diagrama de operación en vivo y tráfico web.",
      "Diagrama: cuenta el proceso del negocio y asume los sistemas activos (rojo solo ante falla real).",
      "Bot conversacional con IA (Workers AI · Llama 3.3): cotiza, verifica disponibilidad real, recuerda el hilo y usa una base de conocimiento editable.",
      "Fix del seguimiento automático: reintenta si WhatsApp falla, sin quemar el seguimiento.",
    ],
  },
];

interface Metrics {
  generatedAt: string;
  messages: { todayIn: number; todayOut: number; weekIn: number; weekOut: number; today: number; week: number; month: number };
  conversations: { today: number; week: number; month: number };
  funnel: { awaitingData: number; quoteProvided: number; awaitingPaymentMethod: number; awaitingPaypal: number; awaitingTransfer: number; total: number };
  conversionFunnel?: {
    leadsNew: number; leadsQuoted: number; leadsQuotedPct: number;
    leadsPaid: number; leadsPaidPct: number;
    medianFirstResponseMin: number | null;
    followupSent: number; followupStillInterested: number; followupDeclined: number; followupNoResponse: number; followupEffectivenessPct: number;
    revenueByOrigin: { origin: string; revenue: number; reservas: number }[];
  };
  reservations: { today: number; week: number; month: number; byProperty: { slug: string; c: number }[]; bySource: { source: string; c: number }[] };
  revenue: { direct: { today: number; week: number; month: number }; airbnb: { today: number | null; week: number | null; month: number | null } };
  // Ingreso del mes seleccionado, monedas separadas (por check-in). Es lo que muestra la KPI.
  revenueMonth?: { usd: number; hnl: number; usdAirbnb: number; usdDirect: number; reservas: number };
  availableMonths?: string[];
  marketing?: {
    contacts: number;
    webViews: number;
    webUniques: number;
    sources: { referrer: string; c: number }[];
    topProperties: { path: string; c: number }[];
    directBySource: { source: string; confirmed: number; total: number }[];
    directByProperty: { slug: string; total: number }[];
    airbnbStays: number;
    wonBySource?: { source: string; total: number }[];
    wonByProperty?: { slug: string; total: number }[];
    leadsByAd?: { ad: string; c: number }[];
    funnelByProperty?: { slug: string; webViews: number; waInquiries: number; resAirbnb: number; resDirect: number }[];
    outcomes?: { outcome: string; c: number }[];
  };
  porPropiedad?: { slug: string; revenueMonth: number; revenueHnlMonth?: number; reservasMonth: number; occupancyPct: number | null; nightsBooked: number; adrUsd?: number | null; airbnbSync: string }[];
  mes?: { prefix: string; dias: number };
  health: { lastInAt: string | null; lastOutAt: string | null; lastReservationAt: string | null; cronLastAt: string | null; airbnbStatus: "full" | "partial" | "unavailable" | "unknown"; botLlmErrorAt: string | null; botMudoAt: string | null; waFailed24h?: number; ownerAlertOkAt?: string | null; ownerAlertFailAt?: string | null };
  // 📬 Salud de entrega WhatsApp (qué mandó el bot, qué llegó y qué falta).
  delivery?: {
    d7: { total: number; deliveredPct: number | null; readPct: number | null; failed: number; pending: number };
    d30: { total: number; deliveredPct: number | null; readPct: number | null; failed: number; pending: number };
    failures: { at: string; to: string; rule: string; code: number | null; reason: string }[];
    stuck: { at: string; to: string; rule: string }[];
    pendingCheckins: { id: number; property: string; guest: string; checkIn: string; state: "sin_enviar" | "fallo"; error: string | null }[];
  };
  botHealth: { inbound: number; botReplies: number; manualReplies: number; escalations: number; fails: number; escalationPct: number };
  trend: { day: string; c: number }[];
  feed: { type: "message" | "reservation"; at: string; text: string; tag?: string }[];
  web?: {
    viewsToday: number; uniqueToday: number; viewsYesterday: number;
    viewsWeek: number; uniqueWeek: number; now: number;
    topPages: { path: string; c: number }[];
    sources: { referrer: string; c: number }[];
    trend: { day: string; views: number; uniques: number }[];
  };
  qa?: {
    lastRun: { ranAt: string | null; analyzed: number; found: number; trigger: string | null } | null;
    findings: { id: number; phone: string; issue: string; severity: string; detail: string; suggestion: string; conv_at: string | null }[];
  };
  failures?: {
    byIssue: { issue: string; c: number; alta: number }[];
    byStage: { stage: string; c: number }[];
    byRule: { rule: string; c: number }[];
    escalationPct: number;
  };
}

// Etiquetas legibles para las trazas técnicas del bot (bot_trace.stage).
// DATE_PARSER_FIX es "bueno": mide cuánto está corrigiendo el parser de fechas nuevo.
const STAGE_META: Record<string, { label: string; hex: string }> = {
  LLM_GLITCH: { label: "IA falló (glitch)", hex: "#f87171" },
  THREW: { label: "Excepción", hex: "#ef4444" },
  PRE_LLM: { label: "Pre-IA", hex: "#94a3b8" },
  DATE_PARSER_FIX: { label: "Fechas corregidas por el parser", hex: "#34d399" },
};

// Etiquetas legibles para las reglas de mensajes salientes (📬 Salud de entrega).
const RULE_LABELS: Record<string, string> = {
  checkin_reminder: "Instrucciones de check-in (PDF)",
  tpl_checkin_dia_huesped: "Aviso día de check-in (huésped)",
  tpl_checkout_dia_huesped: "Aviso día de check-out (huésped)",
  tpl_confirmacion_whatsapp_capturado: "Confirmación de reserva",
  tpl_checkin_dia_limpieza: "Aviso a limpieza (check-in)",
  tpl_checkout_dia_limpieza: "Aviso a limpieza (check-out)",
  tpl_checkin_dia_seguridad: "Aviso a seguridad",
  auto_followup: "Seguimiento automático",
  last_call: "Último aviso",
  last_call_redirect: "Último aviso (otras fechas)",
  manual_inbox: "Respuesta manual del inbox",
  template_directo: "Template directo (alerta/aviso)",
  quote_provided: "Cotización",
  bot_gathering_data: "Bot pidiendo datos",
  property_card_proactive: "Tarjeta de propiedad",
  photos_sent: "Fotos de la propiedad",
};
const ruleLabel = (rule: string): string => RULE_LABELS[rule] ?? rule;

// ── Helpers de tiempo / salud ────────────────────────────────────────────────
function parseUtc(iso: string | null): number {
  if (!iso) return NaN;
  return new Date(iso.replace(" ", "T") + "Z").getTime();
}
function timeAgo(iso: string | null): string {
  const t = parseUtc(iso);
  if (Number.isNaN(t)) return "—";
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return "ahora";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}
const HEX = { green: "#34d399", amber: "#fbbf24", red: "#f87171", gray: "#64748b", cyan: "#22d3ee" };
// Los sistemas corren 24/7. Asumimos verde por default y solo marcamos rojo si
// detectamos una falla real (Airbnb reporta "unavailable" o el cron lleva > 60
// min sin latido). La ausencia de mensajes/reservas NO es una falla.
function recencyHex(_iso: string | null, _hoursGreen = 24): string {
  return HEX.green;
}
function cronHex(iso: string | null): string {
  const t = parseUtc(iso);
  if (Number.isNaN(t)) return HEX.green;
  return (Date.now() - t) / 60000 <= 60 ? HEX.green : HEX.red;
}
function airbnbHex(s: string): string {
  return s === "unavailable" ? HEX.red : HEX.green;
}
// Bot IA en ROJO si el LLM (Workers AI) registró un error en los últimos 20 min
// (el webhook escribe el latido 'bot_llm_error' al caer en bot_glitch_silent) O
// si el watchdog detectó un cliente sin respuesta hace poco ('bot_mudo', pista B2
// — corre cada 30 min, por eso la ventana es más ancha que la del LLM). Sin
// ninguna señal reciente → verde (se asume recuperado / operando normal).
function botHex(llmErrorAt: string | null, mudoAt: string | null): string {
  const llm = parseUtc(llmErrorAt);
  if (!Number.isNaN(llm) && (Date.now() - llm) / 60000 <= 20) return HEX.red;
  const mudo = parseUtc(mudoAt);
  if (!Number.isNaN(mudo) && (Date.now() - mudo) / 60000 <= 45) return HEX.red;
  return HEX.green;
}
// Texto de detalle de la card "Bot IA": prioriza la señal MÁS reciente entre falla
// de LLM y bot mudo (pueden coexistir); verde → última respuesta normal del bot.
function botDetail(llmErrorAt: string | null, mudoAt: string | null, lastOutAt: string | null): string {
  const llm = parseUtc(llmErrorAt);
  const mudo = parseUtc(mudoAt);
  const llmLive = !Number.isNaN(llm) && (Date.now() - llm) / 60000 <= 20;
  const mudoLive = !Number.isNaN(mudo) && (Date.now() - mudo) / 60000 <= 45;
  if (llmLive && mudoLive) return llm >= mudo ? `⚠ falla IA · ${timeAgo(llmErrorAt)}` : `⚠ sin responder · ${timeAgo(mudoAt)}`;
  if (llmLive) return `⚠ falla IA · ${timeAgo(llmErrorAt)}`;
  if (mudoLive) return `⚠ sin responder · ${timeAgo(mudoAt)}`;
  return `últ. ${timeAgo(lastOutAt)}`;
}
function isLive(iso: string | null, minutes = 10): boolean {
  const t = parseUtc(iso);
  return !Number.isNaN(t) && (Date.now() - t) / 60000 <= minutes;
}
// 📬 Entrega WhatsApp: verde sin fallos 24h, ámbar 1-2 (fallos sueltos, típico
// re-engagement fuera de ventana), rojo ≥3 (huele a problema sistémico).
function deliveryHex(failed24h: number | undefined): string {
  const n = failed24h ?? 0;
  if (n === 0) return HEX.green;
  return n <= 2 ? HEX.amber : HEX.red;
}
// Canal de avisos a dueños: rojo si el último fallo es MÁS reciente que el último
// ok (canal caído); gris si nunca hubo actividad; verde si el último intento salió.
function ownerAlertHex(okAt: string | null | undefined, failAt: string | null | undefined): string {
  const ok = parseUtc(okAt ?? null);
  const fail = parseUtc(failAt ?? null);
  if (Number.isNaN(ok) && Number.isNaN(fail)) return HEX.gray;
  if (Number.isNaN(ok)) return HEX.red;
  if (Number.isNaN(fail)) return HEX.green;
  return fail > ok ? HEX.red : HEX.green;
}
const AIRBNB_LABEL: Record<string, string> = {
  full: "Sincronizado", partial: "Sincronizado", unavailable: "No responde", unknown: "Sincronizado",
};

// Animación suave de números (count-up con easeOut)
function useCountUp(target: number): number {
  const [val, setVal] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    const start = prev.current;
    const diff = target - start;
    if (diff === 0) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - t0) / 700, 1);
      setVal(Math.round(start + diff * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return val;
}

export default function OperacionPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [pulse, setPulse] = useState(false);
  const [clock, setClock] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [runningQa, setRunningQa] = useState(false);
  // Mes seleccionado (null = mes actual). Solo afecta Reservas/Ingresos/por-propiedad.
  const [month, setMonth] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/inbox/metrics${month ? `?month=${month}` : ""}`);
      if (res.status === 401) { setAuthed(false); return; }
      const data = (await res.json()) as Metrics & { ok: boolean };
      if (data.ok) {
        setAuthed(true);
        setMetrics(data);
        setPulse(true);
        setTimeout(() => setPulse(false), 700);
      }
    } catch { /* keep previous */ }
  }, [month]);

  // Dispara el análisis de QA del bot (botón "Analizar ahora") y recarga.
  const runQa = useCallback(async () => {
    setRunningQa(true);
    try {
      await fetch("/api/inbox/bot-qa-run", { method: "POST", credentials: "include" });
      await load();
    } catch { /* ignore */ } finally {
      setRunningQa(false);
    }
  }, [load]);

  // Auto-clasifica el desenlace de los chats (reservó/cotizó/… ) sin pisar lo manual.
  const [classifying, setClassifying] = useState(false);
  const [classifyMsg, setClassifyMsg] = useState("");
  const runClassify = useCallback(async () => {
    setClassifying(true);
    setClassifyMsg("");
    try {
      const r = await fetch("/api/inbox/conversation-autotag", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: 40 }) });
      const d = await r.json().catch(() => ({})) as { ok?: boolean; deterministic?: number; llm?: number; candidates?: number };
      if (d.ok) setClassifyMsg(`✓ ${(d.deterministic ?? 0) + (d.llm ?? 0)} clasificados (${d.deterministic ?? 0} por reserva, ${d.llm ?? 0} por IA)${(d.candidates ?? 0) >= 40 ? " · corré de nuevo para seguir" : ""}`);
      else setClassifyMsg("Error al clasificar");
      await load();
    } catch { setClassifyMsg("Error de red"); } finally {
      setClassifying(false);
    }
  }, [load]);

  // Marca un hallazgo de QA como resuelto (lo borra) y recarga. Como el análisis
  // es incremental, no reaparece salvo que el cliente vuelva a escribir.
  const resolveFinding = useCallback(async (id: number) => {
    try {
      await fetch("/api/inbox/bot-qa-resolve", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await load();
    } catch { /* ignore */ }
  }, [load]);

  useEffect(() => {
    load();
    timer.current = setInterval(load, 10000);
    const c = setInterval(() => setClock(new Date().toLocaleTimeString("es-HN")), 1000);
    return () => { if (timer.current) clearInterval(timer.current); clearInterval(c); };
  }, [load]);

  if (authed === false) {
    return (
      <div className="min-h-screen bg-[#070b16] flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-8 text-center">
          <h1 className="font-display text-2xl text-white mb-2">Sesión requerida</h1>
          <p className="text-slate-400 text-sm mb-6">Iniciá sesión para ver el centro de control.</p>
          <a href="/inbox" className="inline-block bg-cyan-500 text-slate-900 font-semibold px-5 py-2.5 rounded-lg hover:bg-cyan-400 transition">Ir a iniciar sesión</a>
        </div>
      </div>
    );
  }
  if (authed === null || !metrics) {
    return (
      <div className="min-h-screen bg-[#070b16] flex items-center justify-center">
        <p className="text-cyan-400 font-mono animate-pulse">› Conectando con la operación…</p>
      </div>
    );
  }

  const m = metrics;

  // Reservas + ingresos del MES seleccionado, por check-in. Ingreso con monedas
  // SEPARADAS (nunca sumadas). El mes lo maneja el selector del header.
  const rm = m.revenueMonth ?? { usd: 0, hnl: 0, usdAirbnb: 0, usdDirect: 0, reservas: 0 };
  const curMonthPrefix = m.mes?.prefix ?? "";

  return (
    <div className="min-h-screen bg-[#070b16] text-slate-200" style={{ backgroundImage: "radial-gradient(circle at 20% 0%, rgba(34,211,238,0.06), transparent 40%), radial-gradient(circle at 90% 10%, rgba(45,212,191,0.05), transparent 35%)" }}>
      {/* Header */}
      <header className="border-b border-white/10 px-5 py-3 flex items-center justify-between sticky top-0 z-10 bg-[#070b16]/80 backdrop-blur">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2.5 tracking-tight">
            🛰️ Centro de control
            <span className="flex items-center gap-1 text-[10px] font-semibold text-green-400 border border-green-500/40 rounded-full px-2 py-0.5">
              <span className={`w-1.5 h-1.5 rounded-full bg-green-400 ${pulse ? "opacity-100" : "opacity-50"}`} />
              EN VIVO
            </span>
          </h1>
          <p className="text-[12px] text-slate-400">Estadías Jacarí · {clock}</p>
        </div>
        <div className="flex items-center gap-2">
          <a href="https://app.estadiasjacari.com" target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 border border-amber-400/30 bg-amber-400/5 rounded-lg hover:bg-amber-400/10 text-amber-200 text-sm whitespace-nowrap">📒 Contabilidad ↗</a>
          <a href="/inbox" className="px-3 py-1.5 border border-white/15 rounded-lg hover:bg-white/5 text-slate-300 text-sm">← Inbox</a>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 space-y-5">
        {/* Selector de mes — controla Reservas, Ingresos y las métricas por propiedad */}
        <section className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <button onClick={() => setMonth(shiftMonth(curMonthPrefix, -1))} className="w-8 h-8 rounded-lg border border-white/15 text-slate-300 hover:bg-white/5 flex items-center justify-center" aria-label="Mes anterior">‹</button>
            <span className="text-sm font-semibold text-white min-w-[8.5rem] text-center capitalize">{monthLabel(curMonthPrefix)}</span>
            <button onClick={() => setMonth(shiftMonth(curMonthPrefix, +1))} className="w-8 h-8 rounded-lg border border-white/15 text-slate-300 hover:bg-white/5 flex items-center justify-center" aria-label="Mes siguiente">›</button>
            {month && <button onClick={() => setMonth(null)} className="ml-1 text-xs text-cyan-400 hover:text-cyan-300 px-2 py-1">↩ mes actual</button>}
          </div>
          <span className="text-[11px] text-slate-500">Reservas e ingresos = llegadas (check-in) del mes</span>
        </section>

        {/* KPIs — Mensajes/Conversaciones: actividad reciente · Reservas/Ingresos: mes seleccionado */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi icon="📨" label="Mensajes" hoy={m.messages.today} week={m.messages.week} month={m.messages.month} glow={HEX.cyan} />
          <Kpi icon="💬" label="Conversaciones" hoy={m.conversations.today} week={m.conversations.week} month={m.conversations.month} glow="#a78bfa" />
          <MonthKpi icon="🏠" label="Reservas" sub="llegadas del mes" glow={HEX.green}>
            <div className="font-mono font-bold text-3xl leading-none" style={{ color: HEX.green, textShadow: `0 0 14px ${HEX.green}55` }}>{rm.reservas.toLocaleString("en-US")}</div>
          </MonthKpi>
          <MoneyKpi usd={rm.usd} hnl={rm.hnl} usdDirect={rm.usdDirect} usdAirbnb={rm.usdAirbnb} glow={HEX.amber} />
        </section>

        {/* Reporte para marketing / pauta (mes seleccionado) */}
        {m.marketing && <MarketingReport mk={m.marketing} monthPrefix={curMonthPrefix} onClassify={runClassify} classifying={classifying} classifyMsg={classifyMsg} />}

        {/* Diagrama protagonista */}
        <section className="rounded-2xl border border-cyan-500/20 bg-[#0a1120] p-5 shadow-[0_0_40px_rgba(34,211,238,0.06)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-white tracking-tight">Operación en vivo</h2>
            <span className="text-[11px] text-slate-400">flujo de datos en tiempo real</span>
          </div>
          <ArchitectureDiagram health={m.health} />
        </section>

        {/* Salud + Embudo */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Panel title="🩺 Salud de sistemas">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <HealthItem hex={recencyHex(m.health.lastInAt)} label="WhatsApp" detail={`últ. ${timeAgo(m.health.lastInAt)}`} />
              <HealthItem hex={botHex(m.health.botLlmErrorAt, m.health.botMudoAt)} label="Bot IA" detail={botDetail(m.health.botLlmErrorAt, m.health.botMudoAt, m.health.lastOutAt)} />
              <HealthItem hex={airbnbHex(m.health.airbnbStatus)} label="Airbnb" detail={AIRBNB_LABEL[m.health.airbnbStatus]} />
              <HealthItem hex={cronHex(m.health.cronLastAt)} label="Seguimientos" detail={`últ. ${timeAgo(m.health.cronLastAt)}`} />
              <HealthItem hex={recencyHex(m.health.lastReservationAt, 24 * 30)} label="Reservas / PayPal" detail={`últ. ${timeAgo(m.health.lastReservationAt)}`} />
              <HealthItem hex={HEX.green} label="Base de datos" detail="operativa" />
              <HealthItem
                hex={deliveryHex(m.health.waFailed24h)}
                label="Entrega WhatsApp"
                detail={(m.health.waFailed24h ?? 0) === 0 ? "sin fallos 24h" : `${m.health.waFailed24h} fallo${(m.health.waFailed24h ?? 0) === 1 ? "" : "s"} 24h`}
              />
              <HealthItem
                hex={ownerAlertHex(m.health.ownerAlertOkAt, m.health.ownerAlertFailAt)}
                label="Avisos a dueños"
                detail={
                  ownerAlertHex(m.health.ownerAlertOkAt, m.health.ownerAlertFailAt) === HEX.red
                    ? `⚠ fallando · ${timeAgo(m.health.ownerAlertFailAt ?? null)}`
                    : m.health.ownerAlertOkAt
                      ? `últ. ok ${timeAgo(m.health.ownerAlertOkAt)}`
                      : "sin actividad"
                }
              />
            </div>
          </Panel>

          <Panel title="🪙 Embudo de ventas" subtitle={`${m.funnel.total} activas ahora`}>
            <div className="space-y-2.5">
              <FunnelStep label="Esperando datos" value={m.funnel.awaitingData} total={m.funnel.total} hex={HEX.cyan} />
              <FunnelStep label="Cotización enviada" value={m.funnel.quoteProvided} total={m.funnel.total} hex={HEX.amber} />
              <FunnelStep label="Eligiendo pago" value={m.funnel.awaitingPaymentMethod} total={m.funnel.total} hex="#fb923c" />
              <FunnelStep label="Esperando PayPal" value={m.funnel.awaitingPaypal} total={m.funnel.total} hex="#60a5fa" />
              <FunnelStep label="Esperando comprobante" value={m.funnel.awaitingTransfer} total={m.funnel.total} hex={HEX.green} />
            </div>
            {m.funnel.total === 0 && <p className="text-center text-slate-500 text-sm py-3">Sin conversaciones en proceso ahora. 🌴</p>}
          </Panel>
        </section>

        {/* Conversión del bot (30d) — línea base, pista B3. Todas las cifras salen
            de tablas ya existentes (whatsapp_messages, reservations, conversation_state,
            whatsapp_lead_source); nada de tablas ni dashboards nuevos. */}
        {m.conversionFunnel && (
          <Panel title="🎯 Conversión del bot · 30 días" subtitle="línea base para medir las próximas mejoras">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
              <WebStat label="Leads nuevos" value={m.conversionFunnel.leadsNew} foot={<span className="text-slate-500">primer mensaje en la ventana</span>} />
              <WebStat label="Cotizados" value={m.conversionFunnel.leadsQuotedPct} foot={<span className="text-slate-500">{m.conversionFunnel.leadsQuoted} de {m.conversionFunnel.leadsNew} · %</span>} />
              <WebStat label="Pagaron" value={m.conversionFunnel.leadsPaidPct} foot={<span className="text-slate-500">{m.conversionFunnel.leadsPaid} de {m.conversionFunnel.leadsNew} · %</span>} />
              <WebStat label="1ra respuesta" value={m.conversionFunnel.medianFirstResponseMin ?? 0} foot={<span className="text-slate-500">{m.conversionFunnel.medianFirstResponseMin === null ? "sin datos" : "min · mediana"}</span>} />
              <WebStat label="Followups: siguen interesados" value={m.conversionFunnel.followupEffectivenessPct} foot={<span className="text-slate-500">{m.conversionFunnel.followupStillInterested} de {m.conversionFunnel.followupSent} · {m.conversionFunnel.followupDeclined} rechazó · {m.conversionFunnel.followupNoResponse} sin responder</span>} />
            </div>
            {m.conversionFunnel.revenueByOrigin.length > 0 && (
              <BarList
                title="Revenue por origen del lead (ad de WhatsApp)"
                rows={m.conversionFunnel.revenueByOrigin.map((r) => ({ label: r.origin, value: Math.round(r.revenue) }))}
                empty="Sin reservas con origen de ad este período."
                hex={HEX.amber}
              />
            )}
            {m.conversionFunnel.leadsNew === 0 && <p className="text-center text-slate-500 text-sm py-3">Sin leads nuevos en los últimos 30 días. 🌴</p>}
          </Panel>
        )}

        {/* 📬 Salud de entrega WhatsApp — qué mandó el bot, qué llegó y qué falta.
            Fuentes: whatsapp_messages.status (checks del callback de Meta) +
            bot_trace WA_DELIVERY_FAILED (motivo exacto) + reservations (check-ins
            próximos sin instrucciones). Ver functions/api/inbox/metrics.ts. */}
        {m.delivery && (
          <Panel title="📬 Salud de entrega WhatsApp" subtitle="qué mandó el bot, qué llegó y qué falta">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
              <WebStat label="Enviados · 7 días" value={m.delivery.d7.total} foot={<span className="text-slate-500">{m.delivery.d30.total} en 30 días</span>} />
              <WebStat label="% Entregado" value={m.delivery.d7.deliveredPct ?? 0} foot={<span className="text-slate-500">{m.delivery.d7.deliveredPct === null ? "sin datos" : "llegó al teléfono · 7d"}</span>} />
              <WebStat label="% Leído" value={m.delivery.d7.readPct ?? 0} foot={<span className="text-slate-500">{m.delivery.d7.readPct === null ? "sin datos" : "checks azules · 7d"}</span>} />
              <WebStat label="Fallidos · 7 días" value={m.delivery.d7.failed} foot={<span className="text-slate-500">{m.delivery.d30.failed} en 30 días</span>} />
              <WebStat label="En tránsito" value={m.delivery.d7.pending} foot={<span className="text-slate-500">aceptados, sin confirmar</span>} />
            </div>

            {/* Qué está haciendo falta — accionable: check-ins próximos sin instrucciones */}
            <div className="rounded-xl bg-white/[0.02] border border-white/5 p-3 mb-3">
              <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wider mb-2">⚠️ Qué está haciendo falta</p>
              {m.delivery.pendingCheckins.length === 0 ? (
                <p className="text-center text-slate-500 text-sm py-2">Todos los check-ins próximos tienen sus instrucciones enviadas. 🌴</p>
              ) : (
                <div className="space-y-1.5">
                  {m.delivery.pendingCheckins.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-slate-300 truncate">
                        {p.guest} · <span className="text-slate-400">{p.property}</span> · check-in {p.checkIn}
                      </span>
                      {p.state === "fallo" ? (
                        <span className="shrink-0 text-red-300 text-[12px]" title={p.error ?? undefined}>⚠ falló el envío</span>
                      ) : (
                        <span className="shrink-0 text-amber-300 text-[12px]">sin enviar aún</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Fallos recientes con motivo legible */}
            <div className="rounded-xl bg-white/[0.02] border border-white/5 p-3">
              <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wider mb-2">Fallos recientes · 30 días</p>
              {m.delivery.failures.length === 0 ? (
                <p className="text-center text-slate-500 text-sm py-2">Ningún mensaje falló en los últimos 30 días. ✅</p>
              ) : (
                <div className="space-y-1.5">
                  {m.delivery.failures.map((f, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-slate-300 truncate">
                        <span className="text-slate-500">{timeAgo(f.at)} ·</span> {f.to || "—"} · {ruleLabel(f.rule)}
                      </span>
                      <span className="shrink-0 text-red-300/90 text-[12px]" title={f.code ? `código Meta ${f.code}` : undefined}>{f.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Atascados: Meta los aceptó pero nunca los entregó (>24h) */}
            {m.delivery.stuck.length > 0 && (
              <div className="rounded-xl bg-white/[0.02] border border-white/5 p-3 mt-3">
                <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wider mb-2">Atascados (aceptados hace &gt;24h, nunca entregados)</p>
                <div className="space-y-1.5">
                  {m.delivery.stuck.map((s, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-slate-300 truncate"><span className="text-slate-500">{timeAgo(s.at)} ·</span> {s.to} · {ruleLabel(s.rule)}</span>
                      <span className="shrink-0 text-amber-300 text-[12px]">probable número sin WhatsApp</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Panel>
        )}

        {/* Tráfico web */}
        {m.web && (
          <Panel title="🌐 Tráfico web" subtitle={m.web.now > 0 ? `🟢 ${m.web.now} ${m.web.now === 1 ? "persona navegando" : "personas navegando"} ahora` : "visitas al sitio"}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <WebStat label="Visitas hoy" value={m.web.viewsToday} foot={<Delta today={m.web.viewsToday} prev={m.web.viewsYesterday} />} />
              <WebStat label="Visitantes únicos" value={m.web.uniqueToday} foot={<span className="text-slate-500">personas distintas hoy</span>} />
              <WebStat label="En vivo ahora" value={m.web.now} live />
              <WebStat label="Visitas · 7 días" value={m.web.viewsWeek} foot={<span className="text-slate-500">{m.web.uniqueWeek.toLocaleString("en-US")} únicos</span>} />
            </div>
            <div className="rounded-xl bg-white/[0.02] border border-white/5 p-3 mb-4">
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wider">Tendencia · últimos 7 días</p>
                <p className="text-[10px] text-slate-500">vistas por día</p>
              </div>
              <WebTrend data={m.web.trend} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <BarList
                title="Páginas más vistas (hoy)"
                rows={m.web.topPages.map((p) => ({ label: pageLabel(p.path), value: p.c }))}
                empty="Sin visitas hoy todavía."
                hex={HEX.cyan}
              />
              <BarList
                title="De dónde llegan (7 días)"
                rows={m.web.sources.map((s) => { const name = sourceLabel(s.referrer); return { label: name, value: s.c, icon: SOURCE_ICON[name] }; })}
                empty="Sin datos de origen aún."
                hex="#a78bfa"
                showPct
              />
            </div>
          </Panel>
        )}

        {/* Bot + tendencia */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Panel title="🤖 Salud del bot" subtitle="últimos 7 días">
            <div className="space-y-1.5 text-sm">
              <Row label="Consultas recibidas" value={m.botHealth.inbound} />
              <Row label="Resueltas por el bot" value={m.botHealth.botReplies} hex={HEX.green} />
              <Row label="Respondidas manual" value={m.botHealth.manualReplies} />
              <Row label="Escaladas a humano" value={m.botHealth.escalations} hex={HEX.amber} />
              <Row label="Fallos técnicos" value={m.botHealth.fails} hex={m.botHealth.fails > 0 ? HEX.red : undefined} />
              <div className="pt-2 mt-1 border-t border-white/10 flex justify-between">
                <span className="text-slate-400">Tasa de escalación</span>
                <span className="font-mono font-bold text-cyan-300">{m.botHealth.escalationPct}%</span>
              </div>
            </div>
          </Panel>
          <Panel title="📊 Mensajes por día" subtitle="7 días">
            <TrendChart data={m.trend} />
          </Panel>
        </section>

        {/* Reservas */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Panel title="🏡 Reservas por propiedad" subtitle="30 días">
            <MiniList rows={m.reservations.byProperty.map((r) => ({ label: PROPERTY_NAMES[r.slug] ?? r.slug, value: r.c }))} empty="Sin reservas en 30 días." />
          </Panel>
          <Panel title="🔗 Reservas por canal" subtitle="30 días">
            <MiniList rows={m.reservations.bySource.map((r) => ({ label: SOURCE_NAMES[r.source] ?? r.source, value: r.c }))} empty="Sin reservas en 30 días." />
          </Panel>
        </section>

        {/* Métricas por propiedad — ocupación + ingresos del mes */}
        {m.porPropiedad && m.porPropiedad.length > 0 && (
          <Panel title="🏘️ Métricas por propiedad" subtitle={m.mes ? `ocupación (directo + Airbnb) · ingresos del mes · ${monthLabel(m.mes.prefix)}` : "este mes"}>
            <PropertyMetricsTable rows={m.porPropiedad} airbnbStatus={m.health.airbnbStatus} />
          </Panel>
        )}

        {/* Feed estilo terminal */}
        <Panel title="📋 Actividad reciente">
          {m.feed.length === 0 ? (
            <p className="text-slate-500 text-sm">Sin actividad reciente.</p>
          ) : (
            <ul className="space-y-1 font-mono text-[12px]">
              {m.feed.map((f, i) => (
                <li key={i} className="flex items-start gap-2 border-b border-white/5 pb-1 last:border-0">
                  <span className="text-cyan-500/70 whitespace-nowrap w-12 shrink-0">{timeAgo(f.at)}</span>
                  <span className="text-slate-300 flex-1 truncate">{f.text}</span>
                  {f.tag && <span className="text-[10px] bg-white/5 text-slate-400 px-1.5 rounded whitespace-nowrap">{f.tag}</span>}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* QA del bot — analizador de conversaciones */}
        {m.qa && (
          <Panel
            title="🔍 QA del bot"
            subtitle={m.qa.lastRun ? `última revisión ${timeAgo(m.qa.lastRun.ranAt)} · ${m.qa.lastRun.analyzed} conversaciones` : "sin revisar todavía"}
          >
            <div className="flex items-center justify-between gap-3 mb-3">
              <p className="text-[12px] text-slate-400">
                {m.qa.findings.length === 0
                  ? (m.qa.lastRun ? "Sin problemas en la última revisión. 🌴" : "Corré una revisión para detectar fallos del bot.")
                  : `${m.qa.findings.length} ${m.qa.findings.length === 1 ? "hallazgo" : "hallazgos"} para revisar`}
              </p>
              <button
                onClick={runQa}
                disabled={runningQa}
                className="shrink-0 text-[12px] font-semibold text-slate-900 bg-cyan-400 hover:bg-cyan-300 rounded-lg px-3 py-1.5 disabled:opacity-50 transition"
              >
                {runningQa ? "Analizando…" : "🔄 Analizar ahora"}
              </button>
            </div>
            {m.qa.findings.length > 0 && (
              <ul className="space-y-2.5">
                {m.qa.findings.map((f) => {
                  const sev = f.severity === "alta" ? { bg: "#7f1d1d", fg: "#fecaca" } : f.severity === "media" ? { bg: "#78350f", fg: "#fde68a" } : { bg: "#1e293b", fg: "#cbd5e1" };
                  return (
                    <li key={f.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span style={{ background: sev.bg, color: sev.fg }} className="text-[9px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5">{f.severity}</span>
                        <span className="text-[13px] font-semibold text-slate-100">{f.issue}</span>
                        <button
                          onClick={() => resolveFinding(f.id)}
                          className="ml-auto shrink-0 text-[10px] font-semibold text-emerald-300 hover:text-emerald-200 border border-emerald-500/30 hover:border-emerald-400/50 rounded px-2 py-0.5 transition"
                        >
                          ✓ Resuelto
                        </button>
                      </div>
                      <p className="text-[12px] text-slate-300 leading-snug">{f.detail}</p>
                      {f.suggestion && <p className="text-[12px] text-cyan-300/90 mt-1 leading-snug"><span className="text-slate-500">Fix sugerido: </span>{f.suggestion}</p>}
                      <div className="flex items-center gap-2 mt-1.5 text-[10px] text-slate-500 font-mono">
                        <span>🕐 {f.conv_at ? timeAgo(f.conv_at) : "—"}</span>
                        <span>·</span>
                        <span>{f.phone}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        )}

        {/* Categorías de fallo — error analysis: dónde falla el bot, agrupado */}
        {m.failures && (m.failures.byIssue.length > 0 || m.failures.byStage.length > 0 || m.failures.byRule.length > 0) && (
          <Panel
            title="📊 Categorías de fallo"
            subtitle="dónde falla el bot, agrupado — arreglá la categoría más grande primero"
          >
            {/* Por tipo de problema (snapshot del QA) */}
            {m.failures.byIssue.length > 0 && (() => {
              const max = Math.max(...m.failures!.byIssue.map((x) => x.c), 1);
              return (
                <div className="mb-4">
                  <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Por tipo de problema (último QA)</p>
                  <ul className="space-y-1.5">
                    {m.failures.byIssue.map((x) => (
                      <li key={x.issue} className="flex items-center gap-2">
                        <span className="w-36 shrink-0 truncate text-[12px] text-slate-300" title={x.issue}>{x.issue}</span>
                        <div className="flex-1 h-3 rounded bg-white/5 overflow-hidden">
                          <div className="h-full rounded bg-cyan-500/60" style={{ width: `${Math.round((x.c / max) * 100)}%` }} />
                        </div>
                        <span className="w-6 text-right text-[12px] font-mono text-slate-200">{x.c}</span>
                        {x.alta > 0 && <span className="shrink-0 text-[9px] font-bold uppercase rounded px-1 py-0.5" style={{ background: "#7f1d1d", color: "#fecaca" }}>{x.alta} alta</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}

            {/* Trazas técnicas (7 días) */}
            {m.failures.byStage.length > 0 && (
              <div className="mb-4">
                <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Trazas técnicas (7 días)</p>
                <div className="flex flex-wrap gap-2">
                  {m.failures.byStage.map((s) => {
                    const meta = STAGE_META[s.stage] ?? { label: s.stage, hex: "#94a3b8" };
                    return (
                      <span key={s.stage} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[12px]">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: meta.hex }} />
                        <span className="text-slate-300">{meta.label}</span>
                        <span className="font-mono font-bold text-slate-100">{s.c}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Escalaciones por regla (7 días) */}
            {m.failures.byRule.length > 0 && (
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
                  Escaló a humano por regla (7 días) · {m.failures.escalationPct}% de las consultas
                </p>
                <ul className="space-y-1">
                  {m.failures.byRule.map((r) => (
                    <li key={r.rule} className="flex items-center justify-between gap-2 text-[12px]">
                      <span className="font-mono text-slate-400 truncate" title={r.rule}>{r.rule}</span>
                      <span className="font-mono font-bold text-amber-300">{r.c}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>
        )}

        {/* Registro de cambios / debugging — bitácora visible del sistema */}
        <Panel title="🛠️ Registro de cambios" subtitle="mejoras y arreglos del sistema">
          <div className="space-y-4">
            {CHANGELOG.map((entry) => (
              <div key={entry.date}>
                <p className="text-[11px] font-mono text-cyan-400/80 mb-1.5 uppercase tracking-wider">{entry.date}</p>
                <ul className="space-y-1.5">
                  {entry.items.map((it, i) => (
                    <li key={i} className="flex items-start gap-2 text-[13px] text-slate-300 leading-snug">
                      <span className="text-cyan-500/70 mt-0.5 shrink-0">▸</span>
                      <span>{it}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Panel>

        <p className="text-center text-[10px] text-slate-600 font-mono pb-4">● actualización automática cada 10 s</p>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componentes de UI (tema dark)
// ─────────────────────────────────────────────────────────────────────────────

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[15px] font-semibold text-slate-100">{title}</h2>
        {subtitle && <span className="text-[11px] text-slate-400">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

// Card de una métrica del MES seleccionado (un valor grande, sin hoy/7d/30d).
function MonthKpi({ icon, label, sub, glow, children }: { icon: string; label: string; sub?: string; glow: string; children: ReactNode }) {
  return (
    <div className="relative rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur p-4 overflow-hidden">
      <div className="absolute -top-8 -right-8 w-24 h-24 rounded-full opacity-20 blur-2xl" style={{ background: glow }} />
      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-200">
        <span className="text-[15px]">{icon}</span>{label}
      </div>
      <div className="text-[10px] text-slate-500 mb-3 mt-0.5">{sub ?? " "}</div>
      {children}
    </div>
  );
}

// Card de Ingresos del mes: USD y HNL SEPARADOS (nunca sumados) + desglose directo/Airbnb.
function MoneyKpi({ usd, hnl, usdDirect, usdAirbnb, glow }: { usd: number; hnl: number; usdDirect: number; usdAirbnb: number; glow: string }) {
  const au = useCountUp(usd);
  return (
    <div className="relative rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur p-4 overflow-hidden">
      <div className="absolute -top-8 -right-8 w-24 h-24 rounded-full opacity-20 blur-2xl" style={{ background: glow }} />
      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-200">
        <span className="text-[15px]">💰</span>Ingresos
      </div>
      <div className="text-[10px] text-slate-500 mb-2 mt-0.5">del mes · por check-in</div>
      <div className="flex items-baseline gap-1.5 flex-wrap">
        <span className="font-mono font-bold text-2xl leading-none" style={{ color: glow, textShadow: `0 0 14px ${glow}55` }}>{fmtUsd(au)}</span>
        <span className="text-[11px] text-slate-500">USD</span>
      </div>
      {hnl > 0 && (
        <div className="flex items-baseline gap-1.5 mt-1 flex-wrap">
          <span className="font-mono font-bold text-lg leading-none text-slate-200">{fmtHnl(hnl)}</span>
          <span className="text-[11px] text-slate-500">HNL</span>
        </div>
      )}
      <div className="text-[10px] text-slate-500 mt-2.5 pt-1.5 border-t border-white/5">directo {fmtUsd(usdDirect)} · Airbnb {fmtUsd(usdAirbnb)}</div>
    </div>
  );
}

// Reporte para el equipo de marketing/pauta: alcance, canales, interés y conversión
// del mes seleccionado, en lenguaje simple + botón para copiar y pegarle a marketing.
function MarketingReport({ mk, monthPrefix, onClassify, classifying, classifyMsg }: { mk: NonNullable<Metrics["marketing"]>; monthPrefix: string; onClassify?: () => void; classifying?: boolean; classifyMsg?: string }) {
  const [copied, setCopied] = useState(false);
  const srcTotal = mk.sources.reduce((s, r) => s + r.c, 0) || 1;
  const leadsByAd = mk.leadsByAd ?? [];
  const leadsFromAds = leadsByAd.reduce((s, a) => s + a.c, 0);
  const directTotal = mk.directBySource.reduce((s, r) => s + r.total, 0); // estadías (check-in)
  const wonByProperty = mk.wonByProperty ?? [];
  const wonTotal = (mk.wonBySource ?? []).reduce((s, r) => s + r.total, 0); // conseguidas (created_at)

  // Texto formato WhatsApp (negritas con *asteriscos*), para pegarle a marketing.
  // Honesto sobre atribución: el SITIO se puede atribuir (UTM/referrer); el origen
  // de los leads de WHATSAPP hoy NO se rastrea (ver el instructivo al final).
  const reportText = (() => {
    const L: string[] = [];
    L.push(`📊 *Reporte de marketing — ${monthLabel(monthPrefix)}*`, "_Estadías Jacarí_", "");
    L.push(`🌐 *Sitio web — ${mk.webViews} visitas (${mk.webUniques} personas)*`);
    if (mk.sources.length) {
      L.push("De dónde llegan al sitio:");
      for (const s of mk.sources) L.push(`• ${sourceLabel(s.referrer)}: ${s.c} (${Math.round((s.c / srcTotal) * 100)}%)`);
      L.push("⚠️ \"Directo / sin origen\" incluye a quienes vienen de las apps de Instagram/Facebook, que ocultan el origen del clic. Para verlo exacto → etiquetar los ads con UTM (abajo).");
    }
    L.push("");
    const funnel = mk.funnelByProperty ?? [];
    if (funnel.length) {
      L.push("📍 *Seguimiento por propiedad* (vistas web · consultas WA · reservas):");
      for (const f of funnel) {
        const parts = [`${f.webViews} vistas`];
        if (f.waInquiries) parts.push(`${f.waInquiries} consult.`);
        parts.push(`${f.resAirbnb} Airbnb`, `${f.resDirect} directa`);
        L.push(`• ${PROPERTY_NAMES[f.slug] ?? f.slug}: ${parts.join(" · ")}`);
      }
      L.push("");
    }
    L.push(`💬 *WhatsApp — ${mk.contacts} personas escribieron*`);
    if (leadsFromAds > 0) {
      L.push(`• De esos, *${leadsFromAds}* vinieron de un ad (Click-to-WhatsApp):`);
      for (const a of leadsByAd) L.push(`   • ${a.c} de "${a.ad}"`);
    }
    // Dos vistas SEPARADAS para no confundir el efecto de la pauta con la operación.
    L.push(`🎯 *Reservas CONSEGUIDAS en ${monthLabel(monthPrefix)}* (cuándo reservaron): *${wonTotal}*`);
    for (const p of wonByProperty) L.push(`   • ${p.total} en ${PROPERTY_NAMES[p.slug] ?? p.slug}`);
    L.push(`🏠 *Estadías que LLEGAN en ${monthLabel(monthPrefix)}* (cuándo se atienden): *${directTotal}*`);
    for (const p of mk.directByProperty) L.push(`   • ${p.total} en ${PROPERTY_NAMES[p.slug] ?? p.slug}`);
    L.push("ℹ️ \"Conseguidas\" = efecto de la pauta (cuándo entró la reserva). \"Estadías\" = operación (cuándo llega el huésped). Ej: una reserva de junio para julio cuenta como CONSEGUIDA en junio y ESTADÍA en julio.");
    if (leadsFromAds === 0) {
      L.push("⚠️ De estas reservas todavía no vemos el origen del lead. Acabamos de activar la captura de ads Click-to-WhatsApp — a partir de ahora, cada chat que venga de un ad va a aparecer acá con el nombre del anuncio.");
    }
    L.push("", `_(Airbnb va aparte: ${mk.airbnbStays} estadías con llegada este mes — su propio canal.)_`, "");
    L.push("✅ *Para atribuir todo:*");
    L.push("• WhatsApp: seguí usando ads \"Click to WhatsApp\" — el origen ya se captura solo.");
    L.push("• Sitio web: etiquetá los links de los ads que llevan a la página con:");
    L.push("   estadiasjacari.com/?utm_source=instagram&utm_medium=paid&utm_campaign=NOMBRE");
    return L.join("\n");
  })();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard no disponible */ }
  };

  const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="rounded-xl bg-white/[0.02] border border-white/5 p-3.5">
      <div className="text-[11px] uppercase tracking-wider text-fuchsia-300/70 font-semibold mb-2">{title}</div>
      {children}
    </div>
  );

  return (
    <section className="rounded-2xl border border-fuchsia-500/20 bg-[#0f0a18] p-5 shadow-[0_0_40px_rgba(217,70,239,0.05)]">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight">📣 Para marketing · <span className="capitalize">{monthLabel(monthPrefix)}</span></h2>
          <p className="text-[11px] text-slate-400">Resumen para el equipo de pauta — cambiá el mes con el selector de arriba</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {onClassify && (
            <button onClick={onClassify} disabled={classifying} className="px-3.5 py-2 rounded-lg text-sm font-semibold border border-violet-400/30 bg-violet-400/10 text-violet-200 hover:bg-violet-400/20 transition disabled:opacity-50">
              {classifying ? "Clasificando…" : "🤖 Auto-clasificar chats"}
            </button>
          )}
          <button onClick={copy} className={`px-3.5 py-2 rounded-lg text-sm font-semibold border transition ${copied ? "border-green-400/40 bg-green-400/10 text-green-300" : "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200 hover:bg-fuchsia-400/20"}`}>
            {copied ? "✓ Copiado" : "📋 Copiar reporte"}
          </button>
        </div>
      </div>
      {classifyMsg && <p className="text-[11px] text-violet-300/80 mb-3 -mt-2">{classifyMsg}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Section title="Alcance">
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-slate-300">👀 Visitas al sitio</span><span className="font-mono font-semibold text-white">{mk.webViews.toLocaleString("en-US")}</span></div>
            <div className="flex justify-between"><span className="text-slate-300">🧑 Personas distintas</span><span className="font-mono font-semibold text-white">{mk.webUniques.toLocaleString("en-US")}</span></div>
            <div className="flex justify-between"><span className="text-slate-300">💬 Nos escribieron</span><span className="font-mono font-semibold text-white">{mk.contacts.toLocaleString("en-US")}</span></div>
          </div>
        </Section>

        <Section title="De dónde llegan (canales / pauta)">
          {mk.sources.length === 0 ? <p className="text-[13px] text-slate-500">Sin datos de tráfico este mes.</p> : (
            <ul className="space-y-1.5">
              {mk.sources.map((s, i) => {
                const name = sourceLabel(s.referrer);
                const pct = Math.round((s.c / srcTotal) * 100);
                return (
                  <li key={i} className="flex items-center gap-2 text-sm">
                    <span className="w-5 text-center">{SOURCE_ICON[name] ?? "•"}</span>
                    <span className="text-slate-300 flex-1 truncate">{name}</span>
                    <span className="font-mono text-xs text-slate-400">{s.c}</span>
                    <span className="font-mono text-xs font-semibold text-fuchsia-300 w-9 text-right">{pct}%</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Reservas: conseguidas vs. estadías">
          <div className="text-sm space-y-2">
            <div>
              <div className="flex justify-between">
                <span className="text-slate-300">🎯 Conseguidas <span className="text-slate-500 text-[11px]">(reservaron este mes)</span></span>
                <span className="font-mono font-semibold text-emerald-300">{wonTotal}</span>
              </div>
              {wonByProperty.map((p, i) => (
                <div key={i} className="flex justify-between text-[12px] pl-3">
                  <span className="text-slate-400">{PROPERTY_NAMES[p.slug] ?? p.slug}</span>
                  <span className="font-mono text-slate-300">{p.total}</span>
                </div>
              ))}
            </div>
            <div className="pt-1.5 border-t border-white/5">
              <div className="flex justify-between">
                <span className="text-slate-300">🏠 Estadías <span className="text-slate-500 text-[11px]">(llegan este mes)</span></span>
                <span className="font-mono font-semibold text-cyan-300">{directTotal}</span>
              </div>
              {mk.directByProperty.map((p, i) => (
                <div key={i} className="flex justify-between text-[12px] pl-3">
                  <span className="text-slate-400">{PROPERTY_NAMES[p.slug] ?? p.slug}</span>
                  <span className="font-mono text-slate-300">{p.total}</span>
                </div>
              ))}
            </div>
            <div className="text-[11px] text-slate-500">Airbnb: <span className="font-mono text-slate-400">{mk.airbnbStays}</span> estadía{mk.airbnbStays === 1 ? "" : "s"} este mes (canal aparte)</div>
            <div className="text-[10px] text-slate-500 leading-relaxed pt-1">Conseguidas = efecto de la pauta (cuándo entró la reserva) · Estadías = operación (cuándo llega). Una reserva de junio para julio: conseguida en junio, estadía en julio.</div>
          </div>
        </Section>
      </div>

      {/* Seguimiento por propiedad: vistas web → consultas WhatsApp → reservas */}
      <FunnelTable rows={mk.funnelByProperty} />

      {/* Embudo + nota honesta de atribución */}
      <div className="mt-3 rounded-xl bg-white/[0.02] border border-white/5 p-3.5">
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="font-mono font-semibold text-white">{mk.webViews.toLocaleString("en-US")}</span><span className="text-slate-400">visitas</span>
          <span className="text-slate-600">→</span>
          <span className="font-mono font-semibold text-white">{mk.contacts.toLocaleString("en-US")}</span><span className="text-slate-400">escribieron</span>
          <span className="text-slate-600">→</span>
          <span className="font-mono font-semibold text-emerald-300">{directTotal}</span><span className="text-slate-400">reservas cerradas</span>
        </div>
        {leadsFromAds > 0 && (
          <div className="mt-2.5 pt-2.5 border-t border-white/5">
            <div className="text-[11px] uppercase tracking-wider text-emerald-300/70 font-semibold mb-1.5">📲 Leads que vinieron de un ad (Click-to-WhatsApp)</div>
            <ul className="space-y-1">
              {leadsByAd.map((a, i) => (
                <li key={i} className="flex justify-between text-[13px] gap-2">
                  <span className="text-slate-300 truncate">{a.ad}</span>
                  <span className="font-mono text-emerald-300 whitespace-nowrap">{a.c}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
          📲 <b className="text-emerald-300/80">Origen de los leads de WhatsApp: captura ACTIVA.</b> Como usás ads <b>Click-to-WhatsApp</b>, Meta nos dice de qué anuncio vino cada chat — a partir de ahora aparece acá arriba con el nombre del ad. <b className="text-slate-300">Sitio web:</b> etiquetá los links con <code className="text-fuchsia-300/80 break-all">?utm_source=instagram&amp;utm_medium=paid&amp;utm_campaign=NOMBRE</code>. Y <b>Directo / sin origen</b> = visitas al sitio cuyo referrer se perdió (apps de IG/FB).
        </p>
      </div>
    </section>
  );
}

// Embudo por propiedad: vistas web → consultas WhatsApp → reservas (Airbnb / directas).
function FunnelTable({ rows }: { rows: NonNullable<Metrics["marketing"]>["funnelByProperty"] }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div className="mt-3 rounded-xl bg-white/[0.02] border border-white/5 p-3.5 overflow-x-auto">
      <div className="text-[11px] uppercase tracking-wider text-fuchsia-300/70 font-semibold mb-2">📍 Seguimiento por propiedad</div>
      <table className="w-full text-sm min-w-[460px]">
        <thead>
          <tr className="text-[11px] text-slate-500 uppercase tracking-wider">
            <th className="text-left font-medium pb-2">Propiedad</th>
            <th className="text-right font-medium pb-2">👀 Vistas web</th>
            <th className="text-right font-medium pb-2">💬 Consultas WA</th>
            <th className="text-right font-medium pb-2">🅰 Reserva Airbnb</th>
            <th className="text-right font-medium pb-2">✅ Reserva directa</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.slug} className="border-t border-white/5">
              <td className="py-2 pr-3 text-slate-200 whitespace-nowrap">{PROPERTY_NAMES[r.slug] ?? r.slug}</td>
              <td className="py-2 text-right font-mono text-slate-300">{r.webViews || <span className="text-slate-600">—</span>}</td>
              <td className="py-2 text-right font-mono text-violet-300">{r.waInquiries || <span className="text-slate-600">—</span>}</td>
              <td className="py-2 text-right font-mono text-cyan-300">{r.resAirbnb || <span className="text-slate-600">—</span>}</td>
              <td className="py-2 text-right font-mono text-emerald-300">{r.resDirect || <span className="text-slate-600">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
        👀 vistas del sitio · 💬 consultas por WhatsApp (se llenan al <b className="text-slate-400">etiquetar los chats</b> en el inbox) · reservas por check-in del mes. Así ves, por casa: cuánta gente la mira, cuántos preguntan, y cuántos reservan (y por dónde).
      </p>
    </div>
  );
}

function Kpi({ icon, label, hoy, week, month, glow, prefix, footer }: { icon: string; label: string; hoy: number | null; week: number | null; month: number | null; glow: string; prefix?: string; footer?: string }) {
  return (
    <div className="relative rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur p-4 overflow-hidden">
      <div className="absolute -top-8 -right-8 w-24 h-24 rounded-full opacity-20 blur-2xl" style={{ background: glow }} />
      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-200 mb-2.5">
        <span className="text-[15px]">{icon}</span>{label}
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-center">
        <RangeCell label="Hoy" value={hoy} glow={glow} prefix={prefix} primary />
        <RangeCell label="7 días" value={week} prefix={prefix} />
        <RangeCell label="30 días" value={month} prefix={prefix} />
      </div>
      {footer && <div className="text-[10px] text-slate-500 mt-2 text-center">{footer}</div>}
    </div>
  );
}

function RangeCell({ label, value, glow, prefix, primary }: { label: string; value: number | null; glow?: string; prefix?: string; primary?: boolean }) {
  const animated = useCountUp(typeof value === "number" ? value : 0);
  const display = value === null ? "—" : `${prefix ?? ""}${animated.toLocaleString("en-US")}`;
  return (
    <div className={`rounded-lg py-2 ${primary ? "bg-white/[0.05] border border-white/5" : ""}`}>
      <div className={`font-mono font-bold leading-none ${primary ? "text-2xl" : "text-base text-slate-300"}`} style={primary ? { color: glow, textShadow: `0 0 14px ${glow}55` } : undefined}>
        {display}
      </div>
      <div className="text-[10px] text-slate-500 mt-1.5">{label}</div>
    </div>
  );
}

function FunnelStep({ label, value, total, hex }: { label: string; value: number; total: number; hex: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono font-semibold" style={{ color: hex }}>{value}</span>
      </div>
      <div className="h-2 bg-white/5 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(pct, value > 0 ? 6 : 0)}%`, background: hex, boxShadow: `0 0 10px ${hex}99` }} />
      </div>
    </div>
  );
}

function HealthItem({ hex, label, detail }: { hex: string; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-white/[0.02] border border-white/5 px-3 py-2">
      <span className="relative flex shrink-0">
        <span className="w-2.5 h-2.5 rounded-full animate-ping absolute opacity-60" style={{ background: hex }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: hex }} />
      </span>
      <div className="min-w-0">
        <div className="text-slate-200 text-sm font-medium truncate">{label}</div>
        <div className="text-[11px] text-slate-500 truncate">{detail}</div>
      </div>
    </div>
  );
}

function Row({ label, value, hex }: { label: string; value: number; hex?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono font-semibold" style={{ color: hex ?? "#e2e8f0" }}>{value}</span>
    </div>
  );
}

// KPI del tablero de tráfico. `live` = métrica de tiempo real (punto pulsante
// verde si hay alguien, gris si no). `foot` = línea de contexto (delta, etc.).
function WebStat({ label, value, foot, live }: { label: string; value: number; foot?: React.ReactNode; live?: boolean }) {
  const animated = useCountUp(value);
  const on = !!live && value > 0;
  return (
    <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
      <div className="flex items-center gap-1.5">
        {live && (
          <span className="relative flex h-2 w-2 shrink-0">
            {on && <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-70" style={{ background: HEX.green }} />}
            <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: on ? HEX.green : HEX.gray }} />
          </span>
        )}
        <span className={`font-mono text-2xl font-bold leading-none ${on ? "text-green-400" : "text-slate-100"}`}>{animated.toLocaleString("en-US")}</span>
      </div>
      <div className="text-[11px] text-slate-500 mt-1">{label}</div>
      {foot && <div className="text-[10px] mt-1 leading-tight">{foot}</div>}
    </div>
  );
}

// Variación vs ayer: ▲ verde sube · ▼ rojo baja · = gris igual. Muestra el dato
// de ayer para dar contexto a la cifra de hoy.
function Delta({ today, prev }: { today: number; prev: number }) {
  if (prev === 0 && today === 0) return <span className="text-slate-600">— sin datos de ayer</span>;
  if (prev === 0) return <span style={{ color: HEX.green }}>▲ nuevo · ayer 0</span>;
  const pct = Math.round(((today - prev) / prev) * 100);
  if (pct === 0) return <span className="text-slate-500">= igual · ayer {prev}</span>;
  const up = pct > 0;
  return <span style={{ color: up ? HEX.green : HEX.red }}>{up ? "▲" : "▼"} {Math.abs(pct)}% · ayer {prev}</span>;
}

// Sparkline de vistas por día (7d). La última barra (hoy, parcial) va resaltada.
function WebTrend({ data }: { data: { day: string; views: number; uniques: number }[] }) {
  if (data.length === 0) return <p className="text-slate-500 text-sm py-4 text-center">Aún sin datos de tendencia. Se llena con las visitas de los próximos días.</p>;
  const max = Math.max(...data.map((d) => d.views), 1);
  const DOW = ["D", "L", "M", "M", "J", "V", "S"];
  return (
    <div className="flex items-end gap-1.5 h-20">
      {data.map((d, i) => {
        const pct = Math.round((d.views / max) * 100);
        const last = i === data.length - 1;
        const dow = DOW[new Date(d.day + "T12:00:00").getDay()];
        return (
          <div key={d.day} className="group relative flex-1 flex flex-col items-center justify-end h-full">
            <span className="text-[9px] text-slate-400 mb-0.5 font-mono">{d.views}</span>
            <div
              className="w-full rounded-t transition-all duration-500"
              style={{
                height: `${Math.max(pct, 4)}%`,
                background: last ? "linear-gradient(to top,#0891b2,#67e8f9)" : "linear-gradient(to top,#0e7490,#22d3ee)",
                boxShadow: last ? "0 0 10px rgba(34,211,238,0.6)" : "0 0 6px rgba(34,211,238,0.3)",
                opacity: last ? 1 : 0.85,
              }}
            />
            <span className={`text-[9px] mt-1 font-mono ${last ? "text-cyan-300 font-bold" : "text-slate-500"}`}>{dow}</span>
            <div className="pointer-events-none absolute bottom-full mb-1 hidden group-hover:block z-10 whitespace-nowrap rounded bg-slate-900 border border-white/10 px-2 py-1 text-[10px] text-slate-200 shadow-lg">
              {d.day.slice(5)} · {d.views} vistas · {d.uniques} únicos
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Lista con barra de fondo proporcional (al máximo de la lista) y % de cuota opcional.
function BarList({ title, rows, empty, hex, showPct }: { title: string; rows: { label: string; value: number; icon?: string }[]; empty: string; hex: string; showPct?: boolean }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <div>
      <p className="text-[11px] text-slate-500 mb-2 font-medium uppercase tracking-wider">{title}</p>
      {rows.length === 0 ? (
        <p className="text-slate-500 text-sm">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r, i) => {
            const pct = Math.round((r.value / max) * 100);
            const share = total > 0 ? Math.round((r.value / total) * 100) : 0;
            return (
              <li key={i} className="relative rounded-md overflow-hidden bg-white/[0.02]">
                <div className="absolute inset-y-0 left-0 rounded-md transition-all duration-500" style={{ width: `${Math.max(pct, 6)}%`, background: `${hex}22` }} />
                <div className="relative flex items-center justify-between px-2.5 py-1.5">
                  <span className="text-slate-200 text-sm truncate mr-2">
                    {r.icon && <span className="mr-1.5">{r.icon}</span>}{r.label}
                  </span>
                  <span className="font-mono text-sm font-semibold whitespace-nowrap" style={{ color: hex }}>
                    {r.value}{showPct && <span className="text-slate-500 text-[11px] ml-1">{share}%</span>}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function MiniList({ title, rows, empty }: { title?: string; rows: { label: string; value: number }[]; empty: string }) {
  return (
    <div>
      {title && <p className="text-[11px] text-slate-500 mb-1.5 font-medium uppercase tracking-wider">{title}</p>}
      {rows.length === 0 ? (
        <p className="text-slate-500 text-sm">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r, i) => (
            <li key={i} className="flex justify-between text-sm">
              <span className="text-slate-300 truncate mr-2">{r.label}</span>
              <span className="font-mono font-semibold text-cyan-300">{r.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Tabla ocupación + ingresos por propiedad del mes. Ocupación con barra de color
// (verde >=70%, ámbar >=35%, rojo <35%, gris sin dato). ⚠ = iCal de Airbnb no
// conectado → la ocupación de esa propiedad es solo de reservas directas.
function PropertyMetricsTable({ rows, airbnbStatus }: { rows: NonNullable<Metrics["porPropiedad"]>; airbnbStatus: Metrics["health"]["airbnbStatus"] }) {
  const fmt$ = (n: number) => `$${n.toLocaleString("en-US")}`;
  const totalRev = rows.reduce((s, r) => s + r.revenueMonth, 0);
  const totalHnl = rows.reduce((s, r) => s + (r.revenueHnlMonth ?? 0), 0);
  const totalResv = rows.reduce((s, r) => s + r.reservasMonth, 0);
  const occVals = rows.map((r) => r.occupancyPct).filter((p): p is number => p !== null);
  const avgOcc = occVals.length ? Math.round(occVals.reduce((s, p) => s + p, 0) / occVals.length) : null;
  const occHexOf = (pct: number | null) => (pct === null ? HEX.gray : pct >= 70 ? HEX.green : pct >= 35 ? HEX.amber : HEX.red);
  // ADR promedio del portafolio = ingreso USD total ÷ noches-USD totales (ponderado
  // por volumen, no promedio simple de ADRs). Referencia para leer cada fila.
  const adrVals = rows.filter((r) => typeof r.adrUsd === "number" && r.adrUsd! > 0);
  const portfolioAdr = adrVals.length
    ? Math.round(adrVals.reduce((s, r) => s + r.adrUsd! * r.reservasMonth, 0) / Math.max(1, adrVals.reduce((s, r) => s + r.reservasMonth, 0)))
    : null;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-slate-500 uppercase tracking-wider">
              <th className="text-left font-medium pb-2">Propiedad</th>
              <th className="text-left font-medium pb-2 w-[36%]">Ocupación</th>
              <th className="text-right font-medium pb-2" title="Average Daily Rate: tarifa media por noche (ingreso USD ÷ noches vendidas). Cruzá ADR bajo + ocupación alta = subpreciada.">ADR</th>
              <th className="text-right font-medium pb-2">Ingresos del mes</th>
              <th className="text-right font-medium pb-2">Reservas</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = r.occupancyPct;
              const occHex = occHexOf(pct);
              return (
                <tr key={r.slug} className="border-t border-white/5">
                  <td className="py-2 pr-3 text-slate-200 whitespace-nowrap">
                    {PROPERTY_NAMES[r.slug] ?? r.slug}
                    {pct !== null && r.airbnbSync !== "full" && r.airbnbSync !== "n/a" && (
                      <span title="Ocupación solo de reservas directas: el iCal de Airbnb de esta propiedad no está conectado." className="ml-1.5 text-[10px] text-amber-400/80 cursor-help">⚠</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {r.airbnbSync === "n/a" ? (
                      <span className="text-[11px] text-slate-500 italic">incluida en Brisa + Marea</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden min-w-[60px]">
                          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct ?? 0}%`, background: occHex, boxShadow: `0 0 8px ${occHex}88` }} />
                        </div>
                        <span className="font-mono text-xs font-semibold w-9 text-right" style={{ color: occHex }}>{pct === null ? "—" : `${pct}%`}</span>
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono whitespace-nowrap">
                    {typeof r.adrUsd === "number" && r.adrUsd > 0 ? (
                      <span className="text-violet-300" title={portfolioAdr ? `Portafolio: $${portfolioAdr}/noche` : undefined}>{fmt$(Math.round(r.adrUsd))}</span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="py-2 text-right font-mono whitespace-nowrap">
                    <div className="text-cyan-300">{fmt$(r.revenueMonth)}</div>
                    {(r.revenueHnlMonth ?? 0) > 0 && <div className="text-[11px] text-emerald-300/80">{`L ${Math.round(r.revenueHnlMonth ?? 0).toLocaleString("en-US")}`}</div>}
                  </td>
                  <td className="py-2 text-right font-mono text-slate-300">{r.reservasMonth}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-white/10">
              <td className="pt-2 font-semibold text-slate-200">Total</td>
              <td className="pt-2 text-[11px] text-slate-400">{avgOcc === null ? "—" : `prom. ${avgOcc}%`}</td>
              <td className="pt-2 pr-3 text-right font-mono text-violet-300/90 whitespace-nowrap">{portfolioAdr ? `$${portfolioAdr}` : "—"}</td>
              <td className="pt-2 text-right font-mono whitespace-nowrap">
                <div className="font-bold text-cyan-300">{fmt$(totalRev)}</div>
                {totalHnl > 0 && <div className="text-[11px] text-emerald-300/80">{`L ${Math.round(totalHnl).toLocaleString("en-US")}`}</div>}
              </td>
              <td className="pt-2 text-right font-mono font-semibold text-slate-300">{totalResv}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-[10px] text-slate-500 mt-3 leading-relaxed">
        Ocupación = noches ocupadas del mes ÷ días del mes (reservas directas + Airbnb vía iCal). <strong className="text-violet-300/90">ADR</strong> = tarifa media por noche (ingreso USD ÷ noches vendidas en USD): <strong className="text-slate-400">ADR bajo + ocupación alta = espacio para subir precio</strong>. Ingresos = de reservas con <strong className="text-slate-400">llegada (check-in) este mes</strong> — directo + Airbnb, con USD y HNL (Lempiras) por separado, nunca sumados. Este total cuadra con la tarjeta “Ingresos” de arriba (mismo lente). El paquete Las Gemelas aparece como fila propia para el ingreso; su ocupación se refleja en Casa Brisa y Casa Marea.
        {airbnbStatus !== "full" && <span className="text-amber-400/80"> · ⚠ El iCal de Airbnb no está completo: la ocupación de las propiedades marcadas refleja solo reservas directas.</span>}
      </p>
    </>
  );
}

function TrendChart({ data }: { data: { day: string; c: number }[] }) {
  if (data.length === 0) return <p className="text-slate-500 text-sm">Sin mensajes en 7 días.</p>;
  const max = Math.max(...data.map((d) => d.c), 1);
  return (
    <div className="flex items-end gap-2 h-28">
      {data.map((d) => {
        const pct = Math.round((d.c / max) * 100);
        const label = d.day.slice(8, 10) + "/" + d.day.slice(5, 7);
        return (
          <div key={d.day} className="flex-1 flex flex-col items-center justify-end h-full">
            <span className="text-[10px] text-slate-400 mb-0.5 font-mono">{d.c}</span>
            <div className="w-full rounded-t transition-all duration-500" style={{ height: `${Math.max(pct, 4)}%`, background: "linear-gradient(to top, #0891b2, #22d3ee)", boxShadow: "0 0 8px rgba(34,211,238,0.4)" }} />
            <span className="text-[9px] text-slate-500 mt-1 font-mono">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagrama de arquitectura animado (SVG con glow)
// ─────────────────────────────────────────────────────────────────────────────

// Colores por TIPO de flujo (no por salud)
const FLOW = { msg: "#22d3ee", money: "#34d399", avail: "#fbbf24", data: "#a78bfa" };
type FlowKind = keyof typeof FLOW;

type Pt = { x: number; y: number };
type NodePos = { x: number; y: number; s?: boolean };
const dimOf = (n: NodePos) => (n.s ? { w: 132, h: 46 } : { w: 160, h: 56 });
const rc = (n: NodePos) => ({ x: n.x + dimOf(n).w, y: n.y + dimOf(n).h / 2 });
const lc = (n: NodePos) => ({ x: n.x, y: n.y + dimOf(n).h / 2 });
const bc = (n: NodePos) => ({ x: n.x + dimOf(n).w / 2, y: n.y + dimOf(n).h });
const tc = (n: NodePos) => ({ x: n.x + dimOf(n).w / 2, y: n.y });

function ArchitectureDiagram({ health }: { health: Metrics["health"] }) {
  // Salud → SOLO el punto de cada nodo (separada del color de la línea).
  // Asumimos verde (activo) por defecto; solo se marca rojo si hay falla real.
  const h = {
    ig: HEX.green, fb: HEX.green, google: HEX.green, viajeros: HEX.green,
    airbnb: airbnbHex(health.airbnbStatus),
    wa: recencyHex(health.lastInAt),
    sitio: HEX.green,
    bot: botHex(health.botLlmErrorAt, health.botMudoAt),
    agente: HEX.green,
    db: HEX.green,
    cron: cronHex(health.cronLastAt),
    paypal: recencyHex(health.lastReservationAt, 24 * 30),
    bac: recencyHex(health.lastReservationAt, 24 * 30),
    team: cronHex(health.cronLastAt),
  };
  // Banderas "live" solo aceleran la animación; los flujos SIEMPRE corren.
  const liveMsg = isLive(health.lastInAt);
  const liveMoney = isLive(health.lastReservationAt, 60);
  const liveCron = isLive(health.cronLastAt, 15);

  // Layout en zonas (izq→der): ORIGEN · CANALES · MOTOR · DINERO/SALIDAS.
  // ORIGEN = de dónde vienen los huéspedes (IG/FB/Google + "Viajeros" que buscan
  // en Airbnb). CANALES = donde reservan/pagan (WhatsApp/Sitio/Airbnb). El motor
  // es columna vertical (bot → db → cron); el cron baja alineado con Seguridad.
  // Dinero arriba (PayPal/BAC), Agente al medio, equipo abajo. Google alineado
  // con Sitio (línea recta).
  const P: Record<string, NodePos> = {
    ig: { x: 14, y: 120, s: true }, fb: { x: 14, y: 180, s: true }, google: { x: 14, y: 293, s: true }, viajeros: { x: 14, y: 405, s: true },
    wa: { x: 200, y: 152 }, sitio: { x: 200, y: 288 }, airbnb: { x: 200, y: 400 },
    bot: { x: 440, y: 168 }, db: { x: 440, y: 314 }, cron: { x: 440, y: 469 },
    paypal: { x: 700, y: 120 }, bac: { x: 700, y: 224 }, agente: { x: 700, y: 336, s: true },
    limpieza: { x: 700, y: 420, s: true }, seguridad: { x: 700, y: 474, s: true }, huesped: { x: 700, y: 528, s: true },
  };

  return (
    <div>
      <svg viewBox="0 0 880 588" className="w-full" style={{ maxHeight: 680 }}>
        <defs>
          <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          {/* Degradado oficial de Instagram para su logo */}
          <linearGradient id="ig-grad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#FED576" /><stop offset="0.26" stopColor="#F47133" />
            <stop offset="0.61" stopColor="#BC3081" /><stop offset="1" stopColor="#4C63D2" />
          </linearGradient>
        </defs>

        {/* Etiquetas de zona */}
        <text x={80} y={44} fontSize={11} fontWeight={700} fill="#3f5170" textAnchor="middle" letterSpacing="1.5">ORIGEN</text>
        <text x={280} y={44} fontSize={11} fontWeight={700} fill="#3f5170" textAnchor="middle" letterSpacing="1.5">CANALES</text>
        <text x={520} y={44} fontSize={11} fontWeight={700} fill="#3f5170" textAnchor="middle" letterSpacing="1.5">MOTOR</text>
        <text x={770} y={44} fontSize={11} fontWeight={700} fill="#3f5170" textAnchor="middle" letterSpacing="1.5">DINERO · SALIDAS</text>

        {/* Conexiones */}
        {/* Origen → canales (datos) */}
        <Flow from={rc(P.ig)} to={lc(P.wa)} kind="data" live={liveMsg} />
        <Flow from={rc(P.fb)} to={lc(P.wa)} kind="data" live={liveMsg} />
        <Flow from={rc(P.google)} to={lc(P.sitio)} kind="data" live={false} />
        {/* Los viajeros descubren la propiedad buscando en Airbnb */}
        <Flow from={rc(P.viajeros)} to={lc(P.airbnb)} kind="data" live={false} />
        {/* Conversación (ida y vuelta = el bot responde) */}
        <Flow from={rc(P.wa)} to={lc(P.bot)} kind="msg" live={liveMsg} bidir />
        {/* Sitio web → WhatsApp (botón flotante + "Confirmar llegada por WhatsApp") */}
        <Flow from={tc(P.sitio)} to={bc(P.wa)} kind="msg" live={liveMsg} />
        {/* Bot escala a un agente humano */}
        <Flow from={rc(P.bot)} to={lc(P.agente)} kind="msg" live={liveMsg} bidir />
        {/* Datos internos: el bot lee/escribe en la base (memoria + KB) */}
        <Flow from={bc(P.bot)} to={tc(P.db)} kind="data" live={liveMsg} bidir />
        {/* El cron lee de la base (qué seguimientos/avisos tocan) */}
        <Flow from={bc(P.db)} to={tc(P.cron)} kind="data" live={liveCron} />
        {/* Disponibilidad (calendario compartido) */}
        <Flow from={rc(P.sitio)} to={lc(P.db)} kind="avail" live={false} bidir />
        <Flow from={rc(P.airbnb)} to={lc(P.db)} kind="avail" live={false} bidir />
        {/* Dinero: el bot ofrece PayPal (tarjeta) y BAC (transferencia); PayPal liquida al banco */}
        <Flow from={rc(P.bot)} to={lc(P.paypal)} kind="money" live={liveMoney} />
        <Flow from={rc(P.bot)} to={lc(P.bac)} kind="money" live={liveMoney} />
        <Flow from={bc(P.paypal)} to={tc(P.bac)} kind="money" live={liveMoney} />
        {/* Operaciones: cron → equipo */}
        <Flow from={rc(P.cron)} to={lc(P.limpieza)} kind="msg" live={liveCron} />
        <Flow from={rc(P.cron)} to={lc(P.seguridad)} kind="msg" live={liveCron} />
        <Flow from={rc(P.cron)} to={lc(P.huesped)} kind="msg" live={liveCron} />

        {/* Nodos (logos de marca donde aplica; ícono para conceptos internos) */}
        <Node {...P.ig} icon="instagram" label="Instagram" sub="ads / perfil" health={h.ig} small />
        <Node {...P.fb} icon="facebook" label="Facebook" sub="ads / perfil" health={h.fb} small />
        <Node {...P.google} icon="google" label="Google" sub="tráfico directo" health={h.google} small />
        <Node {...P.viajeros} emoji="🔎" label="Viajeros" sub="buscan en Airbnb" health={h.viajeros} small />
        <Node {...P.wa} icon="whatsapp" label="WhatsApp" sub="cliente" health={h.wa} />
        <Node {...P.sitio} icon="jacari" label="Sitio web" sub="estadiasjacari.com" health={h.sitio} />
        <Node {...P.airbnb} icon="airbnb" label="Airbnb" sub="reservas + pago" health={h.airbnb} />
        <Node {...P.bot} icon="robot" label="Bot IA" sub="Workers AI · responde" health={h.bot} highlight />
        <Node {...P.agente} emoji="👤" label="Agente" sub="humano · escalación" health={h.agente} small />
        <Node {...P.db} emoji="🗄️" label="Base de datos" sub="reservas · KB · memoria" health={h.db} highlight />
        <Node {...P.cron} emoji="⏰" label="Cron" sub="tareas programadas" health={h.cron} />
        <Node {...P.paypal} icon="paypal" label="PayPal" sub="cobros" health={h.paypal} highlight />
        <Node {...P.bac} icon="bac" label="BAC" sub="el dinero llega acá" health={h.bac} highlight />
        <Node {...P.limpieza} emoji="🧹" label="Limpieza" sub="aviso" health={h.team} small />
        <Node {...P.seguridad} emoji="🛡️" label="Seguridad" sub="aviso" health={h.team} small />
        <Node {...P.huesped} emoji="🧳" label="Huésped" sub="check-in" health={h.team} small />
      </svg>

      {/* Leyenda de tipos de flujo */}
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 mt-3 px-1 text-[11px] text-slate-400">
        <LegendDot color={FLOW.msg} label="Conversación / avisos" />
        <LegendDot color={FLOW.money} label="Dinero" />
        <LegendDot color={FLOW.avail} label="Disponibilidad" />
        <LegendDot color={FLOW.data} label="Datos / captación" />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block w-4 h-[3px] rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      {label}
    </span>
  );
}

/** Curva bezier horizontal suave entre dos puntos. */
function curvePath(a: Pt, b: Pt): string {
  const mx = (a.x + b.x) / 2;
  return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
}

function Flow({ from, to, kind, live, bidir }: { from: Pt; to: Pt; kind: FlowKind; live: boolean; bidir?: boolean }) {
  const d = curvePath(from, to);
  const color = FLOW[kind];
  return (
    <g>
      {/* riel base sutil */}
      <path d={d} fill="none" stroke="#172339" strokeWidth={1.5} />
      {/* halo de color (ilumina el camino) — sin blur para que quede nítido/encendido */}
      <path d={d} fill="none" stroke={color} strokeWidth={5} opacity={0.18} />
      {/* flujo animado (siempre corre; live solo lo acelera) */}
      <path d={d} fill="none" stroke={color} strokeWidth={2.8} strokeLinecap="round" strokeDasharray="5 8" opacity={1}>
        <animate attributeName="stroke-dashoffset" from={13} to={0} dur={live ? "0.5s" : "2.1s"} repeatCount="indefinite" />
      </path>
      {/* corriente de retorno (bidireccional) */}
      {bidir && (
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeDasharray="2 11" opacity={0.7}>
          <animate attributeName="stroke-dashoffset" from={0} to={13} dur={live ? "0.6s" : "2.5s"} repeatCount="indefinite" />
        </path>
      )}
    </g>
  );
}

function Node({ x, y, icon, emoji, label, sub, health, small, highlight }: { x: number; y: number; icon?: string; emoji?: string; label: string; sub: string; health: string; small?: boolean; highlight?: boolean }) {
  const w = small ? 132 : 160;
  const ht = small ? 46 : 56;
  return (
    <g transform={`translate(${x},${y})`}>
      <rect width={w} height={ht} rx={12} fill="#0c1626" />
      <rect width={w} height={ht} rx={12} fill={highlight ? "#11223e" : "#0e1a2e"} stroke={highlight ? "#3a5578" : "#2b3a55"} strokeWidth={1.5} />
      {/* ícono: logo de marca o emoji */}
      <NodeIcon icon={icon} emoji={emoji} small={small} />
      {/* textos */}
      <text x={small ? 42 : 50} y={small ? 22 : 25} fontSize={small ? 11 : 13} fontWeight={700} fill="#f1f6fd">{label}</text>
      <text x={small ? 42 : 50} y={small ? 34 : 41} fontSize={small ? 8.5 : 10} fill="#94a6c4">{sub}</text>
      {/* punto de estado */}
      <circle cx={w - 13} cy={13} r={4} fill={health} filter="url(#glow)">
        <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite" />
      </circle>
    </g>
  );
}

/** Dibuja el ícono dentro del chip: logo de marca (SVG/imagen) o emoji. */
function NodeIcon({ icon, emoji, small }: { icon?: string; emoji?: string; small?: boolean }) {
  const cs = small ? 26 : 30;
  const x0 = small ? 9 : 12;
  const y0 = small ? 10 : 13;
  const darkChip = <rect x={x0} y={y0} width={cs} height={cs} rx={7} fill="#0a1322" stroke="#243349" strokeWidth={1} />;
  // Escala un ícono de su viewBox (vbw×vbh) al chip, centrado, ocupando `frac`.
  const scaled = (inner: React.ReactNode, vbw: number, vbh: number, frac: number) => {
    const s = (cs * frac) / Math.max(vbw, vbh);
    const tx = x0 + (cs - vbw * s) / 2;
    const ty = y0 + (cs - vbh * s) / 2;
    return <g transform={`translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${s.toFixed(4)})`}>{inner}</g>;
  };

  if (icon === "bac")
    return (<>{darkChip}<image href="/brands/bac.png" x={x0 + cs * 0.15} y={y0 + cs * 0.17} width={cs * 0.7} height={cs * 0.66} preserveAspectRatio="xMidYMid meet" /></>);
  if (icon === "jacari") // isotipo Jacarí en blanco sobre chip oscuro (líneas blancas), con zoom
    return (<>{darkChip}{scaled(<path d={JACARI_PATH} fill="#f1f6fd" />, 548.14, 522.76, 0.74)}</>);
  if (icon === "google")
    return (<>{darkChip}{scaled(<>{GOOGLE_G.map((g, i) => <path key={i} d={g.d} fill={g.fill} />)}</>, 48, 48, 0.66)}</>);
  if (icon === "robot")
    return (<>{darkChip}{scaled(<path d={ROBOT_PATH} fill="#34d3ee" />, 24, 24, 0.62)}</>);
  if (icon && BRAND_PATHS[icon])
    return (<>{darkChip}{scaled(<path d={BRAND_PATHS[icon]} fill={BRAND_FILL[icon]} />, 24, 24, 0.6)}</>);
  return (<>{darkChip}<text x={small ? 22 : 27} y={small ? 28 : 34} fontSize={small ? 14 : 17} textAnchor="middle">{emoji}</text></>);
}
