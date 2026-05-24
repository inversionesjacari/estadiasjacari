/// <reference types="@cloudflare/workers-types" />
//
// POST /api/admin/test-whatsapp
//
// Endpoint privado que dispara el mensaje de WhatsApp de check-in (template
// checkin_instructions) a un número arbitrario SIN esperar a que sea la noche
// anterior ni a que haya un pago real. Pensado para iterar y verificar el
// flow de WhatsApp sin reservas de prueba.
//
// Auth: Authorization: Bearer <CRON_SECRET>  (mismo secret del cron y test-email)
//
// Body JSON:
//   {
//     "guestPhone": "+50488390145",   // requerido — número destino
//     "slug":       "casa-brisa",    // opcional, default "casa-brisa"
//     "checkIn":    "2026-05-25",    // opcional, default mañana HN
//     "guestName":  "Cliente Test",  // opcional
//   }
//
// Responde JSON:
//   { ok, guestPhone, e164, slug, propertyName, checkInDateEs,
//     pdfAttached, messageId?, mediaId?, error? }
//
// Requiere:
//   - WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID configurados
//   - Slug presente en Google Sheet / cache D1 (para nombre de propiedad)
//   - PDF subido a R2 para ese slug (sin PDF el envío falla — el template
//     exige header document obligatorio)
//   - Número destino registrado como Recipient en la consola de Meta si la
//     app sigue en modo Desarrollo
//

import { sendCheckinReminderWhatsApp, formatCheckinDateForTemplate } from "../../_lib/whatsapp";
import { normalizePhone, isValidE164 } from "../../_lib/phone";
import { getCheckinInfo } from "../../_lib/checkin-info";
import { getCheckinPdf } from "../../_lib/checkin-pdf";
import { todayHn, hnDatePlusDays } from "../../_lib/dates";
import { checkRateLimit, getClientIp } from "../../_lib/rate-limit";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  SHEET_WEBHOOK_URL?: string;
  SHEET_WEBHOOK_SECRET?: string;
  CHECKIN_PDFS?: R2Bucket;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

interface TestWhatsAppRequest {
  guestPhone?: string;
  slug?: string;
  checkIn?: string;
  guestName?: string;
}

const PROPERTY_NAMES: Record<string, string> = {
  "villa-b11-palma-real": "Villa B11 — Palma Real",
  "casa-brisa": "Casa Brisa",
  "casa-marea": "Casa Marea",
  "centro-morazan": "Centro Morazán",
  "casa-lara-townhouse": "Casa Lara Townhouse",
  "la-florida": "La Florida",
};

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

  // 2. Rate limit (mismo patrón que test-email)
  const ip = getClientIp(request);
  const rl = await checkRateLimit(env, {
    endpoint: "admin/test-whatsapp",
    ip,
    max: 10,
    windowSec: 60,
  });
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `Rate limit excedido: ${rl.currentCount} requests en los últimos 60s. Reintenta en ${rl.retryAfterSec}s.`,
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

  // 3. Validar config WhatsApp
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return json({
      ok: false,
      error: "Faltan env vars WHATSAPP_ACCESS_TOKEN y/o WHATSAPP_PHONE_NUMBER_ID",
    }, 500);
  }

  // 4. Parse body
  let body: TestWhatsAppRequest;
  try {
    body = (await request.json()) as TestWhatsAppRequest;
  } catch (err) {
    return json({ ok: false, error: `Body no es JSON válido: ${(err as Error).message}` }, 400);
  }

  if (!body.guestPhone) {
    return json({ ok: false, error: "guestPhone es requerido" }, 400);
  }

  // 5. Normalizar teléfono
  const { e164, hadCountryCode, original } = normalizePhone(body.guestPhone);
  if (!isValidE164(e164)) {
    return json({
      ok: false,
      error: `Teléfono inválido: "${original}" → "${e164}" (esperado 8-15 dígitos sin '+')`,
      hadCountryCode,
    }, 400);
  }

  const slug = body.slug || "casa-brisa";
  const checkIn = body.checkIn || hnDatePlusDays(1);
  const guestName = body.guestName || "Cliente de Prueba";

  // 6. Info de propiedad (nombre para la variable {{2}} del template)
  const infoResult = await getCheckinInfo(slug, {
    DB: env.DB,
    SHEET_WEBHOOK_URL: env.SHEET_WEBHOOK_URL,
    SHEET_WEBHOOK_SECRET: env.SHEET_WEBHOOK_SECRET,
  });
  const propertyName =
    infoResult.info?.propertyName || PROPERTY_NAMES[slug] || slug;

  // 7. PDF (obligatorio para template con header document)
  const pdfResult = await getCheckinPdf(slug, env);
  if (!pdfResult.found || !pdfResult.bytes) {
    return json({
      ok: false,
      slug,
      propertyName,
      error: `PDF no encontrado en R2 para "${slug}": ${pdfResult.error}. El template checkin_instructions exige header document — sin PDF no se puede enviar.`,
    }, 400);
  }

  // 8. Formatear fecha para variable {{3}}
  const checkInDateEs = formatCheckinDateForTemplate(checkIn, todayHn());

  // 9. Enviar
  const waResult = await sendCheckinReminderWhatsApp(
    {
      toPhone: e164,
      guestName,
      propertyName,
      checkInDateEs,
      pdfBytes: pdfResult.bytes,
      pdfFilename: pdfResult.filename ?? `instrucciones-checkin-${slug}.pdf`,
    },
    {
      WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
    },
  );

  return json(
    {
      ok: waResult.ok,
      guestPhone: original,
      e164,
      hadCountryCode,
      slug,
      propertyName,
      checkIn,
      checkInDateEs,
      pdfAttached: true,
      pdfFilename: pdfResult.filename,
      pdfSizeBytes: pdfResult.sizeBytes,
      messageId: waResult.messageId,
      mediaId: waResult.mediaId,
      error: waResult.error,
    },
    waResult.ok ? 200 : 502,
  );
};
