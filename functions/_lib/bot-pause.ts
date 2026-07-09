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

// ── Interruptor GENERAL (shut off / shut on) ─────────────────────────────────
// Pedido de César (2026-07-08, ads corriendo): un botón que apague TODO el bot
// de una — el webhook deja de auto-responder a TODOS los números y el equipo
// atiende a mano desde el inbox. Se implementa como una fila especial phone='*'
// en la MISMA tabla bot_pauses (cero migraciones): isBotPaused ya la ve para
// cualquier número. Los mensajes entrantes se siguen guardando; los avisos
// OPERATIVOS (check-in de reservas confirmadas, staff) NO se apagan — esto solo
// calla al bot conversacional y sus followups.
export const GLOBAL_PAUSE_PHONE = "*";

/** ¿El interruptor general está APAGADO? Devuelve desde cuándo (o null si está encendido). */
export async function globalBotPausedSince(db: D1Database): Promise<string | null> {
  try {
    const row = await db
      .prepare(`SELECT paused_at AS t FROM bot_pauses WHERE phone = ?`)
      .bind(GLOBAL_PAUSE_PHONE)
      .first<{ t: string }>();
    return row?.t ?? null;
  } catch {
    return null;
  }
}

/** Apaga (on=false) o enciende (on=true) el bot ENTERO. */
export async function setGlobalBot(on: boolean, db: D1Database): Promise<void> {
  if (on) {
    await db.prepare(`DELETE FROM bot_pauses WHERE phone = ?`).bind(GLOBAL_PAUSE_PHONE).run();
  } else {
    await db
      .prepare(
        `INSERT INTO bot_pauses (phone, paused_at, reason)
           VALUES (?, datetime('now'), 'apagado_general')
         ON CONFLICT(phone) DO UPDATE SET paused_at = datetime('now'), reason = 'apagado_general'`,
      )
      .bind(GLOBAL_PAUSE_PHONE)
      .run();
  }
}

/** ¿El bot está pausado para este número (o apagado en general)? Fail-soft: si la
 *  tabla no existe → false. La fila especial '*' (interruptor general) pausa a TODOS. */
export async function isBotPaused(phone: string, db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(`SELECT 1 AS p FROM bot_pauses WHERE phone IN (?, ?)`)
      .bind(phone, GLOBAL_PAUSE_PHONE)
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
