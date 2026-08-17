import { describe, expect, it } from "vitest";
import {
  buildCancelAlert,
  buildCancelVariants,
  buildRestoreVariants,
  deriveRestoreStatus,
  moneyLine,
  tryUpdate,
  type RestoreRow,
} from "../reservation-cancel";

//
// reservation-cancel: cancelar libera fechas (status='cancelled') sin reembolsar;
// reactivar (undo) vuelve al estado correcto.
//
// El camino normal preserva el estado EXACTO previo a la cancelación
// (cancel_prev_status, schema 0045). deriveRestoreStatus es SOLO el fallback para
// filas canceladas antes de esa columna: sigue el mismo criterio de "pago" que
// paymentInfo del resto del sistema. Estos tests fijan ese fallback.
//   - Libro LPS (total_hnl): confirmed solo si paid_hnl >= total_hnl.
//   - Fuente confirmada-al-capturar (website/airbnb/airbnb_ical): confirmed.
//   - whatsapp_bot (depósito 50%), transferencia, manual: pending.
//

const r = (over: Partial<RestoreRow> = {}): RestoreRow => ({
  source: "manual",
  total_hnl: null,
  paid_hnl: null,
  amount_usd: null,
  ...over,
});

describe("deriveRestoreStatus — fallback de reactivación (filas sin cancel_prev_status)", () => {
  it("libro LPS pagado completo → confirmed", () => {
    expect(deriveRestoreStatus(r({ total_hnl: 5000, paid_hnl: 5000 }))).toBe("confirmed");
    expect(deriveRestoreStatus(r({ total_hnl: 5000, paid_hnl: 6000 }))).toBe("confirmed"); // pagó de más
  });

  it("libro LPS con depósito o sin pago → pending (falta el saldo)", () => {
    expect(deriveRestoreStatus(r({ total_hnl: 5000, paid_hnl: 2500 }))).toBe("pending");
    expect(deriveRestoreStatus(r({ total_hnl: 5000, paid_hnl: 0 }))).toBe("pending");
    expect(deriveRestoreStatus(r({ total_hnl: 5000, paid_hnl: null }))).toBe("pending");
  });

  it("el libro LPS MANDA aunque haya amount_usd (no lo confundas con PayPal)", () => {
    // total_hnl presente pero impago: pending, aunque venga con un amount_usd viejo.
    expect(deriveRestoreStatus(r({ total_hnl: 5000, paid_hnl: 1000, amount_usd: 200, source: "website" }))).toBe("pending");
  });

  it("fuente confirmada-al-capturar sin libro LPS → confirmed (aunque falte amount_usd)", () => {
    // Airbnb sin monto (amount_usd NULL) es un estado real: se guarda 'confirmed'.
    // No degradarla a pending o aparecería impaga y retendría las instrucciones.
    expect(deriveRestoreStatus(r({ source: "website", amount_usd: 97 }))).toBe("confirmed");
    expect(deriveRestoreStatus(r({ source: "website", amount_usd: null }))).toBe("confirmed");
    expect(deriveRestoreStatus(r({ source: "airbnb", amount_usd: null, total_hnl: null }))).toBe("confirmed");
    expect(deriveRestoreStatus(r({ source: "airbnb_ical", amount_usd: null }))).toBe("confirmed");
  });

  it("whatsapp_bot (depósito 50%) NO es pago total → pending", () => {
    // El bot solo cobra el depósito; tratarlo como pagado liberaría las
    // instrucciones sin cobrar el saldo. Sin total_hnl, cae a pending.
    expect(deriveRestoreStatus(r({ source: "whatsapp_bot", amount_usd: 120 }))).toBe("pending");
  });

  it("transferencia/manual SIN libro LPS → pending (no afirmar pagado)", () => {
    expect(deriveRestoreStatus(r({ source: "whatsapp_transfer", amount_usd: 100 }))).toBe("pending");
    expect(deriveRestoreStatus(r({ source: "manual" }))).toBe("pending");
  });
});

//
// tryUpdate — el que hace que CANCELAR funcione aunque la migración 0045 esté a
// medias. La ventana es real: el push despliega el código en minutos, pero los
// ALTER los pega César a mano en la consola D1 (y `cancelled_by` llegó una
// semana después que las otras tres). Cada nivel pide menos columnas y lleva SUS
// PROPIOS binds — el conteo de '?' cambia entre niveles, y un desajuste ahí
// rompe el cancelar en producción.
//

/** D1 falso: falla con "no such column" para las columnas que NO existen. */
function makeDb(existing: Set<string>) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async run() {
              calls.push({ sql, binds });
              const missing = ["cancelled_by", "cancel_prev_status", "cancelled_at", "cancel_reason"]
                .filter((c) => sql.includes(c) && !existing.has(c));
              if (missing.length > 0) throw new Error(`D1_ERROR: no such column: ${missing[0]}`);
              // Chequeo de contrato: tantos binds como '?' tenga el SQL.
              const holes = (sql.match(/\?/g) ?? []).length;
              if (holes !== binds.length) throw new Error(`binds ${binds.length} != '?' ${holes}`);
              return { meta: { changes: 1 } } as unknown as D1Result;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

const ALL = new Set(["cancelled_by", "cancel_prev_status", "cancelled_at", "cancel_reason"]);

describe("tryUpdate — cancelar sobrevive a una migración a medias", () => {
  it("con TODAS las columnas: usa el nivel 1 (firma quién canceló) y no reintenta", async () => {
    const { db, calls } = makeDb(ALL);
    const res = await tryUpdate(db, buildCancelVariants("no-show", "Isaías Rivera", 7));
    expect(res.meta?.changes).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("cancelled_by");
    expect(calls[0].binds).toEqual(["no-show", "Isaías Rivera", 7]);
  });

  it("sin `cancelled_by` (ALTER pendiente): baja al nivel 2 y conserva motivo y fecha", async () => {
    const existing = new Set(ALL); existing.delete("cancelled_by");
    const { db, calls } = makeDb(existing);
    const res = await tryUpdate(db, buildCancelVariants("no-show", "Isaías Rivera", 7));
    expect(res.meta?.changes).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].sql).not.toContain("cancelled_by");
    expect(calls[1].sql).toContain("cancel_prev_status");
    expect(calls[1].binds).toEqual(["no-show", 7]); // sin actor: 2 binds, 2 '?'
  });

  it("sin NINGUNA columna nueva: cae al nivel 3 y IGUAL cancela (libera las fechas)", async () => {
    const { db, calls } = makeDb(new Set());
    const res = await tryUpdate(db, buildCancelVariants("no-show", "Isaías Rivera", 7));
    expect(res.meta?.changes).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls[2].sql).toContain("status = 'cancelled'");
    expect(calls[2].binds).toEqual([7]);
  });

  it("un error que NO es de columna se propaga (no se disfraza bajando de nivel)", async () => {
    const db = {
      prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1_ERROR: database is locked"); } }) }),
    } as unknown as D1Database;
    await expect(tryUpdate(db, buildCancelVariants(null, null, 7))).rejects.toThrow("database is locked");
  });
});

//
// Aviso a los socios (César + Eduardo) — pedido de César al abrirle el botón al
// empleado: si Isaías cancela algo, los dos dueños se enteran EN EL MOMENTO.
// Este aviso va al WhatsApp de los dueños, así que acá SÍ se nombran montos (no
// es la pantalla del staff). Dos cosas que se rompen fácil y hay que fijar: que
// el texto no mienta sobre la plata, y que entre en los 250 chars de Meta.
//

const ar = (over: Partial<Parameters<typeof buildCancelAlert>[0]> = {}) => ({
  property_slug: "villa-b11-palma-real",
  check_in: "2026-08-19",
  check_out: "2026-08-20",
  guest_name: "martinez",
  guest_phone: "50488675655",
  total_hnl: 2500,
  paid_hnl: 1250,
  amount_usd: null,
  ...over,
});

describe("moneyLine — qué plata está en juego (sin mentir)", () => {
  it("depósito en Lempiras: dice cuánto pagó y que lo pierde", () => {
    expect(moneyLine(ar())).toBe("pagó L 1,250 (los pierde)");
  });

  it("libro LPS sin un centavo pagado → no inventa una pérdida", () => {
    expect(moneyLine(ar({ paid_hnl: 0 }))).toBe("sin pago recibido");
  });

  it("cobro por PayPal sin libro LPS → el monto en dólares", () => {
    expect(moneyLine(ar({ total_hnl: null, paid_hnl: null, amount_usd: 97 }))).toBe("pagó $97 (los pierde)");
  });

  it("sin ningún monto → lo dice, no afirma que perdió algo", () => {
    expect(moneyLine(ar({ total_hnl: null, paid_hnl: null, amount_usd: null }))).toBe("sin pago cargado");
  });
});

describe("buildCancelAlert — el WhatsApp que le llega a los socios", () => {
  it("cancelación del empleado: quién fue, qué propiedad, la plata y que las fechas quedan libres", () => {
    const a = buildCancelAlert(ar(), "Isaías Rivera", "no-show", "cancel");
    expect(a.tipo).toBe("Reserva CANCELADA");
    expect(a.cliente).toContain("martinez");
    expect(a.detalle).toContain("Villa B11 — Palma Real");
    expect(a.detalle).toContain("19 ago → 20 ago");
    expect(a.detalle).toContain("canceló Isaías Rivera");
    expect(a.detalle).toContain("pagó L 1,250 (los pierde)");
    expect(a.detalle).toContain("motivo: no-show");
    expect(a.detalle).toContain("LIBRES");
    // El botón del template abre el chat del huésped en el inbox.
    expect(a.guestPhone).toBe("50488675655");
  });

  it("reactivación: avisa que las fechas vuelven a bloquearse (no habla de plata perdida)", () => {
    const a = buildCancelAlert(ar(), "Propietario", "", "restore");
    expect(a.tipo).toBe("Reserva REACTIVADA");
    expect(a.detalle).toContain("la reactivó Propietario");
    expect(a.detalle).toContain("BLOQUEADAS");
    expect(a.detalle).not.toContain("pierde");
  });

  it("sin motivo no deja un 'motivo:' colgando", () => {
    expect(buildCancelAlert(ar(), "Isaías Rivera", "", "cancel").detalle).not.toContain("motivo:");
  });

  it("respeta el límite de 250 chars de Meta aunque el motivo sea larguísimo", () => {
    const a = buildCancelAlert(ar(), "Isaías Rivera", "x".repeat(400), "cancel");
    expect(a.detalle.length).toBeLessThanOrEqual(250);
  });

  it("sin nombre ni teléfono del huésped no rompe (guestPhone vacío lo maneja notifyOwners)", () => {
    const a = buildCancelAlert(ar({ guest_name: null, guest_phone: null }), null, "", "cancel");
    expect(a.cliente).toBe("Huésped sin nombre");
    expect(a.detalle).toContain("canceló alguien del inbox");
    expect(a.guestPhone).toBe("");
  });
});

describe("buildRestoreVariants — el reactivar tiene el mismo contrato de binds", () => {
  it("con todas las columnas: nivel 1 y vuelve al estado pedido", async () => {
    const { db, calls } = makeDb(ALL);
    await tryUpdate(db, buildRestoreVariants("confirmed", 7));
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("cancelled_by = NULL"); // limpia la firma
    expect(calls[0].binds).toEqual(["confirmed", 7]);
  });

  it("sin las columnas del rastro: cae al último nivel y IGUAL reactiva", async () => {
    const { db, calls } = makeDb(new Set());
    await tryUpdate(db, buildRestoreVariants("pending", 7));
    expect(calls).toHaveLength(3);
    expect(calls[2].binds).toEqual(["pending", 7]);
  });
});
