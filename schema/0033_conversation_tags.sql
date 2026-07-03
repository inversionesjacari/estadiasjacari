-- 0033_conversation_tags.sql
--
-- Etiquetas / desenlace de cada conversación de WhatsApp — herramienta manual para
-- descifrar en qué quedó cada chat (reservó, cotizó, sin disponibilidad, precio,
-- sin respuesta…) y de qué propiedad preguntó. Alimenta el "seguimiento por
-- propiedad" del reporte de marketing (cuántos preguntaron por cada espacio).
--
-- Una fila por teléfono = el estado ACTUAL de esa conversación (se sobrescribe).

CREATE TABLE IF NOT EXISTS conversation_tags (
  phone         TEXT PRIMARY KEY,   -- E.164 sin '+'
  outcome       TEXT,               -- reservo | cotizo | sin_disponibilidad | precio | sin_respuesta | fuera | otro
  property_slug TEXT,               -- opcional: de qué propiedad preguntó
  note          TEXT,               -- nota libre opcional
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversation_tags_updated ON conversation_tags(updated_at);
CREATE INDEX IF NOT EXISTS idx_conversation_tags_prop ON conversation_tags(property_slug);
