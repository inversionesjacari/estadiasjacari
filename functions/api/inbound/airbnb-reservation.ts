/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbound/airbnb-reservation
//
// Recibe del Apps Script de Gmail (ver scripts/google-apps-script-airbnb-parser.gs)
// los datos de una nueva reserva de Airbnb parseada del email de confirmación.
// Inserta en D1 con source='airbnb', guest_phone=NULL (se completa después con
// el mensaje del huésped vía /api/inbound/airbnb-message).
//
// Auth: Authorization: Bearer <AIRBNB_INBOUND_SECRET>
//
// Body JSON (ver validateAirbnbReservation en airbnb-parser.ts):
//   {
//     listingName:        "Modern & Comfortable 1 BedRoom Apt",
//     confirmationCode:   "HMXQAHMJ4P",
//     guestName:          "Wander Jeremias Canelo Espinal",
//     checkIn:            "2026-05-29",
//     checkOut:           "2026-06-01",
//     guestCount:         2,
//     amountUsd:          89.01,         // opcional
//     guestLocation:      "Santo Domingo, República Dominicana"  // opcional
//   }
//
// Idempotencia: `confirmationCode` se guarda en `paypal_order_id` (UNIQUE).
// Si llega dos veces el mismo email, el INSERT OR IGNORE no duplica.
// Como prefijamos con "AIRBNB-" no choca con order IDs reales de PayPal.
//

import { validateAirbnbReservation } from "../../_lib/airbnb-parser";
import { checkRateLimit, getClientIp } from "../../_lib/rate-limit";
import { requireBearerAuth } from "../../_lib/admin-auth";

interface Env {
  DB: D1Database;
  AIRBNB_INBOUND_SECRET?: string;
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

  // Rate limit — 30/min holgado para Apps Script legítimo, bloquea flood si
  // el secret se filtra.
  const ip = getClientIp(request);
  const rl = await checkRateLimit(env, {
    endpoint: "inbound/airbnb-reservation",
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

  // Parse + validate
  let raw: unknown;
  try {
    raw = await request.json();
  } catch (err) {
    return json({ ok: false, error: `Body no es JSON: ${(err as Error).message}` }, 400);
  }

  const validation = validateAirbnbReservation(raw);
  if (!validation.ok) {
    return json({ ok: false, errors: validation.errors }, 400);
  }

  const r = validation.normalized!;
  const slug = validation.slug!;
  // Prefijo "AIRBNB-" para distinguir de PayPal en `paypal_order_id`.
  // Mantenemos esa columna como pseudo "external_id" porque ya es UNIQUE
  // y todos los flows de la app la consultan.
  const externalId = `AIRBNB-${r.confirmationCode}`;

  try {
    // INSERT OR IGNORE para idempotencia. Si el email se reprocesa, no duplica.
    const insertResult = await env.DB.prepare(
      `INSERT OR IGNORE INTO reservations
         (property_slug, check_in, check_out, guest_name, guest_email, guest_phone,
          paypal_order_id, amount_usd, status, source, guest_count, raw_payload)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'confirmed', 'airbnb', ?, ?)`,
    )
      .bind(
        slug,
        r.checkIn,
        r.checkOut,
        r.guestName,
        externalId,
        r.amountUsd ?? null,
        r.guestCount,
        JSON.stringify(r),
      )
      .run();

    const changes = insertResult.meta?.changes ?? 0;

    if (changes === 0) {
      // Ya existía — devolver OK pero indicar que no se insertó nada.
      const existing = await env.DB.prepare(
        `SELECT id FROM reservations WHERE paypal_order_id = ?`,
      )
        .bind(externalId)
        .first<{ id: number }>();
      return json({
        ok: true,
        action: "idempotent_skip",
        externalId,
        reservationId: existing?.id ?? null,
        slug,
        message: "Reserva ya existía. No se duplicó.",
      });
    }

    // Sacar el ID de la reserva recién creada para el log
    const created = await env.DB.prepare(
      `SELECT id FROM reservations WHERE paypal_order_id = ?`,
    )
      .bind(externalId)
      .first<{ id: number }>();

    return json({
      ok: true,
      action: "created",
      externalId,
      reservationId: created?.id ?? null,
      slug,
      guestName: r.guestName,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      guestCount: r.guestCount,
    });
  } catch (err) {
    return json(
      { ok: false, error: `Error D1: ${(err as Error).message}` },
      500,
    );
  }
};
