/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/bot-retry-now
//
// "Que el bot retome": encola una conversación en bot_retry_queue para que el
// cron /api/cron/bot-retry reprocese el último mensaje del cliente y el bot
// responda SOLO (auto-recuperación bajo demanda). Útil para un chat que quedó
// mudo/escalado por un crash del LLM y querés que el bot lo retome sin esperar
// ni tocar SQL. El cron salta el chat si el bot está en pausa o si ya hubo
// respuesta posterior, así que es seguro apretarlo aunque el chat esté sano.
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
        `INSERT INTO bot_retry_queue (phone, attempts, created_at)
         VALUES (?, 0, datetime('now'))
         ON CONFLICT(phone) DO UPDATE SET attempts = 0, created_at = datetime('now')`,
      )
      .bind(phone)
      .run();
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
  }

  return json({ ok: true, phone, queued: true });
};
