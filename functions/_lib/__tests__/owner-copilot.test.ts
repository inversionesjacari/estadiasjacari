import { describe, it, expect } from "vitest";
import { OWNER_PHONES, isOwnerPhone, OWNER_PHONES_SQL } from "../owner-copilot";

//
// MODO PROPIETARIO (2026-07-25): César + Eduardo. Esta identidad alimenta el
// reconocimiento inbound (webhook), las alertas salientes (owner-alerts) y las
// exclusiones de métricas/inbox/followups — una sola lista, cero drift.
//

describe("OWNER_PHONES — la lista canónica de dueños", () => {
  it("son exactamente César y Eduardo (confirmados 25-jul-2026)", () => {
    expect([...OWNER_PHONES]).toEqual(["50497649035", "50498035697"]);
  });
});

describe("isOwnerPhone — reconocimiento tolerante", () => {
  it("reconoce E.164 pelado, con '+' y con espacios", () => {
    expect(isOwnerPhone("50497649035")).toBe(true);
    expect(isOwnerPhone("+50498035697")).toBe(true);
    expect(isOwnerPhone("+504 9764 9035")).toBe(true);
  });
  it("NO reconoce huéspedes, vacíos ni null", () => {
    expect(isOwnerPhone("50499881234")).toBe(false);
    expect(isOwnerPhone("")).toBe(false);
    expect(isOwnerPhone(null)).toBe(false);
    expect(isOwnerPhone(undefined)).toBe(false);
  });
  it("un número que CONTIENE al de un dueño no matchea (prefijos/sufijos)", () => {
    expect(isOwnerPhone("150497649035")).toBe(false);
    expect(isOwnerPhone("504976490351")).toBe(false);
  });
});

describe("OWNER_PHONES_SQL — literal para NOT IN (...)", () => {
  it("forma exacta esperada por las queries de exclusión", () => {
    expect(OWNER_PHONES_SQL).toBe("'50497649035','50498035697'");
  });
  it("solo dígitos y comillas — nada inyectable", () => {
    expect(OWNER_PHONES_SQL).toMatch(/^'[0-9]+'(,'[0-9]+')*$/);
  });
});
