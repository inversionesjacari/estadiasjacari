import { describe, it, expect } from "vitest";
import { cleanTranscript } from "../voice-transcribe";

//
// B6 "Notas de voz legibles" (2026-07-11). La parte con efectos (bajar el audio +
// Whisper) no se testea unitariamente; sí fijamos la limpieza del texto crudo,
// que es la que decide si una nota "cuenta" como transcripción o cae al escalado
// genérico. La regla de oro: nunca meter basura/ruido en la alerta ni en el inbox.
//

describe("cleanTranscript — texto legible o nada", () => {
  it("deja un texto normal casi igual (solo trim)", () => {
    expect(cleanTranscript("  Hola, quiero reservar Casa Brisa  ")).toBe("Hola, quiero reservar Casa Brisa");
  });

  it("colapsa saltos de línea y espacios múltiples en uno", () => {
    expect(cleanTranscript("Hola\n\n  quiero   reservar")).toBe("Hola quiero reservar");
  });

  it("null / undefined / vacío → cadena vacía (no se transcribió)", () => {
    expect(cleanTranscript(null)).toBe("");
    expect(cleanTranscript(undefined)).toBe("");
    expect(cleanTranscript("")).toBe("");
    expect(cleanTranscript("    ")).toBe("");
  });

  it("ruido de 1 carácter → vacío (no lo mandamos como si fuera una frase)", () => {
    expect(cleanTranscript("a")).toBe("");
    expect(cleanTranscript(" . ")).toBe("");
  });

  it("recorta a un tope de 1500 (una nota larguísima no inunda la alerta)", () => {
    const largo = "hola ".repeat(1000); // 5000 chars
    const out = cleanTranscript(largo);
    expect(out.length).toBe(1500);
  });
});
