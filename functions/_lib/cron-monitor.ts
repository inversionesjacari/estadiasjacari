/// <reference types="@cloudflare/workers-types" />
//
// cron-monitor.ts — instrumentación compartida para functions/api/cron/*.ts.
//
// Envolvé el handler con `withCronMonitor` para que CADA corrida quede
// registrada en `cron_runs` (schema/0036) y actualice `system_heartbeat`
// (schema/0015) — sin tocar la lógica interna de cada cron. El watchdog
// (functions/api/cron/watchdog.ts) usa ambas tablas para avisar por WhatsApp
// si un cron deja de correr o empieza a fallar seguido.
//
// Best-effort: si el registro mismo falla (D1 caído), NUNCA rompe el cron —
// se loguea y se sigue. Preservamos el status/Response original tal cual.

export interface CronMonitorEnv {
  DB: D1Database;
}

/**
 * Envuelve un handler de cron: registra inicio/fin en cron_runs + heartbeat,
 * inspeccionando el body `{ ok, error }` de la Response si es JSON (la
 * convención que ya siguen todos los endpoints de functions/api/cron/*.ts).
 * Devuelve la Response original sin modificar.
 */
export async function withCronMonitor(
  env: CronMonitorEnv,
  cronKey: string,
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  const startedAt = new Date().toISOString();
  try {
    const response = await handler();
    let ok = response.ok;
    let errorMsg: string | undefined;
    let detail: string | undefined;
    try {
      const body = (await response.clone().json()) as { ok?: boolean; error?: string };
      if (typeof body.ok === "boolean") ok = body.ok;
      if (!ok) errorMsg = body.error ?? "cron devolvió ok:false";
      detail = JSON.stringify(body).slice(0, 300);
    } catch {
      // Respuesta no era JSON — nos quedamos con response.ok (status HTTP).
    }
    await recordCronRun(env.DB, cronKey, startedAt, ok, { error: errorMsg, detail });
    return response;
  } catch (err) {
    await recordCronRun(env.DB, cronKey, startedAt, false, { error: (err as Error).message });
    throw err;
  }
}

async function recordCronRun(
  db: D1Database,
  cronKey: string,
  startedAt: string,
  ok: boolean,
  opts: { error?: string; detail?: string },
): Promise<void> {
  const finishedAt = new Date().toISOString();
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  try {
    await db
      .prepare(
        `INSERT INTO cron_runs (cron_key, started_at, finished_at, ok, error, duration_ms, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(cronKey, startedAt, finishedAt, ok ? 1 : 0, opts.error ?? null, durationMs, opts.detail ?? null)
      .run();
  } catch (err) {
    console.error(`No se pudo registrar cron_runs[${cronKey}] (¿falta aplicar schema/0036?):`, (err as Error).message);
  }
  try {
    await db
      .prepare(
        `INSERT INTO system_heartbeat (key, last_at) VALUES (?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET last_at = datetime('now')`,
      )
      .bind(cronKey)
      .run();
  } catch (err) {
    console.error(`No se pudo actualizar system_heartbeat[${cronKey}]:`, (err as Error).message);
  }
}
