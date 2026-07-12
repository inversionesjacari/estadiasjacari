import { describe, it, expect } from "vitest";
import { classifyCatalogSend } from "../catalog-trace";

// Contexto: la tarjeta NATIVA del catálogo de WhatsApp cae al texto+fotos EN
// SILENCIO cuando no puede salir. La auditoría del bot (doc 11 §3) dejó como
// pendiente "verificar WHATSAPP_CATALOG_ID en producción" porque nadie sabía si
// las tarjetas nativas de verdad se comparten o si el fallback lo escondía.
// `classifyCatalogSend` es la decisión (queryable en bot_trace) que saca la duda.

describe("classifyCatalogSend — instrumentación de la tarjeta nativa del catálogo", () => {
  it("sin WHATSAPP_CATALOG_ID en prod → FALLBACK y NO cuenta como enviada", () => {
    const out = classifyCatalogSend({
      retailerId: "casa-brisa",
      hasCatalogId: false,
      sendOk: null,
    });
    expect(out.sent).toBe(false);
    expect(out.stage).toBe("CATALOG_CARD_FALLBACK");
    expect(out.detail).toContain("casa-brisa");
    expect(out.detail).toContain("WHATSAPP_CATALOG_ID");
  });

  it("con catalog_id y envío OK → SENT, cuenta como compartida y guarda el messageId", () => {
    const out = classifyCatalogSend({
      retailerId: "villa-b11-palma-real",
      hasCatalogId: true,
      sendOk: true,
      messageId: "wamid.ABC123",
    });
    expect(out.sent).toBe(true);
    expect(out.stage).toBe("CATALOG_CARD_SENT");
    expect(out.detail).toContain("villa-b11-palma-real");
    expect(out.detail).toContain("wamid.ABC123");
  });

  it("con catalog_id y envío OK pero sin messageId → SENT igual, detail = solo el slug", () => {
    const out = classifyCatalogSend({
      retailerId: "casa-marea",
      hasCatalogId: true,
      sendOk: true,
      messageId: null,
    });
    expect(out.sent).toBe(true);
    expect(out.stage).toBe("CATALOG_CARD_SENT");
    expect(out.detail).toBe("casa-marea");
  });

  it("con catalog_id pero sendProductMessage falló → FALLBACK con el error exacto", () => {
    const out = classifyCatalogSend({
      retailerId: "la-florida",
      hasCatalogId: true,
      sendOk: false,
      error: "(#131009) Parameter value is not valid: product not found",
    });
    expect(out.sent).toBe(false);
    expect(out.stage).toBe("CATALOG_CARD_FALLBACK");
    expect(out.detail).toContain("la-florida");
    expect(out.detail).toContain("product not found");
  });

  it("falló sin error legible → FALLBACK con motivo genérico, nunca vacío", () => {
    const out = classifyCatalogSend({
      retailerId: "las-gemelas-tela",
      hasCatalogId: true,
      sendOk: false,
      error: null,
    });
    expect(out.sent).toBe(false);
    expect(out.stage).toBe("CATALOG_CARD_FALLBACK");
    expect(out.detail).toContain("las-gemelas-tela");
    expect(out.detail).toContain("error desconocido");
  });
});
