/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/bot-qa-resolve
//
// Marca un hallazgo de QA como resuelto (lo borra). Como el análisis es
// incremental (no re-revisa una conversación sin actividad nueva), el hallazgo
// resuelto NO reaparece. Lo dispara el botón "✓ Resuelto" del panel.
//
// Body JSON: { id: 123 }   — protegido con la cookie de sesión del inbox.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";

interface Env {
  DB: D1Database;
  INBOX_PASSWORD?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  let id: number;
  try {
    const body = (await request.json()) as { id?: number };
    id = Number(body.id);
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }
  if (!Number.isInteger(id) || id <= 0) {
    return json({ ok: false, error: "id inválido" }, 400);
  }

  try {
    await env.DB.prepare(`DELETE FROM bot_qa_findings WHERE id = ?`).bind(id).run();
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 200);
  }
  return json({ ok: true, id });
};
