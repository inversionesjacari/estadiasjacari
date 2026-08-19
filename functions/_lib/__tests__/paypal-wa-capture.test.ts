import { describe, expect, it } from "vitest";
import { handleWaCapture, type WaCaptureInput } from "../paypal-wa-capture";
import type { PayPalRefundParams, PayPalRefundResult } from "../paypal-refund";

// Auditoría 2026-07-12 (A1/A2): la rama PayPal del bot confirmaba reservas SIN
// chequear solape y con solo el depósito pagado. Estos tests fijan la política:
// el INSERT es atómico (WHERE NOT EXISTS de solape en la misma sentencia — sin
// ventana TOCTOU); solape → refund + disculpa + alerta; depósito → 'pending'
// (check-in gateado al pago total); reintentos → ni doble refund ni doble mensaje.

/** Stub mínimo de D1 que rutea por el SQL y graba los INSERT (patrón wa-log.test).
 *  `prior` e `insertChanges` aceptan listas para simular secuencias (carreras). */
function makeDb(opts: {
  prior?: Array<{ status: string } | null>;
  overlap?: { paypal_order_id: string; check_in: string; check_out: string; guest_phone_normalized?: string | null } | null;
  overlapThrows?: boolean;
  insertChanges?: number[];
  insertThrows?: boolean;
} = {}) {
  const inserts: { sql: string; binds: unknown[] }[] = [];
  const priorQueue = [...(opts.prior ?? [])];
  const changesQueue = [...(opts.insertChanges ?? [])];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              if (sql.includes("SELECT status FROM reservations")) {
                return priorQueue.length > 0 ? priorQueue.shift() : null;
              }
              if (sql.includes("SELECT paypal_order_id, check_in, check_out")) {
                if (opts.overlapThrows) throw new Error("D1 boom");
                return opts.overlap ?? null;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO reservations")) {
                if (opts.insertThrows) throw new Error("D1 insert boom");
                inserts.push({ sql, binds });
                // El INSERT de auditoría 'cancelled' siempre aplica; el atómico
                // de 'pending' consume la cola (default: 1 = insertó).
                if (sql.includes("'cancelled'")) return { meta: { changes: 1 } };
                const changes = changesQueue.length > 0 ? changesQueue.shift()! : 1;
                return { meta: { changes } };
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, inserts };
}

function makeRefund(result: Partial<PayPalRefundResult> = {}) {
  const calls: PayPalRefundParams[] = [];
  const fn = async (args: PayPalRefundParams): Promise<PayPalRefundResult> => {
    calls.push(args);
    return { ok: true, refundId: "RF-1", status: "COMPLETED", ...result };
  };
  return { fn, calls };
}

const baseInput: WaCaptureInput = {
  phone: "50499990000",
  propertySlug: "casa-brisa",
  propertyName: "Casa Brisa",
  checkIn: "2026-08-15",
  checkOut: "2026-08-17",
  guests: 4,
  orderId: "ORD-1",
  captureId: "CAP-1",
  amountUsd: 90,
  guestName: "Ana López",
  guestEmail: "ana@x.com",
  rawBody: "{}",
  accessToken: "tok-paypal",
  todayIso: "2026-07-12",
  lang: "es",
};

const OVERLAP = { paypal_order_id: "ORD-OTRA", check_in: "2026-08-14", check_out: "2026-08-16" };

describe("handleWaCapture — depósito sin conflicto", () => {
  it("fechas libres → reserva 'pending' (NO 'confirmed'), INSERT atómico con NOT EXISTS, sin refund", async () => {
    const { db, inserts } = makeDb();
    const res = await handleWaCapture({ db }, baseInput);

    expect(res.outcome).toBe("reserved");
    expect(inserts).toHaveLength(1);
    // A2: el depósito nace 'pending' (el par source/status va hardcodeado en el
    // SELECT del INSERT; el 'confirmed' que sí aparece en el SQL es el del
    // filtro NOT EXISTS, no el valor insertado)
    expect(inserts[0].sql).toContain("'whatsapp_bot', 'pending'");
    expect(inserts[0].sql).not.toContain("'whatsapp_bot', 'confirmed'");
    // A1: el chequeo de solape vive DENTRO de la misma sentencia (atómico)
    expect(inserts[0].sql).toContain("WHERE NOT EXISTS");
    expect(inserts[0].sql).toContain("status IN ('pending', 'confirmed')");
    // Mensaje alineado a la política: totalidad del pago, ya no "un día antes"
    expect(res.guestMessage).toContain("reservadas");
    expect(res.guestMessage).toContain("totalidad del pago");
    expect(res.guestMessage).not.toContain("Un día antes");
    // Llegada futura: sin alerta a dueños (la cola + el cron T-1 la cubren)
    expect(res.ownerAlert).toBeNull();
  });

  it("llegada SAME-DAY → reserva 'pending' + alerta a dueños para coordinar", async () => {
    const { db } = makeDb();
    const res = await handleWaCapture(
      { db },
      { ...baseInput, checkIn: "2026-07-12", checkOut: "2026-07-14" },
    );
    expect(res.outcome).toBe("reserved");
    expect(res.ownerAlert).not.toBeNull();
    expect(res.ownerAlert?.tipo).toContain("SAME-DAY");
    expect(res.ownerAlert?.guestPhone).toBe(baseInput.phone);
  });

  it("mensajes en inglés cuando el lead venía en inglés", async () => {
    const { db } = makeDb();
    const res = await handleWaCapture({ db }, { ...baseInput, lang: "en" });
    expect(res.guestMessage).toContain("reserved");
    expect(res.guestMessage).toContain("full payment");
  });
});

describe("handleWaCapture — solape (A1)", () => {
  //
  // REGLA DE CÉSAR (2026-08-19, después de perder USD 97 así): NINGÚN reembolso
  // automático. El caso que lo destapó no era ni una doble venta — el equipo
  // había cargado a mano la reserva del MISMO huésped, el pago entró después y
  // el guard le devolvió el depósito solo. Devolver plata la decide una persona.
  //
  it("fechas tomadas → la plata SE QUEDA: fila 'pending' con la nota del conflicto + alerta, SIN reembolso", async () => {
    const { db, inserts } = makeDb({ insertChanges: [0], overlap: OVERLAP });
    const res = await handleWaCapture({ db }, baseInput);

    expect(res.outcome).toBe("overlap_held");
    // La fila entra como 'pending' (la plata TIENE que quedar visible en el
    // registro), no como 'cancelled' — que la escondía del inbox.
    expect(inserts).toHaveLength(2);
    expect(inserts[1].sql).toContain("'pending'");
    expect(inserts[1].sql).not.toContain("'cancelled'");
    // Nada de prometerle al huésped un reembolso que nadie hizo.
    expect(res.guestMessage ?? "").not.toMatch(/reembols/i);
    expect(res.ownerAlert?.tipo).toContain("FECHAS OCUPADAS");
    expect(res.logMessage).toContain("SIN reembolso automático");
  });

  it("el conflicto es con una reserva del MISMO huésped → lo dice (carga manual duplicada), tampoco reembolsa", async () => {
    const { db } = makeDb({
      insertChanges: [0],
      overlap: { ...OVERLAP, guest_phone_normalized: baseInput.phone },
    });
    const res = await handleWaCapture({ db }, baseInput);

    expect(res.outcome).toBe("overlap_held");
    expect(res.ownerAlert?.tipo).toContain("duplicado");
    expect(res.ownerAlert?.detalle).toContain("cargada a mano");
    expect(res.logMessage).toContain("MISMO huésped");
    expect(res.guestMessage ?? "").not.toMatch(/reembols/i);
  });

  it("bloqueador desaparece entre el insert frenado y la lectura → reintenta y reserva (NO reembolsa por un conflicto que ya no existe)", async () => {
    const { db, inserts } = makeDb({ insertChanges: [0, 1], overlap: null });
    const res = await handleWaCapture({ db }, baseInput);
    expect(res.outcome).toBe("reserved");
    expect(inserts).toHaveLength(2); // 2 intentos del atómico
  });

  it("insert frenado 2 veces sin causa identificable (D1 intermitente) → insert_failed con alerta, NUNCA refund a ciegas", async () => {
    const { db } = makeDb({ insertChanges: [0, 0], overlap: null });
    const res = await handleWaCapture({ db }, baseInput);
    expect(res.outcome).toBe("insert_failed");
    expect(res.ownerAlert?.tipo).toContain("SIN reserva registrada");
    expect(res.guestMessage).not.toContain("reservadas");
  });
});

describe("handleWaCapture — reintentos e I/O roto", () => {
  it("orderId ya procesado (reintento de PayPal tras overlap) → duplicate: sin refund, sin mensajes, sin insert", async () => {
    const { db, inserts } = makeDb({ prior: [{ status: "cancelled" }], overlap: OVERLAP });
    const res = await handleWaCapture({ db }, baseInput);
    expect(res.outcome).toBe("duplicate");
    expect(res.guestMessage).toBeNull();
    expect(res.ownerAlert).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("carrera del MISMO orderId (OR IGNORE frenó el insert, el prior aparece en la re-lectura) → duplicate", async () => {
    const { db } = makeDb({ prior: [null, { status: "pending" }], insertChanges: [0] });
    const res = await handleWaCapture({ db }, baseInput);
    expect(res.outcome).toBe("duplicate");
    expect(res.guestMessage).toBeNull();
  });

  it("INSERT lanza (D1 caída) → insert_failed: NO afirma 'reservado', alerta 🔴 a dueños", async () => {
    const { db } = makeDb({ insertThrows: true });
    const res = await handleWaCapture({ db }, baseInput);
    expect(res.outcome).toBe("insert_failed");
    expect(res.guestMessage).not.toContain("reservadas"); // nada de confirmación en falso
    expect(res.guestMessage).toContain("Pago recibido");
    expect(res.ownerAlert?.tipo).toContain("SIN reserva registrada");
  });

  it("lectura de solape FALLA con insert frenado → reintenta y luego insert_failed (fail-safe: ni reserva en falso ni refund a ciegas)", async () => {
    const { db } = makeDb({ insertChanges: [0, 0], overlapThrows: true });
    const res = await handleWaCapture({ db }, baseInput);
    expect(res.outcome).toBe("insert_failed");
    expect(res.ownerAlert).not.toBeNull();
  });
});

describe("handleWaCapture — cruce del combo Las Gemelas (slugs expandidos, GEMELAS-XBLOCK)", () => {
  // El NOT EXISTS por slug EXACTO dejaba pasar la doble venta cruzada: una
  // reserva de las-gemelas-tela no frenaba el pago de casa-marea ni al revés.
  it("pago del combo las-gemelas-tela → el NOT EXISTS mira también casa-brisa y casa-marea", async () => {
    const { db, inserts } = makeDb();
    const res = await handleWaCapture(
      { db },
      { ...baseInput, propertySlug: "las-gemelas-tela", propertyName: "Las Gemelas de Tela" },
    );
    expect(res.outcome).toBe("reserved");
    expect(inserts[0].sql).toContain("property_slug IN (?, ?, ?)");
    expect(inserts[0].binds).toContain("casa-brisa");
    expect(inserts[0].binds).toContain("casa-marea");
  });

  it("pago de casa-marea → el NOT EXISTS mira también el combo (marea bloquea gemelas y viceversa)", async () => {
    const { db, inserts } = makeDb();
    await handleWaCapture(
      { db },
      { ...baseInput, propertySlug: "casa-marea", propertyName: "Casa Marea" },
    );
    expect(inserts[0].sql).toContain("property_slug IN (?, ?)");
    expect(inserts[0].binds).toContain("las-gemelas-tela");
  });

  it("pago de casa-brisa NO consulta casa-marea (casas separadas: brisa no bloquea marea)", async () => {
    const { db, inserts } = makeDb();
    await handleWaCapture({ db }, baseInput); // baseInput = casa-brisa
    expect(inserts[0].sql).toContain("property_slug IN (?, ?)");
    expect(inserts[0].binds).toContain("las-gemelas-tela");
    expect(inserts[0].binds).not.toContain("casa-marea");
  });
});
