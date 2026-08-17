/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/login
//
// Recibe { password } y lo valida contra INBOX_PASSWORD (dueño) o STAFF_PASSWORD
// (empleado). Devuelve la cookie de sesión con el ROL adentro, más { role, user }
// en el body para que el front se pinte de una sin pedir /api/inbox/session.
// Ver inbox-auth.ts para detalles.
//
// Rate limit anti-fuerza-bruta: 10 intentos FALLIDOS por 60s por IP.
//
// Cuentan solo los fallidos, y acertar borra los que se habían acumulado. Antes
// se cobraba el cupo ANTES de mirar la contraseña, así que entrar bien también
// gastaba tiro: con César, Eduardo e Isaías en la misma oficina (una sola IP
// pública para Cloudflare) el tercero en conectarse se comía un 429 sin haberse
// equivocado nunca. Ver el bloque de peek/record/clear en `_lib/rate-limit.ts`.
//
// No afloja la protección: quien no sabe la contraseña sigue topando a los 10
// fallos por minuto y no borra nada. La defensa de fondo es que INBOX_PASSWORD y
// STAFF_PASSWORD no sean adivinables.
//

import { buildLoginCookie } from "../../_lib/inbox-auth";
import {
  peekRateLimit,
  recordRateLimitEvent,
  clearRateLimit,
  getClientIp,
} from "../../_lib/rate-limit";

const RL_ENDPOINT = "inbox/login";
const RL_MAX_FAILS = 10;
const RL_WINDOW_SEC = 60;

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  INBOX_SESSION_SECRET?: string;
  INBOX_PASSWORD?: string;
  STAFF_PASSWORD?: string;
  STAFF_NAME?: string;
}

interface LoginRequest {
  password?: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Rate limit: se MIRA el contador, no se incrementa todavía. El intento solo
  // se anota más abajo si la contraseña resulta incorrecta.
  const ip = getClientIp(request);
  const rl = await peekRateLimit(env, {
    endpoint: RL_ENDPOINT,
    ip,
    max: RL_MAX_FAILS,
    windowSec: RL_WINDOW_SEC,
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
    // Recién ACÁ se gasta el cupo: el intento falló de verdad.
    await recordRateLimitEvent(env, RL_ENDPOINT, ip);
    return jsonResponse({ ok: false, error: result.error }, 401);
  }

  // Entró bien → se limpian los fallos de esa IP. Así, cuando Isaías tipea mal
  // dos veces y a la tercera acierta, no le deja el cupo gastado al siguiente
  // que se conecte desde la misma oficina.
  await clearRateLimit(env, RL_ENDPOINT, ip);

  return new Response(JSON.stringify({ ok: true, role: result.session!.role, user: result.session!.user }), {
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
