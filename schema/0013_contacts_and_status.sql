-- 0013_contacts_and_status.sql
--
-- 1. Columna `status` en whatsapp_messages → checks de WhatsApp (✓ enviado,
--    ✓✓ entregado, ✓✓ azul leído). Meta manda estos eventos en value.statuses,
--    que antes ignorábamos.
-- 2. Tabla whatsapp_contacts → nombre del perfil de WhatsApp (Meta lo manda en
--    contacts[].profile.name, antes no lo guardábamos).
--
-- NOTA: D1/SQLite no soporta "ADD COLUMN IF NOT EXISTS". Si la columna ya existe,
-- este ALTER falla — en ese caso ignorá el error de esa línea y seguí.

ALTER TABLE whatsapp_messages ADD COLUMN status TEXT;  -- sent | delivered | read | failed

CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  phone         TEXT PRIMARY KEY,        -- E.164 sin '+'
  profile_name  TEXT,                    -- nombre del perfil de WhatsApp
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
