-- 0026_last_call.sql
--
-- "Último aviso" antes de que se cierre la ventana de 24h de WhatsApp.
-- El cron de seguimiento (quote-followups.ts) hace UN followup temprano (~10 min).
-- Esta columna marca un SEGUNDO toque, cerca del límite de las 24h, para no dejar
-- morir leads calientes (especialmente los que ya tienen cotización). Antes de
-- mandarlo, el cron verifica disponibilidad y excluye a los desinteresados.
--
-- NULL = todavía no se le mandó el último aviso a esa conversación.

ALTER TABLE conversation_state ADD COLUMN last_call_sent_at TEXT;
