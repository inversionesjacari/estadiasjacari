-- 0021_bot_qa_incremental.sql
-- QA del bot v2: tiempo del hallazgo + análisis incremental.
--
-- (a) `conv_at` en los hallazgos = momento del último mensaje de la conversación
--     (para "ver los tiempos" de cada error en el panel).
-- (b) `qa_analyzed` recuerda hasta qué mensaje se analizó cada conversación, así
--     una conversación ya revisada NO se vuelve a marcar salvo que el cliente
--     escriba algo nuevo → lo ya resuelto no reaparece.
--
-- Correr UNA vez (si el ALTER da error "duplicate column", ya estaba aplicado).

ALTER TABLE bot_qa_findings ADD COLUMN conv_at TEXT;

CREATE TABLE IF NOT EXISTS qa_analyzed (
  phone       TEXT PRIMARY KEY,
  last_msg_at TEXT,                                  -- último mensaje cuando se analizó
  analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
