-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0004 — Índice parcial para el cron diario de recordatorios
-- ─────────────────────────────────────────────────────────────────────────────
--
-- El cron `/api/cron/checkin-reminders` hace cada noche:
--
--   SELECT id, property_slug, check_in, check_out, guest_name, guest_email, guest_phone
--     FROM reservations
--    WHERE status = 'confirmed'
--      AND check_in = ?
--      AND checkin_reminder_sent_at IS NULL;
--
-- El índice existente `idx_reservations_slug_dates(property_slug, check_in, check_out)`
-- NO es óptimo para esta query: el campo más selectivo en este caso es
-- `check_in = ?` (constante = mañana_HN). Y el partial filter `checkin_reminder_sent_at IS NULL`
-- elimina la mayoría de filas históricas.
--
-- Este partial index acelera específicamente esa query, con menor footprint
-- de disco que un índice full (solo indexa filas pendientes de recordatorio).
--
-- Cómo aplicar (uno de los dos):
--   1. Cloudflare Dashboard → D1 → estadias-jacari-db → Console → pegar y Execute
--   2. wrangler d1 execute estadias-jacari-db --remote --file=schema/0004_cron_index.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_reservations_status_checkin_pending
  ON reservations(status, check_in)
  WHERE checkin_reminder_sent_at IS NULL;
