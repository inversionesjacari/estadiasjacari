/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbound/airbnb-cancellation
//
// Recibe del Apps Script de Gmail una cancelación de reserva de Airbnb.
// César etiqueta el email con "Airbnb-Cancellations" en Gmail (igual que
// "Airbnb-Reservations"/"Airbnb-Messages") — NO hay auto-detección de
// subject/body: nunca vimos un email de cancelación real para basar un
// parser confiable en eso, así que la señal confiable es que CÉSAR lo
// etiquetó a mano. Lo único que el script extrae es el confirmationCode
// (está en cualquier correo de Airbnb sobre la reserva).
//
// Marca la reserva como status='cancelled'. Esto:
//   1. Libera la disponibilidad automáticamente — availability/[slug].ts ya
//      filtra WHERE status IN ('pending','confirmed'), sin cambios ahí.
//   2. Excluye la reserva del próximo sync a contabilidad (sync-airbnb-income.js
//      filtra status='confirmed'), y si YA se había sincronizado antes de
//      cancelarse, el sync borra ese income (ver ese archivo).
//
// Auth: Authorization: Bearer <AIRBNB_INBOUND_SECRET> (mismo secret que
// /api/inbound/airbnb-reservation — no hace falta uno nuevo).
//
// Body JSON: { confirmationCode: "HMXQAHMJ4P" }
//

import { checkRateLimit, getClientIp } from "../../_lib/rate-limit";
import { requireBearerAuth } from "../../_lib/admin-auth";

interface Env {
  DB: D1Database;
  AIRBNB_INBOUND_SECRET?: string;
}

interface ReservationRow {
  id: number;
  status: string;
  property_slug: string;
  check_in: string;
  check_out: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireBearerAuth(request, env.AIRBNB_INBOUND_SECRET, "AIRBNB_INBOUND_SECRET");
  if (!auth.ok) return auth.response!;

  const ip = getClientIp(request);
  const rl = await checkRateLimit(env, {
    endpoint: "inbound/airbnb-cancellation",
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

  let payload: { confirmationCode?: string };
  try {
    payload = (await request.json()) as { confirmationCode?: string };
  } catch (err) {
    return json({ ok: false, error: `Body no es JSON: ${(err as Error).message}` }, 400);
  }

  const code = (payload.confirmationCode ?? "").trim().toUpperCase();
  if (!code) return json({ ok: false, error: "confirmationCode requerido" }, 400);

  const externalId = `AIRBNB-${code}`;

  try {
    const existing = await env.DB
      .prepare(
        `SELECT id, status, property_slug, check_in, check_out
           FROM reservations
          WHERE paypal_order_id = ?`,
      )
      .bind(externalId)
      .first<ReservationRow>();

    if (!existing) {
      // El email se etiquetó pero no hay reserva en D1 con ese código — puede
      // ser que el import original haya fallado (o que el backfill no haya
      // llegado a esta reserva todavía). No hay nada que cancelar; visible
      // en el log del Apps Script para revisión manual.
      return json({
        ok: false,
        action: "not_found",
        error: `No hay reserva con code ${code} en D1 — revisar si el import original falló o falta backfill.`,
      });
    }

    if (existing.status === "cancelled") {
      return json({ ok: true, action: "already_cancelled", reservationId: existing.id });
    }

    await env.DB
      .prepare(`UPDATE reservations SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`)
      .bind(existing.id)
      .run();

    return json({
      ok: true,
      action: "cancelled",
      reservationId: existing.id,
      propertySlug: existing.property_slug,
      checkIn: existing.check_in,
      checkOut: existing.check_out,
      previousStatus: existing.status,
      note: "Disponibilidad liberada automáticamente. Próximo sync a contabilidad la excluye (o borra el income si ya estaba sincronizado).",
    });
  } catch (err) {
    return json({ ok: false, error: `Error D1: ${(err as Error).message}` }, 500);
  }
};
