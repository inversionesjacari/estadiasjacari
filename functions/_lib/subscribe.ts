/// <reference types="@cloudflare/workers-types" />
//
// Lógica PURA de la captura de email (Fase 3.3). Se extrae del endpoint
// `functions/api/subscribe.ts` para poder testearla sin D1 (mismo patrón que
// detectors/party-size/etc.). El endpoint es un wrapper delgado: rate-limit +
// esto + INSERT.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

export interface SubscribeBody {
  email?: unknown;
  source?: unknown;
  path?: unknown;
  /** Honeypot: campo oculto que un humano deja vacío. Si viene lleno = bot. */
  website?: unknown;
}

export type SubscribeParse =
  | { ok: true; email: string; source: string | null; path: string | null }
  | { ok: false; reason: "honeypot" | "invalid_email" };

// Validación pragmática (no RFC-completa, que es un pozo sin fondo): algo@algo.tld
// con TLD de ≥2 letras, sin espacios. Suficiente para filtrar tipeos y basura.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

const clampSlug = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, max);
  return s.length > 0 && /^[a-z0-9_\-/]+$/i.test(s) ? s : null;
};

/**
 * Normaliza y valida el body del POST /api/subscribe.
 * - Honeypot lleno → { ok:false, reason:'honeypot' } (el endpoint responde 200
 *   igual, para no darle señal al bot, pero NO inserta).
 * - Email inválido → { ok:false, reason:'invalid_email' }.
 * - Válido → email en minúsculas + recortado, source/path saneados.
 */
export function parseSubscribeInput(body: SubscribeBody): SubscribeParse {
  // Honeypot: si el campo trampa trae contenido, es un bot.
  if (typeof body.website === "string" && body.website.trim().length > 0) {
    return { ok: false, reason: "honeypot" };
  }

  const raw = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (raw.length < 3 || raw.length > 254 || !EMAIL_RE.test(raw)) {
    return { ok: false, reason: "invalid_email" };
  }

  return {
    ok: true,
    email: raw,
    source: clampSlug(body.source, 40),
    path: clampSlug(body.path, 200),
  };
}
