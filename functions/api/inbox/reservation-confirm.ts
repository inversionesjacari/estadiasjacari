/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/reservation-confirm
//
// Confirma una reserva 'pending' → 'confirmed'. A partir de ahí el cron de
// check-in le entrega la info al huésped automáticamente el día antes de entrar.
// César la toca DESPUÉS de ver la plata en el banco (su regla). Body: { id }.
// Protegido con la cookie de sesión del inbox.
//
// Cierre del hueco "confirm-tarde" (auditoría 2026-07-12): el cron T-1 corre la
// víspera 6 PM y solo mira las llegadas de MAÑANA. Si César confirma tarde —el
// mismo día de llegada, o la víspera pasado el cron— el huésped se quedaba sin
// instrucciones. Ahora, si la llegada cae en [hoy, mañana] y aún no salió el
// recordatorio, este endpoint auto-dispara el cron de check-in para esa fecha
// exacta (reusa TODA la maquinaria de envío: idempotente por
// checkin_reminder_sent_at, formatea "hoy/mañana" solo). Best-effort: si el
// envío falla, la confirmación NO se cae (el huésped queda confirmado igual).
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { shouldSendCheckinNow } from "../../_lib/checkin-immediate";
import { todayHn, hnDatePlusDays } from "../../_lib/dates";

interface Env {
  DB: D1Database;
  INBOX_PASSWORD?: string;
  // Para auto-disparar el cron de check-in al confirmar tarde (self-fetch).
  CRON_SECRET?: string;
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

  let id: number;
  try {
    const body = (await request.json()) as { id?: number };
    id = Number(body.id);
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }
  if (!Number.isInteger(id) || id <= 0) {
    return json({ ok: false, error: "id inválido" }, 400);
  }

  let confirmed = false;
  try {
    const res = await env.DB
      .prepare(
        `UPDATE reservations
            SET status = 'confirmed', updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'`,
      )
      .bind(id)
      .run();
    confirmed = (res.meta?.changes ?? 0) > 0;
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
  }

  // Si acabó de confirmarse y la llegada es inminente, disparar el check-in ya
  // (el cron T-1 no la cubre). Todo best-effort: nunca romper el confirmar.
  let checkinTriggered = false;
  if (confirmed) {
    try {
      const row = await env.DB
        .prepare(
          `SELECT check_in, checkin_reminder_sent_at
             FROM reservations WHERE id = ?`,
        )
        .bind(id)
        .first<{ check_in: string | null; checkin_reminder_sent_at: string | null }>();

      const today = todayHn();
      const tomorrow = hnDatePlusDays(1);
      if (
        row &&
        env.CRON_SECRET &&
        shouldSendCheckinNow(row.check_in, row.checkin_reminder_sent_at, today, tomorrow)
      ) {
        const origin = new URL(request.url).origin;
        const resp = await fetch(
          `${origin}/api/cron/checkin-reminders?date=${row.check_in}`,
          { method: "POST", headers: { Authorization: `Bearer ${env.CRON_SECRET}` } },
        );
        // resp.ok = el cron corrió para esa fecha (no garantiza entrega: si falta
        // guest_email o Meta rechaza, el propio cron avisa a los dueños y la card
        // "Salud de entrega" lo muestra). El cron es idempotente por
        // checkin_reminder_sent_at, así que no duplica con el disparo diario.
        checkinTriggered = resp.ok;
      }
    } catch (err) {
      // Best-effort: el huésped ya quedó confirmado; el cron diario sigue de
      // respaldo para llegadas de mañana. Se registra pero no se falla.
      console.error("reservation-confirm: auto check-in falló:", (err as Error).message);
    }
  }

  return json({ ok: true, id, confirmed, checkinTriggered });
};
