/// <reference types="@cloudflare/workers-types" />
//
// POST /api/admin/send-whatsapp-manual
//
// Endpoint privado para disparar manualmente CUALQUIER template operativo de
// WhatsApp a una reserva o a un teléfono ad-hoc, sin esperar al cron. Útil
// para casos sueltos: reenvíos, re-tests, propiedades sin contactos staff
// registrados aún, etc.
//
// Auth: Authorization: Bearer <CRON_SECRET>  (mismo secret del cron + test-email)
//
// Body JSON — DOS modos:
//
// Modo A — por reserva (idempotente; respeta wa_*_sent_at):
//   {
//     "template": "checkin_dia_huesped"|"checkin_dia_limpieza"|"checkin_dia_seguridad"|
//                 "checkout_dia_huesped"|"checkout_dia_limpieza"|"confirmacion_whatsapp_capturado",
//     "reservationId": 42,
//     "force": false,   // si true, ignora el wa_*_sent_at y reenvía
//     "dryRun": false   // si true, valida y rutea SIN enviar ni tocar D1
//   }
//
// Modo B — ad-hoc (NO idempotente, NO actualiza D1):
//   {
//     "template": "<mismo set de arriba>",
//     "toPhone":  "+50488390145",            // requerido en modo B
//     "vars": ["César","Casa Brisa","Tela"]   // requerido — variables en orden {{1}},{{2}},...
//   }
//
// El endpoint detecta el modo por presencia de reservationId vs toPhone.
//
// La lógica de Modo A vive en functions/_lib/whatsapp-dispatch.ts (compartida con
// el endpoint inbox cookie-authed reservation-send-message.ts).
//
// Rate limit: 10 requests por 60s por IP (mismo patrón que test-email y test-whatsapp).
//

import { normalizePhone, isValidE164 } from "../../_lib/phone";
import { checkRateLimit, getClientIp } from "../../_lib/rate-limit";
import { requireBearerAuth } from "../../_lib/admin-auth";
import { sendTextTemplate } from "../../_lib/whatsapp-templates";
import {
  dispatchTemplateToReservation,
  VALID_TEMPLATES,
  type DispatchTemplateName,
} from "../../_lib/whatsapp-dispatch";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

interface RequestBody {
  template?: DispatchTemplateName;
  reservationId?: number;
  toPhone?: string;
  vars?: string[];
  force?: boolean;
  dryRun?: boolean;
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

  // 2. Rate limit
  const ip = getClientIp(request);
  const rl = await checkRateLimit(env, {
    endpoint: "admin/send-whatsapp-manual",
    ip,
    max: 10,
    windowSec: 60,
  });
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `Rate limit excedido: ${rl.currentCount} en 60s. Reintenta en ${rl.retryAfterSec}s.`,
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

  // 3. Validar config Meta
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return json({
      ok: false,
      error: "Faltan env vars WHATSAPP_ACCESS_TOKEN y/o WHATSAPP_PHONE_NUMBER_ID",
    }, 500);
  }

  // 4. Parse body
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch (err) {
    return json({ ok: false, error: `Body no es JSON: ${(err as Error).message}` }, 400);
  }

  if (!body.template || !VALID_TEMPLATES.includes(body.template)) {
    return json({
      ok: false,
      error: `template inválido. Válidos: ${VALID_TEMPLATES.join(", ")}`,
    }, 400);
  }

  // 5. Dispatch — Modo A (reservationId) o Modo B (toPhone + vars)
  if (body.reservationId) {
    const result = await dispatchTemplateToReservation(
      {
        reservationId: body.reservationId,
        template: body.template,
        force: body.force === true,
        dryRun: body.dryRun === true,
      },
      env,
    );
    return json(result.body, result.status);
  } else if (body.toPhone && body.vars) {
    return handleAdHoc(body, {
      WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
    });
  } else {
    return json({
      ok: false,
      error: "Body debe incluir 'reservationId' (modo A) o 'toPhone' + 'vars' (modo B).",
    }, 400);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Modo B — Ad-hoc (no toca D1). Manda el template a un número arbitrario con las
// variables en orden. Útil para tests y casos sin reserva en D1.
// ─────────────────────────────────────────────────────────────────────────────

async function handleAdHoc(
  body: RequestBody,
  waEnv: { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
): Promise<Response> {
  const template = body.template!;
  const { e164 } = normalizePhone(body.toPhone!);
  if (!isValidE164(e164)) {
    return json({
      ok: false,
      error: `toPhone inválido: "${body.toPhone}" → "${e164}"`,
    }, 400);
  }
  const vars = body.vars ?? [];

  const result = await sendTextTemplate(template, e164, vars, waEnv);
  return json({
    ok: result.ok,
    mode: "ad-hoc",
    template,
    toPhone: e164,
    vars,
    messageId: result.messageId,
    error: result.error,
  });
}
