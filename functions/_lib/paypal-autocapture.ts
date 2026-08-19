/// <reference types="@cloudflare/workers-types" />
//
// Red de seguridad del cobro (incidente 2026-08-19).
//
// El cobro ya se cierra solo por dos caminos:
//   1. Webhook CHECKOUT.ORDER.APPROVED → capturamos apenas el huésped aprueba.
//   2. La página /gracias → captura cuando el huésped vuelve de PayPal.
//
// Este barrido es el TERCER camino, para lo que se escape de los otros dos: que
// PayPal no tenga suscrito ese evento, que el webhook falle, o que el huésped
// cierre el navegador antes de volver. Corre pegado al cron de bot-retry (cada
// 2 min) para no depender de re-pegar el worker de Cloudflare.
//
// Por qué corre TAN seguido: una orden aprobada vive HORAS, no días. En el
// incidente, la orden de un huésped que pagó a las 9 PM ya no existía a las
// 11 AM del día siguiente (PayPal 404 RESOURCE_NOT_FOUND) — plata imposible de
// rescatar. Cuanto antes se capture, mejor.
//

import { capturePayPalOrder, getPayPalOrder } from "./paypal-checkout";

export interface AutoCaptureEnv {
  DB: D1Database;
  PAYPAL_API_BASE?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
}

/** Saca los order id de los links de pago del bot. Pura (test). */
export function orderIdsFrom(body: string | null): string[] {
  if (!body) return [];
  const out: string[] = [];
  const re = /checkoutnow\?token=([A-Z0-9]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

export interface AutoCaptureResult {
  revisadas: number;
  cobradas: number;
  montoUsd: number;
  errores: string[];
}

/**
 * Busca links de pago recientes cuya orden siga APROBADA-SIN-COBRAR y las cobra.
 *
 * Acotado a propósito:
 *   - ventana de 6 h (más allá, la orden ya venció y no hay nada que rescatar),
 *   - excluye las que YA tienen reserva (esas se capturaron y el webhook las
 *     registró) para no interrogar a PayPal de gusto,
 *   - tope de 10 por corrida.
 * Nunca lanza: es una red de seguridad, no puede tumbar el cron que la hospeda.
 */
export async function autoCaptureApproved(env: AutoCaptureEnv): Promise<AutoCaptureResult> {
  const out: AutoCaptureResult = { revisadas: 0, cobradas: 0, montoUsd: 0, errores: [] };
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return out;

  try {
    const rows = await env.DB.prepare(
      `SELECT body FROM whatsapp_messages
        WHERE direction = 'out'
          AND body LIKE '%checkoutnow?token=%'
          AND created_at >= datetime('now', '-6 hours')
        ORDER BY id DESC
        LIMIT 40`,
    ).all<{ body: string | null }>();

    const ids = [...new Set((rows.results ?? []).flatMap((r) => orderIdsFrom(r.body)))];
    if (ids.length === 0) return out;

    // Las que ya tienen reserva están cobradas: no hay que preguntarle a PayPal.
    const ph = ids.map(() => "?").join(",");
    const yaHechas = await env.DB
      .prepare(`SELECT paypal_order_id FROM reservations WHERE paypal_order_id IN (${ph})`)
      .bind(...ids)
      .all<{ paypal_order_id: string }>()
      .catch(() => ({ results: [] as { paypal_order_id: string }[] }));
    const hechas = new Set((yaHechas.results ?? []).map((r) => r.paypal_order_id));

    for (const id of ids.filter((i) => !hechas.has(i)).slice(0, 10)) {
      out.revisadas++;
      const o = await getPayPalOrder(id, env);
      if (!o.ok || o.status !== "APPROVED") continue; // pagó y no se cobró = APPROVED
      const cap = await capturePayPalOrder(id, env);
      if (cap.ok && cap.capturedNow) {
        out.cobradas++;
        out.montoUsd += cap.amountUsd ?? 0;
      } else if (!cap.ok) {
        out.errores.push(`${id}: ${cap.error ?? "sin detalle"}`.slice(0, 200));
      }
    }
  } catch (err) {
    out.errores.push(`barrido: ${(err as Error).message}`.slice(0, 200));
  }
  return out;
}
