import { describe, expect, it } from "vitest";
import { formatDateRangeEs, buildTemplateFollowupVars } from "../followup-template";
import { PROPERTY_PRICING } from "../quote-builder";

// B4: las 3 variables del template seguimiento_cotizacion ({{1}} nombre,
// {{2}} propiedad, {{3}} fechas). El template solo se manda a leads que llegaron
// a una cotización real (propiedad + fechas); sin esos datos, null → no se manda.

describe("formatDateRangeEs", () => {
  it("mismo mes (es) → 'del D al D de mes'", () => {
    expect(formatDateRangeEs("2026-08-15", "2026-08-17", "es")).toBe("del 15 al 17 de agosto");
  });

  it("cruce de mes (es) → 'del D de mes al D de mes'", () => {
    expect(formatDateRangeEs("2026-08-30", "2026-09-02", "es")).toBe("del 30 de agosto al 2 de septiembre");
  });

  it("mismo mes (en) → 'Mon D–D'", () => {
    expect(formatDateRangeEs("2026-08-15", "2026-08-17", "en")).toBe("Aug 15–17");
  });

  it("cruce de mes (en) → 'Mon D – Mon D'", () => {
    expect(formatDateRangeEs("2026-08-30", "2026-09-02", "en")).toBe("Aug 30 – Sep 2");
  });

  it("fecha malformada → null (el llamador salta el lead, no manda un template roto)", () => {
    expect(formatDateRangeEs("15 de agosto", "2026-08-17", "es")).toBeNull();
    expect(formatDateRangeEs("2026-13-01", "2026-08-17", "es")).toBeNull();
    expect(formatDateRangeEs("", "", "es")).toBeNull();
  });
});

describe("buildTemplateFollowupVars", () => {
  // Un slug real del motor para {{2}}
  const slug = "casa-brisa";
  const propName = PROPERTY_PRICING[slug].name;

  it("datos completos → arma las 3 variables con el primer nombre", () => {
    const v = buildTemplateFollowupVars(
      { property: slug, checkIn: "2026-08-15", checkOut: "2026-08-17", language: "es" },
      "Karen López",
    );
    expect(v).toEqual({ name: "Karen", property: propName, dates: "del 15 al 17 de agosto" });
  });

  it("sin nombre de contacto → neutro que lee natural ('Hola de nuevo')", () => {
    const v = buildTemplateFollowupVars(
      { property: slug, checkIn: "2026-08-15", checkOut: "2026-08-17" },
      null,
    );
    expect(v?.name).toBe("de nuevo");
  });

  it("lead marcado en inglés → IGUAL en español (el template solo existe en es; nada de mezcla)", () => {
    const v = buildTemplateFollowupVars(
      { property: slug, checkIn: "2026-08-15", checkOut: "2026-08-17", language: "en" },
      "   ",
    );
    expect(v?.name).toBe("de nuevo"); // no "there"
    expect(v?.dates).toBe("del 15 al 17 de agosto"); // no "Aug 15–17"
  });

  it("sin propiedad conocida → null (no mandar template con {{2}} vacío)", () => {
    expect(
      buildTemplateFollowupVars({ city: "Tela", checkIn: "2026-08-15", checkOut: "2026-08-17" }, "Ana"),
    ).toBeNull();
  });

  it("slug que no está en el motor (ej. eventos VdA) → null", () => {
    expect(
      buildTemplateFollowupVars(
        { property: "eventos-valle-angeles", checkIn: "2026-08-15", checkOut: "2026-08-17" },
        "Ana",
      ),
    ).toBeNull();
  });

  it("sin fechas → null", () => {
    expect(buildTemplateFollowupVars({ property: slug }, "Ana")).toBeNull();
    expect(buildTemplateFollowupVars({ property: slug, checkIn: "2026-08-15" }, "Ana")).toBeNull();
  });

  it("las gemelas (combo) SÍ cotiza → arma variables", () => {
    const v = buildTemplateFollowupVars(
      { property: "las-gemelas-tela", checkIn: "2026-08-15", checkOut: "2026-08-17" },
      "Dvall",
    );
    expect(v?.property).toBe(PROPERTY_PRICING["las-gemelas-tela"].name);
  });
});
