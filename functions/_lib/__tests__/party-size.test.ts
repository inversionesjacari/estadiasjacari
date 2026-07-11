import { describe, it, expect } from "vitest";
import { extractPartySize, partyHeadcount } from "../party-size";

describe("extractPartySize — caso real Karen López (Friends Trip, 10-jul-2026)", () => {
  it("'4 adultos 2 niños 1bb' → adultos=4, niños=2, bebés=1 (bebé excluido del total)", () => {
    const p = extractPartySize("Es que quiero saber precios para ir a tela con 4 adultos 2 niños 1bb.");
    expect(p.adults).toBe(4);
    expect(p.children).toBe(2);
    expect(p.babies).toBe(1);
    expect(partyHeadcount(p)).toBe(6); // el bebé NO cuenta
  });
  it("solo adultos, sin niños ni bebés", () => {
    const p = extractPartySize("somos 2 adultos");
    expect(p.adults).toBe(2);
    expect(p.children).toBeNull();
    expect(partyHeadcount(p)).toBe(2);
  });
  it("variantes de niño/niña/kids", () => {
    expect(extractPartySize("2 adultos 1 nina").children).toBe(1);
    expect(extractPartySize("2 adultos 3 kids").children).toBe(3);
  });
  it("un mensaje sin desglose (solo un total suelto) no inventa adultos/niños", () => {
    const p = extractPartySize("seríamos 6 en total");
    expect(p.adults).toBeNull();
    expect(p.children).toBeNull();
    expect(partyHeadcount(p)).toBeNull();
  });
});
