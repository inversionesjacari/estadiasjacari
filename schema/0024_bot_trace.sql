-- 0024_bot_trace.sql
-- Tabla de diagnóstico temporal: registra en qué punto y por qué el bot
-- conversacional no responde a un mensaje de entrada. La leemos con una query
-- para ver el error EXACTO (sin adivinar). Se puede borrar cuando termine el
-- diagnóstico: DROP TABLE bot_trace;
CREATE TABLE IF NOT EXISTS bot_trace (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  phone  TEXT,
  stage  TEXT,   -- PRE_LLM | LLM_GLITCH | THREW
  detail TEXT
);
