/// <reference types="@cloudflare/workers-types" />
//
// GET /api/inbox/reservations-pending
//
// Lista las reservas en estado 'pending' (POR VERIFICAR) — sobre todo las de
// transferencia por WhatsApp (source 'whatsapp_transfer') que esperan que César
// confirme el pago. Ordenadas por check_in (las más próximas primero).
// Protegido con la cookie de sesión del inbox.
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

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  try {
    const rows = await env.DB.prepare(
      `SELECT id, property_slug, check_in, check_out, guest_name, guest_phone,
              amount_usd, source, created_at
         FROM reservations
        WHERE status = 'pending'
        ORDER BY check_in ASC, created_at DESC
        LIMIT 100`,
    ).all();
    return json({ ok: true, reservations: rows.results ?? [] });
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
  }
};
