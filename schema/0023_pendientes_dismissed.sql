-- 0023_pendientes_dismissed.sql
-- Permite descartar un chat de la columna "Pendientes" del inbox (botón ✕).
-- Se oculta hasta que el cliente VUELVA a escribir: si llega un mensaje más nuevo
-- que dismissed_at, el chat reaparece en Pendientes (algo nuevo que atender).
-- Ideal para vendedores/spam o chats que ya atendiste por otro lado.
CREATE TABLE IF NOT EXISTS pendientes_dismissed (
  phone        TEXT PRIMARY KEY,
  dismissed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
