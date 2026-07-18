import { describe, expect, it } from "vitest";
import { deriveRestoreStatus, type RestoreRow } from "../reservation-cancel";

//
// reservation-cancel: cancelar libera fechas (status='cancelled') sin reembolsar;
// reactivar (undo) vuelve al estado correcto.
//
// El camino normal preserva el estado EXACTO previo a la cancelación
// (cancel_prev_status, schema 0045). deriveRestoreStatus es SOLO el fallback para
// filas canceladas antes de esa columna: sigue el mismo criterio de "pago" que
// paymentInfo del resto del sistema. Estos tests fijan ese fallback.
//   - Libro LPS (total_hnl): confirmed solo si paid_hnl >= total_hnl.
//   - Fuente confirmada-al-capturar (website/airbnb/airbnb_ical): confirmed.
//   - whatsapp_bot (depósito 50%), transferencia, manual: pending.
//

const r = (over: Partial<RestoreRow> = {}): RestoreRow => ({
  source: "manual",
  total_hnl: null,
  paid_hnl: null,
  amount_usd: null,
  ...over,
});

describe("deriveRestoreStatus — fallback de reactivación (filas sin cancel_prev_status)", () => {
  it("libro LPS pagado completo → confirmed", () => {
    expect(deriveRestoreStatus(r({ total_hnl: 5000, paid_hnl: 5000 }))).toBe("confirmed");
    expect(deriveRestoreStatus(r({ total_hnl: 5000, paid_hnl: 6000 }))).toBe("confirmed"); // pagó de más
  });

  it("libro LPS con depósito o sin pago → pending (falta el saldo)", () => {
    expect(deriveRestoreStatus(r({ total_hnl: 5000, paid_hnl: 2500 }))).toBe("pending");
    expect(deriveRestoreStatus(r({ total_hnl: 5000, paid_hnl: 0 }))).toBe("pending");
    expect(deriveRestoreStatus(r({ total_hnl: 5000, paid_hnl: null }))).toBe("pending");
  });

  it("el libro LPS MANDA aunque haya amount_usd (no lo confundas con PayPal)", () => {
    // total_hnl presente pero impago: pending, aunque venga con un amount_usd viejo.
    expect(deriveRestoreStatus(r({ total_hnl: 5000, paid_hnl: 1000, amount_usd: 200, source: "website" }))).toBe("pending");
  });

  it("fuente confirmada-al-capturar sin libro LPS → confirmed (aunque falte amount_usd)", () => {
    // Airbnb sin monto (amount_usd NULL) es un estado real: se guarda 'confirmed'.
    // No degradarla a pending o aparecería impaga y retendría las instrucciones.
    expect(deriveRestoreStatus(r({ source: "website", amount_usd: 97 }))).toBe("confirmed");
    expect(deriveRestoreStatus(r({ source: "website", amount_usd: null }))).toBe("confirmed");
    expect(deriveRestoreStatus(r({ source: "airbnb", amount_usd: null, total_hnl: null }))).toBe("confirmed");
    expect(deriveRestoreStatus(r({ source: "airbnb_ical", amount_usd: null }))).toBe("confirmed");
  });

  it("whatsapp_bot (depósito 50%) NO es pago total → pending", () => {
    // El bot solo cobra el depósito; tratarlo como pagado liberaría las
    // instrucciones sin cobrar el saldo. Sin total_hnl, cae a pending.
    expect(deriveRestoreStatus(r({ source: "whatsapp_bot", amount_usd: 120 }))).toBe("pending");
  });

  it("transferencia/manual SIN libro LPS → pending (no afirmar pagado)", () => {
    expect(deriveRestoreStatus(r({ source: "whatsapp_transfer", amount_usd: 100 }))).toBe("pending");
    expect(deriveRestoreStatus(r({ source: "manual" }))).toBe("pending");
  });
});
