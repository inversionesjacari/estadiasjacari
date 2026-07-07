/// <reference types="@cloudflare/workers-types" />
//
// POST /api/track-event
//
// Eventos del embudo de reserva (ver schema/0037_site_events.sql). Calcado
// de /api/track (mismo rate-limit, mismo filtro de bots, mismo hash de
// visitante) pero para acciones puntuales en vez de pageviews.
//
// Best-effort: si la tabla site_events no existe todavía (falta aplicar la
// migración), el catch responde 204 igual — nunca rompe la navegación.
//

import { checkRateLimit, getClientIp } from "../_lib/rate-limit";

interface Env {
  DB: D1Database;
}

interface TrackEventBody {
  event?: string;
  propertySlug?: string;
  path?: string;
  meta?: unknown;
}

const ALLOWED_EVENTS = new Set([
  "whatsapp_click",
  "booking_widget_open",
  "dates_selected",
  "checkout_review",
  "paypal_shown",
  "booking_success",
]);

const noContent = () => new Response(null, { status: 204 });

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const ip = getClientIp(request);

  const rl = await checkRateLimit(env, { endpoint: "track-event", ip, max: 80, windowSec: 60 });
  if (!rl.allowed) return noContent();

  const ua = request.headers.get("user-agent") ?? "";
  if (/bot|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|whatsapp|preview|monitor|curl|wget|python|axios|node-fetch/i.test(ua)) {
    return noContent();
  }

  let body: TrackEventBody;
  try {
    body = (await request.json()) as TrackEventBody;
  } catch {
    return noContent();
  }

  const event = (body.event ?? "").slice(0, 60);
  if (!ALLOWED_EVENTS.has(event)) return noContent();

  const propertySlug = /^[a-z0-9-]{0,60}$/.test(body.propertySlug ?? "")
    ? (body.propertySlug ?? null)
    : null;
  const path = (body.path ?? "").slice(0, 200) || null;
  const meta = body.meta ? JSON.stringify(body.meta).slice(0, 500) : null;

  const day = new Date().toISOString().slice(0, 10);
  const visitor = (await sha256Hex(`${ip}|${ua}|${day}`)).slice(0, 16);

  try {
    await env.DB.prepare(
      `INSERT INTO site_events (event, property_slug, path, visitor, meta) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(event, propertySlug, path, visitor, meta)
      .run();
  } catch {
    // best-effort — tolerante a migración aún no aplicada
  }

  return noContent();
};
