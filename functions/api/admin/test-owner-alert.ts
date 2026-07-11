/// <reference types="@cloudflare/workers-types" />
//
// POST /api/admin/test-owner-alert
//
// Endpoint privado de diagnóstico (B8, 2026-07-11): dispara UNA alerta de
// prueba por la MISMA ruta que usan las escalaciones reales (notifyOwners →
// template `alerta_jacari` a César + socio) y devuelve en la respuesta el
// veredicto EXACTO de Meta por destinatario (status HTTP + wamid o el body de
// error completo). Diagnóstico en un solo paso: si Meta rechaza el template
// (parámetros que no calzan, idioma, botón URL estático vs dinámico), el error
// aparece ACÁ, no en un silencio.
//
// Auth: Authorization: Bearer <CRON_SECRET>  (mismo patrón que test-whatsapp)
//
// Body JSON (todo opcional):
//   { "tipo": "...", "cliente": "...", "detalle": "...", "guestPhone": "504..." }
//
// Uso típico (César, tras el deploy):
//   curl -X POST https://estadiasjacari.com/api/admin/test-owner-alert \
//     -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" -d '{}'
//

import { notifyOwners } from "../../_lib/owner-alerts";
import { checkRateLimit, getClientIp } from "../../_lib/rate-limit";
import { requireBearerAuth } from "../../_lib/admin-auth";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

interface TestAlertRequest {
  tipo?: string;
  cliente?: string;
  detalle?: string;
  guestPhone?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // 1. Auth (timing-safe Bearer compare via helper compartido)
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  // 2. Rate limit (patrón de test-whatsapp; esto manda WhatsApps reales)
  const ip = getClientIp(request);
  const rl = await checkRateLimit(env, {
    endpoint: "admin/test-owner-alert",
    ip,
    max: 5,
    windowSec: 60,
  });
  if (!rl.allowed) {
    return json(
      { ok: false, error: `Rate limit: ${rl.currentCount} requests en 60s. Reintenta en ${rl.retryAfterSec}s.` },
      429,
    );
  }

  // 3. Body opcional
  let body: TestAlertRequest = {};
  try {
    body = (await request.json()) as TestAlertRequest;
  } catch { /* body vacío o no-JSON → defaults */ }

  // 4. Disparar por la ruta REAL (misma función que usan las escalaciones)
  const result = await notifyOwners(
    { WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID, DB: env.DB },
    {
      tipo: body.tipo || "🧪 Prueba del canal de alertas",
      cliente: body.cliente || "Diagnóstico B8 (sin cliente real)",
      detalle: body.detalle || "Si estás leyendo esto en WhatsApp, el canal de alertas FUNCIONA.",
      guestPhone: body.guestPhone || "",
    },
  );

  // 5. Veredicto crudo — por destinatario: wamid si salió, error EXACTO si no.
  return json(
    {
      ok: result.ok,
      skipped: result.skipped,
      hint: result.ok
        ? "Meta aceptó los envíos. Si igual no llegan al teléfono, revisá los statuses (entrega) — pero la API ya no es el problema."
        : result.skipped
          ? "Falta WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID en el entorno."
          : "Meta rechazó al menos un envío — el campo error de abajo trae el porqué exacto (código + mensaje).",
      results: result.results,
    },
    result.ok ? 200 : 502,
  );
};
