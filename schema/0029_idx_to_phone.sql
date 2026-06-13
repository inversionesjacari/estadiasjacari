-- ─────────────────────────────────────────────────────────────────────────────
-- 0029 — Índice por to_phone en whatsapp_messages
-- ─────────────────────────────────────────────────────────────────────────────
--
-- El inbox consulta mensajes por from_phone OR to_phone (conversations.ts /
-- messages.ts). Ya existe idx (from_phone, created_at) pero NO sobre to_phone,
-- así que el lado to_phone de cada query hace table scan (y empeora con cada
-- mensaje). Cloudflare D1 cobra por filas leídas → esto pega en latencia y costo.
--
-- Aplicar en la Consola D1 antes/junto al deploy.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_to_phone_created
  ON whatsapp_messages(to_phone, created_at DESC);
