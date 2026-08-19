/// <reference types="@cloudflare/workers-types" />
//
// GET /gracias — la vuelta del huésped después de pagar en PayPal.
//
// ESTA PÁGINA ES EL COBRO. Hasta el 2026-08-19 no existía: el `return_url` de
// las órdenes del bot apuntaba acá y el huésped caía en un 404, dejando la orden
// APPROVED (retención en su tarjeta) pero SIN capturar — la plata nunca entraba
// a Jacarí y, como no hay captura, PayPal nunca mandaba
// PAYMENT.CAPTURE.COMPLETED, así que el bot se quedaba repitiendo "esperando la
// confirmación del pago".
//
// PayPal redirige acá con ?token=<orderId>&PayerID=<...>. Capturamos con
// `capturePayPalOrder` (idempotente: si el huésped recarga la página no se cobra
// dos veces) y le mostramos el resultado en su idioma de siempre: castellano
// simple, sin jerga.
//
// Todo lo que viene DESPUÉS ya funcionaba y no se toca: la captura dispara el
// webhook, que crea la reserva, le escribe por WhatsApp y avisa a los dueños.
//
// Si la captura falla, NO le decimos al huésped "pagá de nuevo" (podría terminar
// pagando dos veces): le decimos que estamos validando y avisamos a los dueños
// por WhatsApp para que lo resuelvan a mano.
//

import { capturePayPalOrder } from "./_lib/paypal-checkout";
import { notifyOwners } from "./_lib/owner-alerts";

interface Env {
  PAYPAL_API_BASE?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  DB?: D1Database;
}

/** Página simple, marca Jacarí, legible en el teléfono donde acaba de pagar. */
function page(title: string, body: string, tone: "ok" | "warn" = "ok"): Response {
  const accent = tone === "ok" ? "#0e9f6e" : "#d97706";
  return new Response(
    `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Estadías Jacarí</title>
<style>
 body{margin:0;background:#070b16;color:#e2e8f0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
      display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
 .card{max-width:420px;width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);
       border-radius:20px;padding:28px;text-align:center}
 h1{font-size:20px;margin:0 0 12px;color:#fff}
 p{font-size:15px;line-height:1.55;color:#cbd5e1;margin:0 0 10px}
 .dot{width:52px;height:52px;border-radius:50%;background:${accent};margin:0 auto 18px;
      display:flex;align-items:center;justify-content:center;font-size:26px}
 a{display:inline-block;margin-top:18px;color:#22d3ee;text-decoration:none;font-size:14px}
</style></head><body><div class="card">${body}
<a href="https://wa.me/50488390145">Escribinos por WhatsApp</a>
</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const orderId = new URL(request.url).searchParams.get("token") ?? "";

  // Sin token no hay nada que cobrar (alguien entró a /gracias de curioso).
  if (!orderId) {
    return page("Gracias", `<div class="dot">🌴</div><h1>¡Gracias!</h1>
      <p>Si acabás de pagar, en un momento te llega la confirmación por WhatsApp.</p>`);
  }

  const result = await capturePayPalOrder(orderId, env);

  if (result.ok) {
    // capturedNow=false → el huésped recargó la página; el cobro ya estaba hecho.
    return page("Pago recibido", `<div class="dot">✓</div>
      <h1>¡Listo, recibimos tu pago!</h1>
      <p>Tu reserva quedó tomada. En un momento te llega la confirmación por WhatsApp y por correo.</p>
      <p style="color:#94a3b8;font-size:13px">Ya podés cerrar esta página.</p>`);
  }

  // No se pudo cobrar. El huésped NO tiene que resolver esto solo: avisamos a
  // los dueños con el número de orden para que lo tomen a mano.
  try {
    await notifyOwners(
      {
        WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
        WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
        DB: env.DB,
      },
      {
        tipo: "PAGO NO SE PUDO COBRAR",
        cliente: `Orden ${orderId}`,
        detalle: `El huésped volvió de PayPal pero la captura falló: ${result.error ?? "sin detalle"}. Revisá la orden en PayPal y cobrala a mano.`.slice(0, 250),
        guestPhone: "",
      },
    );
  } catch { /* el aviso no puede tumbar la página del huésped */ }

  return page(
    "Estamos validando tu pago",
    `<div class="dot">⏳</div>
     <h1>Estamos validando tu pago</h1>
     <p>No te preocupes: no hace falta que lo intentes de nuevo. Un miembro del equipo lo revisa y te escribe por WhatsApp en breve.</p>`,
    "warn",
  );
};
