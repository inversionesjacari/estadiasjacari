-- 0025_message_media.sql
--
-- Media en los mensajes de WhatsApp: notas de voz, imágenes, video, documentos
-- y stickers — tanto los que mandan los clientes (entrantes) como las fotos del
-- bot y lo que sube César desde el inbox (salientes).
--
-- Antes el webhook descartaba todo lo no-texto como "[<tipo> no manejado]".
-- Ahora guardamos la referencia al archivo para poder verlo/oírlo en el inbox.
--
-- Dos formas de referenciar el archivo (el front elige):
--   • media_id  → id de Meta (entrantes + lo que sube César). Se sirve por el
--                 proxy autenticado /api/inbox/media?id=<media_id> (necesita el
--                 token de Meta, por eso no se expone la URL directa).
--   • media_url → URL pública directa (fotos salientes del bot: /images/<slug>/…).
--                 No necesita proxy ni token.
--
-- NOTA: D1/SQLite no soporta "ADD COLUMN IF NOT EXISTS". Si una columna ya
-- existe, ese ALTER falla — ignorá el error de esa línea y seguí con la siguiente.

ALTER TABLE whatsapp_messages ADD COLUMN media_type     TEXT;  -- image | audio | video | document | sticker
ALTER TABLE whatsapp_messages ADD COLUMN media_id       TEXT;  -- id de Meta (se sirve por /api/inbox/media)
ALTER TABLE whatsapp_messages ADD COLUMN media_url       TEXT; -- URL pública directa (fotos salientes del bot)
ALTER TABLE whatsapp_messages ADD COLUMN media_mime     TEXT;  -- ej. image/jpeg, audio/ogg, video/mp4
ALTER TABLE whatsapp_messages ADD COLUMN media_filename TEXT;  -- nombre original (documentos)
