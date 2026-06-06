/// <reference types="@cloudflare/workers-types" />
//
// CORS helper para Cloudflare Pages Functions.
//
// Política:
//   - Origenes permitidos:
//       https://estadiasjacari.com         (producción canónica)
//       https://www.estadiasjacari.com     (alias www)
//       https://*.estadiasjacari.pages.dev (Cloudflare Pages preview/branches)
//       http://localhost:*                  (dev local)
//       http://127.0.0.1:*                  (dev local)
//   - Dos perfiles de endpoint:
//
//       "public" — lecturas idempotentes sin PII (availability, ical, exchange-rate).
//         Devuelven `Access-Control-Allow-Origin: *` para que cualquier cliente
//         (incluyendo Airbnb iCal subscriber, scripts de terceros consumiendo
//         exchange-rate) pueda leerlas. NO incluyen credentials.
//
//       "restricted" — todo lo demás (inbox, admin, cron, inbound, webhooks).
//         Echo del Origin SOLO si está en la allow-list. Si no, no setean ningún
//         header CORS — el navegador rechaza la respuesta. Soportan credentials
//         (cookies del inbox).
//
// Diseño:
//   El middleware `functions/_middleware.ts` decide qué perfil aplicar según el
//   path y delega a estas funciones. No se usa en webhooks que reciben requests
//   server-to-server (PayPal, Meta) — esos nunca incluyen Origin header, así que
//   el CORS check es no-op y no estorba.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

/** Lista cerrada de orígenes (host + scheme) permitidos. */
const EXACT_ORIGINS = new Set<string>([
  "https://estadiasjacari.com",
  "https://www.estadiasjacari.com",
]);

/**
 * Decide si un Origin recibido está permitido.
 *
 * - Exactos: estadiasjacari.com (con/sin www)
 * - Patrón: *.estadiasjacari.pages.dev (preview deploys de Cloudflare Pages)
 * - Dev:    http://localhost:PUERTO, http://127.0.0.1:PUERTO
 *
 * Retorna el Origin a echar de vuelta o null si no se permite.
 */
export function getAllowedOrigin(originHeader: string | null): string | null {
  if (!originHeader) return null;

  // 1. Match exacto en allow-list
  if (EXACT_ORIGINS.has(originHeader)) return originHeader;

  // 2. Cloudflare Pages preview: https://<branch>.estadiasjacari.pages.dev
  //    Usamos URL parser para evitar parseo a mano que pueda fallar en edge cases.
  let url: URL;
  try {
    url = new URL(originHeader);
  } catch {
    return null;
  }

  if (
    url.protocol === "https:" &&
    (url.hostname === "estadiasjacari.pages.dev" ||
      url.hostname.endsWith(".estadiasjacari.pages.dev"))
  ) {
    return originHeader;
  }

  // 3. Dev local — cualquier puerto en localhost / 127.0.0.1
  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  ) {
    return originHeader;
  }

  return null;
}

export type CorsProfile = "public" | "restricted";

export interface CorsOptions {
  profile: CorsProfile;
  /** Métodos permitidos. Default según verbo del request. */
  allowMethods?: string;
  /** Headers permitidos en preflight. Default cubre Content-Type + Authorization. */
  allowHeaders?: string;
  /** Tiempo de cache del preflight en segundos. Default 1 día. */
  maxAge?: number;
}

const DEFAULT_ALLOW_METHODS = "GET, HEAD, POST, OPTIONS";
const DEFAULT_ALLOW_HEADERS = "Content-Type, Authorization";
const DEFAULT_MAX_AGE = 86400;

/**
 * Devuelve los headers CORS apropiados para inyectar en una Response.
 *
 * - profile="public": Allow-Origin=*. No credentials. Vary: Origin (semánticamente
 *   no necesario con "*", pero algunas caches CDN lo respetan mejor).
 * - profile="restricted": Allow-Origin=<echo del origin si está allow-listed>.
 *   Allow-Credentials=true para soportar cookies del inbox. Si el origin no
 *   está en la lista, NO se setean headers CORS — el navegador bloquea la
 *   respuesta (Same-Origin Policy).
 */
export function corsHeadersFor(
  request: Request,
  options: CorsOptions,
): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    Vary: "Origin",
  };

  if (options.profile === "public") {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Methods"] = options.allowMethods ?? DEFAULT_ALLOW_METHODS;
    headers["Access-Control-Allow-Headers"] = options.allowHeaders ?? DEFAULT_ALLOW_HEADERS;
    headers["Access-Control-Max-Age"] = String(options.maxAge ?? DEFAULT_MAX_AGE);
    return headers;
  }

  // restricted
  const allowed = getAllowedOrigin(origin);
  if (allowed) {
    headers["Access-Control-Allow-Origin"] = allowed;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Access-Control-Allow-Methods"] = options.allowMethods ?? DEFAULT_ALLOW_METHODS;
    headers["Access-Control-Allow-Headers"] = options.allowHeaders ?? DEFAULT_ALLOW_HEADERS;
    headers["Access-Control-Max-Age"] = String(options.maxAge ?? DEFAULT_MAX_AGE);
  }
  // Sin Origin recibido o Origin no permitido: no se setean headers CORS.
  // Para requests server-to-server (webhooks) esto es lo correcto — no envían
  // Origin y no necesitan CORS. Para navegadores con origen no permitido, la
  // ausencia de Access-Control-Allow-Origin causa el bloqueo de la respuesta.
  return headers;
}

/**
 * Maneja un OPTIONS preflight. Devuelve la Response 204 lista para enviar.
 *
 * Si el origin no está permitido en perfil "restricted", la Response 204 sale
 * sin headers Access-Control-Allow-*, lo cual hace que el navegador rechace
 * el preflight (que es el comportamiento deseado).
 */
export function handleCorsPreflightRequest(
  request: Request,
  options: CorsOptions,
): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeadersFor(request, options),
  });
}

/**
 * Aplica CORS a una Response existente (clona y agrega headers).
 * Útil cuando el handler ya construyó la Response y queremos inyectar CORS
 * en el middleware sin reconstruirla.
 */
export function applyCorsHeaders(
  response: Response,
  request: Request,
  options: CorsOptions,
): Response {
  const cors = corsHeadersFor(request, options);
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) {
    // Vary: combinar en vez de sobreescribir (el helper interno usa "Origin"
    // pero la response original podría tener Vary preexistente).
    if (k === "Vary") {
      const existing = merged.get("Vary");
      if (existing && !existing.split(",").map((s) => s.trim().toLowerCase()).includes("origin")) {
        merged.set("Vary", `${existing}, Origin`);
      } else if (!existing) {
        merged.set("Vary", "Origin");
      }
      continue;
    }
    merged.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}
