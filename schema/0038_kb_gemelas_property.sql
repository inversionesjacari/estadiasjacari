-- 0038_kb_gemelas_property.sql
--
-- Las Gemelas (Casa Brisa + Casa Marea juntas) como fila de kb_properties.
--
-- Hasta ahora el precio combinado vivía SOLO en código (PROPERTY_PRICING de
-- quote-builder.ts) → (a) no era editable desde /inbox/conocimiento y (b) el
-- system prompt del bot en producción NO incluía la tarifa combinada (la KB de
-- D1 solo tenía las 6 propiedades individuales; la sección de Gemelas existía
-- únicamente en el fallback hardcoded, que no se usa cuando D1 está poblada).
--
-- Con esta fila: el panel puede editar la tarifa combinada, buildPricingMap la
-- toma de D1 (el slug ya existe en PROPERTY_PRICING, así que mapea), y
-- buildKnowledgeBaseText la muestra al LLM bajo "Propiedades de Tela".
--
-- Tarifa = decisión de César 2026-07-11: L.5,000/noche (la SUMA de las dos
-- casas, 2×2,500; USD 180 = 2×90) + L.700 de limpieza (2×350). El 4,900/176
-- que cobraba el motor era error histórico, corregido en quote-builder.ts en
-- el mismo commit que agrega este schema.
--
-- INSERT OR IGNORE → idempotente: si la fila ya existe (o César la editó), no
-- la pisa. Seguro de re-ejecutar.

INSERT OR IGNORE INTO kb_properties
  (slug, name, city, capacity, bedrooms, bathrooms, beds,
   price_night_hnl, cleaning_hnl, price_night_usd, cleaning_usd,
   aliases, amenities, pool, beach, pets, parking, tv, ideal_for, notes, sort_order)
VALUES
  ('las-gemelas-tela', 'Las Gemelas (Casa Brisa + Casa Marea juntas)', 'Tela', 12, 4, 4,
   'Brisa: 1 Queen + 1 individual / 1 matrimonial + 1 individual · Marea: 1 Queen / 1 litera + 1 individual',
   5000, 700, 180, 28,
   'Las Gemelas, las dos casas de Tela, ambas casas',
   'Todo lo de Casa Brisa y Casa Marea: cocinas equipadas · A/C · WiFi dual · Smart TV · generadores propios · jardines con asador',
   'Opcional — se paga en el hotel: L.250/persona lunes a jueves, L.350/persona viernes a domingo',
   'Sí — playa pública gratis rodeando el hotel, o acceso por el hotel con costo opcional (L.250-350/persona)',
   'Sí se permiten (con cláusula de responsabilidad)',
   'Incluido (amplio, varios vehículos)',
   'Smart TV en ambas casas — conectá tu cuenta de streaming',
   'Familias grandes, grupos de amigos, retiros (7 a 12 personas)',
   'Son DOS casas contiguas (Casa Brisa + Casa Marea) que se rentan JUNTAS. Solo se cotiza si AMBAS están disponibles en esas fechas.', 7);
