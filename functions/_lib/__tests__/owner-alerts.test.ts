import { describe, it, expect } from "vitest";
import { buildAlertComponents } from "../owner-alerts";
import { severityPrefix, shouldPingOwner, guestSignalsCritical } from "../whatsapp-escalation";

//
// B8 "Las alertas mudas" (2026-07-11) — César reportó que los WhatsApp de
// escalación no llegan pese a que el template `alerta_jacari` está APROBADO.
// La causa de que nadie lo supiera: notifyOwners descartaba la respuesta de
// Meta. Estos tests fijan la parte PURA del canal: la estructura del payload
// debe calzar EXACTO con el template aprobado (3 parámetros de body + 1 botón
// URL dinámico) — si alguien la cambia, Meta rechaza con 4xx y el canal muere.
//

type BodyComponent = { type: string; parameters: Array<{ type: string; text: string }> };
type ButtonComponent = { type: string; sub_type: string; index: string; parameters: Array<{ type: string; text: string }> };

describe("buildAlertComponents — el payload calza con el template alerta_jacari aprobado", () => {
  const base = { tipo: "Reportó pago, verificá", cliente: "Ana García - +504 99881234", detalle: "Listo, ya hice el pago", guestPhone: "50499881234" };

  it("3 parámetros de body en orden (tipo, cliente, detalle) + 1 botón URL index 0", () => {
    const comps = buildAlertComponents(base) as [BodyComponent, ButtonComponent];
    expect(comps).toHaveLength(2);
    expect(comps[0].type).toBe("body");
    expect(comps[0].parameters.map((p) => p.text)).toEqual([
      "Reportó pago, verificá",
      "Ana García - +504 99881234",
      "Listo, ya hice el pago",
    ]);
    expect(comps[1]).toMatchObject({ type: "button", sub_type: "url", index: "0" });
    expect(comps[1].parameters[0].text).toBe("50499881234");
  });

  it("trunca a los límites de Meta (120/120/250) — un detalle largo no tumba el envío", () => {
    const comps = buildAlertComponents({
      ...base,
      tipo: "x".repeat(300),
      cliente: "y".repeat(300),
      detalle: "z".repeat(600),
    }) as [BodyComponent, ButtonComponent];
    const [t, c, d] = comps[0].parameters.map((p) => p.text);
    expect(t).toHaveLength(120);
    expect(c).toHaveLength(120);
    expect(d).toHaveLength(250);
  });

  it("NUNCA manda parámetros vacíos (Meta los rechaza): campos vacíos → placeholder", () => {
    // Caso real: el watchdog alerta sin cliente (guestPhone "") — el botón URL
    // con parámetro vacío haría que Meta rechace TODA la alerta del sistema.
    const comps = buildAlertComponents({ tipo: "", cliente: "", detalle: "", guestPhone: "" }) as [BodyComponent, ButtonComponent];
    for (const p of comps[0].parameters) {
      expect(p.text.length).toBeGreaterThan(0);
    }
    expect(comps[1].parameters[0].text).toBe("0"); // /inbox?c=0 → abre el inbox general
  });
});

describe("severityPrefix — el asunto del email distingue plata de ruido", () => {
  it("🔴 cuando hay plata en la mano (pago / comprobante / transferencia)", () => {
    expect(severityPrefix("💳 Comprobante de transferencia para verificar")).toBe("🔴");
    expect(severityPrefix("Reportó pago, verificá")).toBe("🔴");
  });
  it("🟠 cuando un humano tiene que atender (escalado, evento, largo plazo, LLM caído)", () => {
    expect(severityPrefix("El huésped pidió hablar con un humano")).toBe("🟠");
    expect(severityPrefix("🎉 Lead de EVENTO (Valle de Ángeles) — el bot le preguntó tipo/fecha/personas")).toBe("🟠");
    expect(severityPrefix("Renta a LARGO PLAZO (estadía de un mes o más)")).toBe("🟠");
    expect(severityPrefix("⚠️ El bot intentó recuperarse varias veces pero el LLM (Workers AI) sigue sin responder. El cliente quedó sin respuesta")).toBe("🟠");
  });
  it("⚪ para lo informativo", () => {
    expect(severityPrefix("Mensaje desde un número sin reserva activa")).toBe("⚪");
  });
});

//
// "Menos alertas" (César, 2026-07-12): el teléfono solo debe sonar (ping de
// WhatsApp) para lo estrictamente necesario. El email sigue saliendo para todo;
// shouldPingOwner es el filtro del ping.
//
describe("shouldPingOwner — el teléfono solo suena para lo estrictamente necesario", () => {
  it("PINGA plata en juego (pago reportado / comprobante a verificar)", () => {
    expect(shouldPingOwner("💳 Comprobante de transferencia para verificar")).toBe(true);
    expect(shouldPingOwner("Reportó pago, verificá")).toBe(true);
    expect(shouldPingOwner("Quote flow: payment_reported — Cliente quiere reservar / mandar link de pago")).toBe(true);
  });

  it("PINGA cuando esperan a un humano (pidió hablar, evento, largo plazo, bot caído)", () => {
    expect(shouldPingOwner("El huésped pidió hablar con un humano")).toBe(true);
    expect(shouldPingOwner("Huésped existente pidiendo soporte de su estadía")).toBe(true);
    expect(shouldPingOwner("🎉 Lead de EVENTO (Valle de Ángeles)")).toBe(true);
    expect(shouldPingOwner("Renta a LARGO PLAZO (estadía de un mes o más)")).toBe(true);
  });

  it("NO pinga media suelta (foto, nota de voz, sticker, documento, contacto)", () => {
    expect(shouldPingOwner("El cliente mandó 📷 Imagen — míralo en el inbox")).toBe(false);
    expect(shouldPingOwner("El cliente mandó una nota de voz (transcrita abajo) — respondele", '🎤 Nota de voz: "hola, mil gracias, buenísimo, nos vemos"')).toBe(false);
    expect(shouldPingOwner("El cliente mandó 🌟 Sticker — míralo en el inbox")).toBe(false);
    expect(shouldPingOwner("El cliente compartió un contacto — míralo en el inbox")).toBe(false);
  });

  it("NO pinga cuando el bot solo no matcheó una regla / info sin acción", () => {
    expect(shouldPingOwner("Bot no pudo matchear ninguna regla")).toBe(false);
    expect(shouldPingOwner("Mensaje desde un número sin reserva activa")).toBe(false);
  });

  it("RED DE SEGURIDAD: una nota de voz que PIDE humano o AVISA pago sí pinga", () => {
    // aunque la razón del sistema sea genérica ("mandó nota de voz"), el CONTENIDO manda.
    expect(shouldPingOwner("El cliente mandó una nota de voz — respondele", '🎤 Nota de voz: "hola, quiero que me llamen por favor, es urgente"')).toBe(true);
    expect(shouldPingOwner("El cliente mandó 📷 Imagen — míralo en el inbox", "aquí está mi comprobante, ya deposité el total")).toBe(true);
  });
});

describe("guestSignalsCritical — detecta pago/pedido-de-humano en el texto del huésped", () => {
  it("detecta pago en varias formas (incl. HN 'cancelé'/'aboné' = pagar)", () => {
    for (const s of ["ya pagué", "hice el pago", "voy a pagar", "está pagado", "ya deposité", "te mando el comprobante", "adjunto comprobante", "ya cancelé el total", "cancele el pago", "ya aboné el saldo", "abono 500"]) {
      expect(guestSignalsCritical(s)).toBe(true);
    }
  });
  it("detecta pedido de humano/llamada (incl. formas que solo cachan los detectores)", () => {
    for (const s of ["quiero que me llamen", "me pueden llamar?", "¿podrían llamarme?", "me podrian llamar", "necesito hablar con alguien", "quiero hablar con una persona", "es urgente", "necesito un asesor", "quiero una persona real"]) {
      expect(guestSignalsCritical(s)).toBe(true);
    }
  });
  it("NO se dispara con charla normal", () => {
    for (const s of ["hola buenas", "gracias, nos vemos", "qué lindo lugar", "", "🎤 Nota de voz: \"perfecto, ahí llego\""]) {
      expect(guestSignalsCritical(s)).toBe(false);
    }
  });
  // Falsos positivos que la revisión adversaria cazó: NO deben sonar (reintroducían ruido).
  it("NO confunde 'llam-' de presentarse/nombrar con un pedido de llamada", () => {
    for (const s of ["hola, me llamo Ana", "¿cómo se llama la propiedad?", "qué lugar tan llamativo", "me llamo Carlos y quiero info"]) {
      expect(guestSignalsCritical(s)).toBe(false);
    }
  });
  it("NO confunde el verbo 'recibir' con un recibo de pago", () => {
    expect(guestSignalsCritical("¿a qué hora recibo las llaves?")).toBe(false);
  });
  it("NO confunde 'cancelar una reserva' (infinitivo) con pagar", () => {
    expect(guestSignalsCritical("quiero cancelar mi reserva")).toBe(false);
  });
});
