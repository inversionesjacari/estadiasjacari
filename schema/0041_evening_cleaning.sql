-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0041 — Aviso a LIMPIEZA la víspera del check-in (6 PM HN)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Decisión de César (2026-07-12): el personal de limpieza debe enterarse de una
-- entrada a las 6:00 PM del día ANTERIOR, no a las 7 AM del mismo día. El aviso
-- matutino a limpieza se retiró del hito `morning-staff` (que queda solo para
-- seguridad); lo reemplaza el hito nuevo `evening-staff` del cron
-- `whatsapp-operations`, con el template Meta nuevo `limpieza_aviso_entrada`.
--
-- Mismo patrón de idempotencia que la migration 0009:
--   - wa_eve_cleaning_sent_at IS NULL  → aún no enviado → candidato a enviar
--   - wa_eve_cleaning_sent_at NOT NULL → ya enviado OK  → skip (no reenviar)
--   - wa_eve_cleaning_error            → último error si el envío falló
--
-- ⚠️ Aplicar ANTES de desplegar el código que la usa: reservations-confirmed,
-- whatsapp-operations y whatsapp-dispatch SELECTean estas columnas.
--
-- Cómo aplicar:
--   1. Cloudflare Dashboard → D1 → estadias-jacari-db → Console → pegar y Execute
--   2. wrangler d1 execute estadias-jacari-db --remote --file=schema/0041_evening_cleaning.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Template limpieza_aviso_entrada — víspera del check-in, limpieza (6 PM HN)
ALTER TABLE reservations ADD COLUMN wa_eve_cleaning_sent_at TEXT;
ALTER TABLE reservations ADD COLUMN wa_eve_cleaning_error TEXT;
