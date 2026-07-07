-- Eventos del embudo de reserva del sitio público (analytics propio).
-- page_views (0031) ya mide visitas; esta tabla mide ACCIONES dentro del
-- embudo: click a WhatsApp, apertura del calendario, selección de fechas,
-- pasos del checkout y confirmación de pago. Sin esto no había forma de ver
-- dónde se cae la gente entre "entró a la propiedad" y "pagó".
CREATE TABLE IF NOT EXISTS site_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  property_slug TEXT,
  path TEXT,
  visitor TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_site_events_event_created
  ON site_events(event, created_at);
