-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0003 — Recordatorio de check-in (Correo #2) + base de info de check-in
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Agrega columnas de idempotencia para el recordatorio que se envía la NOCHE
-- ANTERIOR al check-in (6 PM hora Honduras), y una tabla `property_checkin_info`
-- que sirve de COPIA DE RESPALDO (cache) de la info que el dueño edita en su
-- Google Sheet. El job de recordatorios lee el Sheet en vivo y vuelca el
-- resultado aquí; si el Sheet no responde, usa esta copia para no fallar.
--
-- Cómo aplicar (uno de los dos):
--   1. Cloudflare Dashboard → D1 → estadias-jacari-db → Console → pegar y Execute
--   2. wrangler d1 execute estadias-jacari-db --remote --file=schema/0003_checkin_reminders.sql
--
-- SQLite no soporta múltiples ALTER TABLE en un solo statement, por eso van
-- separados por ";".
-- ─────────────────────────────────────────────────────────────────────────────

-- Timestamp de cuándo se envió el recordatorio de check-in (Correo #2).
-- NULL = aún no se envió. NOT NULL = ya se envió OK (idempotencia: no reenviar).
ALTER TABLE reservations ADD COLUMN checkin_reminder_sent_at TEXT;

-- Si el envío del recordatorio falló, aquí queda el detalle del error para debug
-- y para que el dueño pueda hacer el envío manual.
ALTER TABLE reservations ADD COLUMN checkin_reminder_error TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Info de check-in por propiedad (estática). Fuente de verdad editable = Google
-- Sheet del dueño; esta tabla es la copia de respaldo que el job sincroniza en
-- cada corrida. La clave `slug` debe coincidir con los slugs canónicos de
-- src/data/properties.ts (villa-b11-palma-real, casa-brisa, casa-marea,
-- centro-morazan, casa-lara-townhouse, la-florida).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS property_checkin_info (
  slug                 TEXT PRIMARY KEY,
  property_name        TEXT,
  wifi_network         TEXT,
  wifi_password        TEXT,
  access_instructions  TEXT,   -- cómo entrar: código de puerta / dónde recoger llaves
  arrival_instructions TEXT,   -- cómo llegar: dirección, parqueo, referencias
  local_contact_name   TEXT,
  local_contact_phone  TEXT,
  extra_notes          TEXT,   -- cualquier detalle adicional de la estadía
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);
