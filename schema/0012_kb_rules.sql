-- 0012_kb_rules.sql
--
-- Reglas generales de comportamiento del bot, editables desde
-- /inbox/conocimiento → pestaña "Reglas". Son instrucciones libres que se
-- inyectan al system prompt del bot con MÁXIMA prioridad (ej: "nunca des
-- precios sin que los pidan").
--
-- Seed con INSERT OR IGNORE (idempotente). Seguro de re-ejecutar.

CREATE TABLE IF NOT EXISTS kb_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO kb_rules (id, rule, sort_order) VALUES
  (1, 'Nunca des precios ni cotizaciones si el cliente no los ha pedido. Esperá a que pregunte por el precio, la disponibilidad, o diga que quiere reservar.', 1),
  (2, 'No abrumes al cliente listando todas las propiedades de golpe al inicio. Primero entendé qué busca: a qué ciudad quiere ir, para cuántas personas y en qué fechas.', 2),
  (3, 'Sé cálido y natural, como una persona real del equipo. Nunca menciones que sos un bot o una IA.', 3);
