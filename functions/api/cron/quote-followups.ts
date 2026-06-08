/// <reference types="@cloudflare/workers-types" />
//
// POST /api/cron/quote-followups
//
// Seguimiento automático: si un cliente dejó una cotización a medias y no
// respondió en ~10 minutos, el bot le reescribe UNA vez ("¿seguimos?") con un
// mensaje contextual según en qué paso quedó. Recupera ventas que se enfrían.
//
// Disparado por el Worker `estadia-jacari-cron` cada ~10 min.
// Auth: Authorization: Bearer <CRON_SECRET>
//
// Reglas:
//   - Solo estados activos sin cerrar (awaiting_quote_data, quote_provided,
//     awaiting_payment_method).
//   - Inactivo entre 10 min y 24 h (la ventana de 24h de WhatsApp para texto libre).
//   - Un solo followup por conversación (followup_sent_at IS NULL).
//
// Respuesta SIEMPRE 200 con detalle JSON.
//

import { requireBearerAuth } from "../../_lib/admin-auth";
import { sendTextMessage } from "../../_lib/whatsapp";
import { PROPERTY_PRICING } from "../../_lib/quote-builder";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

interface StateRow {
  phone: string;
  state: string;
  data: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Construye el mensaje de seguimiento según el paso en que quedó la charla. */
function buildFollowupMessage(state: string, data: Record<string, unknown>): string {
  const slug = typeof data.property === "string" ? data.property : null;
  const propName = slug && PROPERTY_PRICING[slug as keyof typeof PROPERTY_PRICING]
    ? PROPERTY_PRICING[slug as keyof typeof PROPERTY_PRICING].name
    : null;
  const city = typeof data.city === "string" ? data.city : null;
  const en = data.language === "en";
  const ref = propName
    ? en ? ` for ${propName}` : ` con ${propName}`
    : city
      ? en ? ` in ${city}` : ` en ${city}`
      : "";

  if (en) {
    switch (state) {
      case "quote_provided":
        return `Hi again! 👋 Did you get a chance to see the quote${ref}? If you'd like to book or have any questions, I'm here. 🙏`;
      case "awaiting_payment_method":
        return `Hi! Shall we continue with your booking${ref}? Let me know if you prefer *bank transfer* or *card/PayPal* and I'll send the details. 🙏`;
      default:
        return `Hi! 👋 We're still here to help${ref}. Want me to check availability or a quote? Send me the dates and let's take a look. 🌴`;
    }
  }

  switch (state) {
    case "quote_provided":
      return `¡Hola de nuevo! 👋 ¿Pudiste ver la cotización${ref}? Si querés reservar o tenés alguna duda, estoy a la orden. 🙏`;
    case "awaiting_payment_method":
      return `¡Hola! ¿Seguimos con tu reserva${ref}? Decime si preferís *transferencia bancaria* o *tarjeta/PayPal* y te paso los datos enseguida. 🙏`;
    case "awaiting_quote_data":
    default:
      return `¡Hola! 👋 Seguimos a tu disposición${ref}. ¿Querés que te ayude a ver disponibilidad o una cotización? Contame las fechas y lo vemos. 🌴`;
  }
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return json({ ok: false, error: "Faltan credenciales de WhatsApp" }, 500);
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  let rows: StateRow[] = [];
  try {
    const res = await env.DB.prepare(
      `SELECT phone, state, data
         FROM conversation_state
        WHERE state IN ('awaiting_quote_data', 'quote_provided', 'awaiting_payment_method')
          AND followup_sent_at IS NULL
          AND updated_at <= datetime('now', '-10 minutes')
          AND updated_at >= datetime('now', '-24 hours')
          AND expires_at > datetime('now')
        LIMIT 20`,
    ).all<StateRow>();
    rows = res.results ?? [];
  } catch (err) {
    return json({ ok: false, error: `Error D1: ${(err as Error).message}` }, 500);
  }

  const results: Array<{ phone: string; state: string; sent: boolean; error?: string }> = [];

  for (const row of rows) {
    let data: Record<string, unknown> = {};
    if (row.data) {
      try {
        data = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        /* data corrupto — seguir con {} */
      }
    }
    const message = buildFollowupMessage(row.state, data);

    if (dryRun) {
      results.push({ phone: row.phone, state: row.state, sent: false, error: "dryRun" });
      continue;
    }

    const sendResult = await sendTextMessage(row.phone, message, env);

    // Marcar followup enviado SIEMPRE (incluso si falló) para no reintentar en bucle.
    // NO tocamos updated_at: así el ciclo de inactividad no se reinicia.
    try {
      await env.DB.prepare(
        `UPDATE conversation_state SET followup_sent_at = datetime('now') WHERE phone = ?`,
      )
        .bind(row.phone)
        .run();
    } catch {
      /* best-effort */
    }

    // Registrar el mensaje saliente en el historial (para que aparezca en el inbox)
    if (sendResult.ok) {
      try {
        await env.DB.prepare(
          `INSERT INTO whatsapp_messages
             (meta_message_id, direction, from_phone, to_phone, body, matched_rule, escalated, status)
           VALUES (?, 'out', ?, ?, ?, 'auto_followup', 0, 'sent')`,
        )
          .bind(
            sendResult.messageId ?? null,
            env.WHATSAPP_PHONE_NUMBER_ID,
            row.phone,
            message,
          )
          .run();
      } catch {
        /* best-effort */
      }
    }

    results.push({
      phone: row.phone,
      state: row.state,
      sent: sendResult.ok,
      error: sendResult.ok ? undefined : sendResult.error,
    });
  }

  return json({
    ok: true,
    candidates: rows.length,
    sent: results.filter((r) => r.sent).length,
    dryRun,
    results,
  });
};
