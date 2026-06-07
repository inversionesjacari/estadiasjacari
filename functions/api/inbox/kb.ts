/// <reference types="@cloudflare/workers-types" />
//
// /api/inbox/kb — Lectura y edición de la base de conocimiento del bot.
//
//   GET  → devuelve { properties, policies, faqs }
//   POST → { action, payload } edita la KB. Acciones:
//          - update_property  { slug, ...campos }
//          - update_policy    { key, value }
//          - create_faq       { question, answer, sort_order? }
//          - update_faq       { id, question, answer, sort_order?, active? }
//          - delete_faq       { id }
//
// Protegido con requireInboxAuth (misma cookie de sesión que el resto del /inbox).
// Todas las queries usan prepared statements con bind → seguras contra injection.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { getProperties, getPolicies, getFaqs } from "../../_lib/kb-store";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  INBOX_PASSWORD?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Convierte a entero válido (>= 0) o null si no es un número. */
function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return null;
}

/** Acepta string o null; recorta espacios. Default a "" si undefined. */
function toStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — leer toda la KB
// ─────────────────────────────────────────────────────────────────────────────

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  const [properties, policies, faqs] = await Promise.all([
    getProperties(env.DB),
    getPolicies(env.DB),
    getFaqs(env.DB),
  ]);

  return json({ ok: true, properties, policies, faqs });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST — editar la KB
// ─────────────────────────────────────────────────────────────────────────────

interface PostBody {
  action?: string;
  payload?: Record<string, unknown>;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return json({ ok: false, error: "Body no es JSON válido" }, 400);
  }

  const action = body.action;
  const p = body.payload ?? {};

  try {
    switch (action) {
      case "update_property":
        return await updateProperty(p, env.DB);
      case "update_policy":
        return await updatePolicy(p, env.DB);
      case "create_faq":
        return await createFaq(p, env.DB);
      case "update_faq":
        return await updateFaq(p, env.DB);
      case "delete_faq":
        return await deleteFaq(p, env.DB);
      default:
        return json({ ok: false, error: `Acción desconocida: ${action}` }, 400);
    }
  } catch (err) {
    console.error("KB POST error:", (err as Error).message);
    return json({ ok: false, error: "Error procesando la operación" }, 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers por acción
// ─────────────────────────────────────────────────────────────────────────────

async function updateProperty(
  p: Record<string, unknown>,
  db: D1Database,
): Promise<Response> {
  const slug = toStr(p.slug);
  if (!slug) return json({ ok: false, error: "slug requerido" }, 400);

  const capacity = toInt(p.capacity);
  const priceNightHnl = toInt(p.priceNightHnl);
  const cleaningHnl = toInt(p.cleaningHnl);
  const priceNightUsd = toInt(p.priceNightUsd);
  const cleaningUsd = toInt(p.cleaningUsd);

  // Validaciones numéricas mínimas
  if (capacity == null || capacity < 1 || capacity > 30) {
    return json({ ok: false, error: "Capacidad debe ser un número entre 1 y 30" }, 400);
  }
  if (priceNightHnl == null || priceNightHnl < 0) {
    return json({ ok: false, error: "Precio por noche (HNL) inválido" }, 400);
  }
  if (cleaningHnl == null || cleaningHnl < 0) {
    return json({ ok: false, error: "Tarifa de limpieza (HNL) inválida" }, 400);
  }
  if (priceNightUsd == null || priceNightUsd < 0) {
    return json({ ok: false, error: "Precio por noche (USD) inválido" }, 400);
  }
  if (cleaningUsd == null || cleaningUsd < 0) {
    return json({ ok: false, error: "Tarifa de limpieza (USD) inválida" }, 400);
  }

  const result = await db
    .prepare(
      `UPDATE kb_properties SET
         name = ?, city = ?, capacity = ?, bedrooms = ?, bathrooms = ?, beds = ?,
         price_night_hnl = ?, cleaning_hnl = ?, price_night_usd = ?, cleaning_usd = ?,
         aliases = ?, amenities = ?, pool = ?, beach = ?, pets = ?, parking = ?, tv = ?,
         ideal_for = ?, notes = ?, active = ?, updated_at = datetime('now')
       WHERE slug = ?`,
    )
    .bind(
      toStr(p.name),
      toStr(p.city),
      capacity,
      toInt(p.bedrooms),
      toInt(p.bathrooms),
      toStr(p.beds),
      priceNightHnl,
      cleaningHnl,
      priceNightUsd,
      cleaningUsd,
      toStr(p.aliases),
      toStr(p.amenities),
      toStr(p.pool),
      toStr(p.beach),
      toStr(p.pets),
      toStr(p.parking),
      toStr(p.tv),
      toStr(p.idealFor),
      toStr(p.notes),
      p.active === false || p.active === 0 ? 0 : 1,
      slug,
    )
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    return json({ ok: false, error: `Propiedad no encontrada: ${slug}` }, 404);
  }
  return json({ ok: true });
}

async function updatePolicy(
  p: Record<string, unknown>,
  db: D1Database,
): Promise<Response> {
  const key = toStr(p.key);
  const value = toStr(p.value);
  if (!key) return json({ ok: false, error: "key requerida" }, 400);
  if (!value) return json({ ok: false, error: "El valor no puede estar vacío" }, 400);

  const result = await db
    .prepare(
      `UPDATE kb_policies SET value = ?, updated_at = datetime('now') WHERE key = ?`,
    )
    .bind(value, key)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    return json({ ok: false, error: `Política no encontrada: ${key}` }, 404);
  }
  return json({ ok: true });
}

async function createFaq(
  p: Record<string, unknown>,
  db: D1Database,
): Promise<Response> {
  const question = toStr(p.question);
  const answer = toStr(p.answer);
  if (!question) return json({ ok: false, error: "La pregunta no puede estar vacía" }, 400);
  if (!answer) return json({ ok: false, error: "La respuesta no puede estar vacía" }, 400);
  const sortOrder = toInt(p.sortOrder) ?? 999;

  const result = await db
    .prepare(
      `INSERT INTO kb_faqs (question, answer, sort_order) VALUES (?, ?, ?)`,
    )
    .bind(question, answer, sortOrder)
    .run();

  return json({ ok: true, id: result.meta?.last_row_id });
}

async function updateFaq(
  p: Record<string, unknown>,
  db: D1Database,
): Promise<Response> {
  const id = toInt(p.id);
  if (id == null) return json({ ok: false, error: "id requerido" }, 400);
  const question = toStr(p.question);
  const answer = toStr(p.answer);
  if (!question) return json({ ok: false, error: "La pregunta no puede estar vacía" }, 400);
  if (!answer) return json({ ok: false, error: "La respuesta no puede estar vacía" }, 400);
  const sortOrder = toInt(p.sortOrder) ?? 999;
  const active = p.active === false || p.active === 0 ? 0 : 1;

  const result = await db
    .prepare(
      `UPDATE kb_faqs SET question = ?, answer = ?, sort_order = ?, active = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(question, answer, sortOrder, active, id)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    return json({ ok: false, error: `FAQ no encontrada: ${id}` }, 404);
  }
  return json({ ok: true });
}

async function deleteFaq(
  p: Record<string, unknown>,
  db: D1Database,
): Promise<Response> {
  const id = toInt(p.id);
  if (id == null) return json({ ok: false, error: "id requerido" }, 400);

  await db.prepare(`DELETE FROM kb_faqs WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}
