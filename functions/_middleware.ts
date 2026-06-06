/// <reference types="@cloudflare/workers-types" />
//
// Middleware global de Pages Functions.
//
// Corre para CADA request que matchea un endpoint en `functions/api/*`.
// (No corre para assets estáticos del export de Next — esos los maneja el CDN
// con headers declarados en `public/_headers`.)
//
// Responsabilidades:
//   1. CORS — perfil "public" para endpoints idempotentes sin PII,
//             perfil "restricted" para el resto.
//   2. OPTIONS preflight — respondido inline, no llega al handler.
//   3. Security headers — inyectados en TODA respuesta de Function.
//
// Orden:
//   - OPTIONS → responder 204 con CORS, no invocar handler.
//   - Resto    → invocar handler, después wrappear su Response con CORS + security.
//
// Webhooks (PayPal, Meta) reciben requests server-to-server SIN header Origin.
// El perfil "restricted" en ese caso simplemente no agrega headers CORS —
// transparente para el caller.
//
// Carpeta `functions/` con `_middleware.ts` en la raíz: Cloudflare Pages lo
// detecta automáticamente. Ver https://developers.cloudflare.com/pages/functions/middleware/.
//

import {
  applyCorsHeaders,
  handleCorsPreflightRequest,
  type CorsProfile,
} from "./_lib/cors";
import { applySecurityHeaders } from "./_lib/security-headers";

/**
 * Decide el perfil CORS según el path. Lecturas idempotentes sin PII → public.
 * Todo lo demás (incluyendo webhooks que igual no usan CORS) → restricted.
 */
function pickCorsProfile(pathname: string): CorsProfile {
  // Lecturas idempotentes sin PII — consumidas por terceros legítimos:
  //   - /api/ical/<slug>.ics  → Airbnb subscriptor de calendario
  //   - /api/exchange-rate    → cualquier cliente que necesite TC USD/HNL
  //   - /api/availability/X   → usado por el frontend pero también podría
  //                             consumirse desde herramientas de terceros
  if (
    pathname.startsWith("/api/ical/") ||
    pathname === "/api/exchange-rate" ||
    pathname.startsWith("/api/availability/")
  ) {
    return "public";
  }
  return "restricted";
}

export const onRequest: PagesFunction = async (context) => {
  const { request, next } = context;
  const url = new URL(request.url);

  // Sólo procesamos paths bajo /api/* — el resto son rutas de Next estáticas
  // que no llegan acá normalmente, pero si llegaran simplemente las dejamos pasar.
  if (!url.pathname.startsWith("/api/")) {
    return next();
  }

  const profile = pickCorsProfile(url.pathname);

  // 1. Preflight: responder inline sin invocar el handler.
  if (request.method === "OPTIONS") {
    const preflight = handleCorsPreflightRequest(request, { profile });
    return applySecurityHeaders(preflight, profile === "public" ? "public" : "default");
  }

  // 2. Resto: invocar handler, wrappear su Response.
  const response = await next();
  const withCors = applyCorsHeaders(response, request, { profile });
  return applySecurityHeaders(withCors, profile === "public" ? "public" : "default");
};
