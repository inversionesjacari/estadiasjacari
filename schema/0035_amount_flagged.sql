-- 0035_amount_flagged.sql
--
-- Marca reservas de Airbnb cuyo amount_usd cayó fuera del rango esperado
-- ($5-$2500, ver AIRBNB_AMOUNT_MIN_USD/MAX_USD en functions/_lib/airbnb-parser.ts)
-- para que NO se sincronicen a contabilidad hasta revisión manual. Defensa
-- adicional contra el bug histórico ×100 (coma decimal mal parseada,
-- JACARI_MEMORY 2026-07-04): un ×100 real (ej. $77.22 → $7722) siempre cae
-- muy por encima del máximo, así que esto lo atrapa aunque el parser se
-- rompa de nuevo.
--
-- SQLite no soporta ADD COLUMN IF NOT EXISTS: si ya existe, ignorá el error
-- de esa línea y seguí con la de abajo.

ALTER TABLE reservations ADD COLUMN amount_flagged INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_reservations_amount_flagged
  ON reservations(amount_flagged)
  WHERE amount_flagged = 1;
