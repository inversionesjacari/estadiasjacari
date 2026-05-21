-- ─────────────────────────────────────────────────────────────────────────────
-- Schema inicial — Estadías Jacarí (Cloudflare D1 / SQLite)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Tabla principal: reservas pagadas en el sitio web vía PayPal.
-- Estas filas + el iCal exportable de Airbnb forman la fuente de verdad de
-- disponibilidad. El endpoint /api/availability/[slug] hace UNION de ambos.
--
-- Status:
--   pending    → reserva creada client-side (onApprove) pero webhook PayPal
--                aún no llegó. Bloquea fechas para evitar race conditions.
--   confirmed  → webhook PAYMENT.CAPTURE.COMPLETED verificado y procesado.
--   refunded   → webhook PAYMENT.CAPTURE.REFUNDED recibido. Libera fechas.
--   cancelled  → webhook PAYMENT.CAPTURE.DENIED o cancelación manual.
--
-- Convención de fechas: check_in inclusivo, check_out exclusivo (igual que iCal).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reservations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  property_slug      TEXT    NOT NULL,
  check_in           TEXT    NOT NULL,   -- YYYY-MM-DD (inclusivo)
  check_out          TEXT    NOT NULL,   -- YYYY-MM-DD (exclusivo)
  guest_name         TEXT,
  guest_email        TEXT,
  guest_phone        TEXT,
  paypal_order_id    TEXT    NOT NULL UNIQUE,
  amount_usd         REAL,                -- Monto cobrado en USD por PayPal
  amount_hnl_ref     REAL,                -- Monto en HNL al TC del momento (referencia)
  exchange_rate      REAL,                -- TC USD/HNL usado en el momento del cobro
  status             TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','confirmed','refunded','cancelled')),
  source             TEXT    NOT NULL DEFAULT 'website',  -- futuro: 'airbnb_ical', etc.
  raw_payload        TEXT,                -- JSON del webhook completo (audit trail)
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Índice principal para la query de availability: dado un slug y un rango,
-- encontrar todas las reservas que se solapan.
CREATE INDEX IF NOT EXISTS idx_reservations_slug_dates
  ON reservations(property_slug, check_in, check_out);

-- Búsqueda inversa por order ID (cuando llega webhook de refund/denial).
CREATE INDEX IF NOT EXISTS idx_reservations_paypal_order_id
  ON reservations(paypal_order_id);

-- Filtros por status (ej: solo confirmed para mostrar al cliente).
CREATE INDEX IF NOT EXISTS idx_reservations_status
  ON reservations(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Tabla secundaria: log de eventos del webhook PayPal (para debug y auditoría).
-- Cada notificación recibida queda registrada — útil para resolver disputas
-- y depurar firmas inválidas.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS paypal_webhook_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  paypal_event_id     TEXT,
  event_type          TEXT,
  paypal_order_id     TEXT,
  verification_status TEXT,                -- 'SUCCESS' | 'FAILURE' | 'SKIPPED'
  processed           INTEGER DEFAULT 0,   -- 1 si llegó a INSERT/UPDATE en reservations
  error_message       TEXT,
  raw_headers         TEXT,
  raw_body            TEXT,
  received_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_log_received_at
  ON paypal_webhook_log(received_at DESC);
