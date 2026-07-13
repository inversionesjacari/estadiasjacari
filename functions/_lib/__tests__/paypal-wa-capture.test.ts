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
  overlap?: { paypal_order_id: string; check_in: string; check_out: string } | null;
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
    const refund = makeRefund();
    const res = await handleWaCapture({ db, refund: refund.fn }, baseInput);

    expect(res.outcome).toBe("reserved");
    expect(refund.calls).toHaveLength(0);
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
    const refund = makeRefund();
    const res = await handleWaCapture(
      { db, refund: refund.fn },
      { ...baseInput, checkIn: "2026-07-12", checkOut: "2026-07-14" },
    );
    expect(res.outcome).toBe("reserved");
    expect(res.ownerAlert).not.toBeNull();
    expect(res.ownerAlert?.tipo).toContain("SAME-DAY");
    expect(res.ownerAlert?.guestPhone).toBe(baseInput.phone);
  });

  it("mensajes en inglés cuando el lead venía en inglés", async () => {
    const { db } = makeDb();
    const refund = makeRefund();
    const res = await handleWaCapture({ db, refund: refund.fn }, { ...baseInput, lang: "en" });
    expect(res.guestMessage).toContain("reserved");
    expect(res.guestMessage).toContain("full payment");
  });
});

describe("handleWaCapture — solape (A1)", () => {
  it("fechas tomadas (insert frenado por NOT EXISTS) → refund + fila 'cancelled' + disculpa + alerta", async () => {
    const { db, inserts } = makeDb({ insertChanges: [0], overlap: OVERLAP });
    const refund = makeRefund();
    const res = await handleWaCapture({ db, refund: refund.fn }, baseInput);

    expect(res.outcome).toBe("overlap_refunded");
    expect(refund.calls).toHaveLength(1);
    expect(refund.calls[0].captureId).toBe("CAP-1");
    expect(refund.calls[0].accessToken).toBe("tok-paypal");
    // 2 INSERTs: el atómico frenado + el audit trail 'cancelled' (no bloquea fechas)
    expect(inserts).toHaveLength(2);
    expect(inserts[1].sql).toContain("'cancelled'");
    expect(res.guestMessage).toContain("reembolsado");
    expect(res.ownerAlert).not.toBeNull();
    expect(res.logMessage).toContain("OVERLAP");
    expect(res.logMessage).toContain("ORD-OTRA");
  });

  it("refund FALLA → la alerta a dueños lo grita (devolver a mano)", async () => {
    const { db } = makeDb({ insertChanges: [0], overlap: OVERLAP });
    const refund = makeRefund({ ok: false, refundId: undefined, error: "422 already refunded" });
    const res = await handleWaCapture({ db, refund: refund.fn }, baseInput);
    expect(res.outcome).toBe("overlap_refunded");
    expect(res.ownerAlert?.tipo).toContain("REFUND FALLÓ");
    expect(res.logMessage).toContain("FALLÓ");
  });

  it("bloqueador desaparece entre el insert frenado y la lectura → reintenta y reserva (NO reembolsa por un conflicto que ya no existe)", async () => {
    const { db, inserts } = makeDb({ insertChanges: [0, 1], overlap: null });
    const refund = makeRefund();
    const res = await handleWaCapture({ db, refund: refund.fn }, baseInput);
    expect(res.outcome).toBe("reserved");
    expect(refund.calls).toHaveLength(0);
    expect(inserts).toHaveLength(2); // 2 intentos del atómico
  });

  it("insert frenado 2 veces sin causa identificable (D1 intermitente) → insert_failed con alerta, NUNCA refund a ciegas", async () => {
    const { db } = makeDb({ insertChanges: [0, 0], overlap: null });
    const refund = makeRefund();
    const res = await handleWaCapture({ db, refund: refund.fn }, baseInput);
    expect(res.outcome).toBe("insert_failed");
    expect(refund.calls).toHaveLength(0);
    expect(res.ownerAlert?.tipo).toContain("SIN reserva registrada");
    expect(res.guestMessage).not.toContain("reservadas");
  });
});

describe("handleWaCapture — reintentos e I/O roto", () => {
  it("orderId ya procesado (reintento de PayPal tras overlap) → duplicate: sin refund, sin mensajes, sin insert", async () => {
    const { db, inserts } = makeDb({ prior: [{ status: "cancelled" }], overlap: OVERLAP });
    const refund = makeRefund();
    const res = await handleWaCapture({ db, refund: refund.fn }, baseInput);
    expect(res.outcome).toBe("duplicate");
    expect(refund.calls).toHaveLength(0); // NUNCA doble refund en el reintento
    expect(res.guestMessage).toBeNull();
    expect(res.ownerAlert).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("carrera del MISMO orderId (OR IGNORE frenó el insert, el prior aparece en la re-lectura) → duplicate", async () => {
    const { db } = makeDb({ prior: [null, { status: "pending" }], insertChanges: [0] });
    const refund = makeRefund();
    const res = await handleWaCapture({ db, refund: refund.fn }, baseInput);
    expect(res.outcome).toBe("duplicate");
    expect(res.guestMessage).toBeNull();
    expect(refund.calls).toHaveLength(0);
  });

  it("INSERT lanza (D1 caída) → insert_failed: NO afirma 'reservado', alerta 🔴 a dueños", async () => {
    const { db } = makeDb({ insertThrows: true });
    const refund = makeRefund();
    const res = await handleWaCapture({ db, refund: refund.fn }, baseInput);
    expect(res.outcome).toBe("insert_failed");
    expect(res.guestMessage).not.toContain("reservadas"); // nada de confirmación en falso
    expect(res.guestMessage).toContain("Pago recibido");
    expect(res.ownerAlert?.tipo).toContain("SIN reserva registrada");
  });

  it("lectura de solape FALLA con insert frenado → reintenta y luego insert_failed (fail-safe: ni reserva en falso ni refund a ciegas)", async () => {
    const { db } = makeDb({ insertChanges: [0, 0], overlapThrows: true });
    const refund = makeRefund();
    const res = await handleWaCapture({ db, refund: refund.fn }, baseInput);
    expect(res.outcome).toBe("insert_failed");
    expect(refund.calls).toHaveLength(0);
    expect(res.ownerAlert).not.toBeNull();
  });
});
