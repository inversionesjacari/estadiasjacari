"use client";
//
// /inbox/pagos — "Pagos por cobrar" (incidente 2026-08-19).
//
// Durante el tiempo en que el flujo del bot no capturaba, cada huésped que pagó
// por link dejó su orden APROBADA pero SIN COBRAR: él vio la retención en su
// tarjeta y a Jacarí nunca le entró la plata. Esta pantalla existe para verla y
// cobrarla con un botón, sin consola ni comandos.
//
// Al cobrar, PayPal dispara PAYMENT.CAPTURE.COMPLETED y de ahí el sistema sigue
// solo: crea la reserva y le escribe al huésped.
//

import { useCallback, useState } from "react";

interface Item {
  orderId: string;
  phone: string;
  linkEnviado: string;
  estado: string;
  montoUsd: number | null;
  cobrable: boolean;
  detalle?: string;
}

interface Resumen {
  linksRevisados: number;
  yaCobradas: number;
  pagadasSinCobrar: number;
  plataColgadaUsd: number;
  nuncaPagaron: number;
}

const ESTADO_LABEL: Record<string, { text: string; cls: string }> = {
  APPROVED: { text: "💰 Pagó y NO se cobró", cls: "text-amber-200 border-amber-400/50 bg-amber-400/10" },
  COMPLETED: { text: "✓ Ya cobrada", cls: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" },
  CREATED: { text: "Abrió el link, no pagó", cls: "text-slate-400 border-white/15 bg-white/5" },
  VOIDED: { text: "Anulada / vencida", cls: "text-rose-300 border-rose-500/40 bg-rose-500/10" },
  ERROR: { text: "No se pudo leer", cls: "text-rose-300 border-rose-500/40 bg-rose-500/10" },
};

function fmtFecha(ts: string): string {
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  const d = new Date(/[Z+]/.test(iso.slice(10)) ? iso : `${iso}Z`);
  if (isNaN(d.getTime())) return ts;
  return new Intl.DateTimeFormat("es-HN", {
    timeZone: "America/Tegucigalpa", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(d);
}

export default function PagosPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [cobrando, setCobrando] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});

  const revisar = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/inbox/paypal-pending", { credentials: "include" });
      if (r.status === 401 || r.status === 403) {
        setError("Entrá al inbox como propietario para ver esto.");
        return;
      }
      const d = (await r.json()) as { ok?: boolean; resumen?: Resumen; todas?: Item[]; error?: string };
      if (!d.ok) {
        setError(d.error || "No se pudo consultar PayPal.");
        return;
      }
      setResumen(d.resumen ?? null);
      // Lo cobrable primero: es lo único que pide acción.
      setItems([...(d.todas ?? [])].sort((a, b) => Number(b.cobrable) - Number(a.cobrable)));
    } catch {
      setError("Error de red. Reintentá.");
    } finally {
      setLoading(false);
    }
  }, []);

  const cobrar = useCallback(async (it: Item) => {
    if (cobrando[it.orderId]) return;
    const monto = it.montoUsd != null ? `USD ${it.montoUsd}` : "este pago";
    if (!window.confirm(`¿Cobrar ${monto} de +${it.phone}?\n\nSe le carga a la tarjeta que el huésped ya autorizó y el sistema le manda la confirmación solo.`)) return;
    setCobrando((s) => ({ ...s, [it.orderId]: true }));
    setMsg((m) => ({ ...m, [it.orderId]: "" }));
    try {
      const r = await fetch("/api/inbox/paypal-pending", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: it.orderId }),
      });
      const d = (await r.json()) as { ok?: boolean; cobradaAhora?: boolean; montoUsd?: number; error?: string; accion?: string };
      if (d.ok) {
        setMsg((m) => ({ ...m, [it.orderId]: d.cobradaAhora ? `✓ Cobrado USD ${d.montoUsd ?? ""}` : "Ya estaba cobrada" }));
        setItems((prev) => prev.map((x) => (x.orderId === it.orderId ? { ...x, estado: "COMPLETED", cobrable: false } : x)));
      } else {
        setMsg((m) => ({ ...m, [it.orderId]: [d.error, d.accion].filter(Boolean).join(" · ").slice(0, 200) }));
      }
    } catch {
      setMsg((m) => ({ ...m, [it.orderId]: "error de red" }));
    } finally {
      setCobrando((s) => ({ ...s, [it.orderId]: false }));
    }
  }, [cobrando]);

  const cobrables = items.filter((i) => i.cobrable);

  return (
    <div className="min-h-screen bg-[#070b16] text-slate-200">
      <header className="border-b border-white/10 px-5 py-3 flex items-center justify-between sticky top-0 z-10 bg-[#070b16]/90 backdrop-blur">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">💰 Pagos por cobrar</h1>
          <p className="text-[12px] text-slate-400">Pagos que el huésped autorizó y quedaron sin cobrar</p>
        </div>
        <a href="/inbox" className="px-3 py-1.5 border border-white/15 rounded-lg hover:bg-white/5 text-slate-300 text-sm">← Inbox</a>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <p className="text-[13px] text-slate-300 leading-relaxed">
            Revisa en PayPal todos los links de pago que mandó el bot en los últimos 90 días y te dice
            cuáles quedaron <b className="text-amber-200">pagados pero sin cobrar</b>. Tocá el botón para verlos.
          </p>
          <button
            type="button"
            onClick={revisar}
            disabled={loading}
            className="mt-4 w-full px-4 py-3 rounded-xl text-sm font-semibold border border-cyan-500/40 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-50"
          >
            {loading ? "Consultando PayPal… (puede tardar unos segundos)" : "🔎 Revisar pagos en PayPal"}
          </button>
          {error && <p className="text-[13px] text-rose-300 mt-3">{error}</p>}
        </div>

        {resumen && (
          <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="grid grid-cols-2 gap-4 text-center">
              <div>
                <div className="text-2xl font-bold text-amber-200">${resumen.plataColgadaUsd.toLocaleString("en-US")}</div>
                <div className="text-[11px] text-slate-400 mt-0.5">sin cobrar ({resumen.pagadasSinCobrar} pago{resumen.pagadasSinCobrar === 1 ? "" : "s"})</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-emerald-300">{resumen.yaCobradas}</div>
                <div className="text-[11px] text-slate-400 mt-0.5">ya cobradas</div>
              </div>
            </div>
            <p className="text-[11px] text-slate-500 text-center mt-3">
              {resumen.linksRevisados} links revisados · {resumen.nuncaPagaron} abrieron el link y no pagaron
            </p>
          </div>
        )}

        {cobrables.length > 0 && (
          <p className="text-[13px] text-amber-200 mt-6 mb-2 font-semibold">
            ⚠️ Estos pagaron y hay que cobrarlos — las autorizaciones vencen en días
          </p>
        )}

        <div className="mt-2 space-y-2">
          {items.map((it) => {
            const badge = ESTADO_LABEL[it.estado] ?? { text: it.estado, cls: "text-slate-400 border-white/15 bg-white/5" };
            return (
              <div
                key={it.orderId}
                className={`rounded-xl border p-3.5 ${it.cobrable ? "border-amber-400/40 bg-amber-400/[0.05]" : "border-white/8 bg-white/[0.02]"}`}
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <a href={`/inbox?c=${it.phone}`} className="text-sm font-medium text-cyan-300 hover:text-cyan-200">
                        +{it.phone}
                      </a>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badge.cls}`}>{badge.text}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1">
                      {it.montoUsd != null ? <b className="text-slate-300">USD {it.montoUsd}</b> : "monto —"} · link enviado {fmtFecha(it.linkEnviado)}
                    </div>
                    {it.detalle && <div className="text-[10px] text-rose-300/80 mt-1 max-w-[420px]">{it.detalle}</div>}
                  </div>
                  {it.cobrable && (
                    <button
                      type="button"
                      disabled={Boolean(cobrando[it.orderId])}
                      onClick={() => cobrar(it)}
                      className="shrink-0 px-3 py-2 rounded-lg text-sm font-semibold border border-emerald-500/50 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-50"
                    >
                      {cobrando[it.orderId] ? "cobrando…" : `💵 Cobrar${it.montoUsd != null ? ` $${it.montoUsd}` : ""}`}
                    </button>
                  )}
                </div>
                {msg[it.orderId] && (
                  <p className="text-[11px] text-slate-300 mt-2 border-t border-white/5 pt-2">{msg[it.orderId]}</p>
                )}
              </div>
            );
          })}
        </div>

        {resumen && items.length === 0 && (
          <p className="text-center text-slate-500 py-10">No se encontraron links de pago en los últimos 90 días.</p>
        )}

        <p className="text-[11px] text-slate-600 text-center mt-8 leading-relaxed">
          Al cobrar se le carga a la tarjeta que el huésped YA autorizó — no se le pide nada de nuevo.
          El sistema crea la reserva y le manda la confirmación solo. Si una orden ya venció, no se puede
          cobrar: hay que mandarle un link de pago nuevo.
        </p>
      </main>
    </div>
  );
}
