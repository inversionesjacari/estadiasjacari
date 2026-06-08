/// <reference types="@cloudflare/workers-types" />
//
// POST /api/track
//
// Beacon de analytics propio (privacy-friendly). Lo llama el sitio en cada
// page view. NO usa cookies ni guarda IP: el "visitor" es un hash anónimo de
// (IP + User-Agent + día) — sirve para contar únicos sin identificar a nadie.
//
// Siempre responde 204 (sin contenido) y rápido — es un beacon, no debe
// bloquear la navegación. Rate-limited para evitar abuso. Filtra bots.
//

import { checkRateLimit, getClientIp } from "../_lib/rate-limit";

interface Env {
  DB: D1Database;
}

interface TrackBody {
  path?: string;
  referrer?: string;
}

const noContent = () => new Response(null, { status: 204 });

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const ip = getClientIp(request);

  // Rate limit generoso (navegación normal no se bloquea; frena abuso/spam).
  const rl = await checkRateLimit(env, { endpoint: "track", ip, max: 80, windowSec: 60 });
  if (!rl.allowed) return noContent();

  // Filtrar bots/crawlers para no inflar las visitas reales.
  const ua = request.headers.get("user-agent") ?? "";
  if (/bot|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|whatsapp|preview|monitor|curl|wget|python|axios|node-fetch/i.test(ua)) {
    return noContent();
  }

  let body: TrackBody;
  try {
    body = (await request.json()) as TrackBody;
  } catch {
    return noContent();
  }

  const path = (body.path ?? "").slice(0, 200);
  if (!path || !path.startsWith("/")) return noContent();
  const referrer = (body.referrer ?? "").slice(0, 120) || null;

  // Visitante anónimo: hash de IP+UA+día (NO se guarda la IP).
  const day = new Date().toISOString().slice(0, 10);
  const visitor = (await sha256Hex(`${ip}|${ua}|${day}`)).slice(0, 16);

  try {
    await env.DB.prepare(
      `INSERT INTO page_views (path, referrer, visitor) VALUES (?, ?, ?)`,
    )
      .bind(path, referrer, visitor)
      .run();
  } catch {
    // best-effort — nunca rompemos la navegación del visitante
  }

  return noContent();
};
