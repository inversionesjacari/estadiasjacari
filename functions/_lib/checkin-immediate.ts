/// <reference types="@cloudflare/workers-types" />
//
// checkin-immediate.ts — ¿al confirmar una reserva en el inbox, hay que
// disparar el envío de check-in AL TOQUE en vez de esperar al cron T-1?
//
// El cron `checkin-reminders` corre 6 PM HN de la VÍSPERA y solo mira las
// llegadas de MAÑANA. Hueco (auditoría 2026-07-12): si César confirma TARDE
// —el mismo día de llegada, o la víspera después de que el cron ya corrió— la
// reserva pasa a 'confirmed' pero nadie le manda las instrucciones al huésped.
// Este predicado detecta ese caso: llegada dentro de [hoy, mañana] y todavía
// sin recordatorio enviado → el endpoint de confirmar auto-dispara el cron para
// esa fecha exacta (idempotente: si el recordatorio ya salió, no se repite).
//
// Función PURA (sin I/O) para poder testear la ventana de fechas sin red.

/**
 * @param checkInIso        YYYY-MM-DD de la llegada.
 * @param reminderSentAt    valor de checkin_reminder_sent_at (null/"" = no enviado).
 * @param todayIso          YYYY-MM-DD de HOY en Honduras (todayHn()).
 * @param tomorrowIso       YYYY-MM-DD de MAÑANA en Honduras (hnDatePlusDays(1)).
 */
export function shouldSendCheckinNow(
  checkInIso: string | null | undefined,
  reminderSentAt: string | null | undefined,
  todayIso: string,
  tomorrowIso: string,
): boolean {
  if (!checkInIso || !/^\d{4}-\d{2}-\d{2}$/.test(checkInIso)) return false;
  // Ya se envió (el cron lo agarró antes, o un envío previo) → no repetir.
  if (reminderSentAt) return false;
  // Solo la ventana que el cron T-1 NO cubre de forma confiable: llegada HOY
  // (el cron de anoche buscó "mañana" y la reserva estaba pending) o MAÑANA
  // (confirmada después del cron de las 6 PM). Comparación lexicográfica válida
  // porque el formato YYYY-MM-DD ordena igual que la fecha.
  return checkInIso === todayIso || checkInIso === tomorrowIso;
}
