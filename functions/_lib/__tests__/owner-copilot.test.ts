import { describe, it, expect } from "vitest";
import {
  OWNER_PHONES,
  isOwnerPhone,
  OWNER_PHONES_SQL,
  validateCopilotOutput,
  dispatchCopilotAction,
  formatOpsToday,
  formatOpsMonth,
  replyHasMoney,
  type CopilotEnv,
  type CopilotFields,
  type OpsReservationRow,
} from "../owner-copilot";

//
// MODO PROPIETARIO (2026-07-25): César + Eduardo. Esta identidad alimenta el
// reconocimiento inbound (webhook), las alertas salientes (owner-alerts) y las
// exclusiones de métricas/inbox/followups — una sola lista, cero drift.
//

describe("OWNER_PHONES — la lista canónica de dueños", () => {
  it("son exactamente César y Eduardo (confirmados 25-jul-2026)", () => {
    expect([...OWNER_PHONES]).toEqual(["50497649035", "50498035697"]);
  });
});

describe("isOwnerPhone — reconocimiento tolerante", () => {
  it("reconoce E.164 pelado, con '+' y con espacios", () => {
    expect(isOwnerPhone("50497649035")).toBe(true);
    expect(isOwnerPhone("+50498035697")).toBe(true);
    expect(isOwnerPhone("+504 9764 9035")).toBe(true);
  });
  it("NO reconoce huéspedes, vacíos ni null", () => {
    expect(isOwnerPhone("50499881234")).toBe(false);
    expect(isOwnerPhone("")).toBe(false);
    expect(isOwnerPhone(null)).toBe(false);
    expect(isOwnerPhone(undefined)).toBe(false);
  });
  it("un número que CONTIENE al de un dueño no matchea (prefijos/sufijos)", () => {
    expect(isOwnerPhone("150497649035")).toBe(false);
    expect(isOwnerPhone("504976490351")).toBe(false);
  });
});

describe("OWNER_PHONES_SQL — literal para NOT IN (...)", () => {
  it("forma exacta esperada por las queries de exclusión", () => {
    expect(OWNER_PHONES_SQL).toBe("'50497649035','50498035697'");
  });
  it("solo dígitos y comillas — nada inyectable", () => {
    expect(OWNER_PHONES_SQL).toMatch(/^'[0-9]+'(,'[0-9]+')*$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validador del esquema del LLM
// ─────────────────────────────────────────────────────────────────────────────

describe("validateCopilotOutput — el LLM solo clasifica, y hasta eso se valida", () => {
  it("acción desconocida → clarify (anotada en problems)", () => {
    const r = validateCopilotOutput({ action: "hack_the_planet" });
    expect(r.fields.action).toBe("clarify");
    expect(r.problems.join(" ")).toContain("action desconocida");
  });
  it("output no-objeto → clarify vacío", () => {
    expect(validateCopilotOutput("hola").fields.action).toBe("clarify");
    expect(validateCopilotOutput(null).fields.action).toBe("clarify");
    expect(validateCopilotOutput([1]).fields.action).toBe("clarify");
  });
  it("fechas no-ISO y slugs inventados → null", () => {
    const r = validateCopilotOutput({ action: "quote", property: "casa-inventada", checkIn: "2 de octubre", checkOut: "06/10/2026" });
    expect(r.fields.property).toBeNull();
    expect(r.fields.checkIn).toBeNull();
    expect(r.fields.checkOut).toBeNull();
  });
  it("montos fuera de rango → null (0, negativos, gigantes)", () => {
    const r = validateCopilotOutput({ action: "payment_link", amountUsd: 0, amountHnl: -50 });
    expect(r.fields.amountUsd).toBeNull();
    expect(r.fields.amountHnl).toBeNull();
    expect(validateCopilotOutput({ action: "payment_link", amountUsd: 99999 }).fields.amountUsd).toBeNull();
  });
  it("guestPhone basura → null; guestPhone válido → normalizado E.164", () => {
    expect(validateCopilotOutput({ action: "payment_link", guestPhone: "no es un tel" }).fields.guestPhone).toBeNull();
    const ok = validateCopilotOutput({ action: "payment_link", guestPhone: "+504 9988-1234" });
    expect(ok.fields.guestPhone).toBe("50499881234");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher — clarifies determinísticos (sin tocar D1/LLM)
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_ENV = {} as unknown as CopilotEnv; // los casos de clarify no tocan env

function fields(over: Partial<CopilotFields>): CopilotFields {
  return {
    action: "clarify", property: null, checkIn: null, checkOut: null,
    guests: null, adults: null, children: null, amountUsd: null,
    amountHnl: null, guestPhone: null, reply: null, ...over,
  };
}

describe("dispatchCopilotAction — pide lo que falta sin quemar LLM", () => {
  it("quote sin propiedad/fechas/personas → clarify enumerando lo que falta", async () => {
    const r = await dispatchCopilotAction(fields({ action: "quote" }), "cotizame", "2026-07-25", FAKE_ENV);
    expect(r.traceAction).toBe("quote_clarify");
    expect(r.replies[0].text).toContain("la propiedad");
    expect(r.replies[0].text).toContain("fechas");
    expect(r.replies[0].text).toContain("personas");
  });
  it("photos sin propiedad → clarify con el catálogo", async () => {
    const r = await dispatchCopilotAction(fields({ action: "photos" }), "fotos", "2026-07-25", FAKE_ENV);
    expect(r.replies[0].text).toContain("estadiasjacari.com/propiedades");
  });
  it("availability sin fechas → clarify", async () => {
    const r = await dispatchCopilotAction(fields({ action: "availability", property: "casa-brisa" }), "libre?", "2026-07-25", FAKE_ENV);
    expect(r.traceAction).toBe("avail_clarify");
  });
  it("payment_link/transfer_info todavía apagados en B4 → aviso honesto, jamás plata a medias", async () => {
    const pl = await dispatchCopilotAction(fields({ action: "payment_link" }), "link", "2026-07-25", FAKE_ENV);
    expect(pl.traceAction).toBe("payment_link_not_yet");
    const ti = await dispatchCopilotAction(fields({ action: "transfer_info" }), "cuenta", "2026-07-25", FAKE_ENV);
    expect(ti.traceAction).toBe("transfer_info_not_yet");
  });
  it("kb_answer con montos → nota interna de verificación (el LLM no manda en plata)", async () => {
    const r = await dispatchCopilotAction(
      fields({ action: "kb_answer", reply: "La noche sale L. 2,500" }), "precio?", "2026-07-25", FAKE_ENV,
    );
    expect(r.replies[0].text).toContain("verificá antes de reenviar");
  });
  it("kb_answer sin montos → limpio, sin nota", async () => {
    const r = await dispatchCopilotAction(
      fields({ action: "kb_answer", reply: "Sí, Casa Brisa tiene WiFi dual y generador." }), "wifi?", "2026-07-25", FAKE_ENV,
    );
    expect(r.replies[0].text).not.toContain("verificá");
  });
});

describe("replyHasMoney — la red anti-precio", () => {
  it("caza HNL/L./USD/$ seguidos de números", () => {
    for (const s of ["HNL 2,500", "L. 350", "L 5000", "USD 97", "$40"]) expect(replyHasMoney(s)).toBe(true);
  });
  it("no se dispara con texto normal", () => {
    for (const s of ["la casa tiene 3 cuartos", "llegan el 15", "USD es la moneda"]) expect(replyHasMoney(s)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Formatters de operación (puros)
// ─────────────────────────────────────────────────────────────────────────────

function resv(over: Partial<OpsReservationRow>): OpsReservationRow {
  return {
    property_slug: "casa-brisa", guest_name: "Ana García", guest_phone: "50499881234",
    check_in: "2026-07-25", check_out: "2026-07-27", status: "confirmed",
    source: "website", total_hnl: 5350, paid_hnl: 2675, amount_usd: null, ...over,
  };
}

describe("formatOpsToday — llegadas/salidas hoy y mañana (🔒 interno)", () => {
  it("agrupa llegadas y salidas por día, marca PENDING y Airbnb", () => {
    const out = formatOpsToday(
      [
        resv({ check_in: "2026-07-25", check_out: "2026-07-27" }),
        resv({ guest_name: "Luis", check_in: "2026-07-26", check_out: "2026-07-28", status: "pending" }),
        resv({ guest_name: "Marta", source: "airbnb", check_in: "2026-07-23", check_out: "2026-07-25" }),
      ],
      "2026-07-25",
      "2026-07-26",
    );
    expect(out).toContain("🔒 interno");
    expect(out).toContain("Llegan HOY");
    expect(out).toContain("Ana García");
    expect(out).toContain("⚠️ PENDING");
    expect(out).toContain("· Airbnb");
    expect(out).toContain("Salen HOY");
  });
  it("sin movimientos → 'nadie' en cada bloque", () => {
    const out = formatOpsToday([], "2026-07-25", "2026-07-26");
    expect(out).toContain("Llegan HOY: nadie");
    expect(out).toContain("Salen MAÑANA: nadie");
  });
});

describe("formatOpsMonth — reservas del mes agrupadas por propiedad (🔒 interno)", () => {
  it("agrupa por propiedad con nombre legible", () => {
    const out = formatOpsMonth(
      [resv({}), resv({ property_slug: "centro-morazan", guest_name: "Pedro" })],
      "julio 2026",
    );
    expect(out).toContain("2 reservas");
    expect(out).toContain("*Casa Brisa*");
    expect(out).toContain("*Centro Morazán*");
  });
  it("mes vacío → mensaje honesto", () => {
    expect(formatOpsMonth([], "julio 2026")).toContain("sin reservas");
  });
});
