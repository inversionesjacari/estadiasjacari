-- 0022_bot_retry.sql
-- Cola de AUTO-RECUPERACIÓN del bot.
--
-- Cuando el LLM (Workers AI) tiene un hipo y el bot no puede responder, el webhook
-- encola la conversación acá EN VEZ de quedar mudo o escalar de inmediato. El cron
-- /api/cron/bot-retry reprocesa el último mensaje del cliente cada ~2 min; cuando el
-- LLM se recupera (casi siempre en minutos), el bot RESPONDE SOLO y retoma la
-- conversación. Solo escala a César por email si tras varios intentos sigue caído.
CREATE TABLE IF NOT EXISTS bot_retry_queue (
  phone           TEXT PRIMARY KEY,        -- número del cliente (E.164 sin +)
  last_in_id      TEXT,                     -- meta_message_id del último entrante a reprocesar
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_attempt_at TEXT
);
