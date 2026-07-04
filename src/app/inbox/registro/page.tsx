"use client";
//
// /inbox/registro — Registro de huéspedes (planilla tipo Excel).
//
// Una fila por reserva (confirmada o con depósito/por verificar), pasada o futura:
// huésped, teléfono, propiedad, fechas, personas y el PAGO en Lempiras (total /
// pagado / saldo) con su estado real. Ordenable, con buscador + filtros, botón
// "Exportar a Excel (CSV)", alta manual ("➕ Agregar") y edición del pago por fila
// ("💲 Pago"). Datos en vivo de /api/inbox/reservations-registry.
//

import { useEffect, useState, useCallback, useMemo } from "react";
import { getProperty, properties } from "@/data/properties";

interface Reservation {
  id: number;
  property_slug: string;
  check_in: string;
  check_out: string;
  guest_name: string | null;
  guest_phone: string | null;
  guest_count: number | null;
  amount_usd: number | null;
  total_hnl: number | null;
  paid_hnl: number | null;
  source: string;
  status: string;
  created_at: string;
}

const SOURCE_LABEL: Record<string, string> = {
  airbnb: "Airbnb",
  website: "Web",
  whatsapp_bot: "WhatsApp",
  whatsapp_transfer: "Transferencia",
  manual: "Manual",
};

function sourceLabel(s: string): string {
  return SOURCE_LABEL[s] ?? s;
}

const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${String(d).padStart(2, "0")} ${MONTHS_ES[m - 1]} ${y}`;
}

function nights(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/** Lempiras sin decimales: 2500 → "L 2,500". */
function fmtL(n: number): string {
  return `L ${Math.round(n).toLocaleString("es-HN")}`;
}

const PAY_GREEN = "text-emerald-300 border-emerald-500/40 bg-emerald-500/10";
const PAY_AMBER = "text-amber-300 border-amber-500/40 bg-amber-500/10";
const PAY_ROSE = "text-rose-300 border-rose-500/40 bg-rose-500/10";

/** Estado del pago a partir de total/pagado en LPS; si no hay total LPS, cae al status. */
function paymentBadge(r: Reservation): { text: string; cls: string; saldo: number | null } {
  if (r.total_hnl != null) {
    const total = r.total_hnl;
    const paid = r.paid_hnl ?? 0;
    const saldo = Math.max(0, total - paid);
    if (paid >= total) return { text: "Pagado", cls: PAY_GREEN, saldo: 0 };
    if (paid > 0) return { text: `Depósito · falta ${fmtL(saldo)}`, cls: PAY_AMBER, saldo };
    return { text: "Sin pago", cls: PAY_ROSE, saldo };
  }
  // Transferencia / alta manual SIN contabilidad en Lempiras: NO afirmar "Pagado"
  // (engañoso — caso Sandra). Pedir cargar el total/pagado real con el botón 💲 Pago.
  // Las de PayPal (web/airbnb/bot) sí se cobraron de verdad → ahí el status manda.
  if (r.source === "whatsapp_transfer" || r.source === "manual") {
    return { text: "Falta cargar pago", cls: PAY_AMBER, saldo: null };
  }
  if (r.status === "confirmed") return { text: "Pagado", cls: PAY_GREEN, saldo: null };
  return { text: "Pendiente", cls: PAY_AMBER, saldo: null };
}

type SortKey = "check_in" | "guest_name" | "property" | "total" | "paid" | "status" | "created_at" | "source";

const COLUMNS: { key: SortKey | null; label: string; align?: "right" }[] = [
  { key: "guest_name", label: "Huésped" },
  { key: null, label: "Teléfono" },
  { key: "property", label: "Propiedad" },
  { key: null, label: "Pers.", align: "right" },
  { key: "check_in", label: "Entra" },
  { key: null, label: "Sale" },
  { key: null, label: "Noches", align: "right" },
  { key: "total", label: "Total", align: "right" },
  { key: "paid", label: "Pagado", align: "right" },
  { key: "source", label: "Origen" },
  { key: "status", label: "Estado" },
  { key: "created_at", label: "Reservada" },
  { key: null, label: "" },
];

const EMPTY_FORM = {
  guest_name: "", guest_phone: "", property_slug: "",
  check_in: "", check_out: "", guest_count: "", total_hnl: "", paid_hnl: "",
  booked_at: "",
};

const INPUT_CLS =
  "w-full px-3 py-2 bg-white/[0.04] border border-white/10 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50";

export default function RegistroPage() {
  const [authed, setAuthed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [propFilter, setPropFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("check_in");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Alta manual
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  // Edición de pago de una reserva existente
  const [payRes, setPayRes] = useState<Reservation | null>(null);
  const [payForm, setPayForm] = useState({ total_hnl: "", paid_hnl: "" });
  const [savingPay, setSavingPay] = useState(false);
  const [payError, setPayError] = useState("");

  const fetchData = useCallback(async (): Promise<void> => {
    try {
      const resp = await fetch("/api/inbox/reservations-registry", { credentials: "include" });
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
      console.error("registro fetch error", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetchData();
    };
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [fetchData]);

  // Prefill desde un chat: /inbox/registro?nueva=1&phone=...&name=...&prop=slug
  // Abre el form de nueva reserva ya con los datos del huésped cargados.
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get("nueva") !== "1") return;
      setForm((f) => ({
        ...f,
        guest_phone: sp.get("phone") ?? f.guest_phone,
        guest_name: sp.get("name") ?? f.guest_name,
        property_slug: sp.get("prop") ?? f.property_slug,
      }));
      setShowAdd(true);
      window.history.replaceState({}, "", "/inbox/registro"); // limpiar para no re-abrir al recargar
    } catch {
      /* ignore */
    }
  }, []);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "guest_name" || key === "property" || key === "source" ? "asc" : "desc");
    }
  };

  const slugsPresent = useMemo(
    () => Array.from(new Set(reservations.map((r) => r.property_slug))),
    [reservations],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = reservations.filter((r) => {
      if (propFilter && r.property_slug !== propFilter) return false;
      if (statusFilter && r.status !== statusFilter) return false;
      if (q) {
        const hay = `${r.guest_name ?? ""} ${r.guest_phone ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (r: Reservation): string | number => {
      switch (sortKey) {
        case "guest_name": return (r.guest_name ?? "").toLowerCase();
        case "property": return (getProperty(r.property_slug)?.name ?? r.property_slug).toLowerCase();
        case "total": return r.total_hnl ?? r.amount_usd ?? -1;
        case "paid": return r.paid_hnl ?? -1;
        case "status": return r.status;
        case "source": return r.source;
        case "created_at": return r.created_at;
        case "check_in":
        default: return r.check_in;
      }
    };
    return [...rows].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }, [reservations, propFilter, statusFilter, search, sortKey, sortDir]);

  const exportCsv = useCallback(() => {
    const headers = ["Huésped", "Teléfono", "Propiedad", "Ciudad", "Personas", "Entra", "Sale", "Noches", "Total LPS", "Pagado LPS", "Saldo LPS", "Estado", "Origen", "Reservada"];
    const esc = (v: unknown): string => {
      const s = v == null ? "" : String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(",")];
    for (const r of filtered) {
      const prop = getProperty(r.property_slug);
      const pay = paymentBadge(r);
      const total = r.total_hnl != null ? Math.round(r.total_hnl) : "";
      const paid = r.total_hnl != null ? Math.round(r.paid_hnl ?? 0) : "";
      const saldo = pay.saldo != null ? Math.round(pay.saldo) : "";
      lines.push([
        r.guest_name ?? "",
        r.guest_phone ?? "",
        prop?.name ?? r.property_slug,
        prop?.city ?? "",
        r.guest_count ?? "",
        r.check_in,
        r.check_out,
        nights(r.check_in, r.check_out),
        total,
        paid,
        saldo,
        pay.text,
        sourceLabel(r.source),
        (r.created_at ?? "").slice(0, 10),
      ].map(esc).join(","));
    }
    // BOM (U+FEFF) al inicio para que Excel respete los acentos al abrir el CSV.
    const blob = new Blob([String.fromCharCode(0xFEFF) + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `registro-reservas-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filtered]);

  const submitAdd = useCallback(async (): Promise<void> => {
    setFormError("");
    if (!form.property_slug) { setFormError("Elegí una propiedad."); return; }
    if (!form.check_in || !form.check_out) { setFormError("Poné la llegada y la salida."); return; }
    if (form.check_out <= form.check_in) { setFormError("La salida tiene que ser después de la llegada."); return; }
    if (!form.guest_name.trim() && !form.guest_phone.trim()) { setFormError("Poné al menos el nombre o el teléfono."); return; }
    setSaving(true);
    try {
      const resp = await fetch("/api/inbox/reservation-create", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (resp.status === 401) { setAuthed(false); return; }
      const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (data.ok) {
        setShowAdd(false);
        setForm(EMPTY_FORM);
        fetchData();
      } else {
        setFormError(data.error || "No se pudo guardar.");
      }
    } catch {
      setFormError("Error de red.");
    } finally {
      setSaving(false);
    }
  }, [form, fetchData]);

  const openPay = (r: Reservation) => {
    setPayRes(r);
    setPayForm({
      total_hnl: r.total_hnl != null ? String(Math.round(r.total_hnl)) : "",
      paid_hnl: r.paid_hnl != null ? String(Math.round(r.paid_hnl)) : "",
    });
    setPayError("");
  };

  const submitPay = useCallback(async (): Promise<void> => {
    if (!payRes) return;
    setPayError("");
    if (!payForm.total_hnl.trim() || Number(payForm.total_hnl) <= 0) { setPayError("Poné el total (en Lempiras)."); return; }
    setSavingPay(true);
    try {
      const resp = await fetch("/api/inbox/reservation-payment", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: payRes.id, total_hnl: payForm.total_hnl, paid_hnl: payForm.paid_hnl }),
      });
      if (resp.status === 401) { setAuthed(false); return; }
      const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (data.ok) {
        setPayRes(null);
        fetchData();
      } else {
        setPayError(data.error || "No se pudo guardar.");
      }
    } catch {
      setPayError("Error de red.");
    } finally {
      setSavingPay(false);
    }
  }, [payRes, payForm, fetchData]);

  const confirmedCount = reservations.filter((r) => r.status === "confirmed").length;
  const pendingCount = reservations.filter((r) => r.status === "pending").length;

  // Saldo vivo en el modal de pago (para mostrarlo mientras escribe).
  const payTotal = Number(payForm.total_hnl);
  const payPaid = Number(payForm.paid_hnl);
  const paySaldo = Number.isFinite(payTotal) && payTotal > 0 ? Math.max(0, payTotal - (Number.isFinite(payPaid) ? payPaid : 0)) : null;

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

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  return (
    <div className="min-h-screen bg-[#070b16] text-slate-200">
      {/* Header */}
      <header className="border-b border-white/10 px-5 py-3 flex items-center justify-between gap-3 sticky top-0 z-10 bg-[#070b16]/90 backdrop-blur">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white tracking-tight">📋 Registro de reservas</h1>
          <p className="text-[12px] text-slate-400">
            {reservations.length} en total · {confirmedCount} pagadas · {pendingCount} pendientes
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => { setForm(EMPTY_FORM); setFormError(""); setShowAdd(true); }}
            className="px-3 py-1.5 rounded-lg text-sm font-medium border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20"
            title="Cargar a mano una reserva (directa, o una que el bot no registró)"
          >
            ➕ Agregar
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="px-3 py-1.5 rounded-lg text-sm font-medium border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
            title="Descargar lo que estás viendo como planilla (.csv, abre en Excel)"
          >
            ⬇ Exportar a Excel
          </button>
          <a href="/inbox" className="px-3 py-1.5 border border-white/15 rounded-lg hover:bg-white/5 text-slate-300 text-sm">← Inbox</a>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-5">
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
              <option key={slug} value={slug}>{getProperty(slug)?.name ?? slug}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 bg-white/[0.04] border border-white/10 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50"
          >
            <option value="">Todos los estados</option>
            <option value="confirmed">Pagadas</option>
            <option value="pending">Pendientes</option>
          </select>
          <span className="text-[12px] text-slate-500 ml-auto">{filtered.length} mostradas</span>
        </div>

        {loading && reservations.length === 0 ? (
          <p className="text-center text-slate-500 py-16">Cargando registro…</p>
        ) : filtered.length === 0 ? (
          <p className="text-center text-slate-500 py-16">
            {reservations.length === 0 ? "Todavía no hay reservas registradas." : "Ninguna reserva coincide con el filtro."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-[13px] whitespace-nowrap">
              <thead>
                <tr className="bg-white/[0.04] text-slate-400 text-left">
                  {COLUMNS.map((c, i) => (
                    <th
                      key={i}
                      className={`px-3 py-2 font-medium ${c.align === "right" ? "text-right" : ""} ${c.key ? "cursor-pointer select-none hover:text-slate-200" : ""}`}
                      onClick={c.key ? () => toggleSort(c.key as SortKey) : undefined}
                    >
                      {c.label}{c.key ? sortArrow(c.key) : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const prop = getProperty(r.property_slug);
                  const pay = paymentBadge(r);
                  const phoneDigits = r.guest_phone ? r.guest_phone.replace(/\D/g, "") : "";
                  return (
                    <tr key={r.id} className="border-t border-white/5 hover:bg-white/[0.03]">
                      <td className="px-3 py-2 text-white font-medium max-w-[180px] truncate" title={r.guest_name ?? ""}>
                        {r.guest_name || "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-300">{r.guest_phone || "—"}</td>
                      <td className="px-3 py-2 text-slate-300">
                        {prop?.name ?? r.property_slug}
                        {prop?.city ? <span className="text-slate-500"> · {prop.city}</span> : null}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-300">{r.guest_count ?? "—"}</td>
                      <td className="px-3 py-2 text-slate-300">{fmtDate(r.check_in)}</td>
                      <td className="px-3 py-2 text-slate-300">{fmtDate(r.check_out)}</td>
                      <td className="px-3 py-2 text-right text-slate-400">{nights(r.check_in, r.check_out)}</td>
                      <td className="px-3 py-2 text-right text-slate-200">
                        {r.total_hnl != null
                          ? fmtL(r.total_hnl)
                          : r.amount_usd != null ? `$${r.amount_usd.toLocaleString("en-US")}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-200">
                        {r.total_hnl != null ? fmtL(r.paid_hnl ?? 0) : "—"}
                      </td>
                      <td className="px-3 py-2 text-slate-400">{sourceLabel(r.source)}</td>
                      <td className="px-3 py-2">
                        <span className={`text-[11px] px-2 py-0.5 rounded-full border ${pay.cls}`}>{pay.text}</span>
                      </td>
                      <td className="px-3 py-2 text-slate-500">{(r.created_at ?? "").slice(0, 10)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => openPay(r)}
                            className="text-[11px] text-amber-200 border border-amber-400/40 rounded px-1.5 py-0.5 hover:bg-amber-400/10"
                            title="Cargar / corregir el pago de esta reserva"
                          >
                            💲 Pago
                          </button>
                          {phoneDigits ? (
                            <a
                              href={`/inbox?c=${phoneDigits}`}
                              className="text-[11px] text-cyan-300 border border-cyan-500/30 rounded px-1.5 py-0.5 hover:bg-cyan-500/10"
                            >
                              Chat
                            </a>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-slate-600 text-center mt-5">
          Montos en Lempiras. El estado muestra si está pagada o cuánto falta. El botón exporta lo que estés viendo (con los filtros aplicados).
        </p>
      </main>

      {/* ── Modal: agregar reserva ──────────────────────────────────────────── */}
      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => { if (!saving) setShowAdd(false); }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0c1322] p-5 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-white">➕ Agregar reserva</h2>
            <p className="text-[12px] text-slate-400 mb-4">
              Reservas directas, o una que el bot hizo y no quedó registrada. Bloquea el calendario para esas fechas.
            </p>

            <label className="block text-[12px] text-slate-400 mb-1">Nombre del huésped</label>
            <input value={form.guest_name} onChange={(e) => setForm((f) => ({ ...f, guest_name: e.target.value }))} placeholder="Ej: Sandra Lagos" className={INPUT_CLS} />

            <label className="block text-[12px] text-slate-400 mb-1 mt-3">Teléfono (WhatsApp)</label>
            <input value={form.guest_phone} onChange={(e) => setForm((f) => ({ ...f, guest_phone: e.target.value }))} placeholder="Ej: 9621-2568" className={INPUT_CLS} />

            <label className="block text-[12px] text-slate-400 mb-1 mt-3">Propiedad</label>
            <select value={form.property_slug} onChange={(e) => setForm((f) => ({ ...f, property_slug: e.target.value }))} className={INPUT_CLS}>
              <option value="">Elegí una propiedad…</option>
              {properties.map((p) => (
                <option key={p.slug} value={p.slug}>{p.name}</option>
              ))}
            </select>

            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Llegada</label>
                <input type="date" value={form.check_in} onChange={(e) => setForm((f) => ({ ...f, check_in: e.target.value }))} className={INPUT_CLS} />
              </div>
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Salida</label>
                <input type="date" value={form.check_out} onChange={(e) => setForm((f) => ({ ...f, check_out: e.target.value }))} className={INPUT_CLS} />
              </div>
            </div>

            <div className="mt-3">
              <label className="block text-[12px] text-slate-400 mb-1">Fecha en que reservó <span className="text-slate-500">(opcional — para marketing; si lo dejás vacío, cuenta como hoy)</span></label>
              <input type="date" value={form.booked_at} onChange={(e) => setForm((f) => ({ ...f, booked_at: e.target.value }))} className={INPUT_CLS} />
            </div>

            <div className="grid grid-cols-3 gap-3 mt-3">
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Personas</label>
                <input type="number" min="1" value={form.guest_count} onChange={(e) => setForm((f) => ({ ...f, guest_count: e.target.value }))} placeholder="—" className={INPUT_CLS} />
              </div>
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Total (L)</label>
                <input type="number" min="0" value={form.total_hnl} onChange={(e) => setForm((f) => ({ ...f, total_hnl: e.target.value }))} placeholder="2500" className={INPUT_CLS} />
              </div>
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Pagado (L)</label>
                <input type="number" min="0" value={form.paid_hnl} onChange={(e) => setForm((f) => ({ ...f, paid_hnl: e.target.value }))} placeholder="1250" className={INPUT_CLS} />
              </div>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">Todo en Lempiras. Si Pagado &lt; Total, queda como depósito (falta el saldo).</p>

            {formError && <p className="text-[12px] text-rose-300 mt-3">{formError}</p>}

            <div className="flex gap-2 mt-5">
              <button
                type="button"
                onClick={submitAdd}
                disabled={saving}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
              >
                {saving ? "Guardando…" : "Guardar reserva"}
              </button>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                disabled={saving}
                className="px-3 py-2 rounded-lg text-sm border border-white/15 text-slate-300 hover:bg-white/5 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: cargar / corregir pago ───────────────────────────────────── */}
      {payRes && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => { if (!savingPay) setPayRes(null); }}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0c1322] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-white">💲 Pago de la reserva</h2>
            <p className="text-[12px] text-slate-400 mb-4">
              {payRes.guest_name || "Huésped"} · {getProperty(payRes.property_slug)?.name ?? payRes.property_slug} · {fmtDate(payRes.check_in)} → {fmtDate(payRes.check_out)}
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Total (L)</label>
                <input type="number" min="0" value={payForm.total_hnl} onChange={(e) => setPayForm((f) => ({ ...f, total_hnl: e.target.value }))} placeholder="2500" className={INPUT_CLS} />
              </div>
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Pagado (L)</label>
                <input type="number" min="0" value={payForm.paid_hnl} onChange={(e) => setPayForm((f) => ({ ...f, paid_hnl: e.target.value }))} placeholder="1250" className={INPUT_CLS} />
              </div>
            </div>

            {paySaldo != null && (
              <p className="text-[12px] mt-3">
                {paySaldo > 0
                  ? <span className="text-amber-300">Falta por pagar: <b>{fmtL(paySaldo)}</b></span>
                  : <span className="text-emerald-300">✅ Pagado completo</span>}
              </p>
            )}

            {payError && <p className="text-[12px] text-rose-300 mt-3">{payError}</p>}

            <div className="flex gap-2 mt-5">
              <button
                type="button"
                onClick={submitPay}
                disabled={savingPay}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
              >
                {savingPay ? "Guardando…" : "Guardar pago"}
              </button>
              <button
                type="button"
                onClick={() => setPayRes(null)}
                disabled={savingPay}
                className="px-3 py-2 rounded-lg text-sm border border-white/15 text-slate-300 hover:bg-white/5 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
