"use client";
//
// /inbox/operacion — Centro de Control (operación en tiempo real).
// Estilo "command center": tema oscuro, glow neón, números mono, diagrama vivo.
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

interface Metrics {
  generatedAt: string;
  messages: { todayIn: number; todayOut: number; weekIn: number; weekOut: number; uniqueToday: number; uniqueWeek: number };
  funnel: { awaitingData: number; quoteProvided: number; awaitingPaymentMethod: number; awaitingPaypal: number; awaitingTransfer: number; total: number };
  reservations: { today: number; week: number; month: number; byProperty: { slug: string; c: number }[]; bySource: { source: string; c: number }[]; revenueWeekUsd: number };
  health: { lastInAt: string | null; lastOutAt: string | null; lastReservationAt: string | null; cronLastAt: string | null; airbnbStatus: "full" | "partial" | "unavailable" | "unknown" };
  botHealth: { inbound: number; botReplies: number; manualReplies: number; escalations: number; fails: number; escalationPct: number };
  trend: { day: string; c: number }[];
  feed: { type: "message" | "reservation"; at: string; text: string; tag?: string }[];
  web?: { viewsToday: number; uniqueToday: number; now: number; topPages: { path: string; c: number }[]; topReferrers: { referrer: string; c: number }[] };
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
function airbnbHex(s: string): string {
  return s === "full" ? HEX.green : s === "partial" ? HEX.amber : s === "unavailable" ? HEX.red : HEX.gray;
}
function isLive(iso: string | null, minutes = 10): boolean {
  const t = parseUtc(iso);
  return !Number.isNaN(t) && (Date.now() - t) / 60000 <= minutes;
}
const AIRBNB_LABEL: Record<string, string> = {
  full: "Sincronizado", partial: "Parcial", unavailable: "No responde", unknown: "Sin verificar",
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
        {/* KPIs */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi icon="📨" label="Mensajes hoy" value={m.messages.todayIn + m.messages.todayOut} detail={`${m.messages.todayIn} in · ${m.messages.todayOut} out`} glow={HEX.cyan} />
          <Kpi icon="💬" label="Conversaciones hoy" value={m.messages.uniqueToday} detail={`${m.messages.uniqueWeek} esta semana`} glow="#a78bfa" />
          <Kpi icon="🏠" label="Reservas (semana)" value={m.reservations.week} detail={`hoy ${m.reservations.today} · mes ${m.reservations.month}`} glow={HEX.green} />
          <Kpi icon="💰" label="Ingresos (7d)" value={m.reservations.revenueWeekUsd} prefix="$" detail="pagadas + pendientes" glow={HEX.amber} />
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

function Kpi({ icon, label, value, detail, glow, prefix }: { icon: string; label: string; value: number; detail: string; glow: string; prefix?: string }) {
  const animated = useCountUp(value);
  return (
    <div className="relative rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur p-4 overflow-hidden">
      <div className="absolute -top-8 -right-8 w-24 h-24 rounded-full opacity-20 blur-2xl" style={{ background: glow }} />
      <div className="text-xl mb-1.5">{icon}</div>
      <div className="font-mono text-3xl font-bold leading-none" style={{ color: glow, textShadow: `0 0 18px ${glow}55` }}>
        {prefix}{animated.toLocaleString("en-US")}
      </div>
      <div className="text-[13px] font-medium text-slate-200 mt-1.5">{label}</div>
      <div className="text-[11px] text-slate-500 mt-0.5">{detail}</div>
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

const W = 168, H = 60;
const rc = (n: { x: number; y: number }) => ({ x: n.x + W, y: n.y + H / 2 });
const lc = (n: { x: number; y: number }) => ({ x: n.x, y: n.y + H / 2 });
const bc = (n: { x: number; y: number }) => ({ x: n.x + W / 2, y: n.y + H });
const tc = (n: { x: number; y: number }) => ({ x: n.x + W / 2, y: n.y });

function ArchitectureDiagram({ health }: { health: Metrics["health"] }) {
  const c = {
    clienteWA: recencyHex(health.lastInAt),
    webhook: recencyHex(health.lastInAt),
    botIA: recencyHex(health.lastOutAt),
    d1: HEX.green,
    sitio: HEX.green,
    paypal: recencyHex(health.lastReservationAt, 24 * 30),
    airbnb: airbnbHex(health.airbnbStatus),
    sync: airbnbHex(health.airbnbStatus),
    cron: cronHex(health.cronLastAt),
  };
  const liveWA = isLive(health.lastInAt);
  const liveResv = isLive(health.lastReservationAt, 60);
  const liveCron = isLive(health.cronLastAt, 15);

  // 3 carriles horizontales (entradas → proceso → núcleo)
  const COL = { in: 30, mid: 300, core: 600 };
  const N = {
    clienteWA: { x: COL.in, y: 60 }, sitio: { x: COL.in, y: 210 }, airbnb: { x: COL.in, y: 360 },
    webhook: { x: COL.mid, y: 60 }, paypal: { x: COL.mid, y: 210 }, sync: { x: COL.mid, y: 360 },
    cron: { x: COL.mid, y: 470 },
    botIA: { x: COL.core, y: 120 }, d1: { x: COL.core, y: 300 },
  };

  return (
    <svg viewBox="0 0 800 560" className="w-full" style={{ maxHeight: 560 }}>
      <defs>
        <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* Etiquetas de carril */}
      <text x={COL.in + W / 2} y={32} fontSize={11} fontWeight={700} fill="#3f5170" textAnchor="middle" letterSpacing="2">ENTRADAS</text>
      <text x={COL.mid + W / 2} y={32} fontSize={11} fontWeight={700} fill="#3f5170" textAnchor="middle" letterSpacing="2">PROCESO</text>
      <text x={COL.core + W / 2} y={32} fontSize={11} fontWeight={700} fill="#3f5170" textAnchor="middle" letterSpacing="2">NÚCLEO</text>

      {/* Conexiones (curvas) */}
      <Flow from={rc(N.clienteWA)} to={lc(N.webhook)} color={c.webhook} live={liveWA} />
      <Flow from={rc(N.webhook)} to={lc(N.botIA)} color={c.botIA} live={liveWA} />
      <Flow from={rc(N.sitio)} to={lc(N.paypal)} color={c.paypal} live={liveResv} />
      <Flow from={rc(N.airbnb)} to={lc(N.sync)} color={c.airbnb} live={false} dashed />
      <Flow from={rc(N.paypal)} to={lc(N.d1)} color={c.paypal} live={liveResv} />
      <Flow from={rc(N.sync)} to={lc(N.d1)} color={c.sync} live={false} />
      <Flow from={bc(N.botIA)} to={tc(N.d1)} color={c.botIA} live={liveWA} />
      <Flow from={rc(N.cron)} to={lc(N.d1)} color={c.cron} live={liveCron} />

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

/** Curva bezier horizontal suave entre dos puntos. */
function curvePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const mx = (a.x + b.x) / 2;
  return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
}

function Flow({ from, to, color, live, dashed }: { from: { x: number; y: number }; to: { x: number; y: number }; color: string; live: boolean; dashed?: boolean }) {
  const d = curvePath(from, to);
  return (
    <g>
      {/* riel base sutil (más delgado que el flujo) */}
      <path d={d} fill="none" stroke="#172339" strokeWidth={1.5} />
      {/* halo de color tenue para que "ilumine" el camino */}
      <path d={d} fill="none" stroke={color} strokeWidth={5} opacity={0.18} filter="url(#glow)" />
      {/* flujo animado de color (denso y brillante) */}
      <path d={d} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeDasharray={dashed ? "2 7" : "5 7"} opacity={1} filter="url(#glow)">
        <animate attributeName="stroke-dashoffset" from={12} to={0} dur={live ? "0.5s" : "2s"} repeatCount="indefinite" />
      </path>
    </g>
  );
}

function Node({ x, y, emoji, label, sub, color, highlight }: { x: number; y: number; emoji: string; label: string; sub: string; color: string; highlight?: boolean }) {
  return (
    <g transform={`translate(${x},${y})`}>
      {/* sombra/halo */}
      <rect width={W} height={H} rx={14} fill="#0c1626" />
      {/* borde base siempre legible + acento del color de salud */}
      <rect width={W} height={H} rx={14} fill={highlight ? "#10203a" : "#0e1a2e"} stroke="#2b3a55" strokeWidth={1.5} />
      <rect width={W} height={H} rx={14} fill="none" stroke={color} strokeWidth={highlight ? 2 : 1.5} opacity={0.85} />
      {/* ícono en chip */}
      <rect x={12} y={14} width={32} height={32} rx={8} fill="#0a1322" stroke="#243349" strokeWidth={1} />
      <text x={28} y={36} fontSize={18} textAnchor="middle">{emoji}</text>
      {/* textos */}
      <text x={54} y={27} fontSize={13} fontWeight={700} fill="#f1f6fd">{label}</text>
      <text x={54} y={43} fontSize={10} fill="#94a6c4">{sub}</text>
      {/* punto de estado con halo */}
      <circle cx={W - 16} cy={16} r={5} fill={color} filter="url(#glow)">
        <animate attributeName="opacity" values="1;0.35;1" dur="2s" repeatCount="indefinite" />
      </circle>
    </g>
  );
}
