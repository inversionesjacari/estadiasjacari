/// <reference types="@cloudflare/workers-types" />
//
// Helpers de fecha en zona horaria America/Tegucigalpa (UTC-6, sin DST).
//
// Compartidos por:
//   - El cron diario (`checkin-reminders.ts`) — busca check_in = mañana_HN
//   - El webhook PayPal (`paypal-webhook.ts`) — edge case mismo-día: si
//     check_in === hoy_HN, dispara Correo #2 inline (no esperar al cron).
//
// Honduras NUNCA aplica horario de verano → el offset es constante UTC-6
// todo el año. Por eso `0 0 * * *` (00:00 UTC) cae siempre a las 18:00 HN.
//

/**
 * Fecha en zona Honduras (YYYY-MM-DD) desplazada `days` días desde hoy.
 *   hnDatePlusDays(0)  → hoy_HN
 *   hnDatePlusDays(1)  → mañana_HN
 *   hnDatePlusDays(-1) → ayer_HN
 */
export function hnDatePlusDays(days: number): string {
  // en-CA produce siempre formato YYYY-MM-DD.
  const todayHn = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = todayHn.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Conveniencia: fecha de hoy en Honduras (YYYY-MM-DD). */
export function todayHn(): string {
  return hnDatePlusDays(0);
}
