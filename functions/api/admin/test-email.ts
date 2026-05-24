/// <reference types="@cloudflare/workers-types" />
//
// POST /api/admin/test-email
//
// Endpoint privado que dispara el Correo #1 (confirmación de reserva) o el
// Correo #2 (recordatorio de check-in) a un destinatario arbitrario SIN pasar
// por PayPal. Pensado para iterar diseño/textos de correos sin tener que
// hacer pagos reales + refunds.
//
// Auth: Authorization: Bearer <CRON_SECRET>  (reusa el secret del cron diario)
//
// Body JSON:
//   {
//     "type": "confirmation" | "checkin",     // requerido
//     "guestEmail": "test@example.com",       // requerido — destinatario
//     "slug": "casa-brisa",                   // opcional, default "casa-brisa"
//     "checkIn":  "2026-05-25",               // opcional, default hoy HN
//     "checkOut": "2026-05-26",               // opcional, default hoy+1 HN
//     "guestName":  "Cliente Prueba",         // opcional
//     "guestPhone": "50412345678",            // opcional
//     "amountUsd":  104,                       // opcional, default 100 (solo type=confirmation)
//     "paypalOrderId": "TEST-XYZ"             // opcional, default "TEST-<timestamp>"
//   }
//
// Responde JSON con el resultado del envío:
//   { ok, type, slug, checkIn, checkOut, guestEmail, resendId?, error?, ... }
//
// Para type="checkin" requiere que el slug exista en el Google Sheet (o cache D1)
// y opcionalmente que haya un PDF en R2; si falta el PDF el correo sale sin adjunto.
//

import { sendReservationConfirmationEmail } from "../../_lib/email";
import { sendCheckinReminderEmail } from "../../_lib/checkin-email";
import { getCheckinInfo } from "../../_lib/checkin-info";
import { getCheckinPdf } from "../../_lib/checkin-pdf";
import { todayHn, hnDatePlusDays } from "../../_lib/dates";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  SHEET_WEBHOOK_URL?: string;
  SHEET_WEBHOOK_SECRET?: string;
  CHECKIN_PDFS?: R2Bucket;
}

interface TestEmailRequest {
  type?: "confirmation" | "checkin";
  slug?: string;
  checkIn?: string;
  checkOut?: string;
  guestEmail?: string;
  guestName?: string;
  guestPhone?: string;
  amountUsd?: number;
  paypalOrderId?: string;
}

// Replicado de paypal-webhook.ts para que el endpoint sea autocontenido.
const PROPERTY_NAMES: Record<string, string> = {
  "villa-b11-palma-real": "Villa B11 — Palma Real",
  "casa-brisa": "Casa Brisa",
  "casa-marea": "Casa Marea",
  "centro-morazan": "Centro Morazán",
  "casa-lara-townhouse": "Casa Lara Townhouse",
  "la-florida": "La Florida",
};

function nightsBetween(checkInIso: string, checkOutIso: string): number {
  const start = new Date(checkInIso + "T00:00:00Z").getTime();
  const end = new Date(checkOutIso + "T00:00:00Z").getTime();
  const days = Math.round((end - start) / (1000 * 60 * 60 * 24));
  return Math.max(0, days);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // 1. Auth
  if (!env.CRON_SECRET) {
    return json({ ok: false, error: "Falta env var CRON_SECRET" }, 500);
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.CRON_SECRET}`) {
    return json({ ok: false, error: "No autorizado" }, 401);
  }

  // 2. Parse body
  let body: TestEmailRequest;
  try {
    body = (await request.json()) as TestEmailRequest;
  } catch (err) {
    return json(
      { ok: false, error: `Body no es JSON válido: ${(err as Error).message}` },
      400,
    );
  }

  const type = body.type ?? "confirmation";
  if (type !== "confirmation" && type !== "checkin") {
    return json(
      { ok: false, error: `type inválido: "${type}" (esperado "confirmation" o "checkin")` },
      400,
    );
  }

  const guestEmail = body.guestEmail;
  if (!guestEmail) {
    return json({ ok: false, error: "guestEmail es requerido" }, 400);
  }

  const slug = body.slug || "casa-brisa";
  const checkIn = body.checkIn || todayHn();
  const checkOut = body.checkOut || hnDatePlusDays(1);
  const guestName = body.guestName || "Cliente de Prueba";
  const guestPhone = body.guestPhone || "";

  const resendEnv = {
    RESEND_API_KEY: env.RESEND_API_KEY ?? "",
    EMAIL_FROM: env.EMAIL_FROM ?? "",
    EMAIL_REPLY_TO: env.EMAIL_REPLY_TO,
  };

  // 3. Dispatch por tipo
  if (type === "confirmation") {
    const propertyName = PROPERTY_NAMES[slug] || slug;
    const nights = nightsBetween(checkIn, checkOut);
    const amountUsd = typeof body.amountUsd === "number" ? body.amountUsd : 100;
    const paypalOrderId = body.paypalOrderId || `TEST-${Date.now()}`;

    const result = await sendReservationConfirmationEmail(
      {
        guestName,
        guestEmail,
        guestPhone,
        propertyName,
        checkInISO: checkIn,
        checkOutISO: checkOut,
        nights,
        amountUsd,
        paypalOrderId,
      },
      resendEnv,
    );

    return json(
      {
        ok: result.ok,
        type,
        slug,
        propertyName,
        checkIn,
        checkOut,
        guestEmail,
        nights,
        amountUsd,
        paypalOrderId,
        resendId: result.resendId,
        error: result.error,
      },
      result.ok ? 200 : 502,
    );
  }

  // type === "checkin"
  const infoResult = await getCheckinInfo(slug, {
    DB: env.DB,
    SHEET_WEBHOOK_URL: env.SHEET_WEBHOOK_URL,
    SHEET_WEBHOOK_SECRET: env.SHEET_WEBHOOK_SECRET,
  });

  if (!infoResult.info) {
    return json(
      {
        ok: false,
        type,
        slug,
        checkIn,
        checkOut,
        guestEmail,
        error: `Sin info de check-in para "${slug}": ${infoResult.error ?? "desconocido"}`,
        infoSource: infoResult.source,
      },
      400,
    );
  }

  const pdfResult = await getCheckinPdf(slug, env);
  const propertyName =
    infoResult.info.propertyName || PROPERTY_NAMES[slug] || slug;

  const result = await sendCheckinReminderEmail(
    {
      guestName,
      guestEmail,
      guestPhone,
      checkInISO: checkIn,
      checkOutISO: checkOut,
      info: { ...infoResult.info, propertyName },
      pdf:
        pdfResult.found && pdfResult.bytes
          ? { bytes: pdfResult.bytes, filename: pdfResult.filename! }
          : undefined,
    },
    resendEnv,
  );

  return json(
    {
      ok: result.ok,
      type,
      slug,
      propertyName,
      checkIn,
      checkOut,
      guestEmail,
      infoSource: infoResult.source,
      pdfAttached: pdfResult.found,
      pdfFilename: pdfResult.filename,
      pdfError: pdfResult.error,
      resendId: result.resendId,
      error: result.error,
    },
    result.ok ? 200 : 502,
  );
};
