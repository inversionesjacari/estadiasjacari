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
//   - Hasta 2 intentos de followup por conversación (followup_attempts < 2):
//       · Si Meta confirma el envío → se marca followup_sent_at y ya no se reintenta.
//       · Si Meta devuelve failed → solo se incrementa followup_attempts y el
//         siguiente tick lo reintenta, hasta agotar los 2 intentos.
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
      case "awaiting_transfer_proof":
        return `Hi! 👋 Were you able to make the transfer${ref}? When you do, *send me a photo of the receipt here* and we'll confirm your booking. 🙏`;
      case "awaiting_paypal_capture":
        return `Hi! 👋 Were you able to complete the payment with the link${ref}? Let me know if you ran into any trouble. 🙏`;
      case "awaiting_quote_data":
      default:
        return buildGatherFollowup(data, ref, true);
    }
  }

  switch (state) {
    case "quote_provided":
      return `¡Hola de nuevo! 👋 ¿Pudiste ver la cotización${ref}? Si querés reservar o tenés alguna duda, estoy a la orden. 🙏`;
    case "awaiting_payment_method":
      return `¡Hola! ¿Seguimos con tu reserva${ref}? Decime si preferís *transferencia bancaria* o *tarjeta/PayPal* y te paso los datos enseguida. 🙏`;
    case "awaiting_transfer_proof":
      return `¡Hola! 👋 ¿Pudiste hacer la transferencia${ref}? Cuando la hagas, *mandame foto del comprobante por acá* y te confirmamos la reserva. 🙏`;
    case "awaiting_paypal_capture":
      return `¡Hola! 👋 ¿Pudiste completar el pago con el link${ref}? Si tuviste algún problema, avisame. 🙏`;
    case "awaiting_quote_data":
    default:
      return buildGatherFollowup(data, ref, false);
  }
}

/**
 * Followup cuando la charla quedó juntando datos (awaiting_quote_data).
 * Reconoce lo que el cliente YA dio (destino, personas, fechas) y pide SOLO lo
 * que falta. Repreguntar en genérico ("contame las fechas") cuando el cliente
 * ya las dio se siente como que el bot no lo escuchó, y enfría la venta.
 * `ref` ya trae el destino (" con X" / " en Ciudad") si lo hay.
 */
function buildGatherFollowup(data: Record<string, unknown>, ref: string, en: boolean): string {
  const hasDest = ref !== "";
  const hasGuests = typeof data.guests === "number" && (data.guests as number) > 0;
  const hasDates = Boolean(data.checkIn && data.checkOut);

  const missing: string[] = [];
  if (!hasDest) missing.push(en ? "the destination (La Ceiba, Tela or Tegucigalpa)" : "el destino (La Ceiba, Tela o Tegucigalpa)");
  if (!hasGuests) missing.push(en ? "how many guests" : "cuántas personas");
  if (!hasDates) missing.push(en ? "the dates" : "las fechas");

  // Ya tiene todo: el followup solo reanima, SIN asumir que es una cotización en
  // firme (el cliente puede estar solo explorando — "quiero info" no es "cotizame").
  if (missing.length === 0) {
    return en
      ? `Hi again! 👋 Want me to check availability and options${ref}? Just let me know. 🙏`
      : `¡Hola de nuevo! 👋 ¿Te muestro disponibilidad y opciones${ref}? Avisame cuando gustes. 🙏`;
  }

  const join = (xs: string[]) =>
    xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")} ${en ? "and" : "y"} ${xs[xs.length - 1]}`;

  // Tono exploratorio, no transaccional: "te muestro opciones", no "la cotización".
  return en
    ? `Hi again! 👋 Shall we continue${ref}? Tell me ${join(missing)} and I'll show you some options. No rush! 🌴`
    : `¡Hola de nuevo! 👋 ¿Seguimos${ref}? Contame ${join(missing)} y te muestro opciones. ¡Sin apuro! 🌴`;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return json({ ok: false, error: "Faltan credenciales de WhatsApp" }, 500);
  }

  // Latido: registrar que el cron corrió (para el Centro de Control).
  try {
    await env.DB.prepare(
      `INSERT INTO system_heartbeat (key, last_at) VALUES ('cron_followups', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET last_at = datetime('now')`,
    ).run();
  } catch {
    // best-effort (la tabla puede no existir aún)
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  let rows: StateRow[] = [];
  try {
    const res = await env.DB.prepare(
      `SELECT phone, state, data
         FROM conversation_state
        WHERE state IN ('awaiting_quote_data', 'quote_provided', 'awaiting_payment_method', 'awaiting_transfer_proof', 'awaiting_paypal_capture')
          AND followup_sent_at IS NULL
          AND followup_attempts < 2
          AND updated_at <= datetime('now', '-10 minutes')
          AND updated_at >= datetime('now', '-24 hours')
          AND expires_at > datetime('now')
          AND phone NOT IN (SELECT phone FROM bot_pauses)
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

    // Contabilizar el intento. NO tocamos updated_at: así el ciclo de
    // inactividad no se reinicia.
    //   - Envío OK   → marcar followup_sent_at + sumar intento: no se reintenta más.
    //   - Envío FAIL → solo sumar intento: el siguiente tick lo reintenta hasta
    //     llegar a 2 intentos (la query filtra followup_attempts < 2).
    try {
      await env.DB.prepare(
        sendResult.ok
          ? `UPDATE conversation_state
                SET followup_sent_at = datetime('now'),
                    followup_attempts = followup_attempts + 1
              WHERE phone = ?`
          : `UPDATE conversation_state
                SET followup_attempts = followup_attempts + 1
              WHERE phone = ?`,
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
