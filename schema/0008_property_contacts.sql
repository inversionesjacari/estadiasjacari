-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0008 — Contactos del personal operativo por propiedad (Fase 5+)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Tabla `property_contacts` con los teléfonos del personal de LIMPIEZA y
-- SEGURIDAD por propiedad. Sirve para que el cron `whatsapp-operations`
-- les mande templates UTILITY de WhatsApp:
--   - 7:00 AM HN día de check-in → aviso "hoy llega huésped"
--   - 11:30 AM HN día de checkout → aviso "ya salió, pase a limpiar"
--
-- Diferencia con `property_checkin_info`:
--   - property_checkin_info → datos que VE EL HUÉSPED (WiFi, dirección, contacto
--     local DEL HUÉSPED para emergencias). Editable en Google Sheet.
--   - property_contacts → datos INTERNOS de operación (limpieza, seguridad).
--     Editable solo por César/admins, no se expone al huésped.
--
-- Cómo aplicar (uno de los dos):
--   1. Cloudflare Dashboard → D1 → estadias-jacari-db → Console → pegar y Execute
--   2. wrangler d1 execute estadias-jacari-db --remote --file=schema/0008_property_contacts.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS property_contacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT    NOT NULL,           -- slug de propiedad (ver src/data/properties.ts)
  role         TEXT    NOT NULL            -- 'cleaning' | 'security'
               CHECK (role IN ('cleaning', 'security')),
  name         TEXT    NOT NULL,           -- nombre del contacto (ej. "Doña Karina")
  phone_e164   TEXT    NOT NULL,           -- E.164 sin '+' (ej. "50432925998")
  active       INTEGER NOT NULL DEFAULT 1, -- 1 = vigente, 0 = de baja (no recibe mensajes)
  notes        TEXT,                       -- notas internas opcionales (horarios, etc.)
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Índice principal: dame todos los contactos activos de una propiedad para un rol.
-- El cron lo usa: SELECT ... WHERE slug=? AND role=? AND active=1
CREATE INDEX IF NOT EXISTS idx_property_contacts_slug_role_active
  ON property_contacts(slug, role, active);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed inicial — PENDIENTE de completar con César
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Insertar los contactos reales cuando se tengan. Ejemplo de formato:
--
--   INSERT INTO property_contacts (slug, role, name, phone_e164, notes) VALUES
--     ('casa-brisa',           'cleaning', 'Karina Arzu',     '50432925998', 'Vive en HSP, lunes/jueves disponible'),
--     ('casa-brisa',           'security', 'Don Manuel',      '50499XXXXXXX', 'Garita HSP, turno 6am-6pm'),
--     ('casa-marea',           'cleaning', 'Karina Arzu',     '50432925998', 'Misma que Brisa'),
--     ('casa-marea',           'security', 'Don Manuel',      '50499XXXXXXX', 'Misma garita que Brisa'),
--     ('villa-b11-palma-real', 'cleaning', 'PENDIENTE',       'PENDIENTE',   ''),
--     ('villa-b11-palma-real', 'security', 'PENDIENTE',       'PENDIENTE',   'Seguridad del Hotel Palma Real'),
--     ('centro-morazan',       'cleaning', 'PENDIENTE',       'PENDIENTE',   ''),
--     ('centro-morazan',       'security', 'PENDIENTE',       'PENDIENTE',   'Recepción Torre 1'),
--     ('casa-lara-townhouse',  'cleaning', 'PENDIENTE',       'PENDIENTE',   ''),
--     ('casa-lara-townhouse',  'security', 'PENDIENTE',       'PENDIENTE',   'Caseta Colonia Lara'),
--     ('la-florida',           'cleaning', 'PENDIENTE',       'PENDIENTE',   ''),
--     ('la-florida',           'security', 'PENDIENTE',       'PENDIENTE',   'Guardia residencial Lomas');
--
-- Cuando César tenga la lista real, reemplazar 'PENDIENTE' por nombres + teléfonos
-- reales y ejecutar el INSERT en Cloudflare Dashboard D1 Console.
-- Si una propiedad NO tiene contacto de cierto rol (ej. residencial sin seguridad
-- propia), simplemente no insertes esa fila — el cron skip silencioso.
