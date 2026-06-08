-- 0017_followup_attempts.sql
--
-- Contador de intentos de seguimiento automático en conversation_state.
-- Antes el cron marcaba followup_sent_at AUNQUE el envío fallara (status failed
-- de Meta) → la conversación quedaba marcada como "ya seguida" y NUNCA recibía
-- el followup. Ahora se cuentan los intentos: si el envío falla, se incrementa
-- followup_attempts pero NO followup_sent_at, así el siguiente tick lo reintenta
-- hasta un máximo de 2 intentos.
--
-- D1/SQLite no soporta "ADD COLUMN IF NOT EXISTS". Si ya existe, ignorá el error.

ALTER TABLE conversation_state ADD COLUMN followup_attempts INTEGER NOT NULL DEFAULT 0;
