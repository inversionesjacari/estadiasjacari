import { describe, it, expect } from "vitest";
import {
  buttonReplyToText,
  paymentButtons,
  confirmButtons,
  BTN,
} from "../button-map";
import {
  isCardChoice,
  isTransferChoice,
  isConfirmation,
  isDateChangeOrAvailabilityQuestion,
} from "../detectors";

describe("button-map · entrante (tap → texto canónico que los detectors reconocen)", () => {
  it("pay_card → texto que isCardChoice reconoce", () => {
    const t = buttonReplyToText({ type: "button_reply", button_reply: { id: BTN.PAY_CARD } });
    expect(t).toBe("tarjeta");
    expect(isCardChoice(t!)).toBe(true);
  });

  it("pay_transfer → texto que isTransferChoice reconoce", () => {
    const t = buttonReplyToText({ type: "button_reply", button_reply: { id: BTN.PAY_TRANSFER } });
    expect(t).toBe("transferencia");
    expect(isTransferChoice(t!)).toBe(true);
  });

  it("confirm_book → texto que isConfirmation reconoce", () => {
    const t = buttonReplyToText({ type: "button_reply", button_reply: { id: BTN.CONFIRM_BOOK } });
    expect(t).not.toBeNull();
    expect(isConfirmation(t!)).toBe(true);
  });

  it("change_dates → NO confirma y SÍ dispara cambio de fecha (re-cotiza)", () => {
    const t = buttonReplyToText({ type: "button_reply", button_reply: { id: BTN.CHANGE_DATES } });
    expect(t).not.toBeNull();
    expect(isConfirmation(t!)).toBe(false);
    expect(isDateChangeOrAvailabilityQuestion(t!)).toBe(true);
  });

  it("id desconocido / payload vacío → null (el webhook lo escala)", () => {
    expect(buttonReplyToText({ button_reply: { id: "xyz_desconocido" } })).toBeNull();
    expect(buttonReplyToText(null)).toBeNull();
    expect(buttonReplyToText(undefined)).toBeNull();
    expect(buttonReplyToText({})).toBeNull();
  });

  it("también acepta list_reply (por si se usa una lista nativa a futuro)", () => {
    expect(buttonReplyToText({ list_reply: { id: BTN.PAY_CARD } })).toBe("tarjeta");
  });
});

describe("button-map · saliente (botones válidos para Meta)", () => {
  it("máx 3 botones, título ≤20 chars, es y en, ids no vacíos", () => {
    for (const lang of ["es", "en"]) {
      for (const set of [paymentButtons(lang), confirmButtons(lang)]) {
        expect(set.length).toBeGreaterThan(0);
        expect(set.length).toBeLessThanOrEqual(3);
        for (const b of set) {
          expect(b.id.length).toBeGreaterThan(0);
          // Spread cuenta CODE POINTS (un emoji = 1), que es como Meta mide el título.
          expect([...b.title].length).toBeLessThanOrEqual(20);
        }
      }
    }
  });

  // INVARIANTE crítica: todo id que SALE tiene que poder VOLVER a un texto que un
  // detector reconoce. Si alguien agrega un botón saliente sin mapear su id, este
  // test lo caza (el botón se enviaría pero el tap no haría nada).
  it("todo id saliente vuelve a un texto conocido (round-trip)", () => {
    const salientes = [
      ...paymentButtons("es"), ...paymentButtons("en"),
      ...confirmButtons("es"), ...confirmButtons("en"),
    ];
    for (const b of salientes) {
      expect(buttonReplyToText({ button_reply: { id: b.id } })).not.toBeNull();
    }
  });
});
