/// <reference types="@cloudflare/workers-types" />
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
    const tokenResp = await fetch(`${apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
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
    const verifyResp = await fetch(
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
        const parts = customId.split("|");
        if (parts.length !== 4) {
          return logAndReturn(400, {
            paypalEventId: webhookEvent.id,
            eventType,
            orderId,
            verificationStatus: "SUCCESS",
            errorMessage: `custom_id con formato inesperado: "${customId}" (esperado: slug|checkIn|checkOut|email)`,
          });
        }
        const [propertySlug, checkIn, checkOut, guestEmail] = parts;
        const amountUsd = parseFloat(resource.amount?.value ?? "0");
        const givenName = resource.payer?.name?.given_name ?? "";
        const surname = resource.payer?.name?.surname ?? "";
        const guestName = `${givenName} ${surname}`.trim();
        const payerEmail = resource.payer?.email_address ?? guestEmail;

        // INSERT con OR IGNORE — si el webhook llega duplicado por reintento,
        // no creamos filas dobles (paypal_order_id es UNIQUE).
        const result = await env.DB.prepare(
          `INSERT OR IGNORE INTO reservations
             (property_slug, check_in, check_out, guest_name, guest_email,
              paypal_order_id, amount_usd, status, raw_payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
        )
          .bind(
            propertySlug,
            checkIn,
            checkOut,
            guestName || null,
            payerEmail || guestEmail || null,
            orderId,
            amountUsd || null,
            rawBody,
          )
          .run();

        const inserted = result.meta?.changes ?? 0;
        return logAndReturn(200, {
          paypalEventId: webhookEvent.id,
          eventType,
          orderId,
          verificationStatus: "SUCCESS",
          processed: 1,
          errorMessage:
            inserted > 0
              ? `Reserva insertada: ${propertySlug} ${checkIn}→${checkOut}`
              : `Reserva ya existía (webhook duplicado): ${orderId}`,
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
