-- 0027_quick_replies.sql
--
-- Respuestas rápidas (plantillas) que el operador inserta en el composer del
-- inbox con un clic. Editables desde /inbox/conocimiento → pestaña "Respuestas
-- rápidas". NO las usa el bot: son atajos para cuando un humano responde a mano.
--
-- Seed con INSERT OR IGNORE (idempotente). Seguro de re-ejecutar.

CREATE TABLE IF NOT EXISTS quick_replies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO quick_replies (id, title, content, sort_order) VALUES
  (1, 'Formas de pago', 'Podés pagar el 50% ahora por *transferencia bancaria* o *tarjeta/PayPal*, lo que te quede más cómodo. El otro 50% el día del check-in. 🙌', 1),
  (2, 'Confirmo y te aviso', 'Dame un momento, lo confirmo y te aviso enseguida. 🙌', 2),
  (3, 'Gracias / cierre', '¡Gracias por escribir a Estadías Jacarí! Cualquier cosa, por acá estoy. 🌴', 3);
