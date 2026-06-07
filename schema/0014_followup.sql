-- 0014_followup.sql
--
-- Marca de seguimiento automático en conversation_state. Cuando el bot le
-- escribe un "¿seguimos?" a un cliente que dejó la charla a medias, se guarda
-- followup_sent_at para no volver a escribirle (evita spam).
--
-- D1/SQLite no soporta "ADD COLUMN IF NOT EXISTS". Si ya existe, ignorá el error.

ALTER TABLE conversation_state ADD COLUMN followup_sent_at TEXT;
