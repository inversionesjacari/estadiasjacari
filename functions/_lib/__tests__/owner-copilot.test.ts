import { describe, it, expect, vi, beforeEach } from "vitest";

// Spy sobre PayPal: la garantía central de B5 es que sin un teléfono de CLIENTE
// válido (≠ dueños), createPayPalOrder NUNCA se llama — se verifica con el mock.
vi.mock("../paypal-checkout", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../paypal-checkout")>();
  return {
    ...mod,
    createPayPalOrder: vi.fn(async () => ({ ok: true, orderId: "TEST-ORDER", approvalUrl: "https://paypal.test/pay/TEST" })),
  };
});
import { createPayPalOrder } from "../paypal-checkout";

// Spy TRANSPARENTE sobre availability: por defecto delega al módulo real (los
// tests existentes no cambian: sin iCal env → verified:false), pero permite
// simular un "Airbnb marca OCUPADO" puntual con mockResolvedValueOnce.
vi.mock("../availability", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../availability")>();
  return {
    ...mod,
    checkRangeAvailable: vi.fn(mod.checkRangeAvailable),
    checkGemelasAvailable: vi.fn(mod.checkGemelasAvailable),
  };
});
import { checkRangeAvailable } from "../availability";

import {
  OWNER_PHONES,
  isOwnerPhone,
  OWNER_PHONES_SQL,
  staffPhonesFromEnv,
  isStaffPhone,
  copilotRoleFor,
  nonLeadPhonesSql,
  buildCopilotSystemPrompt,
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
  it("guests fraccionario se redondea ANTES de validar: 0.4 → null, jamás 0 (adversaria C3)", () => {
    expect(validateCopilotOutput({ action: "quote", guests: 0.4 }).fields.guests).toBeNull();
    expect(validateCopilotOutput({ action: "quote", guests: 3.6 }).fields.guests).toBe(4);
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
    const r = await dispatchCopilotAction(fields({ action: "quote" }), "cotizame", "2026-07-25", FAKE_ENV, "owner");
    expect(r.traceAction).toBe("quote_clarify");
    expect(r.replies[0].text).toContain("la propiedad");
    expect(r.replies[0].text).toContain("fechas");
    expect(r.replies[0].text).toContain("personas");
  });
  it("photos sin propiedad → clarify con el catálogo", async () => {
    const r = await dispatchCopilotAction(fields({ action: "photos" }), "fotos", "2026-07-25", FAKE_ENV, "owner");
    expect(r.replies[0].text).toContain("estadiasjacari.com/propiedades");
  });
  it("availability sin fechas → clarify", async () => {
    const r = await dispatchCopilotAction(fields({ action: "availability", property: "casa-brisa" }), "libre?", "2026-07-25", FAKE_ENV, "owner");
    expect(r.traceAction).toBe("avail_clarify");
  });
  it("payment_link sin NINGÚN dato → clarify que enumera todo (incl. teléfono del cliente)", async () => {
    const pl = await dispatchCopilotAction(fields({ action: "payment_link" }), "link", "2026-07-25", FAKE_ENV, "owner");
    expect(pl.traceAction).toBe("paylink_clarify");
    expect(pl.replies[0].text).toContain("TELÉFONO del cliente");
  });
  it("kb_answer con montos → nota interna de verificación (el LLM no manda en plata)", async () => {
    const r = await dispatchCopilotAction(
      fields({ action: "kb_answer", reply: "La noche sale L. 2,500" }), "precio?", "2026-07-25", FAKE_ENV, "owner",
    );
    expect(r.replies[0].text).toContain("verificá antes de reenviar");
  });
  it("kb_answer sin montos → limpio, sin nota", async () => {
    const r = await dispatchCopilotAction(
      fields({ action: "kb_answer", reply: "Sí, Casa Brisa tiene WiFi dual y generador." }), "wifi?", "2026-07-25", FAKE_ENV, "owner",
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

// ─────────────────────────────────────────────────────────────────────────────
// B5 — Acciones de PLATA (payment_link / transfer_info)
// ─────────────────────────────────────────────────────────────────────────────

/** D1 falso: sin reservas (cnt 0), kb_properties vacía (fallback hardcode). */
function fakeDb(conflictCnt = 0): unknown {
  const stmt = {
    bind(..._args: unknown[]) { return stmt; },
    async first() { return { cnt: conflictCnt }; },
    async all() { return { results: [] }; },
    async run() { return { meta: {} }; },
  };
  return { prepare: () => stmt };
}

const PAY_FIELDS: Partial<CopilotFields> = {
  action: "payment_link",
  property: "casa-brisa",
  checkIn: "2026-08-15",
  checkOut: "2026-08-17",
  guests: 4,
  guestPhone: "50499881234",
};

describe("payment_link — gates DUROS antes de tocar PayPal", () => {
  beforeEach(() => vi.mocked(createPayPalOrder).mockClear());

  it("SIN guestPhone → clarify pidiendo el teléfono del cliente y PayPal NUNCA se llama", async () => {
    const env = { DB: fakeDb() } as unknown as CopilotEnv;
    const r = await dispatchCopilotAction(fields({ ...PAY_FIELDS, guestPhone: null }), "link", "2026-07-25", env, "owner");
    expect(r.traceAction).toBe("paylink_clarify");
    expect(r.replies[0].text).toContain("TELÉFONO del cliente");
    expect(createPayPalOrder).not.toHaveBeenCalled();
  });

  it("guestPhone = un DUEÑO → rechazo (la reserva se atribuiría al dueño) y PayPal no se llama", async () => {
    const env = { DB: fakeDb() } as unknown as CopilotEnv;
    const r = await dispatchCopilotAction(fields({ ...PAY_FIELDS, guestPhone: "50497649035" }), "link", "2026-07-25", env, "owner");
    expect(r.traceAction).toBe("paylink_owner_phone_rejected");
    expect(createPayPalOrder).not.toHaveBeenCalled();
  });

  it("monto en HNL → rechazo con explicación (PayPal solo USD), sin llamar a PayPal", async () => {
    const env = { DB: fakeDb() } as unknown as CopilotEnv;
    const r = await dispatchCopilotAction(fields({ ...PAY_FIELDS, amountHnl: 5000 }), "link", "2026-07-25", env, "owner");
    expect(r.traceAction).toBe("paylink_hnl_rejected");
    expect(createPayPalOrder).not.toHaveBeenCalled();
  });

  it("HNL + un USD 'convertido' por el LLM → rechazo IGUAL (adversaria C4: el LLM no convierte plata)", async () => {
    const env = { DB: fakeDb() } as unknown as CopilotEnv;
    const r = await dispatchCopilotAction(fields({ ...PAY_FIELDS, amountHnl: 2500, amountUsd: 100 }), "cobrale 2500 lempiras", "2026-07-25", env, "owner");
    expect(r.traceAction).toBe("paylink_hnl_rejected");
    expect(createPayPalOrder).not.toHaveBeenCalled();
  });

  it("fechas OCUPADAS en D1 → NO se genera link (plata que habría que devolver)", async () => {
    const env = { DB: fakeDb(1) } as unknown as CopilotEnv; // conflicto
    const r = await dispatchCopilotAction(fields(PAY_FIELDS), "link", "2026-07-25", env, "owner");
    expect(r.traceAction).toBe("paylink_blocked_unavailable");
    expect(createPayPalOrder).not.toHaveBeenCalled();
  });

  it("mínimo de temporada violado → NO se genera link (Villa B11, 2 noches en morazánica)", async () => {
    const env = { DB: fakeDb() } as unknown as CopilotEnv;
    const r = await dispatchCopilotAction(
      fields({ ...PAY_FIELDS, property: "villa-b11-palma-real", checkIn: "2026-10-02", checkOut: "2026-10-04" }),
      "link", "2026-07-25", env, "owner",
    );
    expect(r.traceAction).toBe("paylink_blocked_unavailable");
    expect(r.replies[0].text).toContain("mínimo de 4 noches");
    expect(createPayPalOrder).not.toHaveBeenCalled();
  });

  it("HAPPY: todo válido → link generado, atribuido al CLIENTE, monto = depósito 50% del cotizador", async () => {
    const env = { DB: fakeDb() } as unknown as CopilotEnv;
    const r = await dispatchCopilotAction(fields(PAY_FIELDS), "link", "2026-07-25", env, "owner");
    expect(r.traceAction).toBe("paylink_ok");
    expect(createPayPalOrder).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(createPayPalOrder).mock.calls[0][0];
    expect(arg.guestPhone).toBe("50499881234"); // el CLIENTE, jamás el dueño
    // Casa Brisa 2 noches: totalUSD = 2×90+14 = 194 → depósito = ceil(194/2) = 97
    expect(arg.amountUsd).toBe(97);
    expect(r.replies[0].text).toContain("https://paypal.test/pay/TEST"); // reenviable
    expect(r.replies[1].text).toContain("🔒 interno");
    expect(r.replies[1].text).toContain("50499881234");
  });

  it("monto CUSTOM explícito → se usa ese y el interno avisa el estándar", async () => {
    const env = { DB: fakeDb() } as unknown as CopilotEnv;
    const r = await dispatchCopilotAction(fields({ ...PAY_FIELDS, amountUsd: 150 }), "link", "2026-07-25", env, "owner");
    expect(vi.mocked(createPayPalOrder).mock.calls[0][0].amountUsd).toBe(150);
    expect(r.replies[1].text).toContain("CUSTOM");
  });
});

describe("transfer_info — datos bancarios con monto", () => {
  it("monto HNL explícito → mensaje de transferencia con ese monto", async () => {
    const r = await dispatchCopilotAction(fields({ action: "transfer_info", amountHnl: 4700 }), "cuenta", "2026-07-25", FAKE_ENV, "owner");
    expect(r.traceAction).toBe("transfer_hnl_ok");
    expect(r.replies[0].text).toContain("4,700");
  });
  it("monto USD explícito → cuenta en dólares", async () => {
    const r = await dispatchCopilotAction(fields({ action: "transfer_info", amountUsd: 97 }), "cuenta usd", "2026-07-25", FAKE_ENV, "owner");
    expect(r.traceAction).toBe("transfer_usd_ok");
  });
  it("con estadía completa → depósito 50% del cotizador + nota interna", async () => {
    const env = { DB: fakeDb() } as unknown as CopilotEnv;
    const r = await dispatchCopilotAction(
      fields({ action: "transfer_info", property: "casa-brisa", checkIn: "2026-08-15", checkOut: "2026-08-17", guests: 4 }),
      "transferencia", "2026-07-25", env, "owner",
    );
    expect(r.traceAction).toBe("transfer_quote_ok");
    // Casa Brisa 2 noches: total 5,350 → depósito 2,675
    expect(r.replies[0].text).toContain("2,675");
    expect(r.replies[1].text).toContain("🔒 interno");
  });
  it("sin monto ni estadía → clarify", async () => {
    const r = await dispatchCopilotAction(fields({ action: "transfer_info" }), "cuenta", "2026-07-25", FAKE_ENV, "owner");
    expect(r.traceAction).toBe("transfer_clarify");
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

// ─────────────────────────────────────────────────────────────────────────────
// ROL STAFF (2026-08-20, entra Isaías al copiloto)
//
// La promesa: el staff usa el copiloto para VENDER (disponibilidad, tarifas,
// fichas, fotos, links de pago) pero el negocio no se le abre — ni resumen del
// mes, ni montos custom en links. Y todo link que genere, los dueños lo ven.
// La frontera vive en el DISPATCHER (código), no en el prompt.
// ─────────────────────────────────────────────────────────────────────────────

const STAFF_PHONE = "50488881111";
const ID_ENV = { STAFF_PHONES: `${STAFF_PHONE}, +504 7777-2222`, STAFF_NAME: "Isaías Rivera" };

describe("identidad staff — STAFF_PHONES desde la env var", () => {
  it("parsea lista con comas, '+' y guiones a solo dígitos", () => {
    expect(staffPhonesFromEnv(ID_ENV)).toEqual(["50488881111", "50477772222"]);
  });
  it("sin la env var no existe el rol staff (estado previo al cambio)", () => {
    expect(staffPhonesFromEnv({})).toEqual([]);
    expect(copilotRoleFor("50488881111", {})).toBeNull();
  });
  it("basura corta y duplicados se ignoran sin romper", () => {
    expect(staffPhonesFromEnv({ STAFF_PHONES: "123, 50488881111, 50488881111, ," })).toEqual(["50488881111"]);
  });
  it("un dueño listado por error como staff SIGUE siendo owner (gana el rol de más acceso para César, jamás al revés)", () => {
    const env = { STAFF_PHONES: "50497649035, 50488881111" };
    expect(staffPhonesFromEnv(env)).toEqual(["50488881111"]); // el dueño se filtra
    expect(copilotRoleFor("50497649035", env)).toBe("owner");
  });
  it("copilotRoleFor: dueño → owner, staff → staff, cliente → null", () => {
    expect(copilotRoleFor("50497649035", ID_ENV)).toBe("owner");
    expect(copilotRoleFor("+504 8888-1111", ID_ENV)).toBe("staff");
    expect(copilotRoleFor("50499881234", ID_ENV)).toBeNull();
    expect(copilotRoleFor(null, ID_ENV)).toBeNull();
  });
  it("isStaffPhone tolera '+' y espacios como isOwnerPhone", () => {
    expect(isStaffPhone("+504 8888 1111", ID_ENV)).toBe(true);
    expect(isStaffPhone("50488881111", {})).toBe(false);
  });
});

describe("nonLeadPhonesSql — dueños + staff fuera de métricas/inbox/followups", () => {
  it("sin staff = exactamente el literal de dueños de siempre (cero cambio de comportamiento)", () => {
    expect(nonLeadPhonesSql({})).toBe(OWNER_PHONES_SQL);
  });
  it("con staff los suma al literal", () => {
    expect(nonLeadPhonesSql(ID_ENV)).toBe(`${OWNER_PHONES_SQL},'50488881111','50477772222'`);
  });
  it("una env var MALICIOSA no puede inyectar SQL: todo se reduce a dígitos", () => {
    const evil = { STAFF_PHONES: "50488881111'); DROP TABLE reservations;--" };
    expect(nonLeadPhonesSql(evil)).toMatch(/^'[0-9]+'(,'[0-9]+')*$/);
  });
});

describe("prompt por rol", () => {
  it("staff: se presenta como asistente del EQUIPO, nombra a Isaías y avisa que el mes es del dueño", () => {
    const p = buildCopilotSystemPrompt("2026-08-20", "KB", "staff", "Isaías Rivera");
    expect(p).toContain("Isaías Rivera");
    expect(p).toContain("del dueño");
    expect(p).not.toContain("El que escribe es un DUEÑO");
  });
  it("owner: idéntico espíritu al de siempre (César y Eduardo)", () => {
    const p = buildCopilotSystemPrompt("2026-08-20", "KB", "owner");
    expect(p).toContain("César y Eduardo");
  });
});

describe("dispatcher con rol staff — lo permitido funciona, lo vedado se corta en código", () => {
  beforeEach(() => vi.mocked(createPayPalOrder).mockClear());
  const staffEnv = (db: unknown = fakeDb()): CopilotEnv => ({ DB: db, ...ID_ENV }) as unknown as CopilotEnv;

  it("ops_month → BLOQUEADO sin tocar la base (el resumen del mes es del dueño)", async () => {
    // FAKE_ENV vacío a propósito: si el bloqueo intentara leer D1, explotaría.
    const r = await dispatchCopilotAction(fields({ action: "ops_month" }), "cómo va el mes", "2026-08-20", { ...ID_ENV } as unknown as CopilotEnv, "staff");
    expect(r.traceAction).toBe("staff_blocked_ops_month");
    expect(r.replies[0].text).toContain("del dueño");
  });
  it("ops_month para el OWNER sigue funcionando igual", async () => {
    const r = await dispatchCopilotAction(fields({ action: "ops_month" }), "cómo va el mes", "2026-08-20", staffEnv(), "owner");
    expect(r.traceAction).toBe("ops_month_ok");
  });
  it("ops_today SÍ es del staff (coordinar llegadas es su trabajo)", async () => {
    const r = await dispatchCopilotAction(fields({ action: "ops_today" }), "quién llega hoy", "2026-08-20", staffEnv(), "staff");
    expect(r.traceAction).toBe("ops_today_ok");
  });
  it("quote staff → cotización reenviable + burbuja interna, igual que el dueño", async () => {
    const r = await dispatchCopilotAction(
      fields({ action: "quote", property: "casa-brisa", checkIn: "2026-09-15", checkOut: "2026-09-17", guests: 4 }),
      "cotizame", "2026-08-20", staffEnv(), "staff",
    );
    expect(r.traceAction).toBe("quote_ok");
    expect(r.replies[1].text).toContain("🔒 interno");
  });
  it("availability staff → responde con el veredicto interno", async () => {
    const r = await dispatchCopilotAction(
      fields({ action: "availability", property: "casa-brisa", checkIn: "2026-09-15", checkOut: "2026-09-17" }),
      "está libre?", "2026-08-20", staffEnv(), "staff",
    );
    expect(r.traceAction).toBe("avail_ok");
  });
  it("clarify staff: el menú NO ofrece 'cómo va el mes'", async () => {
    const r = await dispatchCopilotAction(fields({ action: "clarify" }), "hola", "2026-08-20", staffEnv(), "staff");
    expect(r.replies[0].text).not.toContain("mes");
    expect(r.replies[0].text).toContain("link de pago");
  });

  it("paylink staff con monto CUSTOM → RECHAZADO y PayPal jamás se llama (el monto lo fija el sistema)", async () => {
    const r = await dispatchCopilotAction(fields({ ...PAY_FIELDS, amountUsd: 20 }), "cobrale 20", "2026-08-20", staffEnv(), "staff");
    expect(r.traceAction).toBe("paylink_staff_custom_rejected");
    expect(createPayPalOrder).not.toHaveBeenCalled();
  });
  it("paylink staff estándar → link con el depósito 50% del cotizador + ALERTA compuesta para los dueños", async () => {
    const r = await dispatchCopilotAction(fields(PAY_FIELDS), "link de pago", "2026-08-20", staffEnv(), "staff");
    expect(r.traceAction).toBe("paylink_ok");
    expect(vi.mocked(createPayPalOrder).mock.calls[0][0].amountUsd).toBe(97); // depósito, no otra cosa
    expect(r.staffAlert).toBeDefined();
    expect(r.staffAlert!.tipo).toContain("link de pago");
    expect(r.staffAlert!.detalle).toContain("Isaías Rivera");
    expect(r.staffAlert!.detalle).toContain("USD 97.00");
    expect(r.staffAlert!.guestPhone).toBe("50499881234");
  });
  it("paylink del OWNER no compone alerta (la vigilancia es sobre el staff)", async () => {
    const r = await dispatchCopilotAction(fields(PAY_FIELDS), "link", "2026-08-20", staffEnv(), "owner");
    expect(r.traceAction).toBe("paylink_ok");
    expect(r.staffAlert).toBeUndefined();
  });
  it("guestPhone = teléfono del STAFF → rechazado para AMBOS roles (una reserva atribuida al equipo no le llega a nadie real)", async () => {
    for (const role of ["owner", "staff"] as const) {
      vi.mocked(createPayPalOrder).mockClear();
      const r = await dispatchCopilotAction(fields({ ...PAY_FIELDS, guestPhone: STAFF_PHONE }), "link", "2026-08-20", staffEnv(), role);
      expect(r.traceAction).toBe("paylink_staff_phone_rejected");
      expect(createPayPalOrder).not.toHaveBeenCalled();
    }
  });
  it("transfer_info staff con monto EXPLÍCITO → RECHAZADO (era el bypass del gate de PayPal — 4 lentes lo cazaron)", async () => {
    for (const extra of [{ amountHnl: 4700 }, { amountUsd: 180 }] as const) {
      const r = await dispatchCopilotAction(fields({ action: "transfer_info", ...extra }), "cuenta", "2026-08-20", staffEnv(), "staff");
      expect(r.traceAction).toBe("transfer_staff_custom_rejected");
      expect(r.replies[0].text).toContain("depósito 50%");
    }
  });
  it("transfer_info staff vía cotizador → depósito del sistema + ALERTA a los dueños (simetría con PayPal)", async () => {
    const r = await dispatchCopilotAction(
      fields({ action: "transfer_info", property: "casa-brisa", checkIn: "2026-09-15", checkOut: "2026-09-17", guests: 4 }),
      "transferencia", "2026-08-20", staffEnv(), "staff",
    );
    expect(r.traceAction).toBe("transfer_quote_ok");
    expect(r.staffAlert).toBeDefined();
    expect(r.staffAlert!.tipo).toContain("transferencia");
    expect(r.staffAlert!.detalle).toContain("Isaías Rivera");
  });
  it("transfer_info del OWNER con monto explícito sigue intacto (sin alerta)", async () => {
    const r = await dispatchCopilotAction(fields({ action: "transfer_info", amountHnl: 4700 }), "cuenta", "2026-08-20", staffEnv(), "owner");
    expect(r.traceAction).toBe("transfer_hnl_ok");
    expect(r.staffAlert).toBeUndefined();
  });
  it("transfer vía cotizador con Airbnb OCUPADO → NO se pasan los datos bancarios (espejo de paylink_blocked_airbnb; adversaria round 2)", async () => {
    vi.mocked(checkRangeAvailable).mockResolvedValueOnce({ verified: true, available: false, conflictDates: ["2026-09-15", "2026-09-16"] });
    const r = await dispatchCopilotAction(
      fields({ action: "transfer_info", property: "casa-brisa", checkIn: "2026-09-15", checkOut: "2026-09-17", guests: 4 }),
      "transferencia", "2026-08-20", staffEnv(), "owner",
    );
    expect(r.traceAction).toBe("transfer_blocked_airbnb");
    expect(r.replies[0].text).toContain("OCUPADO");
    expect(r.replies.map((x) => x.text).join(" ")).not.toContain("Cuenta"); // ni un dato bancario
  });
  it("transfer vía cotizador con iCal NO verificable → los datos salen PERO con el caveat interno", async () => {
    // El default del spy (sin iCal env) ya devuelve verified:false — camino real.
    const r = await dispatchCopilotAction(
      fields({ action: "transfer_info", property: "casa-brisa", checkIn: "2026-09-15", checkOut: "2026-09-17", guests: 4 }),
      "transferencia", "2026-08-20", staffEnv(), "owner",
    );
    expect(r.traceAction).toBe("transfer_quote_ok");
    expect(r.replies[1].text).toContain("iCal de Airbnb no verificado");
  });
  it("STAFF_PHONES separada por ESPACIOS (misconfiguración) no fabrica un teléfono fantasma de 22 dígitos", () => {
    // Sin el tope de 15, "50411112222 50433334444" se volvía UN token gigante.
    expect(staffPhonesFromEnv({ STAFF_PHONES: "50411112222 50433334444" })).toEqual([]);
  });
});
