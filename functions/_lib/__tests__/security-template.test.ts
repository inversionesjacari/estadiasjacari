import { describe, it, expect, vi } from "vitest";

//
// SEGURIDAD-VB11 (César, 2026-07-13): Villa B11 recibe un aviso a seguridad
// ENRIQUECIDO (template `seguridad_llegada`, 5 variables) en vez del genérico
// `checkin_dia_seguridad` (2 variables). Estos tests fijan el CONTRATO del
// payload — el nombre del template y el ORDEN EXACTO de las variables deben
// calzar con lo que César registre en Meta; si alguien los cambia, Meta rechaza
// el envío con 4xx y el aviso a la garita muere en silencio.
//

const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ body: Record<string, unknown> }> }));

vi.mock("../fetch", () => ({
  TIMEOUT: { CRITICAL: 8000 },
  fetchWithTimeout: async (_url: string, opts: { body: string }) => {
    calls.push({ body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [{ id: "wamid.T" }] }) };
  },
}));

import {
  sendSeguridadLlegada,
  sendCheckinDiaSeguridad,
  SECURITY_ENRICHED_SLUGS,
} from "../whatsapp-templates";

const env = { WHATSAPP_ACCESS_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "111" };

function bodyParams(): string[] {
  const tpl = (calls[0].body as { template: { components: Array<{ parameters: Array<{ text: string }> }> } }).template;
  return tpl.components[0].parameters.map((p) => p.text);
}
function templateName(): string {
  return (calls[0].body as { template: { name: string } }).template.name;
}

describe("SECURITY_ENRICHED_SLUGS — qué propiedades reciben el aviso enriquecido", () => {
  it("incluye Villa B11 y NO las demás (decisión 'solo Villa B11')", () => {
    expect(SECURITY_ENRICHED_SLUGS.has("villa-b11-palma-real")).toBe(true);
    expect(SECURITY_ENRICHED_SLUGS.has("casa-brisa")).toBe(false);
    expect(SECURITY_ENRICHED_SLUGS.has("casa-marea")).toBe(false);
  });
});

describe("sendSeguridadLlegada — template enriquecido (Villa B11)", () => {
  it("manda `seguridad_llegada` idioma 'es' con 5 vars EN ORDEN: propiedad, titular, entrada, salida, #huéspedes", async () => {
    calls.length = 0;
    const res = await sendSeguridadLlegada(
      {
        toPhone: "50499837130",
        propertyName: "Villa B11 — Palma Real",
        guestFullName: "Ana García",
        checkInDateEs: "14 de julio",
        checkOutDateEs: "16 de julio",
        guestCount: 6,
      },
      env,
    );
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(templateName()).toBe("seguridad_llegada");
    expect(
      (calls[0].body as { template: { language: { code: string } } }).template.language.code,
    ).toBe("es");
    expect(bodyParams()).toEqual([
      "Villa B11 — Palma Real",
      "Ana García",
      "14 de julio",
      "16 de julio",
      "6",
    ]);
    expect((calls[0].body as { to: string }).to).toBe("50499837130");
  });

  it("guestCount se serializa a string (Meta exige texto en los parámetros)", async () => {
    calls.length = 0;
    await sendSeguridadLlegada(
      {
        toPhone: "50499837130",
        propertyName: "Villa B11 — Palma Real",
        guestFullName: "X",
        checkInDateEs: "1 de agosto",
        checkOutDateEs: "3 de agosto",
        guestCount: 1,
      },
      env,
    );
    expect(bodyParams()[4]).toBe("1");
  });
});

describe("sendCheckinDiaSeguridad — el genérico (resto de propiedades) NO cambió", () => {
  it("sigue mandando `checkin_dia_seguridad` con [titular, salida]", async () => {
    calls.length = 0;
    await sendCheckinDiaSeguridad(
      { toPhone: "50499837130", guestFullName: "Ana García", checkOutDateEs: "16 de julio" },
      env,
    );
    expect(templateName()).toBe("checkin_dia_seguridad");
    expect(bodyParams()).toEqual(["Ana García", "16 de julio"]);
  });
});
