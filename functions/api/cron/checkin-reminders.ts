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
import { getCheckinPdf } from "../../_lib/checkin-pdf";
import { hnDatePlusDays, todayHn } from "../../_lib/dates";
import { sendCheckinReminderWhatsApp, formatCheckinDateForTemplate } from "../../_lib/whatsapp";
import { logOutboundTemplate } from "../../_lib/wa-log";
import { normalizePhone, isValidE164 } from "../../_lib/phone";
import { checkRateLimit, getClientIp } from "../../_lib/rate-limit";
import { requireBearerAuth } from "../../_lib/admin-auth";
import { withCronMonitor } from "../../_lib/cron-monitor";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  SHEET_WEBHOOK_URL?: string;
  SHEET_WEBHOOK_SECRET?: string;
  /** Bucket R2 con PDFs de check-in privados (filename: `<slug>.pdf`). */
  CHECKIN_PDFS?: R2Bucket;
  // Fase 5 — WhatsApp Cloud API
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
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

export const onRequestPost: PagesFunction<Env> = (context) =>
  withCronMonitor(context.env, "cron_checkin_reminders", () => handlePost(context));

const handlePost: PagesFunction<Env> = async ({ request, env }) => {
  // 1. Auth (timing-safe Bearer compare via helper compartido)
  const authResult = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!authResult.ok) return authResult.response!;

  // 1b. Rate limit por IP — defensa adicional si CRON_SECRET se filtra.
  // 30/min es holgado para el cron legítimo (1/día) + tests manuales con curl.
  const ip = getClientIp(request);
  const rl = await checkRateLimit(env, {
    endpoint: "cron/checkin-reminders",
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

    // PDF de bienvenida desde R2 (graceful degradation: si falta, mandamos
    // el correo sin adjunto + avisamos al dueño que suba el PDF de esa propiedad).
    const pdfResult = await getCheckinPdf(r.property_slug, env);
    if (!pdfResult.found && !dryRun) {
      // No bloquea el correo — solo aviso al dueño.
      await notifyOwner(
        env,
        r,
        `PDF de check-in faltante en R2 para "${r.property_slug}": ${pdfResult.error}. El correo se envió igual con la info en el cuerpo, pero conviene subir el PDF.`,
      );
    }

    if (dryRun) {
      details.push({
        id: r.id,
        slug: r.property_slug,
        guestEmail: r.guest_email,
        status: "sent",
        infoSource: source,
      });
      sent++;
      continue;
    }

    // Enviar Correo #2 (con PDF si está disponible)
    const result = await sendCheckinReminderEmail(
      {
        guestName: r.guest_name || "huésped",
        guestEmail: r.guest_email,
        guestPhone: r.guest_phone || "",
        checkInISO: r.check_in,
        checkOutISO: r.check_out,
        info,
        pdf:
          pdfResult.found && pdfResult.bytes
            ? { bytes: pdfResult.bytes, filename: pdfResult.filename! }
            : undefined,
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

      // ── WhatsApp (Fase 5) ───────────────────────────────────────────────
      // Solo intentar si: (1) hay config Meta, (2) el huésped tiene teléfono
      // válido, (3) el PDF existe (sin PDF no mandamos el template document),
      // (4) no fue enviado antes (whatsapp_sent_at IS NULL).
      if (
        env.WHATSAPP_ACCESS_TOKEN &&
        env.WHATSAPP_PHONE_NUMBER_ID &&
        r.guest_phone &&
        pdfResult.found &&
        pdfResult.bytes
      ) {
        try {
          const existing = await env.DB.prepare(
            `SELECT whatsapp_sent_at FROM reservations WHERE id = ?`,
          )
            .bind(r.id)
            .first<{ whatsapp_sent_at: string | null }>();

          if (existing && !existing.whatsapp_sent_at) {
            const { e164 } = normalizePhone(r.guest_phone);
            if (isValidE164(e164)) {
              const propertyName = info.propertyName || r.property_slug;
              const checkInDateEs = formatCheckinDateForTemplate(r.check_in, todayHn());
              const waResult = await sendCheckinReminderWhatsApp(
                {
                  toPhone: e164,
                  guestName: r.guest_name || "huésped",
                  propertyName,
                  checkInDateEs,
                  pdfBytes: pdfResult.bytes,
                  pdfFilename: pdfResult.filename ?? `instrucciones-checkin-${r.property_slug}.pdf`,
                },
                { WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID },
              );

              await env.DB.prepare(
                `UPDATE reservations
                    SET whatsapp_sent_at    = ?,
                        whatsapp_error      = ?,
                        whatsapp_message_id = ?,
                        updated_at          = datetime('now')
                  WHERE id = ?`,
              )
                .bind(
                  waResult.ok ? new Date().toISOString() : null,
                  waResult.ok ? null : (waResult.error ?? "error desconocido").slice(0, 1000),
                  waResult.messageId ?? null,
                  r.id,
                )
                .run();

              // Fila rastreable en whatsapp_messages: con el wamid, el callback
              // de Meta le actualiza los checks (sent→delivered→read→failed) y
              // la card "📬 Salud de entrega" del inbox la ve. Fail-soft.
              await logOutboundTemplate(env.DB, {
                fromPhone: env.WHATSAPP_PHONE_NUMBER_ID,
                toPhone: e164,
                rule: "checkin_reminder",
                summary: `📋 Instrucciones de check-in + PDF — ${propertyName} (${checkInDateEs})`,
                reservationId: r.id,
                ok: waResult.ok,
                messageId: waResult.messageId ?? null,
                error: waResult.error ?? null,
              });
            }
          }
        } catch (waErr) {
          // WhatsApp es best-effort: el correo ya salió. Nunca bloqueamos
          // ni marcamos la reserva como fallida por error de WhatsApp.
          console.error(`WhatsApp cron error (id=${r.id}):`, (waErr as Error).message);
        }
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
