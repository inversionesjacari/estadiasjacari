/// <reference types="@cloudflare/workers-types" />
//
// GET  /api/inbox/bot-global  → { ok, paused, since }   (estado del interruptor)
// POST /api/inbox/bot-global  → body { on: boolean }    (encender/apagar TODO el bot)
//
// Interruptor GENERAL del bot (pedido de César 2026-07-08, ads corriendo y leads
// que se perdían): apagado = el webhook deja de auto-responder a TODOS los
// números (los mensajes se siguen guardando en el inbox y el equipo atiende a
// mano), y los crons de followup / auto-recuperación no mandan nada. Los avisos
// OPERATIVOS de reservas confirmadas (check-in, staff) NO se apagan.
// Implementado como la fila especial phone='*' en bot_pauses (ver _lib/bot-pause.ts).
//
// Protegido con la cookie de sesión del inbox.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { globalBotPausedSince, setGlobalBot } from "../../_lib/bot-pause";

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
  const since = await globalBotPausedSince(env.DB);
  return json({ ok: true, paused: since !== null, since });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  let on: boolean;
  try {
    const body = (await request.json()) as { on?: unknown };
    if (typeof body.on !== "boolean") {
      return json({ ok: false, error: "Body esperado: { on: true|false }" }, 400);
    }
    on = body.on;
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }

  await setGlobalBot(on, env.DB);
  const since = await globalBotPausedSince(env.DB);
  return json({ ok: true, paused: since !== null, since });
};
