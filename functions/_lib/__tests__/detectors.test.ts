import { describe, it, expect } from "vitest";
import {
  isConfirmation,
  isBankAccountRequest,
  isBedroomPhotoRequest,
  isPhotoRequest,
  isCheckinTimeRequest,
  isNotInterested,
  isLegitimacyQuestion,
  isPhoneNumberRequest,
  isLocationRequest,
  isLongTermRequest,
  nightsBetween,
} from "../detectors";

// Cada caso de acá es un BUG REAL que ya vimos (ver references/patrones-de-fallo.md).
// Si una regex se "mejora" y rompe uno, el test lo caza antes del cliente.

describe("isConfirmation — 'si' suele ser 'if', no 'sí'", () => {
  it("una pregunta de disponibilidad NO es confirmación (bug Zedileth)", () => {
    expect(isConfirmation("Pero si estaría disponible para el 17 de junio?")).toBe(false);
  });
  it("una despedida cortés sola NO confirma (no la mandes a pagar)", () => {
    expect(isConfirmation("Ok buen día")).toBe(false);
  });
  it("un 'sí' fuerte + despedida SÍ confirma", () => {
    expect(isConfirmation("perfecto, buen día")).toBe(true);
  });
  it("confirmaciones claras", () => {
    expect(isConfirmation("sí dale")).toBe(true);
    expect(isConfirmation("de acuerdo")).toBe(true);
  });
  it("negaciones no confirman", () => {
    expect(isConfirmation("no, mejor no")).toBe(false);
    expect(isConfirmation("ya no")).toBe(false);
  });
});

describe("isBankAccountRequest — blinda contra inventar cuenta", () => {
  it("pedir la cuenta para transferir", () => {
    expect(isBankAccountRequest("a qué cuenta transfiero?")).toBe(true);
    expect(isBankAccountRequest("me das los datos bancarios")).toBe(true);
  });
  it("NO roba 'número de personas'", () => {
    expect(isBankAccountRequest("somos un número de 5 personas")).toBe(false);
  });
});

describe("isBedroomPhotoRequest — habitaciones, no la sala", () => {
  it("pide fotos de las habitaciones (incluye typo 'abitaciones')", () => {
    expect(isBedroomPhotoRequest("me mandás fotos de las habitaciones?")).toBe(true);
    expect(isBedroomPhotoRequest("fotos de las abitaciones")).toBe(true);
    expect(isBedroomPhotoRequest("quiero ver los cuartos")).toBe(true);
  });
  it("fotos de la casa en general NO es pedido de dormitorios", () => {
    expect(isBedroomPhotoRequest("fotos de la casa")).toBe(false);
  });
});

describe("isCheckinTimeRequest — el paso de pago no debe tragarse la pregunta (bug Sandra)", () => {
  it("pregunta por la hora de entrada", () => {
    expect(isCheckinTimeRequest("a qué hora puedo entrar?")).toBe(true);
    expect(isCheckinTimeRequest("cuál es el horario de check-in?")).toBe(true);
    expect(isCheckinTimeRequest("what time is check-in?")).toBe(true);
  });
  it("NO roba 'a qué cuenta' ni 'cuántas personas'", () => {
    expect(isCheckinTimeRequest("a qué cuenta deposito?")).toBe(false);
    expect(isCheckinTimeRequest("cuántas personas caben?")).toBe(false);
  });
});

describe("isNotInterested — cerrar sin insistir", () => {
  it("rechazo directo / por precio / despedida sola", () => {
    expect(isNotInterested("no me interesa")).toBe(true);
    expect(isNotInterested("está muy caro")).toBe(true);
    expect(isNotInterested("gracias")).toBe(true);
  });
  it("'gracias, ¿cómo pago?' NO es desinterés", () => {
    expect(isNotInterested("gracias, ¿cómo pago?")).toBe(false);
  });
});

describe("isLegitimacyQuestion — la objeción más cara antes de transferir", () => {
  it("dudas de estafa/realidad", () => {
    expect(isLegitimacyQuestion("¿esto es estafa?")).toBe(true);
    expect(isLegitimacyQuestion("¿son reales?")).toBe(true);
    expect(isLegitimacyQuestion("is this a scam?")).toBe(true);
  });
  it("NO roba 'número de cuenta'", () => {
    expect(isLegitimacyQuestion("me das el número de cuenta")).toBe(false);
  });
});

describe("otros detectores clave", () => {
  it("isPhotoRequest cubre pedir el instagram", () => {
    expect(isPhotoRequest("me pasás el instagram?")).toBe(true);
    expect(isPhotoRequest("tienen fotos?")).toBe(true);
  });
  it("isPhoneNumberRequest pide un teléfono (no que lo llamen)", () => {
    expect(isPhoneNumberRequest("me das un número de teléfono?")).toBe(true);
  });
  it("isLocationRequest pide ubicación/mapa", () => {
    expect(isLocationRequest("dónde queda?")).toBe(true);
    expect(isLocationRequest("me pasás la ubicación?")).toBe(true);
  });
  it("isLongTermRequest detecta renta a largo plazo", () => {
    expect(isLongTermRequest("busco algo por varios meses")).toBe(true);
  });
  it("nightsBetween cuenta noches", () => {
    expect(nightsBetween("2026-07-17", "2026-07-19")).toBe(2);
    expect(nightsBetween("2026-07-17", "2026-07-17")).toBe(0);
  });
});
