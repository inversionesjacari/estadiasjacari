-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0006 — Columnas WhatsApp Cloud API (Fase 5)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Agrega 3 columnas de idempotencia + auditoría a la tabla `reservations` para
-- el envío del recordatorio de check-in por WhatsApp (template checkin_instructions,
-- categoría UTILITY, idioma es, header document con el PDF de bienvenida).
--
-- Lógica de idempotencia (espejo del correo Correo #2):
--   - whatsapp_sent_at IS NULL  → aún no enviado → candidato para enviar
--   - whatsapp_sent_at NOT NULL → ya enviado → skip (no reenviar aunque el
--                                  cron o webhook se reintenten)
--   - whatsapp_error            → último error si el envío falló (se borra al
--                                  reintento exitoso para no acumular basura)
--   - whatsapp_message_id       → ID devuelto por Meta (útil para tracking en
--                                  WhatsApp Manager y soporte con Meta)
--
-- Cómo aplicar (uno de los dos):
--   1. Cloudflare Dashboard → D1 → estadias-jacari-db → Console → pegar y Execute
--   2. wrangler d1 execute estadias-jacari-db --remote --file=schema/0006_whatsapp.sql
--
-- SQLite no soporta múltiples ALTER TABLE en un solo statement, por eso van
-- separados con ";" en líneas distintas.
-- ─────────────────────────────────────────────────────────────────────────────

-- Timestamp de cuándo se envió el mensaje de WhatsApp con las instrucciones de
-- check-in. NULL = no enviado todavía. NOT NULL = enviado OK (no reenviar).
ALTER TABLE reservations ADD COLUMN whatsapp_sent_at TEXT;

-- Detalle del último error si el envío de WhatsApp falló (timeout, token
-- inválido, template no aprobado, teléfono sin WhatsApp, etc.). Se sobreescribe
-- en cada reintento fallido y se limpia a NULL cuando el envío es exitoso.
ALTER TABLE reservations ADD COLUMN whatsapp_error TEXT;

-- ID del mensaje devuelto por Meta Cloud API tras un envío exitoso.
-- Formato: "wamid.XXXX..." — permite rastrear el mensaje en WhatsApp Manager.
ALTER TABLE reservations ADD COLUMN whatsapp_message_id TEXT;
