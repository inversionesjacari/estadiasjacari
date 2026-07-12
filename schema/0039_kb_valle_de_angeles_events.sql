-- 0039_kb_valle_de_angeles_events.sql
--
-- Valle de Ángeles (VdA) al MAPA de la KB (kb_properties) como venue de EVENTOS.
--
-- Objetivo (pedido de César 2026-07-12): que VdA sea "una propiedad también" en
-- el modelo — visible al LLM y al ecosistema de IA — PERO nunca cotizable por
-- noche, porque su precio VARÍA según el evento. El flujo determinístico de
-- eventos (detectors.ts mentionsValleDeAngeles/isEventInquiry + la rama de
-- eventos en quote-flow.ts) sigue siendo la AUTORIDAD y lo intercepta ANTES del
-- LLM; esta fila es solo conocimiento/visibilidad.
--
-- POR QUÉ NO ROMPE EL COTIZADOR:
--   - El slug 'eventos-valle-angeles' NO está en PROPERTY_PRICING ni en el tipo
--     PropertySlug (quote-extractor.ts) → el extractor/llm-schema jamás pueden
--     setearlo como property, y buildPricingMap lo IGNORA (kb-store.ts:
--     `if (!(p.slug in PROPERTY_PRICING)) continue;`). Nunca entra a buildQuote.
--   - `pricing_type='events'` hace que buildKnowledgeBaseText renderice
--     "precio a cotizar" en vez de una tarifa por noche (los 0 de precio NUNCA
--     se muestran). ⚠️ El código de kb-store.ts que ramifica en pricing_type
--     DEBE estar desplegado ANTES o CON esta migración, nunca después
--     (si no, el LLM vería "L.0 por noche" = "el espacio es gratis").
--
-- IDEMPOTENCIA: SQLite no tiene "ADD COLUMN IF NOT EXISTS". El runner del repo
-- aplica cada schema una sola vez por nombre de archivo, así que el ALTER corre
-- una vez. Si se re-ejecutara a mano, el ALTER tira "duplicate column name" —
-- ignorá ese error; el INSERT OR IGNORE de abajo SÍ es re-ejecutable.
--
-- PENDIENTE de César ("en el camino"): capacidad real (80 es PLACEHOLDER),
-- fotos/dirección/contacto del venue, y el panel (4ª ciudad + modo eventos +
-- rango de capacidad) — hasta entonces NO abrir/guardar VdA desde el panel.

ALTER TABLE kb_properties ADD COLUMN pricing_type TEXT NOT NULL DEFAULT 'per_night';

INSERT OR IGNORE INTO kb_properties
  (slug, name, city, capacity, bedrooms, bathrooms, beds,
   price_night_hnl, cleaning_hnl, price_night_usd, cleaning_usd,
   aliases, amenities, pool, beach, pets, parking, tv, ideal_for, notes,
   pricing_type, sort_order)
VALUES
  ('eventos-valle-angeles', 'Valle de Ángeles — Espacio para eventos', 'Valle de Ángeles',
   80, NULL, NULL, NULL,
   0, 0, 0, 0,
   'Valle de Angeles, VdA, el espacio de eventos, salón de eventos, venue de eventos',
   'Espacio para celebraciones privadas (bodas, cumpleaños, quinceañeras, eventos corporativos)',
   NULL, NULL, NULL, NULL, NULL,
   'Eventos privados: bodas, cumpleaños, quinceañeras, eventos corporativos',
   'Venue SOLO de eventos (NO es estadía por noche): el bot no cotiza noches; junta tipo/fecha/personas y deriva al equipo de eventos. Precio a cotizar a medida. Capacidad 80 = PLACEHOLDER (César la ajusta).',
   'events', 8);
