/// <reference types="@cloudflare/workers-types" />
//
// Helper para hacer refund a un cobro de PayPal vía REST API.
//
// Lo usa el webhook PayPal cuando detecta que las fechas reservadas
// ya estaban tomadas por otro huésped en simultáneo (race condition):
// en vez de aceptar el cobro y crear un doble booking, refundeamos
// automáticamente y mandamos correo de disculpa al huésped.
//
// PayPal API doc: https://developer.paypal.com/docs/api/payments/v2/#captures_refund
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { fetchWithTimeout, TIMEOUT } from "./fetch";

export interface PayPalRefundEnv {
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_API_BASE?: string;
}

export interface PayPalRefundParams {
  /** ID del capture a refundear (resource.id del webhook PAYMENT.CAPTURE.COMPLETED). */
  captureId: string;
  /** Monto en USD a refundear. Si se omite, refund completo. */
  amountUsd?: number;
  /** Mensaje opcional que ve el huésped en su email PayPal. */
  noteToPayer?: string;
  /** Access token ya obtenido (evita pedir uno nuevo). Si se omite, lo solicita. */
  accessToken?: string;
}

export interface PayPalRefundResult {
  ok: boolean;
  refundId?: string;
  status?: string;
  error?: string;
}

/**
 * Obtiene un access token OAuth de PayPal. Útil cuando el caller no tiene uno.
 * NUNCA lanza — devuelve { token?: string, error?: string }.
 */
export async function getPayPalAccessToken(
  env: PayPalRefundEnv,
): Promise<{ token?: string; error?: string }> {
  const apiBase = env.PAYPAL_API_BASE || "https://api-m.paypal.com";
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    return { error: "Faltan PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET" };
  }
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
      return { error: `PayPal /oauth2/token HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    const data = (await resp.json()) as { access_token?: string };
    if (!data.access_token) return { error: "PayPal no devolvió access_token" };
    return { token: data.access_token };
  } catch (err) {
    return { error: `Error obteniendo access token: ${(err as Error).message}` };
  }
}

/**
 * Refunde un capture de PayPal. Idempotente vía `PayPal-Request-Id` único.
 *
 * Devuelve `{ ok: true, refundId, status }` en éxito.
 * Devuelve `{ ok: false, error }` en fallo — NO lanza excepción.
 */
export async function refundPayPalCapture(
  env: PayPalRefundEnv,
  params: PayPalRefundParams,
): Promise<PayPalRefundResult> {
  const apiBase = env.PAYPAL_API_BASE || "https://api-m.paypal.com";

  // 1. Obtener access token si el caller no lo pasó
  let accessToken = params.accessToken;
  if (!accessToken) {
    const tokenResult = await getPayPalAccessToken(env);
    if (!tokenResult.token) {
      return { ok: false, error: tokenResult.error ?? "Sin access token" };
    }
    accessToken = tokenResult.token;
  }

  // 2. Construir body del refund
  // Si amountUsd está definido, refund parcial. Si no, refund completo
  // (PayPal API: omitir `amount` = full refund del capture).
  const body: Record<string, unknown> = {};
  if (typeof params.amountUsd === "number" && params.amountUsd > 0) {
    body.amount = {
      value: params.amountUsd.toFixed(2),
      currency_code: "USD",
    };
  }
  if (params.noteToPayer) {
    body.note_to_payer = params.noteToPayer;
  }

  // 3. POST al refund endpoint
  try {
    const resp = await fetchWithTimeout(
      `${apiBase}/v2/payments/captures/${params.captureId}/refund`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          // Idempotencia — si el webhook se reintenta, PayPal no duplica refund
          "PayPal-Request-Id": `refund-${params.captureId}`,
          // Para devolver respuesta minima sin lookup extra
          Prefer: "return=minimal",
        },
        body: JSON.stringify(body),
      },
      TIMEOUT.CRITICAL,
    );

    if (!resp.ok) {
      const text = await resp.text();
      return {
        ok: false,
        error: `PayPal refund HTTP ${resp.status}: ${text.slice(0, 300)}`,
      };
    }

    const data = (await resp.json()) as { id?: string; status?: string };
    return {
      ok: true,
      refundId: data.id,
      status: data.status,
    };
  } catch (err) {
    return { ok: false, error: `Error al refundear: ${(err as Error).message}` };
  }
}
