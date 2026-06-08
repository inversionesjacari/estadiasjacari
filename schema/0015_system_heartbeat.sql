-- 0015_system_heartbeat.sql
--
-- Latido de sistemas: registra la última vez que corrió cada proceso automático
-- (crons). El Centro de Control lo usa para mostrar si cada sistema está vivo
-- (🟢 corrió hace poco / 🔴 lleva mucho sin correr).
--
-- Cada cron hace un UPSERT de su key al ejecutarse (aunque no tenga nada que hacer).

CREATE TABLE IF NOT EXISTS system_heartbeat (
  key      TEXT PRIMARY KEY,   -- 'cron_followups', 'cron_checkin', etc.
  last_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
