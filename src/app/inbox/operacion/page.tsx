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
