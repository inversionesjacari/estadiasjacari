/// <reference types="@cloudflare/workers-types" />
//
// @ts-ignore — import relativo a Pages Function helper compartido
import { sendReservationConfirmationEmail } from "../_lib/email";
// Fase 3.7 — edge case mismo-día
import { getCheckinInfo } from "../_lib/checkin-info";
import { getCheckinPdf } from "../_lib/checkin-pdf";
import { sendCheckinReminderEmail } from "../_lib/checkin-email";
import { todayHn } from "../_lib/dates";
import { fetchWithTimeout, TIMEOUT } from "../_lib/fetch";
// Fase 5 — WhatsApp Cloud API
import { sendCheckinReminderWhatsApp, formatCheckinDateForTemplate } from "../_lib/whatsapp";
import { logOutboundTemplate } from "../_lib/wa-log";
import { normalizePhone, isValidE164 } from "../_lib/phone";
// Sprint 1 — Templates operativos WhatsApp (limpieza + seguridad + huésped día)
import {
  sendCheckinDiaHuesped,
  sendCheckinDiaLimpieza,
  sendCheckinDiaSeguridad,
  formatDateShortEs,
} from "../_lib/whatsapp-templates";
import { getCleaningContacts, getSecurityContacts } from "../_lib/property-contacts";
// Auditoría Sesión 2 — B1 doble booking
import { refundPayPalCapture } from "../_lib/paypal-refund";
import { sendOverlapApologyEmail } from "../_lib/overlap-apology-email";
// Quote flow (bot WhatsApp con LLM) — para órdenes originadas vía WhatsApp
import { parseWhatsAppCustomId } from "../_lib/paypal-checkout";
import { sendTextMessage } from "../_lib/whatsapp";
import { clearState as clearConversationState, getState as getConversationState } from "../_lib/quote-state";
// Auditoría 2026-07-12 (A1/A2): overlap+refund+status pending para órdenes del bot
import { handleWaCapture } from "../_lib/paypal-wa-capture";
import { asLang, type Lang } from "../_lib/i18n";
import { notifyOwners } from "../_lib/owner-alerts";

//
// POST /api/paypal-webhook
//
// Recibe notificaciones de PayPal cuando un pago cambia de estado. Verifica la
// firma usando la API oficial de PayPal y registra/actualiza la reserva en D1.
//
// Eventos manejados:
//   PAYMENT.CAPTURE.COMPLETED → INSERT en reservations (status='confirmed')
//   PAYMENT.CAPTURE.REFUNDED  → UPDATE status='refunded' (libera fechas)
//   PAYMENT.CAPTURE.DENIED    → UPDATE status='cancelled'
//
// Configuración previa (Cloudflare Pages → Settings → Environment variables):
//   PAYPAL_CLIENT_ID      → mismo del frontend (público)
//   PAYPAL_CLIENT_SECRET  → secreto, marcar como Encrypted
//   PAYPAL_WEBHOOK_ID     → ID del webhook configurado en PayPal Dashboard
//   PAYPAL_API_BASE       → https://api-m.paypal.com (Live) o sandbox
//
// Binding D1 requerido: `DB` → estadias-jacari-db (con schema/0001_initial.sql aplicado)
//
// Toda invocación queda registrada en la tabla `paypal_webhook_log` para auditoría,
// incluyendo firmas inválidas o errores de procesamiento.
//

interface Env {
  DB: D1Database;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  PAYPAL_API_BASE?: string;
  // Resend (email transaccional) — Fase 3.5
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string; // ej. 'Estadías Jacarí <hola@estadiasjacari.com>'
  EMAIL_REPLY_TO?: string;
  // Fase 3.7 — edge case mismo-día (Correo #2 inline desde el webhook)
  SHEET_WEBHOOK_URL?: string; // Apps Script Web App (opcional — cae a cache D1)
  SHEET_WEBHOOK_SECRET?: string;
  CHECKIN_PDFS?: R2Bucket; // bucket privado con PDFs `<slug>.pdf`
  // Fase 5 — WhatsApp Cloud API
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

/**
 * Mapeo de slug → nombre legible de propiedad.
 *
 * Los slugs canónicos viven en `src/data/properties.ts` (frontend Next.js).
 * Como ese archivo es del bundle frontend y no podemos importarlo desde aquí
 * (Pages Functions tiene un entorno aislado), replicamos los nombres acá.
 *
 * ⚠️ Si se agrega/renombra una propiedad en src/data/properties.ts, hay que
 * actualizar ESTE mapping también o el email mostrará el slug crudo.
 */
const PROPERTY_NAMES: Record<string, string> = {
  "villa-b11-palma-real": "Villa B11 — Palma Real",
  "casa-brisa": "Casa Brisa",
  "casa-marea": "Casa Marea",
  "centro-morazan": "Centro Morazán",
  "casa-lara-townhouse": "Casa Lara Townhouse",
  "la-florida": "La Florida",
  // El bot cotiza y cobra las gemelas (combo Brisa+Marea) — sin esta entrada el
  // mensaje de captura mostraría el slug crudo.
  "las-gemelas-tela": "Las Gemelas (Casa Brisa + Casa Marea)",
};

/** Diferencia entre dos fechas YYYY-MM-DD (DTEND exclusivo). */
function nightsBetween(checkInIso: string, checkOutIso: string): number {
  const start = new Date(checkInIso + "T00:00:00Z").getTime();
  const end = new Date(checkOutIso + "T00:00:00Z").getTime();
  const days = Math.round((end - start) / (1000 * 60 * 60 * 24));
  return Math.max(0, days);
}

interface PayPalWebhookEvent {
  id?: string;
  event_type?: string;
  resource?: {
    id?: string;
    status?: string;
    custom_id?: string;
    amount?: { value?: string; currency_code?: string };
    payer?: { email_address?: string; name?: { given_name?: string; surname?: string } };
    supplementary_data?: {
      related_ids?: { order_id?: string };
    };
  };
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // 1. Leer headers + body raw (mantener raw para verificar firma)
  const headers = {
    transmission_id: request.headers.get("paypal-transmission-id") ?? "",
    transmission_time: request.headers.get("paypal-transmission-time") ?? "",
    cert_url: request.headers.get("paypal-cert-url") ?? "",
    transmission_sig: request.headers.get("paypal-transmission-sig") ?? "",
    auth_algo: request.headers.get("paypal-auth-algo") ?? "",
  };
  const rawBody = await request.text();

  // 2. Helper para insertar log y devolver early
  const logAndReturn = async (
    status: number,
    fields: {
      paypalEventId?: string;
      eventType?: string;
      orderId?: string;
      verificationStatus?: string;
      processed?: number;
      errorMessage?: string;
    },
  ): Promise<Response> => {
    try {
      await env.DB.prepare(
        `INSERT INTO paypal_webhook_log
           (paypal_event_id, event_type, paypal_order_id, verification_status,
            processed, error_message, raw_headers, raw_body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          fields.paypalEventId ?? null,
          fields.eventType ?? null,
          fields.orderId ?? null,
          fields.verificationStatus ?? null,
          fields.processed ?? 0,
          fields.errorMessage ?? null,
          JSON.stringify(headers),
          rawBody,
        )
        .run();
    } catch (logErr) {
      // No fallar el webhook por errores de logging
      console.error("Error logging webhook:", logErr);
    }
    return new Response(
      JSON.stringify({
        ok: status < 400,
        status,
        message: fields.errorMessage ?? "ok",
      }),
      {
        status,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  // 3. Validar config
  const apiBase = env.PAYPAL_API_BASE || "https://api-m.paypal.com";
  if (
    !env.PAYPAL_CLIENT_ID ||
    !env.PAYPAL_CLIENT_SECRET ||
    !env.PAYPAL_WEBHOOK_ID
  ) {
    return logAndReturn(500, {
      errorMessage:
        "Faltan variables de entorno PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET y/o PAYPAL_WEBHOOK_ID.",
    });
  }

  // 4. Obtener access token PayPal
  let accessToken: string;
  try {
    const tokenResp = await fetchWithTimeout(
      `${apiBase}/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
      },
      TIMEOUT.CRITICAL,
    );
    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      return logAndReturn(502, {
        errorMessage: `PayPal /v1/oauth2/token devolvió HTTP ${tokenResp.status}: ${text.slice(0, 300)}`,
      });
    }
    const tokenJson = (await tokenResp.json()) as { access_token?: string };
    if (!tokenJson.access_token) {
      return logAndReturn(502, {
        errorMessage: "PayPal no devolvió access_token.",
      });
    }
    accessToken = tokenJson.access_token;
  } catch (err) {
    return logAndReturn(502, {
      errorMessage: `Error obteniendo access token PayPal: ${(err as Error).message}`,
    });
  }

  // 5. Verificar firma del webhook
  let webhookEvent: PayPalWebhookEvent;
  try {
    webhookEvent = JSON.parse(rawBody) as PayPalWebhookEvent;
  } catch (err) {
    return logAndReturn(400, {
      errorMessage: `Body del webhook no es JSON válido: ${(err as Error).message}`,
    });
  }

  try {
    const verifyResp = await fetchWithTimeout(
      `${apiBase}/v1/notifications/verify-webhook-signature`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          auth_algo: headers.auth_algo,
          cert_url: headers.cert_url,
          transmission_id: headers.transmission_id,
          transmission_sig: headers.transmission_sig,
          transmission_time: headers.transmission_time,
          webhook_id: env.PAYPAL_WEBHOOK_ID,
          webhook_event: webhookEvent,
        }),
      },
      TIMEOUT.CRITICAL,
    );
    if (!verifyResp.ok) {
      const text = await verifyResp.text();
      return logAndReturn(502, {
        paypalEventId: webhookEvent.id,
        eventType: webhookEvent.event_type,
        verificationStatus: "ERROR",
        errorMessage: `verify-webhook-signature devolvió HTTP ${verifyResp.status}: ${text.slice(0, 300)}`,
      });
    }
    const verifyJson = (await verifyResp.json()) as {
      verification_status?: string;
    };
    if (verifyJson.verification_status !== "SUCCESS") {
      return logAndReturn(401, {
        paypalEventId: webhookEvent.id,
        eventType: webhookEvent.event_type,
        verificationStatus: verifyJson.verification_status ?? "UNKNOWN",
        errorMessage: `Firma inválida: ${verifyJson.verification_status}. Posible intento de webhook falsificado.`,
      });
    }
  } catch (err) {
    return logAndReturn(502, {
      paypalEventId: webhookEvent.id,
      eventType: webhookEvent.event_type,
      verificationStatus: "ERROR",
      errorMessage: `Error verificando firma PayPal: ${(err as Error).message}`,
    });
  }

  // 6. Dispatch por event_type
  const eventType = webhookEvent.event_type ?? "";
  const resource = webhookEvent.resource ?? {};
  const captureId = resource.id ?? "";
  const orderId =
    resource.supplementary_data?.related_ids?.order_id ?? captureId;

  try {
    switch (eventType) {
      case "PAYMENT.CAPTURE.COMPLETED": {
        const customId = resource.custom_id ?? "";

        // ── Branch WhatsApp-originated: custom_id empieza con "wa:" ────────
        // Estas órdenes las crea el quote flow del bot WhatsApp con formato
        // "wa:<phone>|<slug>|<checkin>|<checkout>|<guests>". Manejo aparte
        // del flujo del website para no contaminar y no romper retrocompat.
        // La DECISIÓN (overlap+refund / pending / duplicado) vive en el módulo
        // testeable _lib/paypal-wa-capture.ts — auditoría 2026-07-12 (A1/A2).
        const waOrigin = parseWhatsAppCustomId(customId);
        if (waOrigin) {
          const amountParsed = parseFloat(resource.amount?.value ?? "0");
          const amountUsd = Number.isFinite(amountParsed) ? amountParsed : 0;
          const givenName = resource.payer?.name?.given_name ?? "";
          const surname = resource.payer?.name?.surname ?? "";
          const guestName = `${givenName} ${surname}`.trim() || null;
          const guestEmailPayer = resource.payer?.email_address ?? null;

          // Idioma del lead ANTES de tocar/limpiar el estado (para los mensajes).
          let lang: Lang = "es";
          try {
            const st = await getConversationState(waOrigin.phone, env.DB);
            lang = asLang(st?.data.language);
          } catch {
            /* default es */
          }

          const wa = await handleWaCapture(
            {
              db: env.DB,
              refund: (args) =>
                refundPayPalCapture(
                  {
                    PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID,
                    PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET,
                    PAYPAL_API_BASE: env.PAYPAL_API_BASE,
                  },
                  args,
                ),
            },
            {
              phone: waOrigin.phone,
              propertySlug: waOrigin.propertySlug,
              propertyName: PROPERTY_NAMES[waOrigin.propertySlug] || waOrigin.propertySlug,
              checkIn: waOrigin.checkIn,
              checkOut: waOrigin.checkOut,
              guests: waOrigin.guests,
              orderId,
              captureId,
              amountUsd,
              guestName,
              guestEmail: guestEmailPayer,
              rawBody,
              accessToken,
              todayIso: todayHn(),
              lang,
            },
          );

          // Post-proceso: todo best-effort e independiente entre sí → en paralelo
          // (cada uno con su .catch), para no sumar round-trips en serie antes de
          // responderle el 200 a PayPal (evita acercarse a su timeout/reintento).
          const sideEffects: Promise<unknown>[] = [];

          // Cerrar conversation_state salvo en reintento duplicado. Crítico tras
          // un overlap_refunded o insert_failed: si el estado quedara en
          // 'awaiting_paypal_capture', el CASO 2.6 de quote-flow respondería
          // "¿pudiste completar el pago con el link?" a alguien recién
          // reembolsado, y el followup del cron lo re-engancharía igual —
          // contradiciendo el mensaje que acabamos de mandarle.
          if (wa.outcome !== "duplicate") {
            sideEffects.push(
              clearConversationState(waOrigin.phone, env.DB).catch(() => {
                /* best-effort */
              }),
            );
          }

          // Mensaje al huésped por WhatsApp (best-effort, nunca falla el webhook)
          if (wa.guestMessage && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
            sideEffects.push(
              sendTextMessage(
                waOrigin.phone,
                wa.guestMessage,
                env as { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
              ).catch((waErr) => {
                console.error(
                  "WA-origin: error enviando confirmación WhatsApp:",
                  (waErr as Error).message,
                );
              }),
            );
          }

          // Alerta a dueños: overlap/refund fallido, registro fallido o same-day.
          if (wa.ownerAlert) {
            sideEffects.push(
              notifyOwners(
                {
                  WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
                  WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
                  DB: env.DB,
                },
                wa.ownerAlert,
              ).catch(() => {
                /* best-effort: notifyOwners ya registra sus fallos en heartbeat/trace */
              }),
            );
          }

          // Email de confirmación SOLO si la reserva quedó creada (antes salía
          // incluso cuando el INSERT había fallado — confirmación en falso).
          if (
            wa.outcome === "reserved" &&
            guestEmailPayer &&
            env.RESEND_API_KEY &&
            env.EMAIL_FROM
          ) {
            sideEffects.push(
              sendReservationConfirmationEmail(
                {
                  guestName: guestName || "huésped",
                  guestEmail: guestEmailPayer,
                  guestPhone: waOrigin.phone,
                  propertyName: waOrigin.propertySlug,
                  checkInISO: waOrigin.checkIn,
                  checkOutISO: waOrigin.checkOut,
                  nights: nightsBetween(waOrigin.checkIn, waOrigin.checkOut),
                  amountUsd: amountUsd || 0,
                  paypalOrderId: orderId,
                },
                {
                  RESEND_API_KEY: env.RESEND_API_KEY,
                  EMAIL_FROM: env.EMAIL_FROM,
                  EMAIL_REPLY_TO: env.EMAIL_REPLY_TO,
                },
              ).catch((emailErr) => {
                console.error(
                  "WA-origin: error enviando email confirmación:",
                  (emailErr as Error).message,
                );
              }),
            );
          }

          await Promise.all(sideEffects);

          return logAndReturn(200, {
            paypalEventId: webhookEvent.id,
            eventType,
            orderId,
            verificationStatus: "SUCCESS",
            processed: 1,
            errorMessage: wa.logMessage,
          });
        }
        // ── Fin branch WhatsApp — sigue flow del website ──────────────────

        const parts = customId.split("|");
        // Formato esperado: slug|checkIn|checkOut|email|phone (5 partes).
        // Aceptamos también 4 partes para retrocompatibilidad con orders
        // creados antes de Fase 3.5 (sin phone).
        if (parts.length !== 5 && parts.length !== 4) {
          return logAndReturn(400, {
            paypalEventId: webhookEvent.id,
            eventType,
            orderId,
            verificationStatus: "SUCCESS",
            errorMessage: `custom_id con formato inesperado: "${customId}" (esperado: slug|checkIn|checkOut|email|phone o slug|checkIn|checkOut|email)`,
          });
        }
        const [propertySlug, checkIn, checkOut, guestEmail, guestPhoneRaw] = parts;
        const guestPhone = (guestPhoneRaw ?? "").replace(/\D/g, ""); // solo dígitos
        const amountUsd = parseFloat(resource.amount?.value ?? "0");
        const givenName = resource.payer?.name?.given_name ?? "";
        const surname = resource.payer?.name?.surname ?? "";
        const guestName = `${givenName} ${surname}`.trim();
        const payerEmail = resource.payer?.email_address ?? guestEmail;
        const recipientEmail = guestEmail || payerEmail || null;

        // ── Detección de doble booking (Auditoría Sesión 2 — B1) ────────────
        // Antes de aceptar el cobro, verificar que el rango no esté ya tomado
        // por otra reserva (status pending/confirmed) que NO sea ésta misma
        // (importante para webhook reintentado: orderId igual = mismo cobro).
        //
        // Si detecta overlap: refund automático vía PayPal API + INSERT como
        // 'cancelled' + correo de disculpa al huésped. El huésped recibe su
        // dinero de vuelta en 3-5 días hábiles, no llega un huésped duplicado
        // a la propiedad.
        //
        // Fail-open: si la query de overlap falla por bug nuestro, dejamos
        // pasar el cobro normalmente. Mejor un doble booking eventual (raro)
        // que rechazar pagos válidos por error de infraestructura.
        try {
          const overlap = await env.DB.prepare(
            `SELECT paypal_order_id, guest_email, guest_name, check_in, check_out
               FROM reservations
              WHERE property_slug = ?
                AND status IN ('pending', 'confirmed')
                AND paypal_order_id != ?
                AND check_in < ?
                AND check_out > ?
              LIMIT 1`,
          )
            .bind(propertySlug, orderId, checkOut, checkIn)
            .first<{
              paypal_order_id: string;
              guest_email: string | null;
              guest_name: string | null;
              check_in: string;
              check_out: string;
            }>();

          if (overlap) {
            // 1. Refund automático
            const refundResult = await refundPayPalCapture(
              {
                PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID,
                PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET,
                PAYPAL_API_BASE: env.PAYPAL_API_BASE,
              },
              {
                captureId,
                amountUsd: amountUsd > 0 ? amountUsd : undefined,
                noteToPayer:
                  "Refund automático: las fechas fueron tomadas por otro huésped simultáneamente.",
                accessToken,
              },
            );

            // 2. INSERT como cancelled (audit trail). UNIQUE en paypal_order_id
            // garantiza que si el webhook se reintenta, no duplicamos.
            await env.DB.prepare(
              `INSERT OR IGNORE INTO reservations
                 (property_slug, check_in, check_out, guest_name, guest_email,
                  guest_phone, guest_phone_normalized, paypal_order_id,
                  amount_usd, status, raw_payload, notification_error)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'cancelled', ?, ?)`,
            )
              .bind(
                propertySlug,
                checkIn,
                checkOut,
                guestName || null,
                recipientEmail,
                guestPhone || null,
                guestPhone || null,
                orderId,
                amountUsd || null,
                rawBody,
                `OVERLAP con orden ${overlap.paypal_order_id} (${overlap.check_in}→${overlap.check_out}). Refund: ${refundResult.ok ? `OK (${refundResult.refundId ?? "sin id"}, status ${refundResult.status ?? "n/a"})` : `FALLÓ — ${refundResult.error?.slice(0, 400) ?? "error desconocido"}`}`,
              )
              .run();

            // 3. Correo de disculpa al huésped
            let apologyMsg = "";
            if (recipientEmail) {
              try {
                const apologyResult = await sendOverlapApologyEmail(
                  {
                    guestName: guestName || "huésped",
                    guestEmail: recipientEmail,
                    propertyName: PROPERTY_NAMES[propertySlug] || propertySlug,
                    checkInISO: checkIn,
                    checkOutISO: checkOut,
                    amountUsd,
                    refundId: refundResult.refundId,
                    refundStatus: refundResult.status,
                  },
                  {
                    RESEND_API_KEY: env.RESEND_API_KEY ?? "",
                    EMAIL_FROM: env.EMAIL_FROM ?? "",
                    EMAIL_REPLY_TO: env.EMAIL_REPLY_TO,
                  },
                );
                apologyMsg = apologyResult.ok
                  ? ` · Correo disculpa enviado (${apologyResult.resendId ?? "n/a"})`
                  : ` · Correo disculpa FALLÓ: ${apologyResult.error?.slice(0, 150)}`;
              } catch (apologyErr) {
                apologyMsg = ` · Correo disculpa EXCEPCIÓN: ${(apologyErr as Error).message.slice(0, 150)}`;
              }
            }

            return logAndReturn(200, {
              paypalEventId: webhookEvent.id,
              eventType,
              orderId,
              verificationStatus: "SUCCESS",
              processed: 1,
              errorMessage:
                `OVERLAP detectado con orden ${overlap.paypal_order_id}. ` +
                `Refund: ${refundResult.ok ? `OK (${refundResult.refundId ?? "sin id"})` : `FALLÓ — ${refundResult.error?.slice(0, 200)}`}` +
                apologyMsg,
            });
          }
        } catch (overlapErr) {
          // Fail-open: continuar con flujo normal aunque la detección falle.
          console.error(
            "Error en detección de overlap (fail-open, continúa flow normal):",
            (overlapErr as Error).message,
          );
        }

        // INSERT con OR IGNORE — si el webhook llega duplicado por reintento,
        // no creamos filas dobles (paypal_order_id es UNIQUE).
        const result = await env.DB.prepare(
          `INSERT OR IGNORE INTO reservations
             (property_slug, check_in, check_out, guest_name, guest_email,
              guest_phone, guest_phone_normalized, paypal_order_id,
              amount_usd, status, raw_payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
        )
          .bind(
            propertySlug,
            checkIn,
            checkOut,
            guestName || null,
            recipientEmail,
            guestPhone || null,
            guestPhone || null,
            orderId,
            amountUsd || null,
            rawBody,
          )
          .run();

        const inserted = result.meta?.changes ?? 0;

        // ── Notificación email (Fase 3.5) ──────────────────────────────────
        // Idempotencia: solo enviamos si la fila acaba de insertarse Y aún
        // no fue notificada. Si webhook duplicado o ya notificada, skip.
        let emailMessage = "";
        if (inserted > 0 && recipientEmail) {
          try {
            // Verificar idempotencia leyendo la fila recién insertada
            const existing = await env.DB.prepare(
              `SELECT notified_at FROM reservations WHERE paypal_order_id = ?`,
            )
              .bind(orderId)
              .first<{ notified_at: string | null }>();

            if (existing && !existing.notified_at) {
              const propertyName =
                PROPERTY_NAMES[propertySlug] || propertySlug;
              const nights = nightsBetween(checkIn, checkOut);

              const emailResult = await sendReservationConfirmationEmail(
                {
                  guestName: guestName || "huésped",
                  guestEmail: recipientEmail,
                  guestPhone,
                  propertyName,
                  checkInISO: checkIn,
                  checkOutISO: checkOut,
                  nights,
                  amountUsd,
                  paypalOrderId: orderId,
                },
                {
                  RESEND_API_KEY: env.RESEND_API_KEY ?? "",
                  EMAIL_FROM: env.EMAIL_FROM ?? "",
                  EMAIL_REPLY_TO: env.EMAIL_REPLY_TO,
                },
              );

              if (emailResult.ok) {
                await env.DB.prepare(
                  `UPDATE reservations
                      SET notified_at = datetime('now'),
                          updated_at = datetime('now')
                    WHERE paypal_order_id = ?`,
                )
                  .bind(orderId)
                  .run();
                emailMessage = ` · Email enviado (Resend ID: ${emailResult.resendId ?? "n/a"})`;
              } else {
                await env.DB.prepare(
                  `UPDATE reservations
                      SET notification_error = ?,
                          updated_at = datetime('now')
                    WHERE paypal_order_id = ?`,
                )
                  .bind(emailResult.error?.slice(0, 1000) ?? "unknown", orderId)
                  .run();
                emailMessage = ` · Email FALLÓ: ${emailResult.error?.slice(0, 200) ?? "unknown"}`;
              }
            }
          } catch (emailErr) {
            // Capturamos sin fallar el webhook — el pago YA está procesado.
            const errMsg = (emailErr as Error).message;
            console.error("Error enviando email de confirmación:", errMsg);
            try {
              await env.DB.prepare(
                `UPDATE reservations
                    SET notification_error = ?,
                        updated_at = datetime('now')
                  WHERE paypal_order_id = ?`,
              )
                .bind(`Excepción: ${errMsg.slice(0, 950)}`, orderId)
                .run();
            } catch {
              // ignore — no podemos hacer nada más
            }
            emailMessage = ` · Email EXCEPCIÓN: ${errMsg.slice(0, 200)}`;
          }
        }

        // ── Edge case mismo-día (Fase 3.7) ──────────────────────────────────
        // Si check_in es HOY (hora Honduras), enviar Correo #2 inline con PDF.
        // El cron diario corre a las 6 PM HN buscando MAÑANA — sin esto, las
        // reservas hechas el mismo día (permitidas hasta las 18:00 HN por la
        // UI) nunca recibirían las instrucciones de check-in.
        let checkinMsg = "";
        if (inserted > 0 && recipientEmail && checkIn === todayHn()) {
          try {
            // Idempotencia: solo enviar si aún no se mandó (el cron de las
            // 6 PM tampoco debe reenviar tras nuestro envío inline).
            const existing2 = await env.DB.prepare(
              `SELECT checkin_reminder_sent_at FROM reservations WHERE paypal_order_id = ?`,
            )
              .bind(orderId)
              .first<{ checkin_reminder_sent_at: string | null }>();

            if (existing2 && !existing2.checkin_reminder_sent_at) {
              const infoResult = await getCheckinInfo(propertySlug, {
                DB: env.DB,
                SHEET_WEBHOOK_URL: env.SHEET_WEBHOOK_URL,
                SHEET_WEBHOOK_SECRET: env.SHEET_WEBHOOK_SECRET,
              });

              if (!infoResult.info) {
                // Sin info de check-in en Sheet ni en cache D1 → no podemos
                // mandar Correo #2 útil. Marcar error y dejar que el dueño
                // gestione manual (avisándole con un correo separado).
                const reason = `Mismo-día sin info de check-in para "${propertySlug}": ${infoResult.error?.slice(0, 600) ?? "desconocido"}`;
                await env.DB.prepare(
                  `UPDATE reservations
                      SET checkin_reminder_error = ?,
                          updated_at = datetime('now')
                    WHERE paypal_order_id = ?`,
                )
                  .bind(reason, orderId)
                  .run();
                checkinMsg = ` · Correo #2 NO enviado (mismo-día sin info de check-in)`;
              } else {
                const pdfResult = await getCheckinPdf(propertySlug, env);
                const propertyName =
                  infoResult.info.propertyName ||
                  PROPERTY_NAMES[propertySlug] ||
                  propertySlug;

                const reminderResult = await sendCheckinReminderEmail(
                  {
                    guestName: guestName || "huésped",
                    guestEmail: recipientEmail,
                    guestPhone,
                    checkInISO: checkIn,
                    checkOutISO: checkOut,
                    info: { ...infoResult.info, propertyName },
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

                if (reminderResult.ok) {
                  await env.DB.prepare(
                    `UPDATE reservations
                        SET checkin_reminder_sent_at = datetime('now'),
                            checkin_reminder_error = NULL,
                            updated_at = datetime('now')
                      WHERE paypal_order_id = ?`,
                  )
                    .bind(orderId)
                    .run();
                  checkinMsg = ` · Correo #2 enviado (mismo-día, Resend ID: ${reminderResult.resendId ?? "n/a"}${pdfResult.found ? ", PDF adjunto" : ", SIN PDF"})`;

                  // ── WhatsApp mismo-día (Fase 5) ──────────────────────────
                  // Best-effort: el correo ya salió. Nunca bloquear ni fallar
                  // el webhook por errores de WhatsApp.
                  if (
                    env.WHATSAPP_ACCESS_TOKEN &&
                    env.WHATSAPP_PHONE_NUMBER_ID &&
                    guestPhone &&
                    pdfResult.found &&
                    pdfResult.bytes
                  ) {
                    try {
                      const { e164 } = normalizePhone(guestPhone);
                      if (isValidE164(e164)) {
                        const waPropertyName =
                          infoResult.info?.propertyName ||
                          PROPERTY_NAMES[propertySlug] ||
                          propertySlug;
                        const waResult = await sendCheckinReminderWhatsApp(
                          {
                            toPhone: e164,
                            guestName: guestName || "huésped",
                            propertyName: waPropertyName,
                            checkInDateEs: formatCheckinDateForTemplate(checkIn, todayHn()),
                            pdfBytes: pdfResult.bytes,
                            pdfFilename: pdfResult.filename ?? `instrucciones-checkin-${propertySlug}.pdf`,
                          },
                          { WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID },
                        );
                        await env.DB.prepare(
                          `UPDATE reservations
                              SET whatsapp_sent_at    = ?,
                                  whatsapp_error      = ?,
                                  whatsapp_message_id = ?,
                                  updated_at          = datetime('now')
                            WHERE paypal_order_id = ?`,
                        )
                          .bind(
                            waResult.ok ? new Date().toISOString() : null,
                            waResult.ok ? null : (waResult.error ?? "error desconocido").slice(0, 1000),
                            waResult.messageId ?? null,
                            orderId,
                          )
                          .run();
                        // Fila rastreable en whatsapp_messages (card "📬 Salud
                        // de entrega" + checks del callback). INSERT OR IGNORE:
                        // un reintento del webhook con el mismo wamid no duplica.
                        await logOutboundTemplate(env.DB, {
                          fromPhone: env.WHATSAPP_PHONE_NUMBER_ID,
                          toPhone: e164,
                          rule: "checkin_reminder",
                          summary: `📋 Instrucciones de check-in + PDF — ${waPropertyName} (mismo día)`,
                          reservationId: null,
                          ok: waResult.ok,
                          messageId: waResult.messageId ?? null,
                          error: waResult.error ?? null,
                        });
                        checkinMsg += waResult.ok
                          ? ` · WhatsApp enviado (${waResult.messageId ?? "sin id"})`
                          : ` · WhatsApp FALLÓ: ${waResult.error?.slice(0, 150)}`;
                      }
                    } catch (waErr) {
                      checkinMsg += ` · WhatsApp EXCEPCIÓN: ${(waErr as Error).message.slice(0, 150)}`;
                    }
                  }

                  // ── Templates operativos staff + huésped día (Sprint 1) ─────
                  // Mismo-día: además del template checkin_instructions arriba,
                  // disparar los 3 templates operativos del día de check-in:
                  //   - checkin_dia_huesped     (al huésped, "estamos a la orden")
                  //   - checkin_dia_limpieza    (a cada contacto de limpieza)
                  //   - checkin_dia_seguridad   (a cada contacto de seguridad)
                  // Todo best-effort. Nunca bloquear ni fallar el webhook.
                  if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
                    const waEnv = {
                      WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
                      WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
                    };
                    const opPropertyName =
                      infoResult.info?.propertyName ||
                      PROPERTY_NAMES[propertySlug] ||
                      propertySlug;
                    const opCity =
                      ({
                        "villa-b11-palma-real": "La Ceiba",
                        "casa-brisa": "Tela",
                        "casa-marea": "Tela",
                        "centro-morazan": "Tegucigalpa",
                        "casa-lara-townhouse": "Tegucigalpa",
                        "la-florida": "Tegucigalpa",
                      } as Record<string, string>)[propertySlug] || "Honduras";

                    // ── Template 3: día llegada huésped ──────────────────────
                    if (guestPhone) {
                      try {
                        const { e164: opGuestE164 } = normalizePhone(guestPhone);
                        if (isValidE164(opGuestE164)) {
                          const opGuestFirstName = (guestName || "huésped").split(" ")[0];
                          const opGuestResult = await sendCheckinDiaHuesped(
                            {
                              toPhone: opGuestE164,
                              guestName: opGuestFirstName,
                              propertyName: opPropertyName,
                              city: opCity,
                            },
                            waEnv,
                          );
                          await env.DB.prepare(
                            `UPDATE reservations
                                SET wa_arrival_guest_sent_at = ?,
                                    wa_arrival_guest_error   = ?,
                                    updated_at               = datetime('now')
                              WHERE paypal_order_id = ?`,
                          )
                            .bind(
                              opGuestResult.ok ? new Date().toISOString() : null,
                              opGuestResult.ok ? null : (opGuestResult.error ?? "error desconocido").slice(0, 1000),
                              orderId,
                            )
                            .run();
                          checkinMsg += opGuestResult.ok
                            ? ` · WA día-huésped enviado`
                            : ` · WA día-huésped FALLÓ: ${opGuestResult.error?.slice(0, 100)}`;
                        }
                      } catch (opErr) {
                        checkinMsg += ` · WA día-huésped EXC: ${(opErr as Error).message.slice(0, 100)}`;
                      }
                    }

                    // ── Template 4: día llegada limpieza ─────────────────────
                    try {
                      const cleaners = await getCleaningContacts(propertySlug, env.DB);
                      if (cleaners.length > 0) {
                        const cleaningErrors: string[] = [];
                        let cleaningAnyOk = false;
                        for (const c of cleaners) {
                          if (!isValidE164(c.phoneE164)) {
                            cleaningErrors.push(`Teléfono inválido: ${c.phoneE164}`);
                            continue;
                          }
                          const cRes = await sendCheckinDiaLimpieza(
                            {
                              toPhone: c.phoneE164,
                              cleanerName: c.name,
                              propertyName: opPropertyName,
                              checkOutDateEs: formatDateShortEs(checkOut),
                            },
                            waEnv,
                          );
                          if (cRes.ok) cleaningAnyOk = true;
                          else cleaningErrors.push(`${c.name}: ${cRes.error}`);
                        }
                        await env.DB.prepare(
                          `UPDATE reservations
                              SET wa_arrival_cleaning_sent_at = ?,
                                  wa_arrival_cleaning_error   = ?,
                                  updated_at                  = datetime('now')
                            WHERE paypal_order_id = ?`,
                        )
                          .bind(
                            cleaningAnyOk ? new Date().toISOString() : null,
                            cleaningErrors.length > 0 ? cleaningErrors.join(" | ").slice(0, 1000) : null,
                            orderId,
                          )
                          .run();
                        checkinMsg += cleaningAnyOk
                          ? ` · WA limpieza (${cleaners.length} contactos)`
                          : ` · WA limpieza FALLÓ`;
                      }
                    } catch (opErr) {
                      checkinMsg += ` · WA limpieza EXC: ${(opErr as Error).message.slice(0, 100)}`;
                    }

                    // ── Template 5: día llegada seguridad ────────────────────
                    try {
                      const guards = await getSecurityContacts(propertySlug, env.DB);
                      if (guards.length > 0) {
                        const guestFullName = guestName || "Huésped sin nombre";
                        const secErrors: string[] = [];
                        let secAnyOk = false;
                        for (const g of guards) {
                          if (!isValidE164(g.phoneE164)) {
                            secErrors.push(`Teléfono inválido: ${g.phoneE164}`);
                            continue;
                          }
                          const sRes = await sendCheckinDiaSeguridad(
                            {
                              toPhone: g.phoneE164,
                              guestFullName,
                              checkOutDateEs: formatDateShortEs(checkOut),
                            },
                            waEnv,
                          );
                          if (sRes.ok) secAnyOk = true;
                          else secErrors.push(`${g.name}: ${sRes.error}`);
                        }
                        await env.DB.prepare(
                          `UPDATE reservations
                              SET wa_arrival_security_sent_at = ?,
                                  wa_arrival_security_error   = ?,
                                  updated_at                  = datetime('now')
                            WHERE paypal_order_id = ?`,
                        )
                          .bind(
                            secAnyOk ? new Date().toISOString() : null,
                            secErrors.length > 0 ? secErrors.join(" | ").slice(0, 1000) : null,
                            orderId,
                          )
                          .run();
                        checkinMsg += secAnyOk
                          ? ` · WA seguridad (${guards.length} contactos)`
                          : ` · WA seguridad FALLÓ`;
                      }
                    } catch (opErr) {
                      checkinMsg += ` · WA seguridad EXC: ${(opErr as Error).message.slice(0, 100)}`;
                    }
                  }
                } else {
                  await env.DB.prepare(
                    `UPDATE reservations
                        SET checkin_reminder_error = ?,
                            updated_at = datetime('now')
                      WHERE paypal_order_id = ?`,
                  )
                    .bind(
                      reminderResult.error?.slice(0, 1000) ?? "unknown",
                      orderId,
                    )
                    .run();
                  checkinMsg = ` · Correo #2 FALLÓ (mismo-día): ${reminderResult.error?.slice(0, 200) ?? "unknown"}`;
                }
              }
            } else {
              checkinMsg = ` · Correo #2 mismo-día skip (ya notificado)`;
            }
          } catch (reminderErr) {
            const errMsg = (reminderErr as Error).message;
            console.error("Error enviando Correo #2 mismo-día:", errMsg);
            try {
              await env.DB.prepare(
                `UPDATE reservations
                    SET checkin_reminder_error = ?,
                        updated_at = datetime('now')
                  WHERE paypal_order_id = ?`,
              )
                .bind(`Excepción mismo-día: ${errMsg.slice(0, 950)}`, orderId)
                .run();
            } catch {
              // ignore — best-effort log
            }
            checkinMsg = ` · Correo #2 EXCEPCIÓN (mismo-día): ${errMsg.slice(0, 200)}`;
          }
        }

        return logAndReturn(200, {
          paypalEventId: webhookEvent.id,
          eventType,
          orderId,
          verificationStatus: "SUCCESS",
          processed: 1,
          errorMessage:
            (inserted > 0
              ? `Reserva insertada: ${propertySlug} ${checkIn}→${checkOut}`
              : `Reserva ya existía (webhook duplicado): ${orderId}`) +
            emailMessage +
            checkinMsg,
        });
      }

      case "PAYMENT.CAPTURE.REFUNDED": {
        await env.DB.prepare(
          `UPDATE reservations
              SET status = 'refunded',
                  updated_at = datetime('now')
            WHERE paypal_order_id = ?`,
        )
          .bind(orderId)
          .run();
        return logAndReturn(200, {
          paypalEventId: webhookEvent.id,
          eventType,
          orderId,
          verificationStatus: "SUCCESS",
          processed: 1,
        });
      }

      case "PAYMENT.CAPTURE.DENIED": {
        await env.DB.prepare(
          `UPDATE reservations
              SET status = 'cancelled',
                  updated_at = datetime('now')
            WHERE paypal_order_id = ?`,
        )
          .bind(orderId)
          .run();
        return logAndReturn(200, {
          paypalEventId: webhookEvent.id,
          eventType,
          orderId,
          verificationStatus: "SUCCESS",
          processed: 1,
        });
      }

      default: {
        // Evento que no manejamos — logueamos pero respondemos 200 para que
        // PayPal no reintente eternamente.
        return logAndReturn(200, {
          paypalEventId: webhookEvent.id,
          eventType,
          orderId,
          verificationStatus: "SUCCESS",
          processed: 0,
          errorMessage: `event_type "${eventType}" no manejado (ignorado intencionalmente)`,
        });
      }
    }
  } catch (err) {
    return logAndReturn(500, {
      paypalEventId: webhookEvent.id,
      eventType,
      orderId,
      verificationStatus: "SUCCESS",
      errorMessage: `Error procesando evento en D1: ${(err as Error).message}`,
    });
  }
};
