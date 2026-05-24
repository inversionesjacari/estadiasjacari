-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0005 — Rate limiting para endpoints administrativos
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Sin esto, un leak del `CRON_SECRET` permite a un atacante mandar miles de
-- correos vía `/api/admin/test-email` y quemar la cuenta Resend / triggear
-- el cron docenas de veces.
--
-- Estrategia:
-- Una fila por cada llamada al endpoint admin, con (endpoint, ip, timestamp).
-- Antes de procesar, el endpoint cuenta cuántas hubo en los últimos 60s desde
-- la misma IP. Si supera el límite, devuelve 429 con `Retry-After: 60`.
--
-- Cleanup automático: el helper purga filas con timestamp > 1 hora cada vez
-- que se inserta (best-effort). Para casos extremos, agregar cron mensual.
--
-- Cómo aplicar (uno de los dos):
--   1. Cloudflare Dashboard → D1 → estadias-jacari-db → Console → pegar y Execute
--   2. wrangler d1 execute estadias-jacari-db --remote --file=schema/0005_rate_limit.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint  TEXT    NOT NULL,
  ip        TEXT    NOT NULL,
  ts        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_endpoint_ip_ts
  ON rate_limit_events(endpoint, ip, ts DESC);

-- Sweep helper — no es necesario llamarlo si el helper purga inline, pero
-- útil para una limpieza manual ocasional.
-- DELETE FROM rate_limit_events WHERE ts < datetime('now', '-1 hour');
