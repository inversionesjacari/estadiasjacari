import { describe, it, expect } from "vitest";
import {
  normalizeListingName,
  validateAirbnbReservation,
  extractPhoneFromText,
} from "../airbnb-parser";

describe("normalizeListingName", () => {
  it("colapsa espacios y baja a minúsculas", () => {
    expect(normalizeListingName("  Casa   Brisa  ")).toBe("casa brisa");
  });

  it("unifica em-dash y en-dash a guion normal con espaciado uniforme", () => {
    expect(normalizeListingName("Villa B11 — Palma Real")).toBe(
      "villa b11 - palma real",
    );
    expect(normalizeListingName("Casa Brisa - Honduras Shores")).toBe(
      "casa brisa - honduras shores",
    );
    expect(normalizeListingName("Casa Brisa-Honduras Shores")).toBe(
      "casa brisa - honduras shores",
    );
  });

  it("dos nombres que solo difieren en formato normalizan igual", () => {
    const a = normalizeListingName("Casa Marea  -  Honduras Shores ");
    const b = normalizeListingName("casa marea - honduras shores");
    expect(a).toBe(b);
  });

  it("conserva los acentos (podrían distinguir listings reales)", () => {
    expect(normalizeListingName("Morazán")).toBe("morazán");
  });
});

describe("validateAirbnbReservation — shape (independiente del mapa)", () => {
  const base = {
    listingName: "Cualquier Cosa",
    confirmationCode: "HMXQAHMJ4P",
    guestName: "Wander Canelo",
    checkIn: "2026-06-15",
    checkOut: "2026-06-17",
    guestCount: 2,
  };

  it("rechaza payload que no es objeto", () => {
    expect(validateAirbnbReservation(null).ok).toBe(false);
    expect(validateAirbnbReservation("x").ok).toBe(false);
  });

  it("rechaza confirmationCode inválido", () => {
    const r = validateAirbnbReservation({ ...base, confirmationCode: "??" });
    expect(r.ok).toBe(false);
    expect(r.errors?.some((e) => e.includes("confirmationCode"))).toBe(true);
  });

  it("rechaza fechas mal formadas", () => {
    const r = validateAirbnbReservation({ ...base, checkIn: "15/06/2026" });
    expect(r.ok).toBe(false);
    expect(r.errors?.some((e) => e.includes("checkIn"))).toBe(true);
  });

  it("rechaza checkIn >= checkOut", () => {
    const r = validateAirbnbReservation({
      ...base,
      checkIn: "2026-06-17",
      checkOut: "2026-06-15",
    });
    expect(r.ok).toBe(false);
  });

  it("rechaza guestCount fuera de rango", () => {
    expect(validateAirbnbReservation({ ...base, guestCount: 0 }).ok).toBe(false);
    expect(validateAirbnbReservation({ ...base, guestCount: 99 }).ok).toBe(false);
  });

  it("un listing no mapeado da error de mapeo (no de shape)", () => {
    // Con el mapa vacío, un payload por lo demás válido falla SOLO por el mapeo.
    const r = validateAirbnbReservation(base);
    expect(r.ok).toBe(false);
    expect(r.errors?.some((e) => e.includes("no está mapeado"))).toBe(true);
  });
});

describe("extractPhoneFromText", () => {
  it("saca el teléfono de formatos variados", () => {
    expect(extractPhoneFromText("mi número es +504 9764-9035")).toBe("+50497649035");
    expect(extractPhoneFromText("llamame al 9764 9035")).toBe("97649035");
  });

  it("devuelve null si no hay número", () => {
    expect(extractPhoneFromText("hola, todo bien?")).toBe(null);
    expect(extractPhoneFromText("")).toBe(null);
  });
});
