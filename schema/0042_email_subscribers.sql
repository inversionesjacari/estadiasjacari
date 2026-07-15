-- Captura de email del sitio público (Fase 3.3 del plan maestro).
-- Hoy ~98% del revenue es Airbnb; la reserva directa es ~2%. Un lead que llega
-- al sitio, mira una propiedad y se va SIN escribir por WhatsApp hoy se pierde
-- para siempre. Esta lista es el activo dueño (costo marginal cero, compone):
-- permite un futuro correo de novedades/ofertas para traerlos de vuelta directo.
--
-- email es UNIQUE → el INSERT OR IGNORE del endpoint deduplica solo (un mismo
-- correo que se suscribe dos veces no crea filas repetidas).
CREATE TABLE IF NOT EXISTS email_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  source TEXT,              -- de dónde vino: 'footer', 'post_quote', etc.
  path TEXT,                -- ruta donde se suscribió (para saber qué convierte)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_subscribers_created
  ON email_subscribers(created_at);
