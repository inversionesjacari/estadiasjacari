"use client";
//
// /inbox/registro — Registro de huéspedes (planilla tipo Excel).
//
// Una fila por reserva (confirmada o con depósito/por verificar), pasada o futura:
// huésped, teléfono, propiedad, fechas, personas, monto, origen y estado de pago.
// Ordenable por cualquier columna, con buscador + filtros y un botón "Exportar a
// Excel (CSV)" que baja la planilla con lo que estés viendo. Pensada para llevar el
// registro y dar seguimiento. Datos en vivo de /api/inbox/reservations-registry.
//

import { useEffect, useState, useCallback, useMemo } from "react";
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
}

const SOURCE_LABEL: Record<string, string> = {
  airbnb: "Airbnb",
  website: "Web",
  whatsapp_bot: "WhatsApp",
  whatsapp_transfer: "Transferencia",
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

function statusMeta(status: string): { text: string; cls: string } {
  if (status === "confirmed") return { text: "Pagado", cls: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" };
  return { text: "Pendiente", cls: "text-amber-300 border-amber-500/40 bg-amber-500/10" };
}

type SortKey = "check_in" | "guest_name" | "property" | "amount_usd" | "status" | "created_at" | "source";

const COLUMNS: { key: SortKey | null; label: string; align?: "right" }[] = [
  { key: "guest_name", label: "Huésped" },
  { key: null, label: "Teléfono" },
  { key: "property", label: "Propiedad" },
  { key: null, label: "Pers.", align: "right" },
  { key: "check_in", label: "Entra" },
  { key: null, label: "Sale" },
  { key: null, label: "Noches", align: "right" },
  { key: "amount_usd", label: "Monto USD", align: "right" },
  { key: "source", label: "Origen" },
  { key: "status", label: "Estado" },
  { key: "created_at", label: "Reservada" },
  { key: null, label: "" },
];

export default function RegistroPage() {
  const [authed, setAuthed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [propFilter, setPropFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("check_in");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

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
        case "amount_usd": return r.amount_usd ?? -1;
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
    const headers = ["Huésped", "Teléfono", "Propiedad", "Ciudad", "Personas", "Entra", "Sale", "Noches", "Monto USD", "Origen", "Estado", "Reservada"];
    const esc = (v: unknown): string => {
      const s = v == null ? "" : String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(",")];
    for (const r of filtered) {
      const prop = getProperty(r.property_slug);
      lines.push([
        r.guest_name ?? "",
        r.guest_phone ?? "",
        prop?.name ?? r.property_slug,
        prop?.city ?? "",
        r.guest_count ?? "",
        r.check_in,
        r.check_out,
        nights(r.check_in, r.check_out),
        r.amount_usd ?? "",
        sourceLabel(r.source),
        statusMeta(r.status).text,
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

  const confirmedCount = reservations.filter((r) => r.status === "confirmed").length;
  const pendingCount = reservations.filter((r) => r.status === "pending").length;

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
                  const st = statusMeta(r.status);
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
                        {r.amount_usd != null ? `$${r.amount_usd.toLocaleString("en-US")}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-slate-400">{sourceLabel(r.source)}</td>
                      <td className="px-3 py-2">
                        <span className={`text-[11px] px-2 py-0.5 rounded-full border ${st.cls}`}>{st.text}</span>
                      </td>
                      <td className="px-3 py-2 text-slate-500">{(r.created_at ?? "").slice(0, 10)}</td>
                      <td className="px-3 py-2">
                        {phoneDigits ? (
                          <a
                            href={`/inbox?c=${phoneDigits}`}
                            className="text-[11px] text-cyan-300 border border-cyan-500/30 rounded px-1.5 py-0.5 hover:bg-cyan-500/10"
                          >
                            Chat
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-slate-600 text-center mt-5">
          Incluye reservas confirmadas (pagadas) y con depósito/por verificar. El botón exporta lo que estés viendo (con los filtros aplicados).
        </p>
      </main>
    </div>
  );
}
