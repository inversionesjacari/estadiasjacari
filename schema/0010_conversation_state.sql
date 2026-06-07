-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0010 — Estado de conversación para el quote flow (LLM-powered)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Cuando un huésped potencial pregunta "precio" / "cuánto cuesta", el bot
-- entra en un flow de cotización que necesita acumular datos a lo largo de
-- varios mensajes:
--
--   1. Cliente: "cuánto cuesta?"          → bot pide fechas + huéspedes + propiedad
--   2. Cliente: "del 15 al 18, somos 4"   → bot extrae datos, falta propiedad
--   3. Cliente: "Casa Brisa"               → bot tiene todo → genera cotización
--
-- Esta tabla guarda el estado entre mensajes. Se borra una vez completada la
-- cotización (o expira a las 48h sin actividad para evitar acumulación).
--
-- Diseño:
--   - Key: phone (E.164 sin '+'). UN solo estado activo por número.
--   - state: máquina de estados simple (ver app code para los valores)
--   - data: JSON con { checkIn?, checkOut?, guests?, property?, city? }
--   - expires_at: 48h después del último update — limpieza oportunista
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_state (
  phone        TEXT PRIMARY KEY,
  state        TEXT NOT NULL
               CHECK (state IN (
                 'awaiting_quote_data',     -- esperando fechas+huéspedes+propiedad
                 'quote_provided',           -- ya se le pasó la cotización, esperando "sí"
                 'awaiting_payment_method',  -- confirmó, eligiendo tarjeta o transferencia
                 'awaiting_paypal_capture',  -- mandamos link PayPal, esperando webhook
                 'awaiting_transfer_proof'   -- mandamos datos banco, esperando foto comprobante
               )),
  data         TEXT,                      -- JSON: { checkIn, checkOut, guests, property, city }
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL DEFAULT (datetime('now', '+48 hours'))
);

CREATE INDEX IF NOT EXISTS idx_conversation_state_expires
  ON conversation_state(expires_at);
