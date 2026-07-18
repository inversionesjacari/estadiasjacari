-- 0045 — Cancelación manual de reservas.
--
-- Caso (César, 2026-07-17): un huésped cancela "de buenas a primeras". Pierde lo
-- que pagó (no se reembolsa) PERO hay que volver a habilitar esas fechas para
-- rentarlas de nuevo.
--
-- El mecanismo YA existe: status='cancelled' libera las fechas por sí solo —
-- availability (_lib/availability.ts), la detección de solape (paypal-webhook,
-- reservation-create) y TODOS los crons de avisos (checkin-reminders,
-- whatsapp-operations) actúan SOLO sobre status IN ('pending','confirmed'). Al
-- pasar a 'cancelled' la reserva desaparece del calendario, deja de recibir
-- mensajes y sale del dashboard/registro. NO se toca PayPal: la plata se queda.
--
-- Estas dos columnas guardan el RASTRO de la cancelación manual (cuándo y por
-- qué), para la vista "Canceladas" del registro y la auditoría. Distinguen la
-- cancelación de César de las que ya escribía el sistema ('cancelled' por
-- PAYMENT.CAPTURE.DENIED o por overlap+refund).
--
-- NOTA: D1/SQLite no soporta "ADD COLUMN IF NOT EXISTS". Si una columna ya
-- existe, ese ALTER falla — ignorá el error de esa línea y seguí.

ALTER TABLE reservations ADD COLUMN cancelled_at       TEXT;  -- datetime('now') al cancelar a mano
ALTER TABLE reservations ADD COLUMN cancel_reason      TEXT;  -- nota libre (ej. "no-show", "cambió de planes")
-- Estado EXACTO antes de cancelar ('pending' o 'confirmed'). Reactivar (undo)
-- vuelve a este valor tal cual, en vez de re-derivarlo del monto — que no
-- distingue un depósito del bot (50%, pending) de una captura total (confirmed),
-- ni ve las reservas de Airbnb sin monto. SQLite evalúa el RHS del SET con los
-- valores PREVIOS de la fila, así que `SET status='cancelled', cancel_prev_status=status`
-- guarda el estado viejo. Se limpia a NULL al reactivar.
ALTER TABLE reservations ADD COLUMN cancel_prev_status TEXT;
