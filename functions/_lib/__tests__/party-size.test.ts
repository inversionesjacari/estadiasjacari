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
  it("varios grupos de niños se SUMAN, no solo el primero (caso Dime, 11-jul-2026)", () => {
    // "2 adultos / 1 niño de 12 / 2 niñas de 15" → 2 adultos + 3 niños (12,15,15).
    // Antes tomaba solo "1 niño" y se comía las 2 niñas → day pass cobraba de menos.
    const p = extractPartySize("2 adultos\n1 niño de 12\n2 niñas de 15");
    expect(p.adults).toBe(2);
    expect(p.children).toBe(3);
    expect(p.babies).toBeNull();
    expect(partyHeadcount(p)).toBe(5);
  });
  it("la edad ('de 12', 'de 15') NO se cuenta como personas", () => {
    // El número tiene que ir pegado al sustantivo; 'de 15' no infla el conteo.
    expect(extractPartySize("1 niña de 15").children).toBe(1);
  });

  // Umbral de edad (decisión de César, 11-jul-2026): niño = tarifa niño HASTA 15;
  // de 16 en adelante paga tarifa de ADULTO en el day pass.
  it("un 'niño' de 15 o menos cuenta como NIÑO (borde inferior)", () => {
    expect(extractPartySize("1 niño de 15").children).toBe(1);
    expect(extractPartySize("1 niño de 15").adults).toBeNull();
    expect(extractPartySize("2 niñas de 8").children).toBe(2);
  });
  it("un 'niño' de 16+ cuenta como ADULTO aunque el cliente lo llame niño (borde superior)", () => {
    const p = extractPartySize("2 adultos y 1 niño de 16");
    expect(p.adults).toBe(3);       // 2 adultos + el "niño" de 16
    expect(p.children).toBeNull();
    expect(partyHeadcount(p)).toBe(3);
  });
  it("mezcla con umbral: '1 niño de 12, 1 niña de 17' → 1 niño + 1 adulto", () => {
    const p = extractPartySize("1 niño de 12 y 1 niña de 17");
    expect(p.children).toBe(1); // el de 12
    expect(p.adults).toBe(1);   // la de 17 sube a adulto
  });
  it("'de 15 años' (con la palabra años) también se lee como edad, no como personas", () => {
    const p = extractPartySize("2 adultos, 3 niños de 15 años");
    expect(p.adults).toBe(2);
    expect(p.children).toBe(3);
  });
  it("un mensaje sin desglose (solo un total suelto) no inventa adultos/niños", () => {
    const p = extractPartySize("seríamos 6 en total");
    expect(p.adults).toBeNull();
    expect(p.children).toBeNull();
    expect(partyHeadcount(p)).toBeNull();
  });
});
