/// <reference types="@cloudflare/workers-types" />
//
// Security headers para respuestas de API.
//
// Política conservadora — los headers que no aplican a JSON de API igual no
// hacen daño y dan defensa en profundidad:
//   - HSTS:                 fuerza HTTPS por 1 año, includeSubDomains, preload-ready
//   - X-Content-Type-Options nosniff: evita MIME-sniffing del navegador
//   - X-Frame-Options DENY: nada de iframes para respuestas de API
//   - Referrer-Policy:      no leakear paths con tokens en Referer
//   - Permissions-Policy:   denegar APIs sensibles del navegador
//   - Cross-Origin-Resource-Policy same-origin: bloquea inclusión cross-origin
//
// Los headers para HTML de páginas (incluyendo CSP completo con PayPal/Google
// Maps) viven en `public/_headers` — son responsabilidad del CDN, no de Functions.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

/**
 * Headers de seguridad estándar para CUALQUIER respuesta de Function (JSON, texto,
 * iCal, etc.). No incluye CSP — eso solo aplica a HTML servido al navegador y
 * lo maneja `public/_headers`.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=()",
  "Cross-Origin-Resource-Policy": "same-origin",
});

/**
 * Variante para endpoints "public" (Allow-Origin: *) — no podemos usar
 * Cross-Origin-Resource-Policy: same-origin porque rompería el caso de uso
 * (Airbnb subscribiéndose al iCal, navegador de terceros consultando exchange-rate).
 * Bajamos a `cross-origin` para esos.
 */
export const SECURITY_HEADERS_PUBLIC: Readonly<Record<string, string>> = Object.freeze({
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=()",
  "Cross-Origin-Resource-Policy": "cross-origin",
});

/**
 * Inyecta los security headers en una Response existente sin reconstruir el body.
 * Si la response ya tiene un header equivalente, NO lo sobreescribe — algunos
 * endpoints pueden tener overrides intencionales (ej. iCal con
 * Content-Disposition: attachment).
 */
export function applySecurityHeaders(
  response: Response,
  variant: "default" | "public" = "default",
): Response {
  const source = variant === "public" ? SECURITY_HEADERS_PUBLIC : SECURITY_HEADERS;
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(source)) {
    if (!merged.has(k)) {
      merged.set(k, v);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}
