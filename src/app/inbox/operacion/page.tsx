"use client";
//
// /inbox/operacion — Centro de Control (operación en tiempo real).
//
// Etapa 1: KPIs (mensajes, conversaciones), embudo de ventas en vivo, reservas.
// Lee /api/inbox/metrics cada 10s. Protegido con la cookie de sesión del inbox.
//

import { useEffect, useState, useCallback, useRef } from "react";

const PROPERTY_NAMES: Record<string, string> = {
  "villa-b11-palma-real": "Villa B11",
  "casa-brisa": "Casa Brisa",
  "casa-marea": "Casa Marea",
  "centro-morazan": "Centro Morazán",
  "casa-lara-townhouse": "Casa Lara",
  "la-florida": "La Florida",
};

const SOURCE_NAMES: Record<string, string> = {
  website: "Sitio web",
  whatsapp_bot: "Bot WhatsApp",
  airbnb: "Airbnb",
  airbnb_ical: "Airbnb",
  manual: "Manual",
};

interface Metrics {
  generatedAt: string;
  messages: {
    todayIn: number;
    todayOut: number;
    weekIn: number;
    weekOut: number;
    uniqueToday: number;
    uniqueWeek: number;
  };
  funnel: {
    awaitingData: number;
    quoteProvided: number;
    awaitingPaymentMethod: number;
    awaitingPaypal: number;
    awaitingTransfer: number;
    total: number;
  };
  reservations: {
    today: number;
    week: number;
    month: number;
    byProperty: { slug: string; c: number }[];
    bySource: { source: string; c: number }[];
    revenueWeekUsd: number;
  };
  health: {
    lastInAt: string | null;
    lastOutAt: string | null;
    lastReservationAt: string | null;
    cronLastAt: string | null;
    airbnbStatus: "full" | "partial" | "unavailable" | "unknown";
  };
  botHealth: {
    inbound: number;
    botReplies: number;
    manualReplies: number;
    escalations: number;
    fails: number;
    escalationPct: number;
  };
  trend: { day: string; c: number }[];
  feed: { type: "message" | "reservation"; at: string; text: string; tag?: string }[];
  web?: {
    viewsToday: number;
    uniqueToday: number;
    now: number;
    topPages: { path: string; c: number }[];
    topReferrers: { referrer: string; c: number }[];
  };
}

const REFERRER_NAMES: Record<string, string> = {
  "instagram.com": "Instagram",
  "l.instagram.com": "Instagram",
  "facebook.com": "Facebook",
  "l.facebook.com": "Facebook",
  "m.facebook.com": "Facebook",
  "google.com": "Google",
  "www.google.com": "Google",
  "t.co": "X / Twitter",
};

/** "2026-06-08 01:00:00" (UTC de D1) → "hace 5 min". */
function timeAgo(iso: string | null): string {
  if (!iso) return "sin datos";
  const then = new Date(iso.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(then)) return "—";
  const min = Math.round((Date.now() - then) / 60000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

/** Color del semáforo del cron según cuánto hace que corrió (espera ~10 min). */
function cronColor(iso: string | null): string {
  if (!iso) return "bg-gray-300";
  const min = (Date.now() - new Date(iso.replace(" ", "T") + "Z").getTime()) / 60000;
  if (min <= 15) return "bg-green-500";
  if (min <= 30) return "bg-amber-500";
  return "bg-red-500";
}

const AIRBNB_UI: Record<string, { color: string; label: string }> = {
  full: { color: "bg-green-500", label: "Sincronizado" },
  partial: { color: "bg-amber-500", label: "Parcial" },
  unavailable: { color: "bg-red-500", label: "No responde" },
  unknown: { color: "bg-gray-300", label: "Sin verificar" },
};

// Colores hex para el diagrama SVG (las clases bg-* de Tailwind no aplican a SVG fill)
const HEX = { green: "#22c55e", amber: "#f59e0b", red: "#ef4444", gray: "#cbd5e1" };
function parseUtc(iso: string | null): number {
  if (!iso) return NaN;
  return new Date(iso.replace(" ", "T") + "Z").getTime();
}
/** Verde si hubo actividad en las últimas N horas; gris si no (no es "error"). */
function recencyHex(iso: string | null, hoursGreen = 24): string {
  const t = parseUtc(iso);
  if (Number.isNaN(t)) return HEX.gray;
  return (Date.now() - t) / 3600000 <= hoursGreen ? HEX.green : HEX.gray;
}
function cronHex(iso: string | null): string {
  const t = parseUtc(iso);
  if (Number.isNaN(t)) return HEX.gray;
  const min = (Date.now() - t) / 60000;
  return min <= 15 ? HEX.green : min <= 30 ? HEX.amber : HEX.red;
}
function airbnbHex(status: string): string {
  return status === "full" ? HEX.green : status === "partial" ? HEX.amber : status === "unavailable" ? HEX.red : HEX.gray;
}
/** ¿Hubo actividad muy reciente? → el flujo de la conexión va más rápido. */
function isLive(iso: string | null, minutes = 10): boolean {
  const t = parseUtc(iso);
  return !Number.isNaN(t) && (Date.now() - t) / 60000 <= minutes;
}

export default function OperacionPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [pulse, setPulse] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox/metrics");
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      const data = (await res.json()) as Metrics & { ok: boolean };
      if (data.ok) {
        setAuthed(true);
        setMetrics(data);
        setLastUpdate(new Date().toLocaleTimeString("es-HN"));
        setPulse(true);
        setTimeout(() => setPulse(false), 600);
      }
    } catch {
      /* mantener datos previos */
    }
  }, []);

  useEffect(() => {
    load();
    timer.current = setInterval(load, 10000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  if (authed === false) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg p-8 text-center">
          <h1 className="font-display text-2xl text-primary mb-2">Sesión requerida</h1>
          <p className="text-muted text-sm mb-6">Iniciá sesión para ver el centro de control.</p>
          <a href="/inbox" className="inline-block bg-primary text-white font-semibold px-5 py-2.5 rounded-lg hover:bg-primary/90 transition">
            Ir a iniciar sesión
          </a>
        </div>
      </div>
    );
  }

  if (authed === null || !metrics) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <p className="text-muted">Cargando métricas…</p>
      </div>
    );
  }

  const m = metrics;

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <div>
          <h1 className="font-display text-xl text-primary flex items-center gap-2">
            🛰️ Centro de Control
            <span className={`inline-block w-2 h-2 rounded-full bg-green-500 transition-opacity ${pulse ? "opacity-100" : "opacity-40"}`} />
          </h1>
          <p className="text-xs text-muted">Operación en vivo · actualizado {lastUpdate}</p>
        </div>
        <a href="/inbox" className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 text-muted text-sm">
          ← Volver al inbox
        </a>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* KPIs principales */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi
            icon="📨"
            label="Mensajes hoy"
            value={m.messages.todayIn + m.messages.todayOut}
            detail={`${m.messages.todayIn} recibidos · ${m.messages.todayOut} enviados`}
          />
          <Kpi
            icon="💬"
            label="Conversaciones hoy"
            value={m.messages.uniqueToday}
            detail={`${m.messages.uniqueWeek} esta semana`}
          />
          <Kpi
            icon="🏠"
            label="Reservas (semana)"
            value={m.reservations.week}
            detail={`hoy ${m.reservations.today} · mes ${m.reservations.month}`}
          />
          <Kpi
            icon="💰"
            label="Ingresos (7 días)"
            value={`$${m.reservations.revenueWeekUsd.toLocaleString("en-US")}`}
            detail="reservas pagadas + pendientes"
          />
        </section>

        {/* Tráfico web */}
        {m.web && (
          <section className="bg-white rounded-2xl border border-gray-200 p-5">
            <h2 className="font-display text-lg text-primary mb-3 flex items-center gap-2">
              🌐 Tráfico web
              {m.web.now > 0 && (
                <span className="text-[11px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-sans font-medium">
                  {m.web.now} {m.web.now === 1 ? "persona" : "personas"} ahora
                </span>
              )}
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <MiniStat label="Visitas hoy" value={m.web.viewsToday} />
              <MiniStat label="Visitantes únicos hoy" value={m.web.uniqueToday} />
              <MiniStat label="Ahora en el sitio" value={m.web.now} />
              <MiniStat label="Páginas vistas hoy" value={m.web.topPages.reduce((s, p) => s + p.c, 0)} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted mb-1.5 font-medium">Páginas más vistas (hoy)</p>
                {m.web.topPages.length === 0 ? (
                  <p className="text-muted text-sm">Sin visitas todavía hoy.</p>
                ) : (
                  <ul className="space-y-1">
                    {m.web.topPages.map((p) => (
                      <li key={p.path} className="flex justify-between text-sm">
                        <span className="text-primary truncate mr-2">{p.path}</span>
                        <span className="font-semibold text-primary">{p.c}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="text-xs text-muted mb-1.5 font-medium">De dónde llegan (7 días)</p>
                {m.web.topReferrers.length === 0 ? (
                  <p className="text-muted text-sm">Tráfico directo o sin datos aún.</p>
                ) : (
                  <ul className="space-y-1">
                    {m.web.topReferrers.map((r) => (
                      <li key={r.referrer} className="flex justify-between text-sm">
                        <span className="text-primary truncate mr-2">{REFERRER_NAMES[r.referrer] ?? r.referrer}</span>
                        <span className="font-semibold text-primary">{r.c}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Diagrama de arquitectura en vivo */}
        <section className="bg-[#0b1220] rounded-2xl border border-gray-800 p-5 overflow-hidden">
          <h2 className="font-display text-lg text-white mb-1">🛰️ Operación en vivo</h2>
          <p className="text-xs text-gray-400 mb-3">
            Mapa de todos los sistemas. Las líneas fluyen cuando hay tráfico; cada nodo muestra su salud.
          </p>
          <ArchitectureDiagram health={m.health} />
        </section>

        {/* Embudo de ventas */}
        <section className="bg-white rounded-2xl border border-gray-200 p-5">
          <h2 className="font-display text-lg text-primary mb-1">🪙 Embudo de ventas en vivo</h2>
          <p className="text-xs text-muted mb-4">
            Conversaciones activas ahora mismo, por etapa. Total: {m.funnel.total}
          </p>
          <div className="space-y-2">
            <FunnelStep label="Esperando datos (fechas/huéspedes)" value={m.funnel.awaitingData} total={m.funnel.total} color="bg-secondary" />
            <FunnelStep label="Cotización enviada" value={m.funnel.quoteProvided} total={m.funnel.total} color="bg-accent" />
            <FunnelStep label="Eligiendo método de pago" value={m.funnel.awaitingPaymentMethod} total={m.funnel.total} color="bg-amber-500" />
            <FunnelStep label="Esperando pago (PayPal)" value={m.funnel.awaitingPaypal} total={m.funnel.total} color="bg-blue-500" />
            <FunnelStep label="Esperando comprobante (transferencia)" value={m.funnel.awaitingTransfer} total={m.funnel.total} color="bg-green-600" />
          </div>
          {m.funnel.total === 0 && (
            <p className="text-center text-muted text-sm py-4">
              No hay conversaciones en proceso ahora. Aparecerán cuando lleguen clientes nuevos. 🌴
            </p>
          )}
        </section>

        {/* Salud de sistemas */}
        <section className="bg-white rounded-2xl border border-gray-200 p-5">
          <h2 className="font-display text-lg text-primary mb-3">🩺 Salud de los sistemas</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
            <HealthItem dot="bg-green-500" label="WhatsApp" detail={`últ. ${timeAgo(m.health.lastInAt)}`} />
            <HealthItem dot="bg-green-500" label="Bot IA" detail={`últ. ${timeAgo(m.health.lastOutAt)}`} />
            <HealthItem dot={AIRBNB_UI[m.health.airbnbStatus].color} label="Airbnb" detail={AIRBNB_UI[m.health.airbnbStatus].label} />
            <HealthItem dot={cronColor(m.health.cronLastAt)} label="Seguimientos (cron)" detail={`últ. ${timeAgo(m.health.cronLastAt)}`} />
            <HealthItem dot="bg-green-500" label="Reservas / PayPal" detail={`últ. ${timeAgo(m.health.lastReservationAt)}`} />
          </div>
        </section>

        {/* Salud del bot + Tendencia */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h2 className="font-display text-lg text-primary mb-3">🤖 Salud del bot <span className="text-xs text-muted font-sans">(7 días)</span></h2>
            <div className="space-y-1.5 text-sm">
              <Row label="Consultas recibidas" value={m.botHealth.inbound} />
              <Row label="Respondidas por el bot" value={m.botHealth.botReplies} accent="text-green-600" />
              <Row label="Respondidas manualmente" value={m.botHealth.manualReplies} />
              <Row label="Escaladas a humano" value={m.botHealth.escalations} accent="text-amber-600" />
              <Row label="Fallos técnicos" value={m.botHealth.fails} accent={m.botHealth.fails > 0 ? "text-red-600" : undefined} />
              <div className="pt-2 mt-1 border-t border-gray-100 flex justify-between">
                <span className="text-muted">Tasa de escalación</span>
                <span className="font-bold text-primary">{m.botHealth.escalationPct}%</span>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h2 className="font-display text-lg text-primary mb-3">📊 Mensajes por día <span className="text-xs text-muted font-sans">(7 días)</span></h2>
            <TrendChart data={m.trend} />
          </div>
        </section>

        {/* Feed de actividad */}
        <section className="bg-white rounded-2xl border border-gray-200 p-5">
          <h2 className="font-display text-lg text-primary mb-3">📋 Actividad reciente</h2>
          {m.feed.length === 0 ? (
            <p className="text-muted text-sm">Sin actividad reciente.</p>
          ) : (
            <ul className="space-y-1.5">
              {m.feed.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-sm border-b border-gray-50 pb-1.5 last:border-0">
                  <span className="text-[10px] text-muted whitespace-nowrap pt-0.5 w-16 shrink-0">{timeAgo(f.at)}</span>
                  <span className="text-primary flex-1 truncate">{f.text}</span>
                  {f.tag && (
                    <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded whitespace-nowrap">{f.tag}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Reservas por propiedad + fuente */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h2 className="font-display text-lg text-primary mb-3">🏡 Reservas por propiedad <span className="text-xs text-muted font-sans">(30 días)</span></h2>
            {m.reservations.byProperty.length === 0 ? (
              <p className="text-muted text-sm">Sin reservas en los últimos 30 días.</p>
            ) : (
              <ul className="space-y-1.5">
                {m.reservations.byProperty.map((r) => (
                  <li key={r.slug} className="flex justify-between text-sm">
                    <span className="text-primary">{PROPERTY_NAMES[r.slug] ?? r.slug}</span>
                    <span className="font-semibold text-primary">{r.c}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h2 className="font-display text-lg text-primary mb-3">🔗 Reservas por canal <span className="text-xs text-muted font-sans">(30 días)</span></h2>
            {m.reservations.bySource.length === 0 ? (
              <p className="text-muted text-sm">Sin reservas en los últimos 30 días.</p>
            ) : (
              <ul className="space-y-1.5">
                {m.reservations.bySource.map((r) => (
                  <li key={r.source} className="flex justify-between text-sm">
                    <span className="text-primary">{SOURCE_NAMES[r.source] ?? r.source}</span>
                    <span className="font-semibold text-primary">{r.c}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <p className="text-center text-[11px] text-muted">
          Se actualiza automáticamente cada 10 segundos.
        </p>
      </main>
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  detail,
}: {
  icon: string;
  label: string;
  value: number | string;
  detail: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4">
      <div className="text-2xl mb-1">{icon}</div>
      <div className="text-2xl font-bold text-primary leading-none">{value}</div>
      <div className="text-sm font-medium text-primary mt-1">{label}</div>
      <div className="text-[11px] text-muted mt-0.5">{detail}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagrama de arquitectura animado (SVG)
// ─────────────────────────────────────────────────────────────────────────────

function ArchitectureDiagram({ health }: { health: Metrics["health"] }) {
  // Salud de cada nodo (color hex)
  const c = {
    clienteWA: recencyHex(health.lastInAt),
    webhook: recencyHex(health.lastInAt),
    botIA: recencyHex(health.lastOutAt),
    d1: HEX.green, // si el dashboard carga, D1 responde
    sitio: HEX.green,
    paypal: recencyHex(health.lastReservationAt, 24 * 30),
    airbnb: airbnbHex(health.airbnbStatus),
    sync: airbnbHex(health.airbnbStatus),
    cron: cronHex(health.cronLastAt),
  };
  // Flujos "vivos" (animación rápida) según actividad reciente
  const liveWA = isLive(health.lastInAt);
  const liveResv = isLive(health.lastReservationAt, 60);
  const liveCron = isLive(health.cronLastAt, 15);

  // Posiciones (esquina sup-izq de cada nodo 150×52)
  const N = {
    clienteWA: { x: 15, y: 30 },
    sitio: { x: 15, y: 150 },
    airbnb: { x: 15, y: 270 },
    webhook: { x: 285, y: 30 },
    paypal: { x: 285, y: 150 },
    sync: { x: 285, y: 270 },
    cron: { x: 285, y: 375 },
    botIA: { x: 555, y: 70 },
    d1: { x: 555, y: 230 },
  };
  const W = 150, H = 52;
  const rc = (n: { x: number; y: number }) => ({ x: n.x + W, y: n.y + H / 2 }); // borde derecho
  const lc = (n: { x: number; y: number }) => ({ x: n.x, y: n.y + H / 2 }); // borde izq
  const bc = (n: { x: number; y: number }) => ({ x: n.x + W / 2, y: n.y + H }); // borde inf
  const tc = (n: { x: number; y: number }) => ({ x: n.x + W / 2, y: n.y }); // borde sup

  return (
    <svg viewBox="0 0 720 450" className="w-full" style={{ maxHeight: 460 }}>
      {/* Conexiones (debajo de los nodos) */}
      <Flow from={rc(N.clienteWA)} to={lc(N.webhook)} color={c.webhook} live={liveWA} />
      <Flow from={rc(N.webhook)} to={lc(N.botIA)} color={c.botIA} live={liveWA} />
      <Flow from={bc(N.botIA)} to={tc(N.d1)} color={c.d1} live={liveWA} />
      <Flow from={rc(N.sitio)} to={lc(N.paypal)} color={c.paypal} live={liveResv} />
      <Flow from={rc(N.paypal)} to={lc(N.d1)} color={c.d1} live={liveResv} />
      <Flow from={rc(N.airbnb)} to={lc(N.sync)} color={c.airbnb} live={false} dashed />
      <Flow from={rc(N.sync)} to={lc(N.d1)} color={c.d1} live={false} />
      <Flow from={tc(N.cron)} to={bc(N.botIA)} color={c.cron} live={liveCron} />

      {/* Nodos */}
      <Node {...N.clienteWA} emoji="📱" label="Cliente" sub="WhatsApp" color={c.clienteWA} />
      <Node {...N.sitio} emoji="🌐" label="Sitio web" sub="estadiasjacari.com" color={c.sitio} />
      <Node {...N.airbnb} emoji="🏠" label="Airbnb" sub="calendarios" color={c.airbnb} />
      <Node {...N.webhook} emoji="🔗" label="Webhook" sub="recibe mensajes" color={c.webhook} />
      <Node {...N.paypal} emoji="💳" label="PayPal" sub="pagos" color={c.paypal} />
      <Node {...N.sync} emoji="📅" label="Sync iCal" sub="disponibilidad" color={c.sync} />
      <Node {...N.cron} emoji="⏰" label="Cron" sub="seguimientos" color={c.cron} />
      <Node {...N.botIA} emoji="🧠" label="Bot IA" sub="Workers AI" color={c.botIA} highlight />
      <Node {...N.d1} emoji="🗄️" label="Base de datos" sub="Cloudflare D1" color={c.d1} highlight />
    </svg>
  );
}

function Flow({
  from,
  to,
  color,
  live,
  dashed,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: string;
  live: boolean;
  dashed?: boolean;
}) {
  return (
    <g>
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#1e293b" strokeWidth={2} />
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        stroke={color}
        strokeWidth={2}
        strokeDasharray={dashed ? "2 8" : "6 10"}
        opacity={0.9}
      >
        <animate
          attributeName="stroke-dashoffset"
          from={16}
          to={0}
          dur={live ? "0.6s" : "2.2s"}
          repeatCount="indefinite"
        />
      </line>
    </g>
  );
}

function Node({
  x,
  y,
  emoji,
  label,
  sub,
  color,
  highlight,
}: {
  x: number;
  y: number;
  emoji: string;
  label: string;
  sub: string;
  color: string;
  highlight?: boolean;
}) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect
        width={150}
        height={52}
        rx={12}
        fill={highlight ? "#13233d" : "#0f1a2e"}
        stroke={color}
        strokeWidth={highlight ? 2 : 1.2}
        opacity={0.98}
      />
      <text x={16} y={33} fontSize={20}>{emoji}</text>
      <text x={46} y={24} fontSize={12} fontWeight={700} fill="#e5edf7">{label}</text>
      <text x={46} y={39} fontSize={9.5} fill="#7c8db0">{sub}</text>
      <circle cx={136} cy={14} r={4.5} fill={color}>
        <animate attributeName="opacity" values="1;0.35;1" dur="1.8s" repeatCount="indefinite" />
      </circle>
    </g>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-bg rounded-xl p-3">
      <div className="text-xl font-bold text-primary leading-none">{value}</div>
      <div className="text-[11px] text-muted mt-1">{label}</div>
    </div>
  );
}

function HealthItem({ dot, label, detail }: { dot: string; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${dot} shrink-0`} />
      <div className="min-w-0">
        <div className="text-primary font-medium truncate">{label}</div>
        <div className="text-[11px] text-muted truncate">{detail}</div>
      </div>
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <span className={`font-semibold ${accent ?? "text-primary"}`}>{value}</span>
    </div>
  );
}

function TrendChart({ data }: { data: { day: string; c: number }[] }) {
  if (data.length === 0) {
    return <p className="text-muted text-sm">Sin mensajes en los últimos 7 días.</p>;
  }
  const max = Math.max(...data.map((d) => d.c), 1);
  return (
    <div className="flex items-end gap-2 h-28">
      {data.map((d) => {
        const pct = Math.round((d.c / max) * 100);
        const label = d.day.slice(8, 10) + "/" + d.day.slice(5, 7); // DD/MM
        return (
          <div key={d.day} className="flex-1 flex flex-col items-center justify-end h-full">
            <span className="text-[10px] text-muted mb-0.5">{d.c}</span>
            <div className="w-full bg-secondary/70 rounded-t" style={{ height: `${Math.max(pct, 4)}%` }} />
            <span className="text-[9px] text-muted mt-1">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function FunnelStep({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-primary">{label}</span>
        <span className="font-semibold text-primary">{value}</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
