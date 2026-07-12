"use client";
//
// /inbox/conocimiento — Panel para ver y editar lo que el bot sabe.
//
// Lee y escribe /api/inbox/kb (protegido con la misma cookie de sesión del inbox).
// 3 pestañas:
//   - Propiedades: datos + precios de cada propiedad (editar, no crear/borrar)
//   - Políticas:   check-in, mascotas, cancelación, etc.
//   - FAQs:        preguntas frecuentes (crear / editar / borrar)
//
// Si la sesión expiró (401), muestra un aviso con link a /inbox para volver a entrar.
//

import { useEffect, useState, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos (espejo de kb-store.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface KbProperty {
  slug: string;
  name: string;
  city: string;
  capacity: number;
  bedrooms: number | null;
  bathrooms: number | null;
  beds: string | null;
  priceNightHnl: number;
  cleaningHnl: number;
  priceNightUsd: number;
  cleaningUsd: number;
  aliases: string | null;
  amenities: string | null;
  pool: string | null;
  beach: string | null;
  pets: string | null;
  parking: string | null;
  tv: string | null;
  idealFor: string | null;
  notes: string | null;
  sortOrder: number;
  active: number;
}

interface KbPolicy {
  key: string;
  label: string;
  value: string;
  sortOrder: number;
}

interface KbFaq {
  id: number;
  question: string;
  answer: string;
  sortOrder: number;
  active: number;
}

interface KbRule {
  id: number;
  rule: string;
  sortOrder: number;
  active: number;
}

interface QuickReply {
  id: number;
  title: string;
  content: string;
  sortOrder: number;
  active: number;
}

type Tab = "reglas" | "propiedades" | "politicas" | "faqs" | "respuestas";

// ─────────────────────────────────────────────────────────────────────────────
// Página
// ─────────────────────────────────────────────────────────────────────────────

export default function ConocimientoPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("reglas");
  const [properties, setProperties] = useState<KbProperty[]>([]);
  const [policies, setPolicies] = useState<KbPolicy[]>([]);
  const [faqs, setFaqs] = useState<KbFaq[]>([]);
  const [rules, setRules] = useState<KbRule[]>([]);
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // KB y respuestas rápidas viven en endpoints distintos → en paralelo.
      const [res, repliesRes] = await Promise.all([
        fetch("/api/inbox/kb"),
        fetch("/api/inbox/quick-replies"),
      ]);
      if (res.status === 401) {
        setAuthed(false);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as {
        ok: boolean;
        properties?: KbProperty[];
        policies?: KbPolicy[];
        faqs?: KbFaq[];
        rules?: KbRule[];
      };
      if (data.ok) {
        setAuthed(true);
        setProperties(data.properties ?? []);
        setPolicies(data.policies ?? []);
        setFaqs(data.faqs ?? []);
        setRules(data.rules ?? []);
      }
      const repliesData = (await repliesRes
        .json()
        .catch(() => ({ ok: false }))) as { ok: boolean; replies?: QuickReply[] };
      if (repliesData.ok) setReplies(repliesData.replies ?? []);
    } catch {
      // dejar loading false abajo
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── No autenticado ─────────────────────────────────────────────────────────
  if (authed === false) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg p-8 text-center">
          <h1 className="font-display text-2xl text-primary mb-2">Sesión requerida</h1>
          <p className="text-muted text-sm mb-6">
            Necesitás iniciar sesión para ver el panel del bot.
          </p>
          <a
            href="/inbox"
            className="inline-block bg-primary text-white font-semibold px-5 py-2.5 rounded-lg hover:bg-primary/90 transition"
          >
            Ir a iniciar sesión
          </a>
        </div>
      </div>
    );
  }

  if (authed === null || loading) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <p className="text-muted">Cargando…</p>
      </div>
    );
  }

  // ── Render principal ───────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-2 sticky top-0 z-10">
        <div className="min-w-0">
          <h1 className="font-display text-lg sm:text-xl text-primary leading-tight">🤖 Conocimiento del bot</h1>
          <p className="hidden sm:block text-xs text-muted">Lo que el bot sabe y responde · Estadías Jacarí</p>
        </div>
        <a
          href="/inbox"
          className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 text-muted text-sm whitespace-nowrap shrink-0"
        >
          ← <span className="hidden sm:inline">Volver al </span>inbox
        </a>
      </header>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 px-2 sm:px-4">
        <nav className="flex gap-1 overflow-x-auto">
          {([
            ["reglas", "⚙️ Reglas del bot"],
            ["propiedades", "🏠 Propiedades"],
            ["politicas", "📋 Políticas"],
            ["faqs", "❓ Preguntas frecuentes"],
            ["respuestas", "💬 Respuestas rápidas"],
          ] as [Tab, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 sm:px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap shrink-0 transition ${
                tab === key
                  ? "border-accent text-primary"
                  : "border-transparent text-muted hover:text-primary"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Contenido */}
      <main className="max-w-4xl mx-auto px-4 py-6">
        {tab === "reglas" && (
          <RulesTab
            rules={rules}
            onSaved={(msg) => {
              load();
              showToast(msg);
            }}
          />
        )}
        {tab === "propiedades" && (
          <PropertiesTab
            properties={properties}
            onSaved={() => {
              load();
              showToast("Propiedad guardada ✅");
            }}
          />
        )}
        {tab === "politicas" && (
          <PoliciesTab
            policies={policies}
            onSaved={() => {
              load();
              showToast("Política guardada ✅");
            }}
          />
        )}
        {tab === "faqs" && (
          <FaqsTab
            faqs={faqs}
            onSaved={(msg) => {
              load();
              showToast(msg);
            }}
          />
        )}
        {tab === "respuestas" && (
          <RepliesTab
            replies={replies}
            onSaved={(msg) => {
              load();
              showToast(msg);
            }}
          />
        )}
      </main>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-primary text-white px-5 py-2.5 rounded-full shadow-lg text-sm z-20">
          {toast}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper de guardado
// ─────────────────────────────────────────────────────────────────────────────

async function postKb(
  action: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/inbox/kb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload }),
    });
    return (await res.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: "Error de red" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab Propiedades
// ─────────────────────────────────────────────────────────────────────────────

function PropertiesTab({
  properties,
  onSaved,
}: {
  properties: KbProperty[];
  onSaved: () => void;
}) {
  const [editingSlug, setEditingSlug] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Editá los datos y precios de cada propiedad. Los cambios se aplican al bot en el próximo mensaje.
      </p>
      {properties.map((p) =>
        editingSlug === p.slug ? (
          <PropertyEditor
            key={p.slug}
            property={p}
            onCancel={() => setEditingSlug(null)}
            onSaved={() => {
              setEditingSlug(null);
              onSaved();
            }}
          />
        ) : (
          <PropertyCard
            key={p.slug}
            property={p}
            onEdit={() => setEditingSlug(p.slug)}
          />
        ),
      )}
    </div>
  );
}

function PropertyCard({
  property: p,
  onEdit,
}: {
  property: KbProperty;
  onEdit: () => void;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-display text-lg text-primary">{p.name}</h3>
          <p className="text-xs text-muted">
            {p.city} · {p.slug}
            {p.active === 0 && (
              <span className="ml-2 text-red-600 font-medium">(inactiva)</span>
            )}
          </p>
        </div>
        <button
          onClick={onEdit}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-primary"
        >
          ✏️ Editar
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
        <Fact label="Capacidad" value={`${p.capacity} huéspedes`} />
        <Fact label="Precio/noche" value={`L.${p.priceNightHnl.toLocaleString("es-HN")}`} />
        <Fact label="Limpieza" value={`L.${p.cleaningHnl.toLocaleString("es-HN")}`} />
        {p.pool && <Fact label="Piscina" value={p.pool} span />}
        {p.beach && <Fact label="Playa/mar" value={p.beach} span />}
        {p.pets && <Fact label="Mascotas" value={p.pets} span />}
      </div>
    </div>
  );
}

function Fact({
  label,
  value,
  span,
}: {
  label: string;
  value: string;
  span?: boolean;
}) {
  return (
    <div className={span ? "col-span-2 sm:col-span-3" : ""}>
      <span className="text-muted">{label}: </span>
      <span className="text-primary">{value}</span>
    </div>
  );
}

function PropertyEditor({
  property,
  onCancel,
  onSaved,
}: {
  property: KbProperty;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<KbProperty>({ ...property });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof KbProperty>(key: K, value: KbProperty[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await postKb("update_property", form as unknown as Record<string, unknown>);
    setSaving(false);
    if (res.ok) onSaved();
    else setError(res.error ?? "Error guardando");
  }

  return (
    <div className="bg-white rounded-xl border-2 border-accent p-5">
      <h3 className="font-display text-lg text-primary mb-4">Editando: {property.name}</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Nombre">
          <input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Ciudad">
          <select className={inputCls} value={form.city} onChange={(e) => set("city", e.target.value)}>
            <option>La Ceiba</option>
            <option>Tela</option>
            <option>Tegucigalpa</option>
          </select>
        </Field>
        <Field label="Capacidad (huéspedes)">
          <input type="number" className={inputCls} value={form.capacity} onChange={(e) => set("capacity", Number(e.target.value))} />
        </Field>
        <Field label="Aliases (nombres alternativos)">
          <input className={inputCls} value={form.aliases ?? ""} onChange={(e) => set("aliases", e.target.value)} placeholder="Ej: La Casita del Mar" />
        </Field>
        <Field label="Habitaciones">
          <input type="number" className={inputCls} value={form.bedrooms ?? ""} onChange={(e) => set("bedrooms", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
        <Field label="Baños">
          <input type="number" className={inputCls} value={form.bathrooms ?? ""} onChange={(e) => set("bathrooms", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
        <Field label="Camas (descripción)" full>
          <input className={inputCls} value={form.beds ?? ""} onChange={(e) => set("beds", e.target.value)} placeholder="Ej: Principal: 1 King · Secundaria: 2 matrimoniales" />
        </Field>

        <Field label="Precio/noche (HNL)">
          <input type="number" className={inputCls} value={form.priceNightHnl} onChange={(e) => set("priceNightHnl", Number(e.target.value))} />
        </Field>
        <Field label="Limpieza (HNL)">
          <input type="number" className={inputCls} value={form.cleaningHnl} onChange={(e) => set("cleaningHnl", Number(e.target.value))} />
        </Field>
        <Field label="Precio/noche (USD)">
          <input type="number" className={inputCls} value={form.priceNightUsd} onChange={(e) => set("priceNightUsd", Number(e.target.value))} />
        </Field>
        <Field label="Limpieza (USD)">
          <input type="number" className={inputCls} value={form.cleaningUsd} onChange={(e) => set("cleaningUsd", Number(e.target.value))} />
        </Field>

        <Field label="Amenidades" full>
          <textarea className={textareaCls} rows={2} value={form.amenities ?? ""} onChange={(e) => set("amenities", e.target.value)} placeholder="Cocina equipada · A/C · WiFi · ..." />
        </Field>
        <Field label="Piscina" full>
          <textarea className={textareaCls} rows={2} value={form.pool ?? ""} onChange={(e) => set("pool", e.target.value)} />
        </Field>
        <Field label="Playa / mar" full>
          <textarea className={textareaCls} rows={2} value={form.beach ?? ""} onChange={(e) => set("beach", e.target.value)} />
        </Field>
        <Field label="Mascotas">
          <input className={inputCls} value={form.pets ?? ""} onChange={(e) => set("pets", e.target.value)} />
        </Field>
        <Field label="Estacionamiento">
          <input className={inputCls} value={form.parking ?? ""} onChange={(e) => set("parking", e.target.value)} />
        </Field>
        <Field label="TV">
          <input className={inputCls} value={form.tv ?? ""} onChange={(e) => set("tv", e.target.value)} />
        </Field>
        <Field label="Ideal para">
          <input className={inputCls} value={form.idealFor ?? ""} onChange={(e) => set("idealFor", e.target.value)} />
        </Field>
        <Field label="Notas" full>
          <textarea className={textareaCls} rows={2} value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} placeholder="Ej: Se puede rentar junto a Casa Marea (Las Gemelas)" />
        </Field>
      </div>

      {error && (
        <p className="mt-3 text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2 justify-end">
        <button onClick={onCancel} className="px-4 py-2 text-sm text-muted hover:text-primary" disabled={saving}>
          Cancelar
        </button>
        <button onClick={save} disabled={saving} className="px-5 py-2 text-sm bg-primary text-white font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-50">
          {saving ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab Políticas
// ─────────────────────────────────────────────────────────────────────────────

function PoliciesTab({
  policies,
  onSaved,
}: {
  policies: KbPolicy[];
  onSaved: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Políticas generales que aplican a todas las propiedades.
      </p>
      {policies.map((pol) => (
        <PolicyEditor key={pol.key} policy={pol} onSaved={onSaved} />
      ))}
    </div>
  );
}

function PolicyEditor({
  policy,
  onSaved,
}: {
  policy: KbPolicy;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(policy.value);
  const [saving, setSaving] = useState(false);
  const dirty = value !== policy.value;

  async function save() {
    setSaving(true);
    const res = await postKb("update_policy", { key: policy.key, value });
    setSaving(false);
    if (res.ok) onSaved();
    else alert(res.error ?? "Error guardando");
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <label className="block text-sm font-semibold text-primary mb-1.5">
        {policy.label}
      </label>
      <textarea
        className={textareaCls}
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {dirty && (
        <div className="mt-2 flex gap-2 justify-end">
          <button onClick={() => setValue(policy.value)} className="px-3 py-1.5 text-sm text-muted hover:text-primary">
            Descartar
          </button>
          <button onClick={save} disabled={saving} className="px-4 py-1.5 text-sm bg-primary text-white font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-50">
            {saving ? "Guardando…" : "Guardar"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab FAQs
// ─────────────────────────────────────────────────────────────────────────────

function FaqsTab({
  faqs,
  onSaved,
}: {
  faqs: KbFaq[];
  onSaved: (msg: string) => void;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          Respuestas a preguntas comunes. El bot las usa para responder.
        </p>
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-2 text-sm bg-secondary text-white font-semibold rounded-lg hover:bg-secondary/90"
        >
          + Agregar
        </button>
      </div>

      {creating && (
        <FaqEditor
          faq={{ id: 0, question: "", answer: "", sortOrder: 999, active: 1 }}
          isNew
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            onSaved("Pregunta agregada ✅");
          }}
        />
      )}

      {faqs.map((f) => (
        <FaqEditor key={f.id} faq={f} onSaved={(msg) => onSaved(msg)} />
      ))}
    </div>
  );
}

function FaqEditor({
  faq,
  isNew,
  onCancel,
  onSaved,
}: {
  faq: KbFaq;
  isNew?: boolean;
  onCancel?: () => void;
  onSaved: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(!!isNew);
  const [question, setQuestion] = useState(faq.question);
  const [answer, setAnswer] = useState(faq.answer);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!question.trim() || !answer.trim()) {
      alert("La pregunta y la respuesta no pueden estar vacías");
      return;
    }
    setSaving(true);
    const res = isNew
      ? await postKb("create_faq", { question, answer })
      : await postKb("update_faq", { id: faq.id, question, answer });
    setSaving(false);
    if (res.ok) {
      if (!isNew) setEditing(false);
      onSaved(isNew ? "Pregunta agregada ✅" : "Pregunta guardada ✅");
    } else {
      alert(res.error ?? "Error guardando");
    }
  }

  async function remove() {
    if (!confirm("¿Borrar esta pregunta?")) return;
    const res = await postKb("delete_faq", { id: faq.id });
    if (res.ok) onSaved("Pregunta borrada 🗑️");
    else alert(res.error ?? "Error borrando");
  }

  if (!editing) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <p className="font-medium text-primary text-sm">{faq.question}</p>
            <p className="text-muted text-sm mt-1">{faq.answer}</p>
          </div>
          <div className="flex gap-1 shrink-0">
            <button onClick={() => setEditing(true)} className="px-2 py-1 text-sm text-muted hover:text-primary" title="Editar">
              ✏️
            </button>
            <button onClick={remove} className="px-2 py-1 text-sm text-muted hover:text-red-600" title="Borrar">
              🗑️
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border-2 border-accent p-4">
      <Field label="Pregunta">
        <input className={inputCls} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="¿...?" autoFocus />
      </Field>
      <div className="mt-3">
        <Field label="Respuesta">
          <textarea className={textareaCls} rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 flex gap-2 justify-end">
        <button
          onClick={() => {
            if (isNew) onCancel?.();
            else {
              setEditing(false);
              setQuestion(faq.question);
              setAnswer(faq.answer);
            }
          }}
          className="px-4 py-2 text-sm text-muted hover:text-primary"
          disabled={saving}
        >
          Cancelar
        </button>
        <button onClick={save} disabled={saving} className="px-5 py-2 text-sm bg-primary text-white font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-50">
          {saving ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab Reglas del bot
// ─────────────────────────────────────────────────────────────────────────────

function RulesTab({
  rules,
  onSaved,
}: {
  rules: KbRule[];
  onSaved: (msg: string) => void;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-3">
      <div className="bg-secondary/10 border border-secondary/30 rounded-xl p-4">
        <p className="text-sm text-primary font-medium mb-1">
          ⚙️ Guía de tono y estilo del bot
        </p>
        <p className="text-sm text-muted">
          El bot lee estas notas como guía al redactar sus respuestas libres (tono,
          qué mencionar, qué evitar). Funcionan bien para cosas como &quot;no abrumes
          con opciones&quot; o &quot;sé cálido y natural&quot;. ⚠️ Las reglas DURAS
          (precios, disponibilidad, pagos, cuándo escalar a un humano) viven en el
          código y NO se cambian desde acá — esas pedilas como cambio al bot.
        </p>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-2 text-sm bg-secondary text-white font-semibold rounded-lg hover:bg-secondary/90"
        >
          + Agregar regla
        </button>
      </div>

      {creating && (
        <RuleEditor
          rule={{ id: 0, rule: "", sortOrder: 999, active: 1 }}
          isNew
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            onSaved("Regla agregada ✅");
          }}
        />
      )}

      {rules.length === 0 && !creating && (
        <p className="text-center text-muted text-sm py-8">
          Todavía no hay reglas. Agregá la primera con el botón de arriba.
        </p>
      )}

      {rules.map((r, i) => (
        <RuleEditor key={r.id} rule={r} index={i + 1} onSaved={(msg) => onSaved(msg)} />
      ))}
    </div>
  );
}

function RuleEditor({
  rule,
  index,
  isNew,
  onCancel,
  onSaved,
}: {
  rule: KbRule;
  index?: number;
  isNew?: boolean;
  onCancel?: () => void;
  onSaved: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(!!isNew);
  const [text, setText] = useState(rule.rule);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!text.trim()) {
      alert("La regla no puede estar vacía");
      return;
    }
    setSaving(true);
    const res = isNew
      ? await postKb("create_rule", { rule: text })
      : await postKb("update_rule", { id: rule.id, rule: text });
    setSaving(false);
    if (res.ok) {
      if (!isNew) setEditing(false);
      onSaved(isNew ? "Regla agregada ✅" : "Regla guardada ✅");
    } else {
      alert(res.error ?? "Error guardando");
    }
  }

  async function remove() {
    if (!confirm("¿Borrar esta regla?")) return;
    const res = await postKb("delete_rule", { id: rule.id });
    if (res.ok) onSaved("Regla borrada 🗑️");
    else alert(res.error ?? "Error borrando");
  }

  if (!editing) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm text-primary flex-1">
            <span className="text-muted mr-2">{index}.</span>
            {rule.rule}
          </p>
          <div className="flex gap-1 shrink-0">
            <button onClick={() => setEditing(true)} className="px-2 py-1 text-sm text-muted hover:text-primary" title="Editar">
              ✏️
            </button>
            <button onClick={remove} className="px-2 py-1 text-sm text-muted hover:text-red-600" title="Borrar">
              🗑️
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border-2 border-accent p-4">
      <Field label="Regla (instrucción para el bot)">
        <textarea
          className={textareaCls}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ej: No abrumes al cliente con opciones que no pidió."
          autoFocus
        />
      </Field>
      <div className="mt-3 flex gap-2 justify-end">
        <button
          onClick={() => {
            if (isNew) onCancel?.();
            else {
              setEditing(false);
              setText(rule.rule);
            }
          }}
          className="px-4 py-2 text-sm text-muted hover:text-primary"
          disabled={saving}
        >
          Cancelar
        </button>
        <button onClick={save} disabled={saving} className="px-5 py-2 text-sm bg-primary text-white font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-50">
          {saving ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab Respuestas rápidas
// ─────────────────────────────────────────────────────────────────────────────

async function postReplies(
  action: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/inbox/quick-replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload }),
    });
    return (await res.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: "Error de red" };
  }
}

function RepliesTab({
  replies,
  onSaved,
}: {
  replies: QuickReply[];
  onSaved: (msg: string) => void;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-3">
      <div className="bg-secondary/10 border border-secondary/30 rounded-xl p-4">
        <p className="text-sm text-primary font-medium mb-1">
          💬 Plantillas para responder a mano
        </p>
        <p className="text-sm text-muted">
          Atajos de texto que aparecen en el inbox (botón 💬 del cuadro de mensaje)
          para insertarlos con un clic cuando el bot está en pausa y respondés vos.
          El bot NO las usa.
        </p>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-2 text-sm bg-secondary text-white font-semibold rounded-lg hover:bg-secondary/90"
        >
          + Agregar respuesta
        </button>
      </div>

      {creating && (
        <ReplyEditor
          reply={{ id: 0, title: "", content: "", sortOrder: 999, active: 1 }}
          isNew
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            onSaved("Respuesta agregada ✅");
          }}
        />
      )}

      {replies.length === 0 && !creating && (
        <p className="text-center text-muted text-sm py-8">
          Todavía no hay respuestas rápidas. Agregá la primera con el botón de arriba.
        </p>
      )}

      {replies.map((r) => (
        <ReplyEditor key={r.id} reply={r} onSaved={(msg) => onSaved(msg)} />
      ))}
    </div>
  );
}

function ReplyEditor({
  reply,
  isNew,
  onCancel,
  onSaved,
}: {
  reply: QuickReply;
  isNew?: boolean;
  onCancel?: () => void;
  onSaved: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(!!isNew);
  const [title, setTitle] = useState(reply.title);
  const [content, setContent] = useState(reply.content);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!title.trim() || !content.trim()) {
      alert("El título y el contenido no pueden estar vacíos");
      return;
    }
    setSaving(true);
    const res = isNew
      ? await postReplies("create", { title, content })
      : await postReplies("update", { id: reply.id, title, content });
    setSaving(false);
    if (res.ok) {
      if (!isNew) setEditing(false);
      onSaved(isNew ? "Respuesta agregada ✅" : "Respuesta guardada ✅");
    } else {
      alert(res.error ?? "Error guardando");
    }
  }

  async function remove() {
    if (!confirm("¿Borrar esta respuesta rápida?")) return;
    const res = await postReplies("delete", { id: reply.id });
    if (res.ok) onSaved("Respuesta borrada 🗑️");
    else alert(res.error ?? "Error borrando");
  }

  if (!editing) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <p className="font-medium text-primary text-sm">{reply.title}</p>
            <p className="text-muted text-sm mt-1 whitespace-pre-wrap">{reply.content}</p>
          </div>
          <div className="flex gap-1 shrink-0">
            <button onClick={() => setEditing(true)} className="px-2 py-1 text-sm text-muted hover:text-primary" title="Editar">
              ✏️
            </button>
            <button onClick={remove} className="px-2 py-1 text-sm text-muted hover:text-red-600" title="Borrar">
              🗑️
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border-2 border-accent p-4">
      <Field label="Título (cómo la ves en el menú)">
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ej: Formas de pago" autoFocus />
      </Field>
      <div className="mt-3">
        <Field label="Contenido (lo que se inserta en el mensaje)">
          <textarea className={textareaCls} rows={4} value={content} onChange={(e) => setContent(e.target.value)} placeholder="El texto que querés mandar…" />
        </Field>
      </div>
      <div className="mt-3 flex gap-2 justify-end">
        <button
          onClick={() => {
            if (isNew) onCancel?.();
            else {
              setEditing(false);
              setTitle(reply.title);
              setContent(reply.content);
            }
          }}
          className="px-4 py-2 text-sm text-muted hover:text-primary"
          disabled={saving}
        >
          Cancelar
        </button>
        <button onClick={save} disabled={saving} className="px-5 py-2 text-sm bg-primary text-white font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-50">
          {saving ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────────────────────

const inputCls =
  "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent";
const textareaCls = `${inputCls} resize-y`;

function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={full ? "sm:col-span-2" : ""}>
      <label className="block text-xs font-medium text-muted mb-1">{label}</label>
      {children}
    </div>
  );
}
