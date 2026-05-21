-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0002 — Notificaciones automáticas al confirmar reserva
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Agrega columnas para tracking de envío de email (idempotencia + debug)
-- y para guardar el teléfono normalizado del huésped (capturado en el
-- formulario del BookingWidget, ahora incluido en el custom_id de PayPal).
--
-- Cómo aplicar (uno de los dos):
--   1. Cloudflare Dashboard → D1 → estadias-jacari-db → Console → pegar y Execute
--   2. wrangler d1 execute estadias-jacari-db --remote --file=schema/0002_notifications.sql
--
-- SQLite no soporta múltiples ALTER TABLE en un solo statement, por eso
-- van separados por ";".
-- ─────────────────────────────────────────────────────────────────────────────

-- Timestamp de cuándo se envió el email de confirmación al cliente.
-- NULL = aún no se envió (el webhook lo intentará enviar en su próxima ejecución
-- o un job manual lo puede reintentar). NOT NULL = ya se envió OK.
ALTER TABLE reservations ADD COLUMN notified_at TEXT;

-- Si el envío de email falló, aquí queda el detalle del error para debug.
-- Útil para identificar reservas que necesitan retry manual.
ALTER TABLE reservations ADD COLUMN notification_error TEXT;

-- Teléfono del huésped capturado en el formulario, normalizado a solo dígitos
-- (ej. "+504 8839-0145" → "50488390145"). Se usa para:
--   - Generar el link wa.me/<phone>?text=... en el email
--   - Futuro: enviar WhatsApp push automático vía Cloud API (Fase 5)
ALTER TABLE reservations ADD COLUMN guest_phone_normalized TEXT;
