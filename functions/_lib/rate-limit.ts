/// <reference types="@cloudflare/workers-types" />
//
// Rate limiter simple basado en D1 (no requiere KV ni binding nuevo).
//
// Esquema requerido: ver `schema/0005_rate_limit.sql`. Tabla `rate_limit_events`
// guarda una fila por request a un endpoint protegido, indexada por
// (endpoint, ip, ts). Antes de procesar, contamos las del último minuto.
//
// Trade-off: agrega un write D1 por cada request al endpoint. Para volumen
// actual (admin: <50/día, cron: 1/día + manuales) es despreciable. Si en algún
// momento el endpoint admin sirve >1 request/segundo sostenido, migrar a
// Workers KV con TTL o al binding `RATE_LIMITER` nativo de Cloudflare.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

export interface RateLimitEnv {
  DB: D1Database;
}

export interface RateLimitOptions {
  /** Nombre lógico del endpoint protegido (ej. "admin/test-email"). */
  endpoint: string;
  /** IP del cliente (puede ser "unknown" si no se puede determinar). */
  ip: string;
  /** Máximo de requests permitidas en la ventana. Default 10. */
  max?: number;
  /** Ventana en segundos. Default 60. */
  windowSec?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Si allowed=false, sugerir Retry-After. */
  retryAfterSec: number;
  /** Cuántas requests llevamos en la ventana actual (para debug/logs). */
  currentCount: number;
}

/**
 * Verifica si la request actual cabe dentro del rate limit. Si SÍ, registra la
 * request en D1 y devuelve allowed=true. Si NO, devuelve allowed=false y
 * sugiere Retry-After.
 *
 * Limpia oportunisticamente filas antiguas (>1 hora) cada vez que se llama —
 * mantiene la tabla acotada sin necesidad de cron de limpieza.
 *
 * NUNCA lanza excepción: si D1 falla, devuelve allowed=true (fail-open) para
 * no bloquear al usuario por un problema de infraestructura del rate limiter.
 * Se loguea el error para debug pero no se propaga.
 */
export async function checkRateLimit(
  env: RateLimitEnv,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const max = opts.max ?? 10;
  const windowSec = opts.windowSec ?? 60;

  try {
    // 1. Contar requests recientes desde la misma IP a este endpoint
    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as cnt
         FROM rate_limit_events
        WHERE endpoint = ?
          AND ip = ?
          AND ts > datetime('now', ?)`,
    )
      .bind(opts.endpoint, opts.ip, `-${windowSec} seconds`)
      .first<{ cnt: number }>();

    const currentCount = countResult?.cnt ?? 0;

    if (currentCount >= max) {
      return {
        allowed: false,
        retryAfterSec: windowSec,
        currentCount,
      };
    }

    // 2. Registrar esta request (no esperamos error de UNIQUE — no hay UNIQUE)
    await env.DB.prepare(
      `INSERT INTO rate_limit_events (endpoint, ip) VALUES (?, ?)`,
    )
      .bind(opts.endpoint, opts.ip)
      .run();

    // 3. Cleanup oportunista (1 de cada ~20 requests) de filas antiguas.
    //    Mantiene la tabla pequeña sin necesidad de cron.
    if (Math.random() < 0.05) {
      try {
        await env.DB.prepare(
          `DELETE FROM rate_limit_events WHERE ts < datetime('now', '-1 hour')`,
        ).run();
      } catch {
        // Best-effort, no fatal
      }
    }

    return {
      allowed: true,
      retryAfterSec: 0,
      currentCount: currentCount + 1,
    };
  } catch (err) {
    // Fail-open: si D1 falla, no bloqueamos al usuario por nuestro problema.
    // Pero loguear para debug.
    console.error("Rate limit check failed (fail-open):", (err as Error).message);
    return { allowed: true, retryAfterSec: 0, currentCount: 0 };
  }
}

/**
 * Extrae IP del request desde headers de Cloudflare. Devuelve "unknown" si
 * no se puede determinar (no debería pasar en producción, sí en dev local).
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
