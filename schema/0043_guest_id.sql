-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0043 — Foto de identidad del huésped (para la garita de Villa B11)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- César (2026-07-13): la garita de Villa B11 necesita la foto de la identidad
-- del huésped. Fase 2. El binario NO va en D1 (pesa) — va a un bucket R2 nuevo
-- (binding GUEST_IDS, bucket 'estadias-jacari-guest-ids', PRIVADO). Estas
-- columnas son solo la REFERENCIA (la key en R2) + metadatos.
--
--   security_id_key         → key del objeto en R2 (ej. 'guest-ids/res-42.jpg')
--   security_id_mime        → 'image/jpeg' | 'image/png' (Meta header image solo acepta esos)
--   security_id_captured_at → cuándo se cargó
--   security_id_source      → 'inbox' (César la subió) | 'guest' (el huésped la mandó, Fase 2d)
--
-- PII: la foto es dato sensible. Bucket privado (solo se sirve por el proxy
-- autenticado /api/inbox/reservation-id). Borrado automático tras el checkout
-- queda para un cron de limpieza (Fase 2 siguiente).
--
-- Cómo aplicar: Cloudflare Dashboard → D1 → estadias-jacari-db → Console → pegar.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE reservations ADD COLUMN security_id_key TEXT;
ALTER TABLE reservations ADD COLUMN security_id_mime TEXT;
ALTER TABLE reservations ADD COLUMN security_id_captured_at TEXT;
ALTER TABLE reservations ADD COLUMN security_id_source TEXT;
