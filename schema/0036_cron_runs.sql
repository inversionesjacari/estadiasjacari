-- 0036_cron_runs.sql
--
-- Historial de corridas de cada cron (`functions/api/cron/*.ts`): cuándo
-- arrancó, si terminó ok o con error, cuánto tardó, y un resumen corto.
-- Complementa a `system_heartbeat` (0015, solo guarda el ÚLTIMO latido):
-- esto guarda el HISTORIAL, así se puede detectar "las últimas 3 corridas
-- fallaron" y no solo "corrió hace poco". Ver functions/_lib/cron-monitor.ts
-- y functions/api/cron/watchdog.ts (avisa por WhatsApp si algo se rompe).

CREATE TABLE IF NOT EXISTS cron_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cron_key    TEXT    NOT NULL,   -- 'cron_bot_retry', 'cron_followups', etc.
  started_at  TEXT    NOT NULL,   -- ISO 8601 (generado en JS, no datetime('now'))
  finished_at TEXT    NOT NULL,
  ok          INTEGER NOT NULL,   -- 1 ok, 0 falló
  error       TEXT,
  duration_ms INTEGER,
  detail      TEXT                -- recorte del JSON de respuesta (debug)
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_key_started
  ON cron_runs(cron_key, started_at DESC);
