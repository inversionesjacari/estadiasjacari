/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/conversation-autotag
//
// Auto-clasifica el desenlace de las conversaciones (reservó / cotizó / precio…)
// SIN pisar las etiquetas puestas a mano. Lo dispara:
//   - el botón "Clasificar chats" del Centro de Control → cookie de sesión del inbox.
//   - un cron → Authorization: Bearer <CRON_SECRET>.
//
// Body opcional: { limit }  (default 25, máx 60 por corrida).
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { requireBearerAuth } from "../../_lib/admin-auth";
import { classifyConversations, type ClassifyEnv } from "../../_lib/conversation-classify";

interface Env extends ClassifyEnv {
  INBOX_PASSWORD?: string;
  CRON_SECRET?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const cookieAuth = await requireInboxAuth(request, env);
  if (!cookieAuth.ok) {
    const bearer = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
    if (!bearer.ok) return cookieAuth.response!;
  }

  let limit = 25;
  try {
    const body = (await request.json()) as { limit?: number };
    if (typeof body.limit === "number" && body.limit > 0) limit = body.limit;
  } catch {
    /* sin body → default */
  }

  try {
    const result = await classifyConversations(env, { limit });
    return json({ ok: true, ...result });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
