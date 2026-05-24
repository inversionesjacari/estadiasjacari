/// <reference types="@cloudflare/workers-types" />
//
// fetchWithTimeout — wrapper sobre `fetch` que aborta la request si no responde
// en N milisegundos. Sin esto, una llamada externa lenta (Airbnb iCal, Resend,
// PayPal, Google Apps Script) puede colgar el endpoint hasta el wall-clock
// timeout de Cloudflare Workers (~30s), degradando UX y consumiendo budget.
//
// Uso:
//   import { fetchWithTimeout } from "../_lib/fetch";
//   const resp = await fetchWithTimeout(url, { method: "POST", body }, 5000);
//
// Si excede el timeout, lanza `Error` con mensaje "fetch timeout after Nms".
// El caller debe manejarlo con try/catch igual que cualquier fetch error.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

/** Timeouts recomendados por contexto. */
export const TIMEOUT = {
  /** Resend, PayPal — críticos para flow del usuario, tolerar un poco más. */
  CRITICAL: 8000,
  /** Airbnb iCal, exchange rate, Google Sheet — tenemos fallback, ser estrictos. */
  STANDARD: 5000,
  /** Backups, observabilidad — best-effort, no bloquear. */
  BEST_EFFORT: 3000,
} as const;

/**
 * Wrapper de fetch con timeout absoluto via AbortController.
 *
 * @param input URL o Request object
 * @param init RequestInit estándar (puede incluir signal — se mergea)
 * @param timeoutMs default 5000ms
 * @throws Error con mensaje "fetch timeout after Nms" si excede el timeout
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = TIMEOUT.STANDARD,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Si el caller pasó su propio signal, lo encadenamos (cualquiera de los 2
  // que aborte tira la request).
  const userSignal = init.signal;
  if (userSignal) {
    if (userSignal.aborted) {
      controller.abort();
    } else {
      userSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    // AbortError → reescribimos a un mensaje claro para que los logs digan
    // "timeout" en vez de "operation was aborted".
    if ((err as Error).name === "AbortError") {
      throw new Error(`fetch timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
