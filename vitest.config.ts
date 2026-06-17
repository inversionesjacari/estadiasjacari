import { defineConfig } from "vitest/config";

// Tests unitarios PUROS del bot (detectores + parser de fechas + golden dataset).
// Solo corren sobre módulos sin dependencias "tóxicas" (D1/OpenAI/ical), que es
// justamente por qué extrajimos los detectores a functions/_lib/detectors.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["functions/**/__tests__/**/*.test.ts"],
    // El bot vive en español; los mensajes de error de los tests también pueden serlo.
    globals: false,
  },
});
