/// <reference types="@cloudflare/workers-types" />
//
// GET /api/inbox/session
//
// "¿Quién soy?" — devuelve { ok, role, user } leyendo la cookie de sesión.
// El front lo usa para adaptar la pantalla al rol (esconder Centro de control y
// las columnas de plata cuando entra el empleado) y para mostrar el nombre en el
// header.
//
// OJO: esto es COSMÉTICA. Que el front esconda un botón no protege nada; la
// frontera real la ponen `requireOwner` y `redactMoney` en cada endpoint.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";

interface Env {
  CRON_SECRET?: string;
  INBOX_SESSION_SECRET?: string;
  INBOX_PASSWORD?: string;
  STAFF_PASSWORD?: string;
  STAFF_NAME?: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  return new Response(
    JSON.stringify({ ok: true, role: auth.session!.role, user: auth.session!.user }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // Nunca cachear: depende de la cookie de quien pregunta.
        "Cache-Control": "no-store",
      },
    },
  );
};
