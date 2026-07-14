import { describe, expect, it } from "vitest";
import { GEMELAS_COMBO_SLUG, overlapSlugs, slugPlaceholders } from "../slug-overlap";

// Hallazgo residual de DOCTOR-PROOF-1205 (13-jul-2026): los overlaps D1 por slug
// exacto no cruzaban el combo las-gemelas-tela con sus dos casas → una reserva
// del combo no bloqueaba un comprobante/pago de casa-marea (mismas fechas) ni al
// revés. Estos tests fijan la matriz de cruce: combo↔unidades sí, brisa∦marea no.

describe("overlapSlugs — matriz de cruce del combo Las Gemelas", () => {
  it("las-gemelas-tela expande a las 2 casas (gemelas bloquea marea y brisa)", () => {
    const slugs = overlapSlugs("las-gemelas-tela");
    expect(slugs).toContain("las-gemelas-tela");
    expect(slugs).toContain("casa-brisa");
    expect(slugs).toContain("casa-marea");
    expect(slugs).toHaveLength(3);
  });

  it("casa-marea expande al combo (marea bloquea gemelas)", () => {
    expect(overlapSlugs("casa-marea")).toEqual(["casa-marea", GEMELAS_COMBO_SLUG]);
  });

  it("casa-brisa expande al combo pero NO a casa-marea (brisa no bloquea marea)", () => {
    const slugs = overlapSlugs("casa-brisa");
    expect(slugs).toEqual(["casa-brisa", GEMELAS_COMBO_SLUG]);
    expect(slugs).not.toContain("casa-marea");
  });

  it("el propio slug va siempre incluido y primero (los binds existentes no cambian de semántica)", () => {
    for (const slug of ["las-gemelas-tela", "casa-brisa", "casa-marea", "villa-b11-palma-real"]) {
      expect(overlapSlugs(slug)[0]).toBe(slug);
    }
  });

  it("cualquier otro slug queda solo (sin cruce)", () => {
    expect(overlapSlugs("villa-b11-palma-real")).toEqual(["villa-b11-palma-real"]);
    expect(overlapSlugs("centro-morazan")).toEqual(["centro-morazan"]);
    expect(overlapSlugs("casa-lara-townhouse")).toEqual(["casa-lara-townhouse"]);
    expect(overlapSlugs("la-florida")).toEqual(["la-florida"]);
  });

  it("un slug desconocido no explota ni cruza nada", () => {
    expect(overlapSlugs("eventos-valle-angeles")).toEqual(["eventos-valle-angeles"]);
    expect(overlapSlugs("")).toEqual([""]);
  });
});

describe("slugPlaceholders", () => {
  it("genera un ? por slug, separados por coma", () => {
    expect(slugPlaceholders(["a"])).toBe("?");
    expect(slugPlaceholders(["a", "b"])).toBe("?, ?");
    expect(slugPlaceholders(overlapSlugs("las-gemelas-tela"))).toBe("?, ?, ?");
  });
});
