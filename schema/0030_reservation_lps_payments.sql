-- 0030 — Reservas en Lempiras con pagos parciales.
--
-- Las reservas directas se manejan en LPS y se pagan en partes (depósito + saldo).
--   total_hnl = precio total de la estadía en Lempiras.
--   paid_hnl  = cuánto pagó hasta ahora en Lempiras (suma de pagos).
-- El saldo = total_hnl - paid_hnl se calcula en la app.
-- Reservas viejas / Airbnb quedan con total_hnl = NULL → la planilla cae al
-- display anterior (amount_usd) sin romperse.

ALTER TABLE reservations ADD COLUMN total_hnl REAL;
ALTER TABLE reservations ADD COLUMN paid_hnl  REAL NOT NULL DEFAULT 0;
