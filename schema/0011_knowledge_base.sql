-- 0011_knowledge_base.sql
--
-- Base de conocimiento del bot, editable desde el panel /inbox/conocimiento.
-- Antes vivía hardcoded en functions/_lib/property-kb.ts y quote-builder.ts.
-- Ahora vive en D1 (editable) con esos archivos como fallback/semilla.
--
-- 3 tablas:
--   kb_properties — datos estructurados de cada propiedad (6 fijas, se editan no se crean)
--   kb_policies   — políticas generales (check-in, mascotas, cancelación, etc.)
--   kb_faqs       — preguntas frecuentes (CRUD completo)
--
-- El seed usa INSERT OR IGNORE → idempotente: si ya hay datos (ej. el usuario
-- ya editó), no los sobreescribe. Seguro de re-ejecutar.

-- ─────────────────────────────────────────────────────────────────────────────
-- Tablas
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kb_properties (
  slug             TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  city             TEXT NOT NULL,
  capacity         INTEGER NOT NULL,
  bedrooms         INTEGER,
  bathrooms        INTEGER,
  beds             TEXT,
  price_night_hnl  INTEGER NOT NULL,
  cleaning_hnl     INTEGER NOT NULL,
  price_night_usd  INTEGER NOT NULL,
  cleaning_usd     INTEGER NOT NULL,
  aliases          TEXT,
  amenities        TEXT,
  pool             TEXT,
  beach            TEXT,
  pets             TEXT,
  parking          TEXT,
  tv               TEXT,
  ideal_for        TEXT,
  notes            TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kb_policies (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  value       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kb_faqs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: propiedades
-- ─────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO kb_properties
  (slug, name, city, capacity, bedrooms, bathrooms, beds,
   price_night_hnl, cleaning_hnl, price_night_usd, cleaning_usd,
   aliases, amenities, pool, beach, pets, parking, tv, ideal_for, notes, sort_order)
VALUES
  ('villa-b11-palma-real', 'Villa B11 — Palma Real', 'La Ceiba', 6, 2, 1,
   'Principal: 1 cama King · Secundaria: 2 camas matrimoniales',
   2500, 350, 90, 14,
   'Palma Real, Villa Palma Real',
   'Cocina equipada · Aire acondicionado · WiFi · Smart TV · Terraza privada con asador de carbón · Brazaletes de acceso al Hotel Palma Real',
   'Sí — piscina del Hotel Palma Real incluida con los brazaletes de acceso (sin costo adicional)',
   'Sí — acceso a las playas del hotel, incluido con la reserva (brazaletes)',
   'Sí se permiten (con cláusula de responsabilidad)',
   'Incluido',
   'Smart TV — conectá tu cuenta de streaming',
   'Grupos que quieren la experiencia completa de resort',
   '', 1),

  ('casa-brisa', 'Casa Brisa', 'Tela', 6, 2, 2,
   'Principal: 1 Queen + 1 individual · Secundaria: 1 matrimonial + 1 individual',
   2500, 350, 90, 14,
   'La Casita del Mar',
   'Cocina equipada · A/C en todas las habitaciones y sala · WiFi dual (2 redes) · Smart TV · Estacionamiento amplio · Generador eléctrico propio · Jardín trasero con asador',
   'Opcional — se paga en el hotel: L.250/persona lunes a jueves, L.350/persona viernes a domingo',
   'Sí — playa pública gratis rodeando el hotel, o acceso por el hotel con costo opcional (L.250-350/persona)',
   'Sí se permiten (con cláusula de responsabilidad)',
   'Incluido (amplio, varios vehículos)',
   'Smart TV — conectá tu cuenta de streaming',
   'Familias y grupos que quieren estar cerca del mar',
   'Se puede rentar junto a Casa Marea (Las Gemelas) para hasta 12 personas', 2),

  ('casa-marea', 'Casa Marea', 'Tela', 6, 2, 2,
   'Principal: 1 Queen · Secundaria: 1 litera + 1 individual',
   2500, 350, 90, 14,
   'Tela Beach House',
   'Cocina equipada · A/C en todas las habitaciones y sala · WiFi dual (2 redes) · Smart TV · Estacionamiento amplio · Generador eléctrico propio · Jardín con asador',
   'Opcional — se paga en el hotel: L.250/persona lunes a jueves, L.350/persona viernes a domingo',
   'Sí — playa pública gratis rodeando el hotel, o acceso por el hotel con costo opcional (L.250-350/persona)',
   'Sí se permiten (con cláusula de responsabilidad)',
   'Incluido (amplio)',
   'Smart TV — conectá tu cuenta de streaming',
   'Familias y grupos cerca del mar',
   'Se puede rentar junto a Casa Brisa (Las Gemelas) para hasta 12 personas', 3),

  ('centro-morazan', 'Centro Morazán', 'Tegucigalpa', 6, 2, 2,
   '2 habitaciones + camas adicionales (3 camas en total)',
   2100, 400, 80, 16,
   '',
   'WiFi · A/C independiente en cada habitación · Smart TV · Estacionamiento 1 vehículo · Vistas panorámicas desde el piso 20',
   'No incluida',
   'No aplica (Tegucigalpa)',
   'Sí se permiten (con cláusula de responsabilidad)',
   '1 vehículo incluido (vehículo adicional con costo)',
   'Smart TV — conectá tu cuenta de streaming',
   'Viajeros de negocios, parejas, vistas de la capital',
   '', 4),

  ('casa-lara-townhouse', 'Casa Lara Townhouse', 'Tegucigalpa', 4, 2, 3,
   '2 habitaciones, cada una con cama Queen y baño privado propio',
   1590, 400, 60, 16,
   'Casa Lara',
   'WiFi · A/C en ambas habitaciones · Smart TV · Estacionamiento 1 vehículo · Portón inteligente desde el comedor · Baño privado por habitación',
   'No',
   'No aplica (Tegucigalpa)',
   'Sí se permiten (con cláusula de responsabilidad)',
   'Incluido (1 vehículo)',
   'Smart TV — conectá tu cuenta de streaming',
   'Dos parejas viajando juntas, privacidad, zona exclusiva',
   '', 5),

  ('la-florida', 'La Florida', 'Tegucigalpa', 3, 2, 1,
   'Principal: cama doble · Sala: sofá cama',
   650, 350, 26, 14,
   '',
   'WiFi · A/C · Smart TV · Lavadora y secadora propias · Cocina equipada · Seguridad residencial 24/7',
   'No',
   'No aplica (Tegucigalpa)',
   'Sí se permiten (con cláusula de responsabilidad)',
   'No incluido',
   'Smart TV — conectá tu cuenta de streaming',
   'Estadías económicas, viajes de trabajo, estadías largas',
   '', 6);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: políticas generales
-- ─────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO kb_policies (key, label, value, sort_order) VALUES
  ('check_in', 'Check-in', '3:00 PM (aplica en todos los alojamientos)', 1),
  ('check_out', 'Check-out', '11:00 AM (aplica en todos los alojamientos)', 2),
  ('pets', 'Mascotas', 'Se permiten en todas las propiedades. Mensaje al huésped: "Por esta ocasión podemos hacer una excepción, solo le solicitamos a nuestros huéspedes hacerse responsables por cualquier daño que puedan llegar a ocasionar y comunicarlo de inmediato con nosotros."', 3),
  ('parties', 'Fiestas y eventos', 'PROHIBIDOS en todas las propiedades sin excepción', 4),
  ('smoking', 'Fumar', 'No se permite fumar dentro de las propiedades', 5),
  ('cancellation', 'Cancelación', 'Reembolso completo si cancela con al menos 1 semana de anticipación. Sin eso, el 50% inicial de depósito no es reembolsable. El 50% restante simplemente no se cobra.', 6),
  ('payment', 'Forma de pago', '50% para reservar + 50% el día de check-in. Aceptamos tarjeta de crédito / PayPal (link inmediato) o transferencia bancaria BAC (HNL o USD).', 7),
  ('streaming', 'Streaming / TV', 'Todas las propiedades tienen Smart TV. El huésped conecta su propia cuenta (Netflix, HBO, Disney+, etc.). No incluimos suscripciones.', 8),
  ('address', 'Dirección exacta', 'Se comparte únicamente al confirmar la reserva con el 50% de depósito', 9);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: preguntas frecuentes
-- ─────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO kb_faqs (question, answer, sort_order) VALUES
  ('¿A qué hora es el check-in?', 'El check-in es a las 3:00 PM y el check-out a las 11:00 AM. Aplica en todos nuestros alojamientos.', 1),
  ('¿Tienen WiFi?', 'Sí, todas las propiedades tienen WiFi de alta velocidad. Casa Brisa y Casa Marea tienen WiFi dual (2 redes).', 2),
  ('¿Tienen TV?', 'Sí, todas las propiedades tienen Smart TV. El huésped conecta su propia cuenta de streaming (Netflix, HBO, Disney+, etc.).', 3),
  ('¿Se permiten mascotas?', 'Sí, por esta ocasión podemos hacer una excepción. Solo les solicitamos hacerse responsables por cualquier daño que puedan ocasionar y comunicarlo de inmediato con nosotros.', 4),
  ('¿Hay piscina en Tela (Casa Brisa / Casa Marea)?', 'Hay piscina disponible, pero es un servicio opcional que se paga en el hotel: L.250 por persona de lunes a jueves, y L.350 de viernes a domingo.', 5),
  ('¿Hay piscina en Villa B11 (La Ceiba)?', 'Sí, el acceso a la piscina del Hotel Palma Real está incluido con la renta. Le proporcionamos brazaletes al inicio de su estadía.', 6),
  ('¿Cómo se llega a la playa en Tela?', 'De dos maneras: por la playa pública rodeando el hotel (sin costo), o a través del hotel de forma más directa con el costo opcional de L.250-350 por persona.', 7),
  ('¿Se permiten fiestas o eventos?', 'No, las fiestas y eventos están prohibidos en todas nuestras propiedades.', 8),
  ('¿Cuál es la política de cancelación?', 'Si cancelás con al menos una semana de anticipación, te hacemos el reembolso completo. Después de esa fecha, el depósito inicial del 50% no es reembolsable.', 9),
  ('¿Hay generador eléctrico?', 'Casa Brisa y Casa Marea tienen generador eléctrico propio incluido (muy útil en la costa).', 10),
  ('¿Los precios incluyen todo?', 'Sí. El precio incluye el alojamiento, todas las amenidades y la tarifa de limpieza. No hay cargos ocultos.', 11),
  ('¿Cómo funciona el pago?', 'Se paga el 50% para confirmar la reserva y el 50% restante el día del check-in. Aceptamos tarjeta/PayPal o transferencia bancaria BAC.', 12);
