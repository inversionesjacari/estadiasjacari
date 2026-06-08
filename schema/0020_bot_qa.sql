-- 0020_bot_qa.sql
-- QA del bot: hallazgos del analizador de conversaciones.
--
-- Un agente (botón en el Centro de Control + cron diario) revisa las
-- conversaciones recientes con IA, detecta fallos del bot (inventos, info
-- incompleta, frustración del cliente, ventas perdidas, fallas técnicas…) y
-- guarda un hallazgo por problema con un fix sugerido. El panel "QA del bot"
-- los muestra. Cada corrida REEMPLAZA los hallazgos (snapshot fresco).

CREATE TABLE IF NOT EXISTS bot_qa_findings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT,
  issue      TEXT,                 -- tipo corto del problema
  severity   TEXT,                 -- 'alta' | 'media' | 'baja'
  detail     TEXT,                 -- qué pasó (1-2 líneas)
  suggestion TEXT,                 -- fix sugerido
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Una fila por corrida del análisis (para mostrar "última revisión" + stats).
CREATE TABLE IF NOT EXISTS bot_qa_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at      TEXT NOT NULL DEFAULT (datetime('now')),
  analyzed    INTEGER NOT NULL DEFAULT 0,  -- conversaciones revisadas
  found       INTEGER NOT NULL DEFAULT 0,  -- hallazgos totales
  trigger     TEXT                         -- 'boton' | 'cron'
);
