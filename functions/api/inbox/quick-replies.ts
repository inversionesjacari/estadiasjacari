/// <reference types="@cloudflare/workers-types" />
//
// /api/inbox/quick-replies — Respuestas rápidas (plantillas) del inbox.
//
//   GET  → { ok, replies: [{ id, title, content, sortOrder, active }] }
//   POST → { action, payload }:
//          - create { title, content, sortOrder? }
//          - update { id, title, content, sortOrder?, active? }
//          - delete { id }
//
// Son atajos para el operador cuando responde a mano (NO las usa el bot).
// Protegido con requireInboxAuth (misma cookie del resto del /inbox).
// Todas las queries usan prepared statements con bind → seguras contra injection.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";

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

/** Convierte a entero válido o null si no es un número. */
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

interface ReplyRow {
  id: number;
  title: string;
  content: string;
  sort_order: number;
  active: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — listar respuestas rápidas activas
// ─────────────────────────────────────────────────────────────────────────────

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  try {
    const res = await env.DB.prepare(
      `SELECT id, title, content, sort_order, active
         FROM quick_replies
        WHERE active = 1
        ORDER BY sort_order ASC, id ASC`,
    ).all<ReplyRow>();
    const replies = (res.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      sortOrder: r.sort_order,
      active: r.active,
    }));
    return json({ ok: true, replies });
  } catch (err) {
    // Fail-soft: si la tabla todavía no se aplicó (migración 0027 pendiente),
    // devolver lista vacía en vez de romper el inbox.
    console.error("quick-replies GET error:", (err as Error).message);
    return json({ ok: true, replies: [] });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST — crear / editar / borrar
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
      case "create":
        return await createReply(p, env.DB);
      case "update":
        return await updateReply(p, env.DB);
      case "delete":
        return await deleteReply(p, env.DB);
      default:
        return json({ ok: false, error: `Acción desconocida: ${action}` }, 400);
    }
  } catch (err) {
    console.error("quick-replies POST error:", (err as Error).message);
    return json({ ok: false, error: "Error procesando la operación" }, 500);
  }
};

async function createReply(
  p: Record<string, unknown>,
  db: D1Database,
): Promise<Response> {
  const title = toStr(p.title);
  const content = toStr(p.content);
  if (!title) return json({ ok: false, error: "El título no puede estar vacío" }, 400);
  if (!content) return json({ ok: false, error: "El contenido no puede estar vacío" }, 400);
  const sortOrder = toInt(p.sortOrder) ?? 999;

  const result = await db
    .prepare(`INSERT INTO quick_replies (title, content, sort_order) VALUES (?, ?, ?)`)
    .bind(title, content, sortOrder)
    .run();
  return json({ ok: true, id: result.meta?.last_row_id });
}

async function updateReply(
  p: Record<string, unknown>,
  db: D1Database,
): Promise<Response> {
  const id = toInt(p.id);
  if (id == null) return json({ ok: false, error: "id requerido" }, 400);
  const title = toStr(p.title);
  const content = toStr(p.content);
  if (!title) return json({ ok: false, error: "El título no puede estar vacío" }, 400);
  if (!content) return json({ ok: false, error: "El contenido no puede estar vacío" }, 400);
  const sortOrder = toInt(p.sortOrder) ?? 999;
  const active = p.active === false || p.active === 0 ? 0 : 1;

  const result = await db
    .prepare(
      `UPDATE quick_replies SET title = ?, content = ?, sort_order = ?, active = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(title, content, sortOrder, active, id)
    .run();
  if ((result.meta?.changes ?? 0) === 0) {
    return json({ ok: false, error: `Respuesta no encontrada: ${id}` }, 404);
  }
  return json({ ok: true });
}

async function deleteReply(
  p: Record<string, unknown>,
  db: D1Database,
): Promise<Response> {
  const id = toInt(p.id);
  if (id == null) return json({ ok: false, error: "id requerido" }, 400);

  await db.prepare(`DELETE FROM quick_replies WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}
