/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/bot-pause
//
// Pausa el bot para una conversación: el humano toma el control y el webhook
// deja de auto-responder a ese número. Lo dispara el botón "Pausar bot" del
// inbox. Se revierte con "Reactivar bot" (/api/inbox/bot-resume).
//
// Responder a mano (/api/inbox/send) ya NO pausa el bot automáticamente —
// pausar es una decisión explícita que se hace con este botón.
//
// Body JSON: { phone: "50488390145" }
// Protegido con la cookie de sesión del inbox.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { isValidE164 } from "../../_lib/phone";
import { pauseBot } from "../../_lib/bot-pause";

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

  await pauseBot(phone, "manual_inbox", env.DB);
  return json({ ok: true, phone, botPaused: true });
};
