-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0009 — Tracking de templates operativos WhatsApp (Sprint 1)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Agrega columnas de idempotencia + auditoría a `reservations` para los 6 NUEVOS
-- templates UTILITY que se enviarán por el cron `whatsapp-operations`.
--
-- Lógica (espejo de las columnas whatsapp_sent_at / whatsapp_error de la
-- migration 0006 que ya cubrió el template `checkin_instructions`):
--
--   - wa_<accion>_sent_at IS NULL  → aún no enviado → candidato a enviar
--   - wa_<accion>_sent_at NOT NULL → ya enviado OK  → skip (no reenviar)
--   - wa_<accion>_error            → último error si el envío falló
--
-- Mapeo template → columna:
--   Template 1 confirmacion_whatsapp_capturado  → wa_phone_capture_sent_at
--   Template 2 checkin_instructions (ya existe) → whatsapp_sent_at
--   Template 3 checkin_dia_huesped              → wa_arrival_guest_sent_at
--   Template 4 checkin_dia_limpieza             → wa_arrival_cleaning_sent_at
--   Template 5 checkin_dia_seguridad            → wa_arrival_security_sent_at
--   Template 6 checkout_dia_huesped             → wa_departure_guest_sent_at
--   Template 7 checkout_dia_limpieza            → wa_departure_cleaning_sent_at
--
-- Cómo aplicar:
--   1. Cloudflare Dashboard → D1 → estadias-jacari-db → Console → pegar y Execute
--   2. wrangler d1 execute estadias-jacari-db --remote --file=schema/0009_whatsapp_operations.sql
--
-- SQLite no soporta múltiples ALTER TABLE en un solo statement, por eso van
-- separados línea por línea.
-- ─────────────────────────────────────────────────────────────────────────────

-- Cantidad de huéspedes (no estaba en el schema 0001, lo agregamos aquí porque
-- los templates de seguridad y limpieza lo usan). Default 1 para reservas
-- viejas. El BookingWidget y el parser de Airbnb deberían poblar este campo
-- en reservas nuevas; las antiguas quedan en 1 sin romper nada.
ALTER TABLE reservations ADD COLUMN guest_count INTEGER DEFAULT 1;

-- Template 1 — Confirmación de captura de WhatsApp (al detectar # del huésped)
ALTER TABLE reservations ADD COLUMN wa_phone_capture_sent_at TEXT;
ALTER TABLE reservations ADD COLUMN wa_phone_capture_error TEXT;

-- Template 3 — Día de llegada, huésped (9 AM HN)
ALTER TABLE reservations ADD COLUMN wa_arrival_guest_sent_at TEXT;
ALTER TABLE reservations ADD COLUMN wa_arrival_guest_error TEXT;

-- Template 4 — Día de llegada, personal de limpieza (7 AM HN)
-- Nota: una reserva puede tener N contactos de limpieza activos → este campo
-- guarda el timestamp del PRIMER envío exitoso del lote. Si alguno falla,
-- queda registrado en wa_arrival_cleaning_error y el cron lo reintenta al
-- día siguiente (skip si ya fue exitoso para esa propiedad+reserva).
ALTER TABLE reservations ADD COLUMN wa_arrival_cleaning_sent_at TEXT;
ALTER TABLE reservations ADD COLUMN wa_arrival_cleaning_error TEXT;

-- Template 5 — Día de llegada, personal de seguridad (7 AM HN)
-- Misma semántica que limpieza si hay múltiples contactos.
ALTER TABLE reservations ADD COLUMN wa_arrival_security_sent_at TEXT;
ALTER TABLE reservations ADD COLUMN wa_arrival_security_error TEXT;

-- Template 6 — Día de salida, huésped (9 AM HN)
ALTER TABLE reservations ADD COLUMN wa_departure_guest_sent_at TEXT;
ALTER TABLE reservations ADD COLUMN wa_departure_guest_error TEXT;

-- Template 7 — Día de salida, personal de limpieza (11:30 AM HN)
ALTER TABLE reservations ADD COLUMN wa_departure_cleaning_sent_at TEXT;
ALTER TABLE reservations ADD COLUMN wa_departure_cleaning_error TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Índices para queries del cron orquestador
-- ─────────────────────────────────────────────────────────────────────────────
-- El cron diario filtra por check_in/check_out = HOY HN + columnas NULL.
-- Estos índices parciales aceleran las queries sin pesar mucho en escrituras.

-- Para queries de llegada hoy (7 AM y 9 AM HN):
--   WHERE check_in = ? AND status='confirmed' AND wa_*_sent_at IS NULL
CREATE INDEX IF NOT EXISTS idx_reservations_checkin_confirmed
  ON reservations(check_in, status)
  WHERE status = 'confirmed';

-- Para queries de salida hoy (9 AM y 11:30 AM HN):
--   WHERE check_out = ? AND status='confirmed' AND wa_*_sent_at IS NULL
CREATE INDEX IF NOT EXISTS idx_reservations_checkout_confirmed
  ON reservations(check_out, status)
  WHERE status = 'confirmed';
