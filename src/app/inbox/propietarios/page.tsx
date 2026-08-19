"use client";

//
// /inbox/propietarios — Pipeline de PROPIETARIOS (expansión, modelo B — 2026-08-17).
//
// El embudo de puertas nuevas: dueños que ofrecen su propiedad para que la
// administremos. El bot los captura solo (owner_lead_handoff → owner_leads) y
// acá se clasifican por etapa: nuevo → contactado → llamada → evaluación →
// firmado (o descartado, con razón). También hay alta manual para los que
// llegan por Instagram, referidos o en persona.
//
// Sin plata en pantalla: acá no viven montos ni comisiones (la negociación es
// de la llamada), así que la página es visible para dueño Y staff.
//

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos (espejo del API /api/inbox/owner-leads)
// ─────────────────────────────────────────────────────────────────────────────

type Stage = "nuevo" | "contactado" | "llamada" | "evaluacion" | "firmado" | "descartado";

interface OwnerLead {
  id: number;
  phone: string;
  name: string | null;
  location: string | null;
  on_platform: "si" | "no" | null;
  call_ok: "si" | "no" | null;
  stage: Stage;
  notes: string | null;
  discarded_reason: string | null;
  source: "bot" | "manual";
  created_at: string;
  updated_at: string;
  stage_changed_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo de etapas (espejo de _lib/owner-leads.ts — el server valida igual)
// ─────────────────────────────────────────────────────────────────────────────

const STAGES: { key: Stage; label: string; emoji: string; chip: string }[] = [
  { key: "nuevo",      label: "Nuevo",      emoji: "🆕", chip: "text-cyan-300 border-cyan-500/40 bg-cyan-500/10" },
  { key: "contactado", label: "Contactado", emoji: "📞", chip: "text-sky-300 border-sky-500/40 bg-sky-500/10" },
  { key: "llamada",    label: "Llamada",    emoji: "🗓️", chip: "text-violet-300 border-violet-500/40 bg-violet-500/10" },
  { key: "evaluacion", label: "Evaluación", emoji: "🔍", chip: "text-amber-300 border-amber-500/40 bg-amber-500/10" },
  { key: "firmado",    label: "Firmado",    emoji: "✅", chip: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" },
  { key: "descartado", label: "Descartado", emoji: "❌", chip: "text-rose-300 border-rose-500/40 bg-rose-500/10" },
];

const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s])) as Record<
  Stage,
  (typeof STAGES)[number]
>;

/** Etapas del embudo VIVO (las que se muestran expandidas por defecto). */
const OPEN_STAGES: Stage[] = ["nuevo", "contactado", "llamada", "evaluacion"];

const INPUT_CLS =
  "w-full px-3 py-2 bg-white/[0.04] border border-white/10 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50";

/** "2026-08-17 14:03:22" (UTC de D1) → días transcurridos, legible. */
function daysAgo(sqlDate: string): string {
  const t = Date.parse(sqlDate.replace(" ", "T") + "Z");
  if (isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return "hoy";
  if (days === 1) return "hace 1 día";
  return `hace ${days} días`;
}

/** Días en la etapa actual (para pintar los estancados). */
function daysInStage(sqlDate: string): number {
  const t = Date.parse(sqlDate.replace(" ", "T") + "Z");
  if (isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86400000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Página
// ─────────────────────────────────────────────────────────────────────────────

export default function PropietariosPage() {
  const [leads, setLeads] = useState<OwnerLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [authed, setAuthed] = useState(true);
  const [filter, setFilter] = useState<"embudo" | "todos" | Stage>("embudo");
  const [search, setSearch] = useState("");

  // Alta manual
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ phone: "", name: "", location: "", notes: "" });
  const [addError, setAddError] = useState("");
  const [saving, setSaving] = useState(false);

  // Edición (nombre/ubicación/calificación/notas). `editBase` es la foto inicial:
  // al guardar solo viajan los campos que DE VERDAD cambiaron — así una edición de
  // notas no pisa la ubicación que el bot capturó mientras el modal estaba abierto.
  const [editLead, setEditLead] = useState<OwnerLead | null>(null);
  const [editForm, setEditForm] = useState({ name: "", location: "", onPlatform: "", callOk: "", notes: "" });
  const [editBase, setEditBase] = useState({ name: "", location: "", onPlatform: "", callOk: "", notes: "" });
  const [editError, setEditError] = useState("");

  // Feedback por tarjeta para los botones de etapa (→ / ← / ❌ / Revivir): busy
  // deshabilita mientras viaja el POST y msg muestra el error al lado del botón —
  // un fallo mudo parece éxito y el lead se queda estancado sin que nadie sepa.
  const [cardBusy, setCardBusy] = useState<number | null>(null);
  const [cardMsg, setCardMsg] = useState<Record<number, string>>({});

  // Descarte (pide la razón)
  const [discardLead, setDiscardLead] = useState<OwnerLead | null>(null);
  const [discardReason, setDiscardReason] = useState("");
  const [discardError, setDiscardError] = useState("");

  // Guard de secuencia: una respuesta vieja nunca pisa una más nueva.
  const reqSeq = useRef(0);

  const fetchData = useCallback(async (): Promise<void> => {
    const myReq = ++reqSeq.current;
    try {
      const resp = await fetch("/api/inbox/owner-leads", { credentials: "include" });
      if (myReq !== reqSeq.current) return;
      if (resp.status === 401) { setAuthed(false); return; }
      const data = (await resp.json()) as { ok: boolean; leads?: OwnerLead[] };
      if (myReq !== reqSeq.current) return;
      if (data.ok) { setLeads(data.leads ?? []); setAuthed(true); }
    } catch (err) {
      console.error("propietarios fetch error", err);
    } finally {
      if (myReq === reqSeq.current) setLoading(false);
    }
  }, []);

  // Carga inicial + poll de 30s (pestaña visible). El poll ES el reintento de
  // arranque: si el primer fetch falla (recarga en pleno deploy), el próximo
  // tick lo cura — regla del inbox desde el incidente del 17-ago.
  useEffect(() => {
    fetchData();
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetchData();
    };
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [fetchData]);

  // ── Mutaciones ─────────────────────────────────────────────────────────────

  /** Mueve la etapa y DEVUELVE el resultado — el caller decide qué mostrar.
   *  Nunca throws: error de red → { ok:false, error } igual que el server. */
  const moveStage = useCallback(
    async (
      lead: OwnerLead,
      stage: Stage,
      discardedReason?: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const resp = await fetch("/api/inbox/owner-leads", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stage", id: lead.id, stage, discardedReason }),
        });
        if (resp.status === 401) { setAuthed(false); return { ok: false, error: "Sesión expirada" }; }
        const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (data.ok) { fetchData(); return { ok: true }; }
        return { ok: false, error: data.error || "No se pudo mover." };
      } catch {
        return { ok: false, error: "Sin conexión — probá de nuevo." };
      }
    },
    [fetchData],
  );

  /** Botones de etapa de una tarjeta: busy + error visible junto al botón. */
  const moveFromCard = useCallback(
    async (lead: OwnerLead, stage: Stage): Promise<void> => {
      setCardBusy(lead.id);
      setCardMsg((m) => ({ ...m, [lead.id]: "" }));
      const r = await moveStage(lead, stage);
      setCardBusy(null);
      if (!r.ok) setCardMsg((m) => ({ ...m, [lead.id]: r.error || "No se pudo mover." }));
    },
    [moveStage],
  );

  const submitAdd = useCallback(async (): Promise<void> => {
    setAddError("");
    // Solo limpieza cosmética acá — la normalización real (8 dígitos locales →
    // 504XXXXXXXX) la hace el server con normalizePhone, la fuente única.
    const phone = addForm.phone.replace(/\D+/g, "");
    if (phone.length < 8 || phone.length > 15) {
      setAddError("Poné el teléfono (ej: 99887766 o 50499887766).");
      return;
    }
    setSaving(true);
    try {
      const resp = await fetch("/api/inbox/owner-leads", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          phone,
          name: addForm.name,
          location: addForm.location,
          notes: addForm.notes,
        }),
      });
      if (resp.status === 401) { setAuthed(false); return; }
      const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (data.ok) {
        setShowAdd(false);
        setAddForm({ phone: "", name: "", location: "", notes: "" });
        fetchData();
      } else {
        setAddError(data.error || "No se pudo guardar.");
      }
    } catch {
      setAddError("No se pudo conectar. Probá de nuevo.");
    } finally {
      setSaving(false);
    }
  }, [addForm, fetchData]);

  const submitEdit = useCallback(async (): Promise<void> => {
    if (!editLead) return;
    setEditError("");
    // Solo los campos que cambiaron respecto a la foto inicial: el API soporta
    // parches parciales, y así no pisamos lo que el bot actualizó mientras el
    // modal estaba abierto (el poll refresca la lista, no el formulario).
    const patch: Record<string, string> = {};
    if (editForm.name !== editBase.name) patch.name = editForm.name;
    if (editForm.location !== editBase.location) patch.location = editForm.location;
    if (editForm.onPlatform !== editBase.onPlatform) patch.onPlatform = editForm.onPlatform;
    if (editForm.callOk !== editBase.callOk) patch.callOk = editForm.callOk;
    if (editForm.notes !== editBase.notes) patch.notes = editForm.notes;
    if (Object.keys(patch).length === 0) { setEditLead(null); return; }
    setSaving(true);
    try {
      const resp = await fetch("/api/inbox/owner-leads", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", id: editLead.id, ...patch }),
      });
      if (resp.status === 401) { setAuthed(false); return; }
      const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (data.ok) { setEditLead(null); fetchData(); }
      else { setEditError(data.error || "No se pudo guardar."); }
    } catch {
      setEditError("No se pudo conectar. Probá de nuevo.");
    } finally {
      setSaving(false);
    }
  }, [editLead, editForm, editBase, fetchData]);

  const submitDiscard = useCallback(async (): Promise<void> => {
    if (!discardLead) return;
    setDiscardError("");
    setSaving(true);
    try {
      const r = await moveStage(discardLead, "descartado", discardReason);
      if (r.ok) {
        // Solo el éxito cierra el modal — un fallo mudo que se traga la razón
        // tipeada parece éxito y el lead queda vivo sin que nadie se entere.
        setDiscardLead(null);
        setDiscardReason("");
      } else {
        setDiscardError(r.error || "No se pudo descartar. Probá de nuevo.");
      }
    } finally {
      setSaving(false);
    }
  }, [discardLead, discardReason, moveStage]);

  // ── Derivados ──────────────────────────────────────────────────────────────

  const counts = useMemo(() => {
    const c: Record<Stage, number> = {
      nuevo: 0, contactado: 0, llamada: 0, evaluacion: 0, firmado: 0, descartado: 0,
    };
    for (const l of leads) c[l.stage] = (c[l.stage] ?? 0) + 1;
    return c;
  }, [leads]);

  const visible = useMemo(() => {
    let out = leads;
    if (filter === "embudo") out = out.filter((l) => (OPEN_STAGES as string[]).includes(l.stage));
    else if (filter !== "todos") out = out.filter((l) => l.stage === filter);
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (l) =>
          (l.name ?? "").toLowerCase().includes(q) ||
          (l.location ?? "").toLowerCase().includes(q) ||
          l.phone.includes(q),
      );
    }
    return out;
  }, [leads, filter, search]);

  /** Agrupado por etapa, en el orden del embudo. */
  const grouped = useMemo(() => {
    const g = new Map<Stage, OwnerLead[]>();
    for (const s of STAGES) g.set(s.key, []);
    for (const l of visible) g.get(l.stage)?.push(l);
    return g;
  }, [visible]);

  // ── Sesión expirada ────────────────────────────────────────────────────────

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

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#070b16] text-slate-200">
      <header className="border-b border-white/10 px-5 py-3 flex items-center justify-between gap-3 sticky top-0 z-10 bg-[#070b16]/90 backdrop-blur">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">🏠 Propietarios</h1>
          <p className="text-[12px] text-slate-400">
            Dueños que ofrecen su propiedad — el bot los captura solo; movelos de etapa acá
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => { setAddError(""); setShowAdd(true); }}
            className="px-3 py-1.5 border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 rounded-lg text-sm font-medium"
          >
            ➕ Agregar
          </button>
          <a href="/inbox" className="px-3 py-1.5 border border-white/15 rounded-lg hover:bg-white/5 text-slate-300 text-sm">
            ← Inbox
          </a>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-5">
        {/* Resumen del embudo — los conteos son botones de filtro */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <button
            onClick={() => setFilter("embudo")}
            className={`text-[12px] px-2.5 py-1 rounded-full border ${
              filter === "embudo"
                ? "text-white border-cyan-400/60 bg-cyan-500/20"
                : "text-slate-400 border-white/15 bg-white/5 hover:bg-white/10"
            }`}
          >
            Embudo vivo ({OPEN_STAGES.reduce((n, s) => n + counts[s], 0)})
          </button>
          {STAGES.map((s) => (
            <button
              key={s.key}
              onClick={() => setFilter(filter === s.key ? "embudo" : s.key)}
              className={`text-[12px] px-2.5 py-1 rounded-full border ${
                filter === s.key ? s.chip + " ring-1 ring-white/30" : "text-slate-400 border-white/15 bg-white/5 hover:bg-white/10"
              }`}
            >
              {s.emoji} {s.label} ({counts[s.key]})
            </button>
          ))}
          <button
            onClick={() => setFilter("todos")}
            className={`text-[12px] px-2.5 py-1 rounded-full border ${
              filter === "todos"
                ? "text-white border-white/40 bg-white/15"
                : "text-slate-400 border-white/15 bg-white/5 hover:bg-white/10"
            }`}
          >
            Todos ({leads.length})
          </button>
        </div>

        {/* Búsqueda */}
        <div className="mb-5">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, ubicación o teléfono…"
            className={INPUT_CLS + " max-w-md"}
          />
        </div>

        {loading && leads.length === 0 && (
          <p className="text-center text-slate-500 py-16">Cargando…</p>
        )}

        {!loading && visible.length === 0 && (
          <div className="text-center text-slate-500 py-16">
            {leads.length === 0 ? (
              <>
                <p className="mb-2">Todavía no hay propietarios acá.</p>
                <p className="text-[12px]">
                  Cuando un dueño le ofrezca su propiedad al bot, aparece solo en 🆕 Nuevo.
                  También podés cargar uno con ➕ Agregar.
                </p>
              </>
            ) : (
              // Hay leads, pero el filtro/búsqueda no matchea — decir "no hay
              // propietarios" acá miente (ej. embudo vivo vacío con 3 firmados).
              <p>
                Ningún propietario coincide con {search.trim() ? "la búsqueda" : "este filtro"} —
                probá {search.trim() ? "otro término" : "«Todos»"} arriba.
              </p>
            )}
          </div>
        )}

        {/* Secciones por etapa */}
        {STAGES.map((s) => {
          const items = grouped.get(s.key) ?? [];
          if (items.length === 0) return null;
          return (
            <section key={s.key} className="mb-6">
              <h2 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-2">
                <span>{s.emoji} {s.label}</span>
                <span className="text-[11px] text-slate-500">({items.length})</span>
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((l) => (
                  <LeadCard
                    key={l.id}
                    lead={l}
                    busy={cardBusy === l.id}
                    msg={cardMsg[l.id] ?? ""}
                    onMove={(stage) => {
                      if (stage === "descartado") {
                        setDiscardReason("");
                        setDiscardError("");
                        setDiscardLead(l);
                      } else {
                        moveFromCard(l, stage);
                      }
                    }}
                    onEdit={() => {
                      const base = {
                        name: l.name ?? "",
                        location: l.location ?? "",
                        onPlatform: l.on_platform ?? "",
                        callOk: l.call_ok ?? "",
                        notes: l.notes ?? "",
                      };
                      setEditForm(base);
                      setEditBase(base);
                      setEditError("");
                      setEditLead(l);
                    }}
                  />
                ))}
              </div>
            </section>
          );
        })}

        <p className="text-[11px] text-slate-600 text-center mt-5">
          Los detalles de administración (porcentaje, servicios, proyección) se hablan en la
          llamada — el bot nunca los menciona.
        </p>
      </main>

      {/* ── Modal: alta manual ── */}
      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => { if (!saving) setShowAdd(false); }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0c1322] p-5 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-white">➕ Agregar propietario</h2>
            <p className="text-[12px] text-slate-400 mt-1 mb-4">
              Para dueños que llegan por Instagram, referidos o en persona. Los que le
              escriben al bot entran solos.
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Teléfono (hondureño de 8 dígitos, o con código de país)</label>
                <input
                  value={addForm.phone}
                  onChange={(e) => setAddForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder="99887766"
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Nombre del dueño</label>
                <input
                  value={addForm.name}
                  onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Ej: María López"
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Ubicación de la propiedad</label>
                <input
                  value={addForm.location}
                  onChange={(e) => setAddForm((f) => ({ ...f, location: e.target.value }))}
                  placeholder="Ej: Roatán, West End"
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Notas</label>
                <textarea
                  value={addForm.notes}
                  onChange={(e) => setAddForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={3}
                  placeholder="Cómo llegó, qué ofrece, próximos pasos…"
                  className={INPUT_CLS}
                />
              </div>
            </div>
            {addError && <p className="text-[12px] text-rose-300 mt-3">{addError}</p>}
            <div className="flex gap-2 mt-5">
              <button
                onClick={submitAdd}
                disabled={saving}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
              >
                {saving ? "Guardando…" : "Guardar propietario"}
              </button>
              <button
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

      {/* ── Modal: editar lead ── */}
      {editLead && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => { if (!saving) setEditLead(null); }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0c1322] p-5 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-white">✏️ Editar propietario</h2>
            <p className="text-[12px] text-slate-400 mt-1 mb-4">+{editLead.phone}</p>
            <div className="space-y-3">
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Nombre del dueño</label>
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Ubicación de la propiedad</label>
                <input
                  value={editForm.location}
                  onChange={(e) => setEditForm((f) => ({ ...f, location: e.target.value }))}
                  className={INPUT_CLS}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] text-slate-400 mb-1">¿En plataformas?</label>
                  <select
                    value={editForm.onPlatform}
                    onChange={(e) => setEditForm((f) => ({ ...f, onPlatform: e.target.value }))}
                    className={INPUT_CLS.replace("text-slate-100", "text-slate-200")}
                  >
                    <option value="">No dijo</option>
                    <option value="si">Sí, ya activa</option>
                    <option value="no">No, arranca de cero</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] text-slate-400 mb-1">¿Acepta llamada?</label>
                  <select
                    value={editForm.callOk}
                    onChange={(e) => setEditForm((f) => ({ ...f, callOk: e.target.value }))}
                    className={INPUT_CLS.replace("text-slate-100", "text-slate-200")}
                  >
                    <option value="">No dijo</option>
                    <option value="si">Sí</option>
                    <option value="no">Prefiere por escrito</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[12px] text-slate-400 mb-1">Notas</label>
                <textarea
                  value={editForm.notes}
                  onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={4}
                  placeholder="Qué se habló, condiciones tentativas, próximos pasos…"
                  className={INPUT_CLS}
                />
              </div>
            </div>
            {editError && <p className="text-[12px] text-rose-300 mt-3">{editError}</p>}
            <div className="flex gap-2 mt-5">
              <button
                onClick={submitEdit}
                disabled={saving}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
              >
                {saving ? "Guardando…" : "Guardar cambios"}
              </button>
              <button
                onClick={() => setEditLead(null)}
                disabled={saving}
                className="px-3 py-2 rounded-lg text-sm border border-white/15 text-slate-300 hover:bg-white/5 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: descartar (pide la razón) ── */}
      {discardLead && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => { if (!saving) setDiscardLead(null); }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-rose-500/30 bg-[#0c1322] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-white">❌ Descartar propietario</h2>
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.06] px-3 py-2.5 text-[12px] mt-3 mb-4 text-slate-300">
              {discardLead.name || `+${discardLead.phone}`}
              {discardLead.location ? ` · ${discardLead.location}` : ""}
            </div>
            <label className="block text-[12px] text-slate-400 mb-1">
              ¿Por qué no avanza? (para aprender qué leads no sirven)
            </label>
            <textarea
              value={discardReason}
              onChange={(e) => setDiscardReason(e.target.value)}
              rows={3}
              placeholder="Ej: quería solo limpieza, zona sin demanda, no contestó más…"
              className={INPUT_CLS}
            />
            {discardError && <p className="text-[12px] text-rose-300 mt-3">{discardError}</p>}
            <div className="flex gap-2 mt-5">
              <button
                onClick={submitDiscard}
                disabled={saving}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold border border-rose-500/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25 disabled:opacity-50"
              >
                {saving ? "Guardando…" : "Descartar"}
              </button>
              <button
                onClick={() => setDiscardLead(null)}
                disabled={saving}
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

// ─────────────────────────────────────────────────────────────────────────────
// Tarjeta de un lead
// ─────────────────────────────────────────────────────────────────────────────

function LeadCard({
  lead,
  busy,
  msg,
  onMove,
  onEdit,
}: {
  lead: OwnerLead;
  busy: boolean;
  msg: string;
  onMove: (stage: Stage) => void;
  onEdit: () => void;
}) {
  const stage = STAGE_BY_KEY[lead.stage];
  const stale = daysInStage(lead.stage_changed_at);
  // Un lead ABIERTO sin moverse 5+ días está enfriándose — pintarlo.
  const isStale = (OPEN_STAGES as string[]).includes(lead.stage) && stale >= 5;

  // Siguiente etapa natural del embudo (para el botón de avance rápido).
  const order: Stage[] = ["nuevo", "contactado", "llamada", "evaluacion", "firmado"];
  const idx = order.indexOf(lead.stage);
  const next: Stage | null = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;

  return (
    <div
      className={`rounded-xl border p-4 ${
        isStale ? "border-amber-500/30 bg-amber-500/[0.04]" : "border-white/10 bg-white/[0.02]"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white truncate" title={lead.name ?? undefined}>
            {lead.name || `+${lead.phone}`}
          </p>
          {lead.name && <p className="text-[12px] text-slate-400">+{lead.phone}</p>}
        </div>
        <span className={`text-[11px] px-2 py-0.5 rounded-full border shrink-0 ${stage.chip}`}>
          {stage.emoji} {stage.label}
        </span>
      </div>

      {lead.location && (
        <p className="text-[12px] text-slate-300 mt-2 line-clamp-2" title={lead.location}>
          📍 {lead.location}
        </p>
      )}

      <div className="flex flex-wrap gap-1.5 mt-2">
        {lead.on_platform === "si" && (
          <span className="text-[11px] px-2 py-0.5 rounded-full border text-emerald-300 border-emerald-500/40 bg-emerald-500/10">
            Ya en plataformas
          </span>
        )}
        {lead.on_platform === "no" && (
          <span className="text-[11px] px-2 py-0.5 rounded-full border text-slate-400 border-white/15 bg-white/5">
            Arranca de cero
          </span>
        )}
        {lead.call_ok === "si" && (
          <span className="text-[11px] px-2 py-0.5 rounded-full border text-cyan-300 border-cyan-500/40 bg-cyan-500/10">
            Acepta llamada
          </span>
        )}
        {lead.call_ok === "no" && (
          <span className="text-[11px] px-2 py-0.5 rounded-full border text-amber-300 border-amber-500/40 bg-amber-500/10">
            Prefiere escrito
          </span>
        )}
        {lead.source === "bot" && (
          <span className="text-[11px] px-2 py-0.5 rounded-full border text-violet-300 border-violet-500/40 bg-violet-500/10">
            🤖 Del bot
          </span>
        )}
      </div>

      {lead.notes && (
        <p className="text-[12px] text-slate-400 mt-2 line-clamp-3 whitespace-pre-wrap" title={lead.notes}>
          {lead.notes}
        </p>
      )}
      {lead.stage === "descartado" && lead.discarded_reason && (
        <p className="text-[12px] text-rose-300/80 mt-2">✗ {lead.discarded_reason}</p>
      )}

      <p className={`text-[11px] mt-2 ${isStale ? "text-amber-300" : "text-slate-500"}`}>
        {isStale ? `⏳ ${stale} días sin moverse` : `En esta etapa ${daysAgo(lead.stage_changed_at)}`}
        {" · creado "}{daysAgo(lead.created_at)}
      </p>

      <div className="flex flex-wrap items-center gap-1.5 mt-3 pt-3 border-t border-white/5">
        <a
          href={`/inbox?c=${lead.phone}`}
          className="text-[11px] text-cyan-200 border border-cyan-400/40 rounded px-1.5 py-0.5 hover:bg-cyan-400/10"
        >
          💬 Chat
        </a>
        <button
          onClick={onEdit}
          disabled={busy}
          className="text-[11px] text-slate-300 border border-white/15 rounded px-1.5 py-0.5 hover:bg-white/5 disabled:opacity-40"
        >
          ✏️ Editar
        </button>
        {next && (
          <button
            onClick={() => onMove(next)}
            disabled={busy}
            className="text-[11px] text-emerald-200 border border-emerald-400/40 rounded px-1.5 py-0.5 hover:bg-emerald-400/10 disabled:opacity-40"
          >
            {busy ? "…" : `→ ${STAGE_BY_KEY[next].emoji} ${STAGE_BY_KEY[next].label}`}
          </button>
        )}
        {lead.stage !== "descartado" && (
          <button
            onClick={() => onMove("descartado")}
            disabled={busy}
            className="text-[11px] text-rose-200 border border-rose-400/40 rounded px-1.5 py-0.5 hover:bg-rose-400/10 disabled:opacity-40"
          >
            ❌
          </button>
        )}
        {lead.stage === "descartado" && (
          <button
            onClick={() => onMove("nuevo")}
            disabled={busy}
            className="text-[11px] text-slate-300 border border-white/15 rounded px-1.5 py-0.5 hover:bg-white/5 disabled:opacity-40"
          >
            {busy ? "…" : "↩︎ Revivir"}
          </button>
        )}
        {/* Retroceso de etapa (equivocarse de botón no puede ser un callejón) */}
        {idx > 0 && (
          <button
            onClick={() => onMove(order[idx - 1])}
            disabled={busy}
            title={`Volver a ${STAGE_BY_KEY[order[idx - 1]].label}`}
            className="text-[11px] text-slate-500 border border-white/10 rounded px-1.5 py-0.5 hover:bg-white/5 disabled:opacity-40"
          >
            ←
          </button>
        )}
      </div>
      {msg && <p className="text-[11px] text-rose-300 mt-2">⚠ {msg}</p>}
    </div>
  );
}
