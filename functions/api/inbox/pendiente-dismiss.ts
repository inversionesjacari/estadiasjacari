/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/pendiente-dismiss
//
// Descarta un chat de la columna "Pendientes" del inbox (botón ✕). Lo oculta
// hasta que el cliente vuelva a escribir (un mensaje más nuevo que dismissed_at
// lo hace reaparecer). Útil para vendedores/spam o chats ya atendidos por fuera.
//
// Body JSON: { phone }. Protegido con la cookie de sesión del inbox.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { isValidE164 } from "../../_lib/phone";

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

  let phone: string;
  try {
    const body = (await request.json()) as { phone?: string };
    phone = (body.phone ?? "").trim();
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }

  if (!phone || !isValidE164(phone)) {
    return json({ ok: false, error: "Teléfono inválido" }, 400);
  }

  try {
    await env.DB
      .prepare(
        `INSERT INTO pendientes_dismissed (phone, dismissed_at)
         VALUES (?, datetime('now'))
         ON CONFLICT(phone) DO UPDATE SET dismissed_at = datetime('now')`,
      )
      .bind(phone)
      .run();
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
  }

  return json({ ok: true, phone, dismissed: true });
};
