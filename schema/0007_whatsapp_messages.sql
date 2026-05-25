-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0007 — Bot WhatsApp inbound (Fase 7)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Tabla de log de mensajes entrantes y salientes del bot de WhatsApp.
-- Sirve para 3 cosas:
--   1. Idempotencia — Meta puede reintentar el mismo webhook varias veces.
--      `meta_message_id` UNIQUE garantiza que solo procesamos cada mensaje
--      del huésped una sola vez (INSERT OR IGNORE en el webhook).
--   2. Auditoría — saber qué preguntó el huésped, qué regla matcheó, si se
--      escaló a humano, qué se respondió.
--   3. Análisis futuro — qué preguntas son más frecuentes para decidir si
--      vale la pena agregar nuevas reglas o subir a un bot con LLM.
--
-- Cómo aplicar:
--   1. Cloudflare Dashboard → D1 → estadias-jacari-db → Console → pegar y Execute
--   2. wrangler d1 execute estadias-jacari-db --remote --file=schema/0007_whatsapp_messages.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  meta_message_id   TEXT UNIQUE,              -- wamid.xxx — NULL para mensajes salientes propios
  reservation_id    INTEGER,                  -- FK opcional a reservations.id (NULL si no match)
  direction         TEXT NOT NULL             -- 'in' (huésped → bot) | 'out' (bot → huésped)
                    CHECK (direction IN ('in','out')),
  from_phone        TEXT NOT NULL,            -- E.164 sin '+'
  to_phone          TEXT NOT NULL,            -- E.164 sin '+'
  body              TEXT,                     -- texto del mensaje (in: lo que dijo el huésped; out: respuesta del bot)
  matched_rule      TEXT,                     -- nombre de la regla que respondió (wifi, llaves, ...) — NULL si no matcheó
  escalated         INTEGER NOT NULL DEFAULT 0,  -- 1 si se reenvió por email a César
  escalation_error  TEXT,                     -- detalle si el email de escalación falló
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Índice principal: dado un número de huésped, ver su historial reciente
-- (útil para context de soporte y debugging).
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone_created
  ON whatsapp_messages(from_phone, created_at DESC);

-- Índice para analítica futura: qué reglas son las más usadas.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_rule
  ON whatsapp_messages(matched_rule, created_at DESC)
  WHERE matched_rule IS NOT NULL;
