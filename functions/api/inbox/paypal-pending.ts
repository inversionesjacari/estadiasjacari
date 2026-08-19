/// <reference types="@cloudflare/workers-types" />
//
// Rescate de los pagos que quedaron APROBADOS SIN COBRAR (incidente 2026-08-19).
//
// Durante el tiempo en que el flujo del bot no capturaba, cada huésped que pagó
// por link dejó una orden en APPROVED: él vio la retención en su tarjeta, pero
// la plata nunca entró. Este endpoint sirve para (1) ver cuánta plata quedó
// colgada y cuánta todavía se puede cobrar, y (2) cobrarla.
//
//   GET  /api/inbox/paypal-pending   → lista los links de pago mandados por el
//        bot (últimos 90 días), con el estado REAL de cada orden en PayPal:
//          COMPLETED  = ya cobrada (nada que hacer)
//          APPROVED   = 💰 el huésped pagó y NO se cobró → se puede capturar YA
//          CREATED    = abrió el link pero nunca pagó (no hay plata)
//          otro/error = la orden venció o fue anulada → hay que pedir pago nuevo
//
//   POST /api/inbox/paypal-pending  { orderId }  → captura esa orden.
//        La captura dispara PAYMENT.CAPTURE.COMPLETED, y de ahí en adelante todo
//        el flujo que ya existía hace su trabajo: crea la reserva, le escribe al
//        huésped y avisa a los dueños.
//
// SOLO DUEÑO (requireOwner): es plata entrando, y muestra montos.
//

import { requireOwner } from "../../_lib/inbox-auth";
import { capturePayPalOrder, getPayPalOrder } from "../../_lib/paypal-checkout";

interface Env {
  DB: D1Database;
  INBOX_PASSWORD?: string;
  PAYPAL_API_BASE?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Saca los order id de los links de pago que mandó el bot. Pura (test). */
export function extractOrderIds(body: string | null): string[] {
  if (!body) return [];
  const out: string[] = [];
  const re = /checkoutnow\?token=([A-Z0-9]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireOwner(request, env);
  if (!auth.ok) return auth.response!;

  // Los links viven en los mensajes salientes del bot. Se usa esa fuente (y no
  // conversation_state) porque los estados expiran y se limpian: los mensajes no.
  const rows = await env.DB.prepare(
    `SELECT to_phone, body, created_at
       FROM whatsapp_messages
      WHERE direction = 'out'
        AND body LIKE '%checkoutnow?token=%'
        AND created_at >= datetime('now', '-90 days')
      ORDER BY created_at DESC
      LIMIT 200`,
  ).all<{ to_phone: string; body: string | null; created_at: string }>();

  // Un link por orden (el más reciente gana si se reenvió el mismo).
  const seen = new Map<string, { phone: string; at: string }>();
  for (const r of rows.results ?? []) {
    for (const id of extractOrderIds(r.body)) {
      if (!seen.has(id)) seen.set(id, { phone: r.to_phone, at: r.created_at });
    }
  }

  // Consultar PayPal de a poco (no reventar su rate limit).
  const ids = [...seen.keys()].slice(0, 60);
  const items: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const o = await getPayPalOrder(id, env);
    const meta = seen.get(id)!;
    items.push({
      orderId: id,
      phone: meta.phone,
      linkEnviado: meta.at,
      estado: o.ok ? o.status : "ERROR",
      montoUsd: o.amountUsd ?? null,
      cobrable: o.ok && o.status === "APPROVED",
      detalle: o.ok ? undefined : o.error,
    });
  }

  const cobrables = items.filter((i) => i.cobrable);
  const plataColgada = cobrables.reduce((s, i) => s + (Number(i.montoUsd) || 0), 0);

  return json({
    ok: true,
    resumen: {
      linksRevisados: items.length,
      yaCobradas: items.filter((i) => i.estado === "COMPLETED").length,
      pagadasSinCobrar: cobrables.length,
      plataColgadaUsd: Number(plataColgada.toFixed(2)),
      nuncaPagaron: items.filter((i) => i.estado === "CREATED").length,
    },
    // Lo accionable primero: estas son las que hay que capturar YA.
    paraCobrar: cobrables,
    todas: items,
  });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireOwner(request, env);
  if (!auth.ok) return auth.response!;

  let orderId = "";
  try {
    orderId = String(((await request.json()) as { orderId?: string }).orderId ?? "").trim();
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }
  if (!/^[A-Z0-9]{5,40}$/i.test(orderId)) {
    return json({ ok: false, error: "orderId inválido" }, 400);
  }

  const res = await capturePayPalOrder(orderId, env);
  if (!res.ok) {
    return json({
      ok: false,
      orderId,
      error: res.error,
      // Si venció, el cobro ya no se puede rescatar: hay que mandar link nuevo.
      accion: res.expired ? "La orden venció — mandale al huésped un link de pago nuevo." : undefined,
    }, 409);
  }
  return json({
    ok: true,
    orderId,
    cobradaAhora: res.capturedNow,
    montoUsd: res.amountUsd,
    captureId: res.captureId,
    nota: res.capturedNow
      ? "Cobrada. PayPal dispara el webhook y el sistema crea la reserva y le escribe al huésped."
      : "Ya estaba cobrada de antes.",
  });
};
