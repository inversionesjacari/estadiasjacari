/// <reference types="@cloudflare/workers-types" />
//
// Cliente PayPal Orders API v2 — genera órdenes (links de pago) para el
// quote flow de WhatsApp.
//
// Flujo de pago:
//   1. Bot crea orden vía POST /v2/checkout/orders → obtiene order_id +
//      approval_url
//   2. Bot manda approval_url al huésped por WhatsApp
//   3. Huésped abre link, paga con PayPal o tarjeta
//   4. PayPal manda webhook PAYMENT.CAPTURE.COMPLETED a /api/paypal-webhook
//   5. Webhook ya existente verifica firma + procesa
//
// Custom data: usamos `custom_id` para guardar el teléfono E.164 del huésped
// y `description` para info legible. El webhook puede recuperar esto para
// matchear el pago a la conversación correcta.
//
// Currency: USD obligatorio (PayPal Honduras no acepta HNL directo).
// El BookingWidget ya cobra en USD usando TC del día — mismo patrón acá.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { fetchWithTimeout, TIMEOUT } from "./fetch";

export interface PayPalEnv {
  PAYPAL_API_BASE?: string;     // https://api-m.paypal.com (Live)
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
}

export interface CreateOrderInput {
  /** Monto en USD a cobrar AHORA (el 50% para reservar). */
  amountUsd: number;
  /** Slug de la propiedad. */
  propertySlug: string;
  /** Nombre legible de la propiedad. */
  propertyName: string;
  /** Check-in YYYY-MM-DD. */
  checkIn: string;
  /** Check-out YYYY-MM-DD. */
  checkOut: string;
  /** Cantidad de huéspedes. */
  guests: number;
  /** Teléfono E.164 sin '+' del huésped (vía WhatsApp). */
  guestPhone: string;
  /** TC USD→HNL del momento (para referencia, no se cobra esto). */
  exchangeRate?: number;
}

export interface CreateOrderResult {
  ok: boolean;
  /** ID de la orden PayPal (formato 1AB23456CD789...). */
  orderId?: string;
  /** URL a la que el huésped debe ir para pagar. */
  approvalUrl?: string;
  error?: string;
}

/** Obtiene access_token de PayPal (válido ~9h) usando CLIENT_ID + SECRET. */
async function getAccessToken(env: PayPalEnv): Promise<{ token?: string; error?: string }> {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    return { error: "Faltan PAYPAL_CLIENT_ID o PAYPAL_CLIENT_SECRET" };
  }
  const apiBase = env.PAYPAL_API_BASE || "https://api-m.paypal.com";
  try {
    const resp = await fetchWithTimeout(
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
    if (!resp.ok) {
      const text = await resp.text();
      return { error: `PayPal token HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    const data = (await resp.json()) as { access_token?: string };
    if (!data.access_token) return { error: "PayPal no devolvió access_token" };
    return { token: data.access_token };
  } catch (err) {
    return { error: `Error de red PayPal token: ${(err as Error).message}` };
  }
}

/**
 * Crea una orden PayPal y devuelve la URL de aprobación que el huésped
 * debe abrir para pagar.
 *
 * @returns { ok, orderId, approvalUrl } o { ok: false, error }
 */
export async function createPayPalOrder(
  input: CreateOrderInput,
  env: PayPalEnv,
): Promise<CreateOrderResult> {
  const apiBase = env.PAYPAL_API_BASE || "https://api-m.paypal.com";

  const tokenResult = await getAccessToken(env);
  if (!tokenResult.token) {
    return { ok: false, error: tokenResult.error };
  }

  // custom_id: guardamos el teléfono + slug + fechas + huéspedes para que
  // el webhook pueda reconstruir contexto cuando llegue PAYMENT.CAPTURE.COMPLETED.
  // Formato: "wa:<phone>|<slug>|<checkin>|<checkout>|<guests>"
  const customId = `wa:${input.guestPhone}|${input.propertySlug}|${input.checkIn}|${input.checkOut}|${input.guests}`.slice(0, 127); // PayPal limita custom_id a 127 chars

  const nights = nightsBetween(input.checkIn, input.checkOut);
  const description =
    `Reserva ${input.propertyName} · ${input.checkIn} a ${input.checkOut} (${nights} noche${nights > 1 ? "s" : ""}) · ${input.guests} huésped${input.guests > 1 ? "es" : ""}`.slice(0, 127);

  const body = {
    intent: "CAPTURE",
    purchase_units: [
      {
        amount: {
          currency_code: "USD",
          value: input.amountUsd.toFixed(2),
        },
        description,
        custom_id: customId,
      },
    ],
    application_context: {
      brand_name: "Estadías Jacarí",
      landing_page: "NO_PREFERENCE",
      user_action: "PAY_NOW",
      return_url: "https://estadiasjacari.com/gracias",
      cancel_url: "https://estadiasjacari.com",
      shipping_preference: "NO_SHIPPING",
    },
  };

  try {
    const resp = await fetchWithTimeout(
      `${apiBase}/v2/checkout/orders`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenResult.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      },
      TIMEOUT.CRITICAL,
    );
    if (!resp.ok) {
      const text = await resp.text();
      return {
        ok: false,
        error: `PayPal create order HTTP ${resp.status}: ${text.slice(0, 300)}`,
      };
    }
    interface OrderResp {
      id?: string;
      links?: Array<{ href: string; rel: string }>;
    }
    const data = (await resp.json()) as OrderResp;
    if (!data.id) {
      return { ok: false, error: "PayPal no devolvió order id" };
    }
    const approveLink = data.links?.find((l) => l.rel === "approve" || l.rel === "payer-action");
    if (!approveLink) {
      return { ok: false, error: "PayPal no devolvió approval URL" };
    }
    return {
      ok: true,
      orderId: data.id,
      approvalUrl: approveLink.href,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Error de red PayPal create order: ${(err as Error).message}`,
    };
  }
}

/** Parsea un custom_id de WhatsApp-originated → datos. null si no es WhatsApp. */
export function parseWhatsAppCustomId(customId: string | undefined): {
  phone: string;
  propertySlug: string;
  checkIn: string;
  checkOut: string;
  guests: number;
} | null {
  if (!customId || !customId.startsWith("wa:")) return null;
  const rest = customId.slice(3); // quita "wa:"
  const parts = rest.split("|");
  if (parts.length !== 5) return null;
  const [phone, slug, checkIn, checkOut, guestsStr] = parts;
  const guests = parseInt(guestsStr, 10);
  if (isNaN(guests) || guests <= 0) return null;
  return {
    phone,
    propertySlug: slug,
    checkIn,
    checkOut,
    guests,
  };
}

function nightsBetween(checkInIso: string, checkOutIso: string): number {
  const start = new Date(checkInIso + "T00:00:00Z").getTime();
  const end = new Date(checkOutIso + "T00:00:00Z").getTime();
  return Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24)));
}
