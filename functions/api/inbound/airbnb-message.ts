/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbound/airbnb-message
//
// Recibe del Apps Script de Gmail un mensaje del huésped en el chat de Airbnb.
// Intenta extraer un número de teléfono y, si lo encuentra, lo guarda en la
// reserva (UPDATE guest_phone). Si no encuentra o el match es ambiguo, notifica
// a César por correo para captura manual.
//
// Auth: Authorization: Bearer <AIRBNB_INBOUND_SECRET>
//
// Body JSON:
//   {
//     confirmationCode: "HMXQAHMJ4P",     // opcional, ayuda a matchear
//     guestName:        "Wander Jeremias", // fallback
//     messageText:      "+504 9764-9035 gracias!"
//   }
//
// Si el parser encuentra el teléfono → UPDATE guest_phone en D1.
// Si NO encuentra → email a EMAIL_REPLY_TO con el contexto para captura manual.
//

import { extractPhoneFromText, type AirbnbMessagePayload } from "../../_lib/airbnb-parser";
import { normalizePhone, isValidE164 } from "../../_lib/phone";
import { sendViaResend } from "../../_lib/resend";
import { checkRateLimit, getClientIp } from "../../_lib/rate-limit";
import { requireBearerAuth } from "../../_lib/admin-auth";

interface Env {
  DB: D1Database;
  AIRBNB_INBOUND_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Auth (timing-safe Bearer compare via helper compartido)
  const auth = requireBearerAuth(request, env.AIRBNB_INBOUND_SECRET, "AIRBNB_INBOUND_SECRET");
  if (!auth.ok) return auth.response!;

  // Rate limit — protege contra leak del AIRBNB_INBOUND_SECRET (spam de
  // notifyOwner emails). 30/min holgado para el Apps Script legítimo.
  const ip = getClientIp(request);
  const rl = await checkRateLimit(env, {
    endpoint: "inbound/airbnb-message",
    ip,
    max: 30,
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

  // Parse
  let payload: AirbnbMessagePayload;
  try {
    payload = (await request.json()) as AirbnbMessagePayload;
  } catch (err) {
    return json({ ok: false, error: `Body no es JSON: ${(err as Error).message}` }, 400);
  }

  if (!payload.messageText || payload.messageText.trim().length === 0) {
    return json({ ok: false, error: "messageText vacío" }, 400);
  }

  // Buscar reserva — prioridad: confirmationCode > guestName con check-in futuro/actual
  const reservation = await findReservation(env.DB, payload);
  if (!reservation) {
    // Sin reserva en D1, no podemos asociar el teléfono. Notificar a César.
    await notifyOwnerNoReservation(env, payload);
    return json({
      ok: false,
      action: "no_reservation_found",
      reason: "No se encontró reserva matcheando confirmationCode/guestName",
      messageExcerpt: payload.messageText.slice(0, 200),
    });
  }

  // Si ya tiene teléfono, no sobreescribir — solo loggear
  if (reservation.guest_phone) {
    return json({
      ok: true,
      action: "already_has_phone",
      reservationId: reservation.id,
      existingPhone: reservation.guest_phone,
    });
  }

  // Intentar extraer el teléfono del mensaje
  const rawPhone = extractPhoneFromText(payload.messageText);
  if (!rawPhone) {
    await notifyOwnerCantParse(env, payload, reservation);
    return json({
      ok: false,
      action: "phone_not_found",
      reservationId: reservation.id,
      messageExcerpt: payload.messageText.slice(0, 200),
    });
  }

  const { e164, hadCountryCode } = normalizePhone(rawPhone);
  if (!isValidE164(e164)) {
    await notifyOwnerCantParse(env, payload, reservation);
    return json({
      ok: false,
      action: "phone_invalid",
      reservationId: reservation.id,
      rawPhone,
      normalized: e164,
    });
  }

  // UPDATE reservation con el teléfono encontrado
  try {
    await env.DB.prepare(
      `UPDATE reservations
          SET guest_phone = ?,
              guest_phone_normalized = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(rawPhone, e164, reservation.id)
      .run();
  } catch (err) {
    return json({ ok: false, error: `Error D1: ${(err as Error).message}` }, 500);
  }

  return json({
    ok: true,
    action: "phone_captured",
    reservationId: reservation.id,
    rawPhone,
    normalized: e164,
    hadCountryCode,
    propertySlug: reservation.property_slug,
    note: "El cron `whatsapp-operations` y el webhook PayPal podrán mandar templates a este número.",
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ReservationRow {
  id: number;
  property_slug: string;
  guest_name: string | null;
  guest_phone: string | null;
  check_in: string;
  check_out: string;
}

async function findReservation(
  db: D1Database,
  payload: AirbnbMessagePayload,
): Promise<ReservationRow | null> {
  // Prioridad 1: confirmationCode exacto (prefijado AIRBNB-)
  if (payload.confirmationCode) {
    const code = payload.confirmationCode.trim().toUpperCase();
    const row = await db
      .prepare(
        `SELECT id, property_slug, guest_name, guest_phone, check_in, check_out
           FROM reservations
          WHERE paypal_order_id = ?
            AND source = 'airbnb'
          LIMIT 1`,
      )
      .bind(`AIRBNB-${code}`)
      .first<ReservationRow>();
    if (row) return row;
  }

  // Prioridad 2: guestName + reserva activa
  if (payload.guestName) {
    const name = payload.guestName.trim();
    const today = new Date().toISOString().slice(0, 10);
    const row = await db
      .prepare(
        `SELECT id, property_slug, guest_name, guest_phone, check_in, check_out
           FROM reservations
          WHERE source = 'airbnb'
            AND status IN ('confirmed', 'pending')
            AND check_out >= ?
            AND guest_name = ?
          ORDER BY check_in ASC
          LIMIT 1`,
      )
      .bind(today, name)
      .first<ReservationRow>();
    if (row) return row;
  }

  return null;
}

async function notifyOwnerNoReservation(env: Env, p: AirbnbMessagePayload): Promise<void> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.EMAIL_REPLY_TO) return;
  const subject = `⚠️ Mensaje Airbnb sin reserva matcheable (${p.guestName ?? "sin nombre"})`;
  const text =
    `Llegó un mensaje del chat de Airbnb pero no se encontró reserva matcheable.\n\n` +
    `Código: ${p.confirmationCode ?? "(sin código)"}\n` +
    `Nombre: ${p.guestName ?? "(sin nombre)"}\n\n` +
    `Mensaje:\n${p.messageText.slice(0, 1000)}\n\n` +
    `Acción sugerida: verifica que la reserva esté creada en D1 (la confirmación de email de Airbnb pudo haberse perdido). Si no, créala manual.`;
  try {
    await sendViaResend(
      { to: env.EMAIL_REPLY_TO, subject, text, html: `<pre>${escapeHtml(text)}</pre>` },
      { RESEND_API_KEY: env.RESEND_API_KEY, EMAIL_FROM: env.EMAIL_FROM, EMAIL_REPLY_TO: env.EMAIL_REPLY_TO },
    );
  } catch {
    // best-effort
  }
}

async function notifyOwnerCantParse(
  env: Env,
  p: AirbnbMessagePayload,
  r: ReservationRow,
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.EMAIL_REPLY_TO) return;
  const subject = `⚠️ Teléfono no parseable del huésped ${r.guest_name ?? r.id} (${r.property_slug})`;
  const text =
    `El huésped respondió en Airbnb pero el parser de teléfono no encontró un número válido en el mensaje.\n\n` +
    `Huésped: ${r.guest_name ?? "(sin nombre)"}\n` +
    `Propiedad: ${r.property_slug}\n` +
    `Check-in: ${r.check_in} | Check-out: ${r.check_out}\n` +
    `Reservation ID: ${r.id}\n\n` +
    `Mensaje:\n${p.messageText.slice(0, 1000)}\n\n` +
    `Acción sugerida: pídele al huésped que reenvíe el número con espacios entre dígitos, o agrégalo manual con un UPDATE D1:\n\n` +
    `  UPDATE reservations SET guest_phone='<raw>', guest_phone_normalized='<e164>' WHERE id=${r.id};`;
  try {
    await sendViaResend(
      { to: env.EMAIL_REPLY_TO, subject, text, html: `<pre>${escapeHtml(text)}</pre>` },
      { RESEND_API_KEY: env.RESEND_API_KEY, EMAIL_FROM: env.EMAIL_FROM, EMAIL_REPLY_TO: env.EMAIL_REPLY_TO },
    );
  } catch {
    // best-effort
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
