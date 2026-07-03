/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/conversation-tag
//
// Etiqueta una conversación con su DESENLACE + de qué propiedad preguntó. Sirve
// para descifrar en qué quedó cada chat y alimenta el "seguimiento por propiedad"
// del reporte de marketing. Upsert por teléfono (el estado actual de la conversación).
//
// Body JSON: { phone, outcome, propertySlug?, note? }
//   outcome vacío/"" → borra la etiqueta (des-etiquetar).
// Protegido con la cookie de sesión del inbox.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { isValidE164 } from "../../_lib/phone";

interface Env {
  DB: D1Database;
  INBOX_PASSWORD?: string;
}

// Desenlaces válidos (espejo del selector del inbox).
const OUTCOMES = new Set(["reservo", "cotizo", "sin_disponibilidad", "precio", "sin_respuesta", "fuera", "otro"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  let body: { phone?: string; outcome?: string; propertySlug?: string; note?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }

  const phone = (body.phone ?? "").trim();
  if (!phone || !isValidE164(phone)) return json({ ok: false, error: "Teléfono inválido" }, 400);

  const outcome = (body.outcome ?? "").trim();
  // outcome vacío → borrar la etiqueta.
  if (!outcome) {
    try {
      await env.DB.prepare(`DELETE FROM conversation_tags WHERE phone = ?`).bind(phone).run();
    } catch (err) {
      return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
    }
    return json({ ok: true, phone, cleared: true });
  }

  if (!OUTCOMES.has(outcome)) return json({ ok: false, error: `Desenlace inválido: ${outcome}` }, 400);
  const propertySlug = (body.propertySlug ?? "").trim() || null;
  const note = (body.note ?? "").trim().slice(0, 300) || null;

  try {
    await env.DB
      .prepare(
        `INSERT INTO conversation_tags (phone, outcome, property_slug, note, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(phone) DO UPDATE SET
           outcome = excluded.outcome,
           property_slug = excluded.property_slug,
           note = excluded.note,
           updated_at = datetime('now')`,
      )
      .bind(phone, outcome, propertySlug, note)
      .run();
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
  }

  return json({ ok: true, phone, outcome, propertySlug, note });
};
