"use client";
//
// /inbox/operacion — Centro de Control (operación en tiempo real).
// Estilo "command center": tema oscuro, glow neón, números mono, diagrama vivo.
// Lee /api/inbox/metrics cada 10s. Protegido con la cookie de sesión del inbox.
//

import { useEffect, useState, useCallback, useRef } from "react";
import { BRAND_PATHS, BRAND_FILL, GOOGLE_G, JACARI_PATH, ROBOT_PATH } from "./brand-logos";

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

// Registro de cambios / mejoras del sistema (curado a mano; lo más nuevo arriba).
// Se muestra al final del Centro de Control como bitácora visible del equipo.
const CHANGELOG: { date: string; items: string[] }[] = [
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
  reservations: { today: number; week: number; month: number; byProperty: { slug: string; c: number }[]; bySource: { source: string; c: number }[] };
  revenue: { direct: { today: number; week: number; month: number }; airbnb: { today: number | null; week: number | null; month: number | null } };
  health: { lastInAt: string | null; lastOutAt: string | null; lastReservationAt: string | null; cronLastAt: string | null; airbnbStatus: "full" | "partial" | "unavailable" | "unknown" };
  botHealth: { inbound: number; botReplies: number; manualReplies: number; escalations: number; fails: number; escalationPct: number };
  trend: { day: string; c: number }[];
  feed: { type: "message" | "reservation"; at: string; text: string; tag?: string }[];
  web?: { viewsToday: number; uniqueToday: number; now: number; topPages: { path: string; c: number }[]; topReferrers: { referrer: string; c: number }[] };
  qa?: {
    lastRun: { ranAt: string | null; analyzed: number; found: number; trigger: string | null } | null;
    findings: { id: number; phone: string; issue: string; severity: string; detail: string; suggestion: string; conv_at: string | null }[];
  };
}

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
function isLive(iso: string | null, minutes = 10): boolean {
  const t = parseUtc(iso);
  return !Number.isNaN(t) && (Date.now() - t) / 60000 <= minutes;
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

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox/metrics");
      if (res.status === 401) { setAuthed(false); return; }
      const data = (await res.json()) as Metrics & { ok: boolean };
      if (data.ok) {
        setAuthed(true);
        setMetrics(data);
        setPulse(true);
        setTimeout(() => setPulse(false), 700);
      }
    } catch { /* keep previous */ }
  }, []);

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

  // Ingresos: si ya hay datos de Airbnb (cron corrió), mostramos el TOTAL
  // (directo + Airbnb) y el desglose en el footer; si no, solo lo directo.
  const rev = m.revenue;
  const hasAirbnb = rev.airbnb.month !== null;
  const sumRev = (d: number, a: number | null) => d + (a ?? 0);
  const fmt$ = (n: number) => `$${n.toLocaleString("en-US")}`;
  const incomeFooter = hasAirbnb
    ? `30d: directo ${fmt$(rev.direct.month)} · Airbnb ${fmt$(rev.airbnb.month ?? 0)}`
    : "directo · Airbnb al activar PayPal";

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
        <a href="/inbox" className="px-3 py-1.5 border border-white/15 rounded-lg hover:bg-white/5 text-slate-300 text-sm">← Inbox</a>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 space-y-5">
        {/* KPIs — cada card con hoy / 7 días / 30 días */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi icon="📨" label="Mensajes" hoy={m.messages.today} week={m.messages.week} month={m.messages.month} glow={HEX.cyan} />
          <Kpi icon="💬" label="Conversaciones" hoy={m.conversations.today} week={m.conversations.week} month={m.conversations.month} glow="#a78bfa" />
          <Kpi icon="🏠" label="Reservas" hoy={m.reservations.today} week={m.reservations.week} month={m.reservations.month} glow={HEX.green} />
          <Kpi icon="💰" label="Ingresos" hoy={sumRev(rev.direct.today, rev.airbnb.today)} week={sumRev(rev.direct.week, rev.airbnb.week)} month={sumRev(rev.direct.month, rev.airbnb.month)} prefix="$" glow={HEX.amber} footer={incomeFooter} />
        </section>

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
              <HealthItem hex={recencyHex(m.health.lastOutAt)} label="Bot IA" detail={`últ. ${timeAgo(m.health.lastOutAt)}`} />
              <HealthItem hex={airbnbHex(m.health.airbnbStatus)} label="Airbnb" detail={AIRBNB_LABEL[m.health.airbnbStatus]} />
              <HealthItem hex={cronHex(m.health.cronLastAt)} label="Seguimientos" detail={`últ. ${timeAgo(m.health.cronLastAt)}`} />
              <HealthItem hex={recencyHex(m.health.lastReservationAt, 24 * 30)} label="Reservas / PayPal" detail={`últ. ${timeAgo(m.health.lastReservationAt)}`} />
              <HealthItem hex={HEX.green} label="Base de datos" detail="operativa" />
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

        {/* Tráfico web */}
        {m.web && (
          <Panel title="🌐 Tráfico web" subtitle={m.web.now > 0 ? `🟢 ${m.web.now} ${m.web.now === 1 ? "persona" : "personas"} ahora` : undefined}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <MiniStat label="Visitas hoy" value={m.web.viewsToday} />
              <MiniStat label="Únicos hoy" value={m.web.uniqueToday} />
              <MiniStat label="Ahora en el sitio" value={m.web.now} accent />
              <MiniStat label="Vistas hoy" value={m.web.topPages.reduce((s, p) => s + p.c, 0)} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <MiniList title="Páginas más vistas (hoy)" rows={m.web.topPages.map((p) => ({ label: p.path, value: p.c }))} empty="Sin visitas hoy todavía." />
              <MiniList title="De dónde llegan (7d)" rows={m.web.topReferrers.map((r) => ({ label: REFERRER_NAMES[r.referrer] ?? r.referrer, value: r.c }))} empty="Tráfico directo o sin datos." />
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

function MiniStat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
      <div className={`font-mono text-2xl font-bold leading-none ${accent ? "text-green-400" : "text-slate-100"}`}>{value}</div>
      <div className="text-[11px] text-slate-500 mt-1">{label}</div>
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
    bot: recencyHex(health.lastOutAt),
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
