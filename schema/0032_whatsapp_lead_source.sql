-- 0032_whatsapp_lead_source.sql
--
-- Origen del lead de WhatsApp vía ads "Click to WhatsApp" de Meta. Cuando alguien
-- toca el botón "Enviar mensaje" de un ad de IG/FB, Meta manda un objeto `referral`
-- en el primer mensaje del webhook con el anuncio/campaña exactos. Lo guardamos por
-- teléfono (el PRIMERO = la atribución original) para poder decir de qué ad vino
-- cada reserva. Ver functions/api/whatsapp-webhook.ts (captura) y el reporte de marketing.

CREATE TABLE IF NOT EXISTS whatsapp_lead_source (
  phone        TEXT PRIMARY KEY,   -- E.164 sin '+', normalizado (= guest_phone_normalized)
  source_type  TEXT,               -- 'ad' | 'post'
  source_id    TEXT,               -- id del anuncio/publicación
  source_url   TEXT,               -- link del ad (fb.me/...)
  headline     TEXT,               -- titular del ad (lo más legible para identificarlo)
  body         TEXT,               -- texto del ad
  ctwa_clid    TEXT,               -- click id (para Conversions API, futuro)
  first_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
