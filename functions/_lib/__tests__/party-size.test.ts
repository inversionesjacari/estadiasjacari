import { describe, it, expect } from "vitest";
import { extractPartySize, partyHeadcount, mergeFriendsTripParty } from "../party-size";

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

// Caso real D'Karoll parte 2 (11-jul-2026): el desglose vino como LISTA de edades
// sin conteo ("me menores de 14 16 11") + bebé sin dígito ("la bebé de 2 años") →
// el parser solo veía "3 adultos", el day pass no se podía calcular y el bot
// terminó re-preguntando el desglose ya respondido.
describe("extractPartySize — lista de edades sin conteo (caso D'Karoll parte 2)", () => {
  it("'3 adultos y me menores de 14 16 11 y la bebé de 2 años' → 4 adultos + 2 niños + 1 bebé", () => {
    const p = extractPartySize("3 adultos y me menores de 14 16 11 y la bebé de 2 años");
    expect(p.adults).toBe(4);   // 3 adultos + el menor de 16 (16+ paga tarifa adulto)
    expect(p.children).toBe(2); // los de 14 y 11
    expect(p.babies).toBe(1);   // "la bebé" cuenta como bebé aunque venga sin dígito
    expect(partyHeadcount(p)).toBe(6); // la bebé no suma al cupo
  });
  it("lista con comas e 'y': 'niños de 12, 9 y 7' → 3 niños", () => {
    const p = extractPartySize("vamos 2 adultos y niños de 12, 9 y 7");
    expect(p.adults).toBe(2);
    expect(p.children).toBe(3);
  });
  it("la lista de edades respeta el umbral: 'menores de 17 y 12' → 1 adulto + 1 niño", () => {
    const p = extractPartySize("llevamos menores de 17 y 12");
    expect(p.adults).toBe(1);   // 17 > 15 → tarifa adulto
    expect(p.children).toBe(1);
  });
  it("cantidades en palabra: 'dos adultos y tres niños' → 2 + 3", () => {
    const p = extractPartySize("dos adultos y tres niños");
    expect(p.adults).toBe(2);
    expect(p.children).toBe(3);
  });
  it("'una bebé' (sin dígito) cuenta como bebé, no como niña", () => {
    const p = extractPartySize("5 adultos 1 niña y una bebé");
    expect(p.adults).toBe(5);
    expect(p.children).toBe(1);
    expect(p.babies).toBe(1);
  });
  it("una categoría suelta sin número ni edades no cuenta nada", () => {
    const p = extractPartySize("van adultos y niños");
    expect(p.adults).toBeNull();
    expect(p.children).toBeNull();
  });
  it("la regresión de Dime sigue intacta: el '2' de '2 niñas' no se lee como edad del grupo anterior", () => {
    const p = extractPartySize("2 adultos, 1 niño de 12, 2 niñas de 15");
    expect(p.adults).toBe(2);
    expect(p.children).toBe(3);
  });
});

// El desglose dado en un turno ANTERIOR no puede perderse: el merge genérico de
// quote-flow no conoce adults/children y un "Ok" posterior re-disparaba
// package_need_party_breakdown (pregunta ya respondida, verbatim).
describe("mergeFriendsTripParty — el desglose ya dado se conserva y cuenta como dato nuevo", () => {
  const DESGLOSE = "3 adultos y me menores de 14 16 11 y la bebé de 2 años";

  it("turno del desglose: parsea, recalcula guests y marca changed (el cotizador debe correr)", () => {
    const r = mergeFriendsTripParty({ adults: null, children: null }, DESGLOSE);
    expect(r.adults).toBe(4);
    expect(r.children).toBe(2);
    expect(r.guests).toBe(6);
    expect(r.changed).toBe(true);
  });
  it("'Ok' posterior: CONSERVA el desglose previo (no se vuelve a pedir) y no marca changed", () => {
    const r = mergeFriendsTripParty({ adults: 4, children: 2 }, "Ok");
    expect(r.adults).toBe(4);   // ← adults != null → package_need_party_breakdown NO re-dispara
    expect(r.children).toBe(2);
    expect(r.guests).toBeNull(); // sin desglose nuevo no se toca el guests que ya había
    expect(r.changed).toBe(false);
  });
  it("un desglose corregido pisa el anterior y marca changed (se re-cotiza)", () => {
    const r = mergeFriendsTripParty({ adults: 4, children: 2 }, "mejor somos 2 adultos y 2 niños");
    expect(r.adults).toBe(2);
    expect(r.children).toBe(2);
    expect(r.guests).toBe(4);
    expect(r.changed).toBe(true);
  });
  it("repetir el MISMO desglose no marca changed (no fuerza re-cotización)", () => {
    const r = mergeFriendsTripParty({ adults: 2, children: 3 }, "2 adultos y 3 niños");
    expect(r.changed).toBe(false);
  });
});
