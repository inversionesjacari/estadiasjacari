-- 0040 — Índices para la "Salud de entrega WhatsApp" (card en /inbox/operacion
-- + check de entrega en el watchdog). Solo índices, cero cambios de datos: el
-- código NO depende de que esta migración esté aplicada (sin índices las
-- queries funcionan, solo leen más filas).
--
-- Aplicar:
--   npx wrangler d1 execute estadias-jacari-db --remote --file=schema/0040_delivery_indexes.sql

-- Fallos y atascados: WHERE status='failed'/'sent' AND created_at > X.
-- La columna status vive desde 0013 pero nunca tuvo índice.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_status_created
  ON whatsapp_messages(status, created_at DESC) WHERE status IS NOT NULL;

-- Agregados 7d/30d por dirección (la card los pide en cada poll del inbox).
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_direction_created
  ON whatsapp_messages(direction, created_at DESC);

-- bot_trace no tenía NINGÚN índice y metrics ya la agrupa por stage; ahora
-- además watchdog+metrics filtran stage='WA_DELIVERY_FAILED'. OJO: la columna
-- de tiempo de bot_trace se llama `at` (no created_at).
CREATE INDEX IF NOT EXISTS idx_bot_trace_stage_at
  ON bot_trace(stage, at DESC);
