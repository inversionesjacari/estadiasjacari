import { describe, expect, it } from "vitest";
import { shouldSendCheckinNow } from "../checkin-immediate";

// Hueco confirm-tarde (auditoría 2026-07-12): el cron T-1 corre la víspera 6 PM
// mirando solo "mañana". Si César confirma tarde (mismo día, o víspera pasado el
// cron), el huésped no recibe instrucciones. Este predicado decide cuándo el
// endpoint de confirmar debe auto-disparar el envío.

const TODAY = "2026-07-14";
const TOMORROW = "2026-07-15";

describe("shouldSendCheckinNow", () => {
  it("llegada HOY, sin recordatorio → SÍ dispara (el cron de anoche no la agarró)", () => {
    expect(shouldSendCheckinNow(TODAY, null, TODAY, TOMORROW)).toBe(true);
  });

  it("llegada MAÑANA, sin recordatorio → SÍ dispara (idempotente si el cron también corre)", () => {
    expect(shouldSendCheckinNow(TOMORROW, null, TODAY, TOMORROW)).toBe(true);
  });

  it("recordatorio YA enviado → NO repite (aunque sea hoy/mañana)", () => {
    expect(shouldSendCheckinNow(TODAY, "2026-07-13 18:00:00", TODAY, TOMORROW)).toBe(false);
    expect(shouldSendCheckinNow(TOMORROW, "2026-07-14 10:00:00", TODAY, TOMORROW)).toBe(false);
  });

  it("llegada a FUTURO (pasado mañana+) → NO dispara (el cron T-1 la cubre a su tiempo)", () => {
    expect(shouldSendCheckinNow("2026-07-16", null, TODAY, TOMORROW)).toBe(false);
    expect(shouldSendCheckinNow("2026-08-01", null, TODAY, TOMORROW)).toBe(false);
  });

  it("llegada en el PASADO → NO dispara (no re-mandar a un no-show/reserva vieja)", () => {
    expect(shouldSendCheckinNow("2026-07-13", null, TODAY, TOMORROW)).toBe(false);
  });

  it("fecha nula o malformada → NO dispara (nunca romper el confirmar)", () => {
    expect(shouldSendCheckinNow(null, null, TODAY, TOMORROW)).toBe(false);
    expect(shouldSendCheckinNow("", null, TODAY, TOMORROW)).toBe(false);
    expect(shouldSendCheckinNow("14 de julio", null, TODAY, TOMORROW)).toBe(false);
    expect(shouldSendCheckinNow("2026-7-4", null, TODAY, TOMORROW)).toBe(false);
  });

  it("reminderSentAt como cadena vacía cuenta como NO enviado", () => {
    expect(shouldSendCheckinNow(TODAY, "", TODAY, TOMORROW)).toBe(true);
  });
});
