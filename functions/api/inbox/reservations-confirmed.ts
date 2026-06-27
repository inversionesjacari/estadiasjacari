/// <reference types="@cloudflare/workers-types" />
//
// GET /api/inbox/reservations-confirmed
//
// Alimenta el dashboard /inbox/reservas. Lista TODAS las reservas activas
// (status 'confirmed' = pago completo, o 'pending' = depósito 50% / por verificar)
// cuyo check_out aún no pasó. Ordenadas por check_in (las más próximas primero).
//
// Incluye las columnas wa_*_sent_at para que el dashboard muestre, de un vistazo,
// qué mensajes ya salieron (T-1 instrucciones, huésped día-de, limpieza, seguridad)
// y a quién le falta seguimiento. Hace LEFT JOIN al último comprobante de
// transferencia de cada reserva para distinguir "Depósito 50%" de "Por verificar".
//
// Protegido con la cookie de sesión del inbox.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { todayHn } from "../../_lib/dates";

interface Env {
  DB: D1Database;
  INBOX_PASSWORD?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  try {
    const rows = await env.DB.prepare(
      `SELECT r.id, r.property_slug, r.check_in, r.check_out, r.guest_name,
              r.guest_phone, r.guest_count, r.amount_usd, r.source, r.status, r.created_at,
              r.notified_at, r.checkin_reminder_sent_at, r.whatsapp_sent_at,
              r.wa_arrival_guest_sent_at, r.wa_arrival_cleaning_sent_at, r.wa_arrival_security_sent_at,
              r.wa_departure_guest_sent_at, r.wa_departure_cleaning_sent_at, r.wa_phone_capture_sent_at,
              tr.amount AS tr_amount, tr.expected_hnl AS tr_expected_hnl,
              tr.currency AS tr_currency, tr.decision AS tr_decision
         FROM reservations r
         LEFT JOIN transfer_receipts tr
           ON tr.id = (
             SELECT t2.id FROM transfer_receipts t2
              WHERE t2.reservation_id = r.id
              ORDER BY t2.id DESC LIMIT 1
           )
        WHERE r.status IN ('confirmed', 'pending')
          AND r.check_out >= ?
        ORDER BY r.check_in ASC, r.created_at DESC
        LIMIT 200`,
    )
      .bind(todayHn())
      .all();
    return json({ ok: true, reservations: rows.results ?? [] });
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
  }
};
