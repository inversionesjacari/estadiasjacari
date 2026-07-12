import { describe, it, expect } from "vitest";
import {
  isDuplicateResend,
  parseSqliteUtcMs,
  DUP_WINDOW_MS,
  type LastOutbound,
} from "../outbound-dedup";

// Bug real: chat Méndez (+504 9550-4729), 11-jul-2026. Dos mensajes del cliente con
// segundos de diferencia → el bot mandó la MISMA respuesta dos veces (fotos ×2,
// check-in ×2, "no disponible" ×2, comprobante ×2). Este helper decide, antes de
// enviar, si el saliente es un re-envío verbatim reciente y hay que suprimirlo.

const NOW = 1_752_256_566_000; // epoch ms fijo para el test (nada de Date.now())
function prev(over: Partial<LastOutbound> = {}): LastOutbound {
  return { matchedRule: "photos_sent", body: "¡Claro! Te mando algunas fotos 📸", createdAtMs: NOW - 5_000, ...over };
}

describe("isDuplicateResend — dedup de salientes verbatim (bug Méndez, 11-jul-2026)", () => {
  it("mismo rule + mismo body dentro de la ventana → es duplicado", () => {
    expect(
      isDuplicateResend(prev(), { matchedRule: "photos_sent", body: "¡Claro! Te mando algunas fotos 📸" }, NOW),
    ).toBe(true);
  });

  it("los 4 duplicados reales del chat se reconocen", () => {
    const casos = [
      { rule: "photos_sent", body: "¡Claro! Te mando algunas fotos 📸" },
      { rule: "bot_gathering_data", body: "El check-in es a las 3:00 PM y el check-out a las 11:00 AM. Aplica en todos nuestros alojamientos." },
      { rule: "quote_unavailable_airbnb", body: "Lamentablemente Villa B11 — Palma Real no está disponible en esas fechas 😔\n\n¿Querés que revise otras fechas u otra propiedad?" },
      { rule: "transfer_ask_proof", body: "¡Perfecto! 🙏 Para confirmar tu reserva, mandame por acá una foto del comprobante de la transferencia." },
    ];
    for (const c of casos) {
      expect(
        isDuplicateResend(prev({ matchedRule: c.rule, body: c.body }), { matchedRule: c.rule, body: c.body }, NOW),
      ).toBe(true);
    }
  });

  it("sin fila previa → NO es duplicado (primer envío)", () => {
    expect(isDuplicateResend(null, { matchedRule: "photos_sent", body: "hola" }, NOW)).toBe(false);
  });

  it("fuera de la ventana (repetición legítima horas después) → NO se suprime", () => {
    expect(
      isDuplicateResend(prev({ createdAtMs: NOW - DUP_WINDOW_MS - 1 }), { matchedRule: "photos_sent", body: "¡Claro! Te mando algunas fotos 📸" }, NOW),
    ).toBe(false);
  });

  it("distinto matched_rule → NO es duplicado (aunque el texto se parezca)", () => {
    expect(
      isDuplicateResend(prev({ matchedRule: "photos_sent" }), { matchedRule: "quote_provided", body: "¡Claro! Te mando algunas fotos 📸" }, NOW),
    ).toBe(false);
  });

  it("distinto body (otra plantilla de fotos) → NO es duplicado", () => {
    expect(
      isDuplicateResend(prev(), { matchedRule: "photos_sent", body: "¡Genial! Aquí tienes algunas fotos de Casa Brisa." }, NOW),
    ).toBe(false);
  });

  it("cuerpo vacío (fila de imagen se loggea con body='') nunca deduplica", () => {
    expect(isDuplicateResend(prev({ body: "" }), { matchedRule: "photos_sent", body: "" }, NOW)).toBe(false);
    expect(isDuplicateResend(prev({ body: "" }), { matchedRule: "photos_sent", body: "algo" }, NOW)).toBe(false);
  });

  it("iguala por trim (espacios/newline al borde no rompen la detección)", () => {
    expect(
      isDuplicateResend(prev({ body: "mismo texto" }), { matchedRule: "photos_sent", body: "mismo texto\n" }, NOW),
    ).toBe(true);
  });

  it("createdAt en el futuro (dt<0, reloj corrido) → NO suprime", () => {
    expect(
      isDuplicateResend(prev({ createdAtMs: NOW + 5_000 }), { matchedRule: "photos_sent", body: "¡Claro! Te mando algunas fotos 📸" }, NOW),
    ).toBe(false);
  });

  it("ambos matched_rule null + mismo body dentro de ventana → duplicado (escalación repetida)", () => {
    expect(
      isDuplicateResend(prev({ matchedRule: null, body: "texto" }), { matchedRule: null, body: "texto" }, NOW),
    ).toBe(true);
  });

  it("uno con rule y otro null → NO es duplicado", () => {
    expect(
      isDuplicateResend(prev({ matchedRule: null, body: "texto" }), { matchedRule: "bot_gathering_data", body: "texto" }, NOW),
    ).toBe(false);
  });
});

describe("parseSqliteUtcMs — created_at de SQLite (datetime('now'), UTC)", () => {
  it("parsea el formato 'YYYY-MM-DD HH:MM:SS' como UTC", () => {
    expect(parseSqliteUtcMs("2026-07-11 17:56:06")).toBe(Date.parse("2026-07-11T17:56:06Z"));
  });
  it("tolera un ISO ya con 'T' o zona", () => {
    expect(parseSqliteUtcMs("2026-07-11T17:56:06Z")).toBe(Date.parse("2026-07-11T17:56:06Z"));
  });
  it("null / vacío / basura → null (el caller trata null como 'sin dato' y reenvía)", () => {
    expect(parseSqliteUtcMs(null)).toBeNull();
    expect(parseSqliteUtcMs(undefined)).toBeNull();
    expect(parseSqliteUtcMs("")).toBeNull();
    expect(parseSqliteUtcMs("no-es-fecha")).toBeNull();
  });
});
