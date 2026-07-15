import { describe, it, expect } from "vitest";
import { parseSubscribeInput } from "../subscribe";

// Fase 3.3 del plan maestro: captura de email del sitio público. Estos tests
// cubren la lógica PURA (validación + honeypot + saneo); el endpoint es un
// wrapper delgado sobre esto + rate-limit + INSERT.

describe("parseSubscribeInput — validación de la captura de email (Fase 3.3)", () => {
  it("email válido → ok, en minúsculas y recortado", () => {
    const r = parseSubscribeInput({ email: "  Cesar@Estadias.HN  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.email).toBe("cesar@estadias.hn");
  });

  it("honeypot lleno → rechazado como bot (no inserta)", () => {
    const r = parseSubscribeInput({ email: "real@correo.com", website: "http://spam.ru" });
    expect(r).toEqual({ ok: false, reason: "honeypot" });
  });

  it("honeypot vacío o whitespace → no cuenta como bot", () => {
    expect(parseSubscribeInput({ email: "a@b.com", website: "   " }).ok).toBe(true);
    expect(parseSubscribeInput({ email: "a@b.com", website: "" }).ok).toBe(true);
  });

  it.each([
    ["sin arroba", "cesarestadias.com"],
    ["sin TLD", "cesar@estadias"],
    ["TLD de 1 letra", "cesar@estadias.h"],
    ["con espacio", "ce sar@estadias.com"],
    ["vacío", ""],
    ["solo arroba", "@"],
    ["no-string", 12345 as unknown],
  ])("email inválido (%s) → invalid_email", (_desc, email) => {
    expect(parseSubscribeInput({ email })).toEqual({ ok: false, reason: "invalid_email" });
  });

  it("email demasiado largo (>254) → invalid_email", () => {
    const long = "a".repeat(250) + "@b.com";
    expect(parseSubscribeInput({ email: long })).toEqual({ ok: false, reason: "invalid_email" });
  });

  it("source y path válidos se conservan; basura → null", () => {
    const r = parseSubscribeInput({ email: "a@b.com", source: "footer", path: "/propiedades/casa-brisa" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("footer");
      expect(r.path).toBe("/propiedades/casa-brisa");
    }
    const r2 = parseSubscribeInput({ email: "a@b.com", source: "<script>", path: "raro; drop" });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.source).toBeNull();
      expect(r2.path).toBeNull();
    }
  });

  it("source ausente → null (no rompe)", () => {
    const r = parseSubscribeInput({ email: "a@b.com" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBeNull();
      expect(r.path).toBeNull();
    }
  });
});
