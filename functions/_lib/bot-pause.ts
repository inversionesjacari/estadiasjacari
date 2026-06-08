/// <reference types="@cloudflare/workers-types" />
//
// Pausa del bot por conversación (handoff a humano).
//
// Cuando el bot escala (out_of_scope, huésped existente, pago reportado, pide
// humano) o cuando un humano responde manualmente desde el inbox, se PAUSA el
// bot para ese número: el webhook deja de auto-responder. Los mensajes
// entrantes se siguen guardando (se ven en el inbox), pero el bot calla hasta
// que se reactive a mano con el botón "Reactivar bot".
//
// La reactivación es MANUAL (decisión de César): la pausa no expira sola; se
// limpia solo al apretar el botón (resumeBot).
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.

/** Pausa el bot para un número (upsert). reason = motivo legible (regla/manual). */
export async function pauseBot(phone: string, reason: string, db: D1Database): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO bot_pauses (phone, paused_at, reason)
           VALUES (?, datetime('now'), ?)
         ON CONFLICT(phone) DO UPDATE SET paused_at = datetime('now'), reason = excluded.reason`,
      )
      .bind(phone, reason)
      .run();
  } catch (err) {
    console.error("pauseBot error:", (err as Error).message);
  }
}

/** ¿El bot está pausado para este número? Fail-soft: si la tabla no existe → false. */
export async function isBotPaused(phone: string, db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(`SELECT 1 AS p FROM bot_pauses WHERE phone = ?`)
      .bind(phone)
      .first<{ p: number }>();
    return !!row;
  } catch {
    return false;
  }
}

/** Reactiva el bot para un número (borra la pausa). */
export async function resumeBot(phone: string, db: D1Database): Promise<void> {
  try {
    await db.prepare(`DELETE FROM bot_pauses WHERE phone = ?`).bind(phone).run();
  } catch (err) {
    console.error("resumeBot error:", (err as Error).message);
  }
}
