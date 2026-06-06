/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/login
//
// Recibe { password }, valida contra INBOX_PASSWORD, devuelve cookie de sesión
// de 7 días (HttpOnly, Secure, SameSite=Strict). Ver inbox-auth.ts para detalles.
//
// Rate-limited a 5 intentos por 60s por IP para evitar brute-force.
//

import { buildLoginCookie } from "../../_lib/inbox-auth";
import { checkRateLimit, getClientIp } from "../../_lib/rate-limit";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  INBOX_PASSWORD?: string;
}

interface LoginRequest {
  password?: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Rate limit (brute-force protection)
  const ip = getClientIp(request);
  const rl = await checkRateLimit(env, {
    endpoint: "inbox/login",
    ip,
    max: 5,
    windowSec: 60,
  });
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `Demasiados intentos. Reintenta en ${rl.retryAfterSec}s.`,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(rl.retryAfterSec),
        },
      },
    );
  }

  // Parse body
  let body: LoginRequest;
  try {
    body = (await request.json()) as LoginRequest;
  } catch {
    return jsonResponse({ ok: false, error: "Body no es JSON válido" }, 400);
  }
  if (!body.password) {
    return jsonResponse({ ok: false, error: "Password requerido" }, 400);
  }

  const result = await buildLoginCookie(body.password, env);
  if (!result.ok) {
    return jsonResponse({ ok: false, error: result.error }, 401);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": result.setCookie!,
    },
  });
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
