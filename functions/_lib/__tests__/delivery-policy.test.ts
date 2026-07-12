import { describe, expect, it } from "vitest";
import {
  classifyFailedRule,
  metaCodeLabel,
  parseWaFailTrace,
} from "../delivery-policy";

describe("parseWaFailTrace — formato real del webhook (handleStatusUpdate)", () => {
  it("parsea el caso real de billing 131042 (capturado en producción 11-jul)", () => {
    const detail =
      "wamid=wamid.HBgLNTA0OTgwMzU2OTcVAgARGBI1MDZGOUIwREYxOTEzMDkzNTcA to=50498035697 code=131042 Business eligibility payment issue :: Message failed to send because your WhatsApp Business account currency is not configured.";
    const p = parseWaFailTrace(detail);
    expect(p.wamid).toBe("wamid.HBgLNTA0OTgwMzU2OTcVAgARGBI1MDZGOUIwREYxOTEzMDkzNTcA");
    expect(p.to).toBe("50498035697");
    expect(p.code).toBe(131042);
    expect(p.title).toBe("Business eligibility payment issue");
    expect(p.rest).toContain("currency is not configured");
  });

  it("parsea re-engagement 131047 con detalle", () => {
    const p = parseWaFailTrace(
      "wamid=wamid.ABC to=50499999999 code=131047 Re-engagement message :: Message failed to send because more than 24 hours have passed",
    );
    expect(p.code).toBe(131047);
    expect(p.title).toBe("Re-engagement message");
  });

  it("tolera campos '?' (el webhook los pone cuando faltan) y detail truncado", () => {
    const p = parseWaFailTrace("wamid=? to=? code=? ::");
    expect(p.wamid).toBeNull();
    expect(p.to).toBeNull();
    expect(p.code).toBeNull();
    // Truncado a 500 en medio del detalle: no lanza, conserva lo que hay.
    const long =
      "wamid=wamid.X to=50411111111 code=131026 Undeliverable :: " + "x".repeat(600);
    const t = parseWaFailTrace(long.slice(0, 500));
    expect(t.code).toBe(131026);
    expect(t.title).toBe("Undeliverable");
    expect(t.rest.length).toBeGreaterThan(0);
  });

  it("null/undefined/vacío → objeto vacío sin lanzar", () => {
    for (const v of [null, undefined, ""]) {
      const p = parseWaFailTrace(v);
      expect(p).toEqual({ wamid: null, to: null, code: null, title: "", rest: "" });
    }
  });

  it("sin separador ' :: ' — todo despues del code queda como título", () => {
    const p = parseWaFailTrace("wamid=wamid.Y to=50422222222 code=100 Invalid parameter");
    expect(p.code).toBe(100);
    expect(p.title).toBe("Invalid parameter");
    expect(p.rest).toBe("");
  });
});

describe("metaCodeLabel — etiquetas humanas", () => {
  it("mapea los códigos conocidos del negocio", () => {
    expect(metaCodeLabel(131047)).toMatch(/24h/);
    expect(metaCodeLabel(131026)).toMatch(/[Nn]o entregable/);
    expect(metaCodeLabel(131042)).toMatch(/facturaci/);
    expect(metaCodeLabel(131048)).toMatch(/spam/);
    expect(metaCodeLabel(132012)).toMatch(/template/i);
    expect(metaCodeLabel(132015)).toMatch(/pausado|deshabilitado/);
    expect(metaCodeLabel(132000)).toMatch(/inexistente|no aprobado/);
    expect(metaCodeLabel(100)).toMatch(/inválido/);
  });

  it("default deja el código visible; null/undefined dicen sin código", () => {
    expect(metaCodeLabel(999999)).toContain("999999");
    expect(metaCodeLabel(null)).toMatch(/sin código/);
    expect(metaCodeLabel(undefined)).toMatch(/sin código/);
  });
});

describe("classifyFailedRule — política de alerta", () => {
  it("operativos al huésped → guest_operational (alerta SIEMPRE)", () => {
    expect(classifyFailedRule("checkin_reminder")).toBe("guest_operational");
    expect(classifyFailedRule("tpl_confirmacion_whatsapp_capturado")).toBe("guest_operational");
    expect(classifyFailedRule("tpl_checkin_dia_huesped")).toBe("guest_operational");
  });

  it("staff → staff_operational", () => {
    expect(classifyFailedRule("tpl_checkin_dia_limpieza")).toBe("staff_operational");
    expect(classifyFailedRule("tpl_checkin_dia_seguridad")).toBe("staff_operational");
  });

  it("followups/last_call/manual → reengagement (NO alertan solos)", () => {
    expect(classifyFailedRule("auto_followup")).toBe("reengagement");
    expect(classifyFailedRule("last_call")).toBe("reengagement");
    expect(classifyFailedRule("manual_inbox")).toBe("reengagement");
  });

  it("reglas del bot conversacional y null → other", () => {
    expect(classifyFailedRule("quote_provided")).toBe("other");
    expect(classifyFailedRule("bot_gathering_data")).toBe("other");
    expect(classifyFailedRule(null)).toBe("other");
    expect(classifyFailedRule(undefined)).toBe("other");
  });
});
