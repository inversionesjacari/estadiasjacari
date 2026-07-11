import { describe, it, expect } from "vitest";
import { buildAlertComponents } from "../owner-alerts";
import { severityPrefix } from "../whatsapp-escalation";

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
