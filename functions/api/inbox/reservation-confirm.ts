/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/reservation-confirm
//
// Confirma una reserva 'pending' → 'confirmed'. A partir de ahí el cron de
// check-in le entrega la info al huésped automáticamente el día de entrada.
// César la toca DESPUÉS de ver la plata en el banco (su regla). Body: { id }.
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
    const res = await env.DB
      .prepare(
        `UPDATE reservations
            SET status = 'confirmed', updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'`,
      )
      .bind(id)
      .run();
    const confirmed = (res.meta?.changes ?? 0) > 0;
    return json({ ok: true, id, confirmed });
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
  }
};
