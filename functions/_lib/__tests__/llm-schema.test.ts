import { describe, it, expect } from "vitest";
import { validateBotOutput } from "../llm-schema";

//
// llm-schema — la red que atrapa el JSON roto del modelo (plan maestro 4.1).
// Los casos malformados salen de fallos REALES vistos en bot_trace (LLM_GLITCH):
// texto plano en vez de JSON, reply vacío, slugs/intents inventados, fechas no-ISO.
//

const GOOD = {
  reply: "¡Claro! Casa Brisa está disponible 🌴",
  checkIn: "2026-07-17",
  checkOut: "2026-07-19",
  guests: 4,
  property: "casa-brisa",
  city: "Tela",
  intent: "providing_data",
  language: "es",
};

describe("validateBotOutput — output sano pasa intacto", () => {
  it("acepta el contrato completo", () => {
    const r = validateBotOutput(GOOD);
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.fields).toEqual(GOOD);
  });
});

describe("validateBotOutput — lo que NO sirve para responder (→ retry 1×)", () => {
  it("texto plano (el modelo rompió el modo JSON) no es objeto", () => {
    const r = validateBotOutput("¡Hola! Tenemos casas en Tela y La Ceiba…");
    expect(r.ok).toBe(false);
    expect(r.fields.intent).toBe("unknown");
  });
  it("null / array tampoco", () => {
    expect(validateBotOutput(null).ok).toBe(false);
    expect(validateBotOutput([GOOD]).ok).toBe(false);
  });
  it("objeto sin reply usable", () => {
    expect(validateBotOutput({ ...GOOD, reply: "" }).ok).toBe(false);
    expect(validateBotOutput({ ...GOOD, reply: "   " }).ok).toBe(false);
    const { reply: _omit, ...sinReply } = GOOD;
    expect(validateBotOutput(sinReply).ok).toBe(false);
  });
});

describe("validateBotOutput — campos secundarios inválidos se anulan sin matar el mensaje", () => {
  it("property inventada (Roatán) → null, pero el reply sobrevive", () => {
    const r = validateBotOutput({ ...GOOD, property: "villa-roatan-west-bay" });
    expect(r.ok).toBe(true);
    expect(r.fields.property).toBeNull();
    expect(r.problems.join(" ")).toContain("property");
  });
  it("fecha no-ISO (17/07/2026) → null", () => {
    const r = validateBotOutput({ ...GOOD, checkIn: "17/07/2026" });
    expect(r.ok).toBe(true);
    expect(r.fields.checkIn).toBeNull();
  });
  it("guests fuera de rango o no numérico → null", () => {
    expect(validateBotOutput({ ...GOOD, guests: 50 }).fields.guests).toBeNull();
    expect(validateBotOutput({ ...GOOD, guests: "4" }).fields.guests).toBeNull();
    expect(validateBotOutput({ ...GOOD, guests: 0 }).fields.guests).toBeNull();
  });
  it("intent inventado → unknown; idioma raro → es", () => {
    const r = validateBotOutput({ ...GOOD, intent: "book_now", language: "it" });
    expect(r.fields.intent).toBe("unknown");
    expect(r.fields.language).toBe("es");
  });
  it("guests decimal razonable se redondea (comportamiento histórico)", () => {
    expect(validateBotOutput({ ...GOOD, guests: 4.4 }).fields.guests).toBe(4);
  });
});
