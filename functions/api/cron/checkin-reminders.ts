/// <reference types="@cloudflare/workers-types" />
//
// POST /api/cron/checkin-reminders
//
// Job diario que envía el Correo #2 (recordatorio de check-in) a los huéspedes
// cuya llegada es MAÑANA (hora Honduras). Pensado para dispararse a las 00:00 UTC
// = 6:00 PM hora Honduras (UTC-6, sin horario de verano).
//
// Lo invoca un Cloudflare Worker con Cron Trigger `0 0 * * *` que hace:
//   fetch('https://estadiasjacari.pages.dev/api/cron/checkin-reminders', {
//     method: 'POST', headers: { Authorization: 'Bearer ' + CRON_SECRET } })
// (ver scripts/cron-worker.js). También se puede llamar manual con curl para test.
//
// Seguridad: requiere header `Authorization: Bearer <CRON_SECRET>`.
//
// Parámetros opcionales (query string, solo para pruebas):
//   ?date=YYYY-MM-DD  → en vez de "mañana", procesa esa fecha de check-in.
//   ?dryRun=1         → no envía ni marca nada; devuelve a quién notificaría.
//
// Idempotencia: solo procesa reservas con `checkin_reminder_sent_at IS NULL`.
// Si el envío al huésped falla o falta la info de check-in, NO marca como
// enviado, registra el error y avisa al dueño (EMAIL_REPLY_TO) para gestión
// manual — porque el recordatorio es time-sensitive (la llegada es mañana).
//

import { getCheckinInfo } from "../../_lib/checkin-info";
import { sendCheckinReminderEmail } from "../../_lib/checkin-email";
import { sendViaResend } from "../../_lib/resend";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  SHEET_WEBHOOK_URL?: string;
  SHEET_WEBHOOK_SECRET?: string;
}

interface ReservationRow {
  id: number;
  property_slug: string;
  check_in: string;
  check_out: string;
  guest_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
}

/** Fecha actual en Honduras (YYYY-MM-DD) desplazada `days` días. */
function hnDatePlusDays(days: number): string {
  // en-CA produce formato YYYY-MM-DD.
  const todayHn = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = todayHn.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Avisa al dueño (al Gmail vía EMAIL_REPLY_TO) que un recordatorio no salió. */
async function notifyOwner(
  env: Env,
  reservation: ReservationRow,
  reason: string,
): Promise<void> {
  const to = env.EMAIL_REPLY_TO;
  if (!to || !env.RESEND_API_KEY || !env.EMAIL_FROM) return;
  const subject = `⚠️ Recordatorio de check-in NO enviado — ${reservation.property_slug} (${reservation.check_in})`;
  const text =
    `No se pudo enviar el recordatorio de check-in al huésped. Gestiónalo manualmente.\n\n` +
    `Propiedad: ${reservation.property_slug}\n` +
    `Check-in: ${reservation.check_in}\n` +
    `Check-out: ${reservation.check_out}\n` +
    `Huésped: ${reservation.guest_name ?? "(sin nombre)"}\n` +
    `Email: ${reservation.guest_email ?? "(sin email)"}\n` +
    `Teléfono: ${reservation.guest_phone ?? "(sin teléfono)"}\n\n` +
    `Motivo: ${reason}\n`;
  try {
    await sendViaResend(
      { to, subject, html: `<pre>${text}</pre>`, text },
      { RESEND_API_KEY: env.RESEND_API_KEY, EMAIL_FROM: env.EMAIL_FROM, EMAIL_REPLY_TO: env.EMAIL_REPLY_TO },
    );
  } catch {
    // best-effort
  }
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // 1. Auth
  if (!env.CRON_SECRET) {
    return json({ ok: false, error: "Falta env var CRON_SECRET" }, 500);
  }
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.CRON_SECRET}`;
  if (auth !== expected) {
    return json({ ok: false, error: "No autorizado" }, 401);
  }

  // 2. Fecha objetivo (mañana HN por defecto; override por ?date= para test)
  const url = new URL(request.url);
  const dateParam = url.searchParams.get("date");
  const dryRun = url.searchParams.get("dryRun") === "1";
  const targetDate =
    dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? dateParam
      : hnDatePlusDays(1);

  // 3. Reservas confirmadas con check-in en la fecha objetivo, sin recordar
  let reservations: ReservationRow[];
  try {
    const res = await env.DB.prepare(
      `SELECT id, property_slug, check_in, check_out, guest_name, guest_email, guest_phone
         FROM reservations
        WHERE status = 'confirmed'
          AND check_in = ?
          AND checkin_reminder_sent_at IS NULL`,
    )
      .bind(targetDate)
      .all<ReservationRow>();
    reservations = res.results ?? [];
  } catch (err) {
    return json(
      { ok: false, error: `Error consultando D1: ${(err as Error).message}`, targetDate },
      500,
    );
  }

  const details: Array<{
    id: number;
    slug: string;
    guestEmail: string | null;
    status: "sent" | "failed" | "skipped";
    infoSource?: string;
    error?: string;
  }> = [];
  let sent = 0;
  let failed = 0;

  for (const r of reservations) {
    // Sin email no hay a quién enviar.
    if (!r.guest_email) {
      failed++;
      details.push({ id: r.id, slug: r.property_slug, guestEmail: null, status: "failed", error: "Reserva sin guest_email" });
      if (!dryRun) {
        await markError(env, r.id, "Reserva sin guest_email");
        await notifyOwner(env, r, "Reserva sin guest_email");
      }
      continue;
    }

    // Info de check-in (Sheet privado → cache D1)
    const { info, source, error: infoError } = await getCheckinInfo(r.property_slug, {
      DB: env.DB,
      SHEET_WEBHOOK_URL: env.SHEET_WEBHOOK_URL,
      SHEET_WEBHOOK_SECRET: env.SHEET_WEBHOOK_SECRET,
    });

    if (!info) {
      failed++;
      const reason = `Sin info de check-in para "${r.property_slug}": ${infoError ?? "desconocido"}`;
      details.push({ id: r.id, slug: r.property_slug, guestEmail: r.guest_email, status: "failed", infoSource: source, error: reason });
      if (!dryRun) {
        await markError(env, r.id, reason);
        await notifyOwner(env, r, reason);
      }
      continue;
    }

    if (dryRun) {
      details.push({ id: r.id, slug: r.property_slug, guestEmail: r.guest_email, status: "sent", infoSource: source });
      sent++;
      continue;
    }

    // Enviar Correo #2
    const result = await sendCheckinReminderEmail(
      {
        guestName: r.guest_name || "huésped",
        guestEmail: r.guest_email,
        guestPhone: r.guest_phone || "",
        checkInISO: r.check_in,
        checkOutISO: r.check_out,
        info,
      },
      {
        RESEND_API_KEY: env.RESEND_API_KEY ?? "",
        EMAIL_FROM: env.EMAIL_FROM ?? "",
        EMAIL_REPLY_TO: env.EMAIL_REPLY_TO,
      },
    );

    if (result.ok) {
      sent++;
      details.push({ id: r.id, slug: r.property_slug, guestEmail: r.guest_email, status: "sent", infoSource: source });
      try {
        await env.DB.prepare(
          `UPDATE reservations
              SET checkin_reminder_sent_at = datetime('now'),
                  checkin_reminder_error = NULL,
                  updated_at = datetime('now')
            WHERE id = ?`,
        )
          .bind(r.id)
          .run();
      } catch {
        // Si falla el UPDATE, el correo ya salió; en la próxima corrida
        // podría reenviarse. Riesgo bajo (un correo duplicado, no crítico).
      }
    } else {
      failed++;
      const reason = result.error ?? "Error desconocido enviando email";
      details.push({ id: r.id, slug: r.property_slug, guestEmail: r.guest_email, status: "failed", infoSource: source, error: reason });
      await markError(env, r.id, reason);
      await notifyOwner(env, r, reason);
    }
  }

  return json({
    ok: true,
    targetDate,
    dryRun,
    found: reservations.length,
    sent,
    failed,
    details,
  });
};

/** Registra un error de recordatorio en la reserva (sin marcar como enviado). */
async function markError(env: Env, id: number, reason: string): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE reservations
          SET checkin_reminder_error = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(reason.slice(0, 1000), id)
      .run();
  } catch {
    // best-effort
  }
}
