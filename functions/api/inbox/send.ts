/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/send
//
// Envía un mensaje de texto libre a un número (dentro de la ventana de 24h
// del usuario — sin esa ventana fallaría porque Meta exige template).
// Persiste el mensaje en `whatsapp_messages` con direction='out'.
//
// Body JSON:
//   { phone: "50488390145", text: "Hola, te confirmo..." }
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { sendTextMessage } from "../../_lib/whatsapp";
import { isValidE164 } from "../../_lib/phone";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  INBOX_PASSWORD?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

interface SendRequest {
  phone?: string;
  text?: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return json(
      { ok: false, error: "WhatsApp Cloud API no configurado (faltan env vars Meta)" },
      500,
    );
  }

  let body: SendRequest;
  try {
    body = (await request.json()) as SendRequest;
  } catch {
    return json({ ok: false, error: "Body no es JSON válido" }, 400);
  }

  const phone = body.phone?.trim();
  const text = body.text?.trim();
  if (!phone || !isValidE164(phone)) {
    return json({ ok: false, error: "phone inválido (E.164 sin '+', 8-15 dígitos)" }, 400);
  }
  if (!text || text.length === 0) {
    return json({ ok: false, error: "text vacío" }, 400);
  }
  if (text.length > 4000) {
    return json({ ok: false, error: "text demasiado largo (máx 4000 chars)" }, 400);
  }

  // Buscar reservation_id asociado (best-effort, no bloquea el envío)
  let reservationId: number | null = null;
  try {
    const row = await env.DB.prepare(
      `SELECT id FROM reservations
        WHERE guest_phone_normalized = ?
          AND status IN ('confirmed', 'pending')
        ORDER BY check_in DESC
        LIMIT 1`,
    )
      .bind(phone)
      .first<{ id: number }>();
    reservationId = row?.id ?? null;
  } catch {
    // ignore
  }

  // Enviar
  const sendResult = await sendTextMessage(phone, text, env);

  // Loggear en whatsapp_messages (siempre, ok o no)
  try {
    await env.DB.prepare(
      `INSERT INTO whatsapp_messages
         (meta_message_id, reservation_id, direction, from_phone, to_phone, body, matched_rule, escalated, status)
       VALUES (?, ?, 'out', ?, ?, ?, 'manual_inbox', 0, ?)`,
    )
      .bind(
        sendResult.messageId ?? null,
        reservationId,
        env.WHATSAPP_PHONE_NUMBER_ID,
        phone,
        sendResult.ok ? text : `[FAILED] ${text}\n\nERROR: ${sendResult.error}`,
        sendResult.ok ? "sent" : "failed",
      )
      .run();
  } catch (logErr) {
    console.error("Error guardando mensaje saliente manual:", (logErr as Error).message);
  }

  if (!sendResult.ok) {
    return json({ ok: false, error: sendResult.error }, 502);
  }

  return json({
    ok: true,
    phone,
    messageId: sendResult.messageId,
    reservationId,
  });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
