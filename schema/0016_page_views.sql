-- 0016_page_views.sql
--
-- Visitas a la página web (analytics propio, privacy-friendly).
-- Sin cookies, sin guardar IP. El "visitor" es un hash anónimo de
-- (IP + User-Agent + día) que permite contar únicos sin identificar a nadie.
--
-- Alimenta la sección de tráfico web del Centro de Control.

CREATE TABLE IF NOT EXISTS page_views (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL,                  -- ej. /propiedades/casa-brisa
  referrer    TEXT,                           -- dominio de origen (instagram.com, etc.)
  visitor     TEXT,                           -- hash anónimo por día (no PII)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at);
