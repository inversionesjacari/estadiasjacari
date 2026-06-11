-- 0028_transfer_receipts.sql
-- Comprobantes de transferencia leídos por el bot (visión) + su veredicto.
-- Sirve para: (1) auditoría de cada comprobante, (2) anti-reuso de la MISMA
-- referencia (el índice UNIQUE bloquea que un comprobante se use dos veces).
--
-- decision: 'auto_confirmed' (pasó los chequeos → reserva creada)
--         | 'escalated'      (dudoso/same-day → lo revisa César)
--         | 'duplicate'      (referencia ya usada)

CREATE TABLE IF NOT EXISTS transfer_receipts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  phone             TEXT NOT NULL,
  reference         TEXT,              -- # de referencia/confirmación del comprobante
  amount            REAL,              -- monto leído
  currency          TEXT,              -- 'HNL' | 'USD'
  bank              TEXT,
  account_extracted TEXT,             -- cuenta destino leída
  name_extracted    TEXT,             -- titular destino leído
  receipt_date      TEXT,             -- fecha del comprobante (YYYY-MM-DD)
  property_slug     TEXT,
  check_in          TEXT,
  check_out         TEXT,
  expected_hnl      REAL,             -- lo que debía pagar (50% o total)
  decision          TEXT NOT NULL,    -- auto_confirmed | escalated | duplicate
  decision_reason   TEXT,
  reservation_id    INTEGER,          -- FK a reservations (si se creó)
  raw_extraction    TEXT,             -- JSON crudo de la visión
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Anti-reuso: una misma referencia no puede registrarse dos veces (las referencias
-- nulas/ilegibles se permiten repetidas → índice parcial).
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_receipts_reference
  ON transfer_receipts(reference) WHERE reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transfer_receipts_phone
  ON transfer_receipts(phone, created_at);
