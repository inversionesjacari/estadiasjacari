-- 0018_airbnb_income.sql
-- Caché del ingreso de Airbnb leído de PayPal (Transaction Search API).
--
-- El cron `/api/cron/paypal-income` baja las transacciones de las cuentas
-- PayPal donde caen los payouts de Airbnb, suma las que vienen de "Airbnb" por
-- rango (hoy / 7 días / 30 días) y guarda el total acá. El endpoint de métricas
-- lee esta tabla (rápido) en vez de pegarle a PayPal en cada poll.
--
-- Solo 3 filas: period IN ('today','week','month'). El cron las reescribe.

CREATE TABLE IF NOT EXISTS airbnb_income (
  period      TEXT PRIMARY KEY,          -- 'today' | 'week' | 'month'
  amount_usd  REAL    NOT NULL DEFAULT 0,
  tx_count    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
