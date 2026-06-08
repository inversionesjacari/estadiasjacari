-- 0019_bot_pauses.sql
-- Pausa del bot por conversación (handoff a humano).
--
-- Cuando el bot ESCALA (out_of_scope, huésped existente, pago reportado, pide
-- humano…) o cuando un humano responde manualmente desde el inbox, se inserta
-- una fila acá → el webhook deja de auto-responder a ese número. Los mensajes
-- entrantes se siguen guardando (aparecen en el inbox), pero el bot calla hasta
-- que se reactive a mano con el botón "Reactivar bot" (que borra la fila).

CREATE TABLE IF NOT EXISTS bot_pauses (
  phone     TEXT PRIMARY KEY,
  paused_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason    TEXT
);
