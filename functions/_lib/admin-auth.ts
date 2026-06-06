/// <reference types="@cloudflare/workers-types" />
//
// Auth helper compartido para endpoints protegidos con header Bearer.
//
// Centraliza el patrón `Authorization: Bearer <SECRET>` que usan:
//   - /api/admin/*           → CRON_SECRET
//   - /api/cron/*            → CRON_SECRET
//   - /api/inbound/airbnb-*  → AIRBNB_INBOUND_SECRET
//
// Razones para tenerlo en un lugar:
//   1. Comparación timing-safe (defensa en profundidad — TLS oculta micro-timing
//      en práctica, pero `s1 !== s2` puede early-exit en el primer byte distinto).
//   2. Punto único para agregar logging de intentos fallidos, IP allowlist o
//      auditoría sin tocar 7 archivos.
//   3. Garantiza el mismo shape de respuesta 401/500 en todos los endpoints.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

/**
 * Comparación timing-safe de dos strings. Recorre todo el largo del más largo
 * antes de retornar, sin early-exit en mismatches. Para que la comparación sea
 * realmente constant-time, ambos strings deben tener la misma longitud — si no
 * la tienen, retorna false sin recorrer (la longitud sí es información leakeable,
 * pero menos que el contenido).
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export interface BearerAuthResult {
  ok: boolean;
  /** Si ok=false, la Response 401/500 lista para retornar. */
  response?: Response;
}

/**
 * Valida `Authorization: Bearer <expectedSecret>` en el request.
 *
 * Retorno:
 *   - { ok: true }                      → el handler debe seguir
 *   - { ok: false, response: Response } → el handler debe retornar esa Response
 *
 * Comportamiento:
 *   - Si `expectedSecret` es undefined/empty → 500 (env var no configurada).
 *   - Si el header no matchea (timing-safe) → 401.
 *
 * @param request  Request de Cloudflare Pages Function.
 * @param expectedSecret Valor esperado (típicamente env.CRON_SECRET).
 * @param secretName Nombre de la env var para mensajes de error.
 */
export function requireBearerAuth(
  request: Request,
  expectedSecret: string | undefined,
  secretName: string,
): BearerAuthResult {
  if (!expectedSecret) {
    return {
      ok: false,
      response: json(
        { ok: false, error: `Falta env var ${secretName}` },
        500,
      ),
    };
  }
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${expectedSecret}`;
  if (!timingSafeEqual(auth, expected)) {
    return {
      ok: false,
      response: json({ ok: false, error: "No autorizado" }, 401),
    };
  }
  return { ok: true };
}
