/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/reservation-send-message
//
// Dispara MANUALMENTE un template operativo de WhatsApp a una reserva desde el
// dashboard de Reservas (/inbox/reservas). Mismo motor que el cron y que el
// endpoint admin, pero protegido con la COOKIE del inbox (lo llama el browser),
// no con el Bearer CRON_SECRET.
//
// Pensado para las reservas DIRECTAS (WhatsApp/web): el cron automático solo
// toca las de Airbnb; estas las dispara César a mano tras verificar el pago.
//
// Body JSON:
//   {
//     "reservationId": 42,
//     "template": "checkin_dia_huesped"|"checkin_dia_limpieza"|"checkin_dia_seguridad"|
//                 "checkout_dia_huesped"|"checkout_dia_limpieza"|"confirmacion_whatsapp_capturado",
//     "force": false,   // si true, reenvía aunque ya se haya marcado wa_*_sent_at
//     "dryRun": false   // si true, valida sin enviar ni tocar D1
//   }
//
// Idempotente y marca wa_*_sent_at en D1 (lógica compartida en _lib/whatsapp-dispatch.ts).
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import {
  dispatchTemplateToReservation,
  VALID_TEMPLATES,
  type DispatchTemplateName,
} from "../../_lib/whatsapp-dispatch";

interface Env {
  DB: D1Database;
  INBOX_PASSWORD?: string;
  CRON_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

interface RequestBody {
  reservationId?: number;
  template?: DispatchTemplateName;
  force?: boolean;
  dryRun?: boolean;
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

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch (err) {
    return json({ ok: false, error: `Body no es JSON: ${(err as Error).message}` }, 400);
  }

  if (!body.reservationId || !Number.isFinite(body.reservationId)) {
    return json({ ok: false, error: "reservationId requerido (number)" }, 400);
  }
  if (!body.template || !VALID_TEMPLATES.includes(body.template)) {
    return json({ ok: false, error: `template inválido. Válidos: ${VALID_TEMPLATES.join(", ")}` }, 400);
  }

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
};
