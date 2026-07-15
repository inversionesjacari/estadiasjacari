/// <reference types="@cloudflare/workers-types" />
//
// POST /api/subscribe
//
// Captura de email del sitio público (Fase 3.3 del plan maestro). Calcado de
// /api/track-event: mismo rate-limit por IP y mismo filtro de bots por UA. La
// lógica de validación pura vive en `_lib/subscribe.ts` (testeable sin D1).
//
// Contrato:
//   200 { ok: true }                 → suscrito (o honeypot: respondemos ok para
//                                        no darle señal al bot, pero NO insertamos)
//   400 { ok: false, error }         → email inválido (el form muestra el mensaje)
//   429 { ok: false }                → rate limit
//
// Best-effort en la escritura: si la tabla email_subscribers aún no existe
// (migración 0042 sin aplicar), el catch responde 200 igual — nunca rompe el form.
//

import { checkRateLimit, getClientIp } from "../_lib/rate-limit";
import { parseSubscribeInput, type SubscribeBody } from "../_lib/subscribe";

interface Env {
  DB: D1Database;
}

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const ip = getClientIp(request);

  const rl = await checkRateLimit(env, { endpoint: "subscribe", ip, max: 12, windowSec: 60 });
  if (!rl.allowed) return json(429, { ok: false, error: "Demasiados intentos, probá en un momento" });

  const ua = request.headers.get("user-agent") ?? "";
  if (/bot|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|whatsapp|preview|monitor|curl|wget|python|axios|node-fetch/i.test(ua)) {
    // Respondemos ok para no revelar el filtro; no insertamos.
    return json(200, { ok: true });
  }

  let body: SubscribeBody;
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    return json(400, { ok: false, error: "Body inválido" });
  }

  const parsed = parseSubscribeInput(body);
  if (!parsed.ok) {
    // Honeypot → 200 silencioso (no le damos pista al bot). Email malo → 400.
    if (parsed.reason === "honeypot") return json(200, { ok: true });
    return json(400, { ok: false, error: "Revisá el correo e intentá de nuevo" });
  }

  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO email_subscribers (email, source, path) VALUES (?, ?, ?)`,
    )
      .bind(parsed.email, parsed.source, parsed.path)
      .run();
  } catch {
    // best-effort — tolerante a migración 0042 aún no aplicada
  }

  return json(200, { ok: true });
};
