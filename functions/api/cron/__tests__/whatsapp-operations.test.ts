/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from "vitest";
import {
  resolveTargetDate,
  runEveningStaff,
  runMorningStaff,
  VALID_HITOS,
} from "../whatsapp-operations";
import { SELECT_FULL, SELECT_LEGACY } from "../../inbox/reservations-confirmed";

//
// RECORDATORIOS-0712 (César): mensajes programados por huésped.
//   - Hito NUEVO evening-staff: limpieza se entera a las 6 PM de la VÍSPERA
//     (template limpieza_aviso_entrada) — reemplaza al aviso de las 7 AM.
//   - morning-staff queda SOLO seguridad.
//   - Sin filtro source='airbnb': toda reserva 'confirmed' se automatiza.
// Estos tests fijan ese contrato con un stub de D1 (patrón wa-log.test.ts)
// y corren los hitos en dryRun (no tocan Meta ni escriben en la base).
//

const CLOCK = { today: () => "2026-07-12", tomorrow: () => "2026-07-13" };

describe("resolveTargetDate — la fecha objetivo de cada hito", () => {
  it("evening-staff (víspera) apunta al check-in de MAÑANA", () => {
    expect(resolveTargetDate("evening-staff", null, CLOCK)).toBe("2026-07-13");
  });
  it("los hitos del día-de apuntan a HOY", () => {
    expect(resolveTargetDate("morning-staff", null, CLOCK)).toBe("2026-07-12");
    expect(resolveTargetDate("morning-guests", null, CLOCK)).toBe("2026-07-12");
    expect(resolveTargetDate("checkout-cleaning", null, CLOCK)).toBe("2026-07-12");
  });
  it("?date=YYYY-MM-DD válido siempre manda (pruebas/dry-run)", () => {
    expect(resolveTargetDate("evening-staff", "2026-08-01", CLOCK)).toBe("2026-08-01");
    expect(resolveTargetDate("morning-guests", "2026-08-01", CLOCK)).toBe("2026-08-01");
  });
  it("un ?date malformado se ignora y cae al default", () => {
    expect(resolveTargetDate("evening-staff", "13-07-2026", CLOCK)).toBe("2026-07-13");
    expect(resolveTargetDate("evening-staff", "", CLOCK)).toBe("2026-07-13");
  });
  it("evening-staff está entre los hitos válidos", () => {
    expect(VALID_HITOS).toContain("evening-staff");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stub de D1 que responde según la tabla consultada y graba cada llamada.
// ─────────────────────────────────────────────────────────────────────────────

interface Call {
  sql: string;
  binds: unknown[];
}

function makeDb(opts: {
  reservations?: unknown[];
  /** key = `${slug}:${role}` → filas crudas de property_contacts */
  contacts?: Record<string, unknown[]>;
}) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all() {
              calls.push({ sql, binds });
              if (/FROM reservations/i.test(sql)) return { results: opts.reservations ?? [] };
              if (/FROM property_contacts/i.test(sql)) {
                const key = `${String(binds[0])}:${String(binds[1])}`;
                return { results: opts.contacts?.[key] ?? [] };
              }
              return { results: [] };
            },
            async first() {
              calls.push({ sql, binds });
              return null;
            },
            async run() {
              calls.push({ sql, binds });
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

const baseRow = {
  id: 7,
  property_slug: "casa-brisa",
  check_in: "2026-07-13",
  check_out: "2026-07-15",
  guest_name: "Ana García",
  guest_phone: "+504 9988-1234",
  guest_count: 4,
  wa_arrival_guest_sent_at: null,
  wa_arrival_cleaning_sent_at: null,
  wa_arrival_security_sent_at: null,
  wa_departure_guest_sent_at: null,
  wa_departure_cleaning_sent_at: null,
  wa_eve_cleaning_sent_at: null,
};

const cleanerRow = {
  id: 1, slug: "casa-brisa", role: "cleaning", name: "Karina", phone_e164: "50432925998", active: 1, notes: null,
};
const guardRow = {
  id: 2, slug: "casa-brisa", role: "security", name: "Guardia Tela", phone_e164: "50499837130", active: 1, notes: null,
};

const WA_ENV = { WHATSAPP_ACCESS_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "111" };

function makeEnv(db: D1Database) {
  return { DB: db, ...WA_ENV };
}

type Actions = Parameters<typeof runEveningStaff>[4];

describe("runEveningStaff — aviso a limpieza la víspera (6 PM HN)", () => {
  it("consulta las llegadas del targetDate SIN filtro de source y avisa a limpieza", async () => {
    const { db, calls } = makeDb({
      reservations: [baseRow],
      contacts: { "casa-brisa:cleaning": [cleanerRow] },
    });
    const actions: Actions = [];
    await runEveningStaff(makeEnv(db), WA_ENV, "2026-07-13", true, actions);

    const resQuery = calls.find((c) => /FROM reservations/i.test(c.sql));
    expect(resQuery).toBeDefined();
    expect(resQuery!.binds).toEqual(["2026-07-13"]);
    expect(resQuery!.sql).not.toMatch(/airbnb/i); // César 2026-07-12: todas las confirmadas
    expect(resQuery!.sql).toMatch(/status = 'confirmed'/);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      reservationId: 7,
      action: "limpieza_aviso_entrada → Karina (50432925998)",
      status: "sent",
      detail: "dryRun",
    });
  });

  it("idempotente: si wa_eve_cleaning_sent_at ya está, ni consulta contactos", async () => {
    const { db, calls } = makeDb({
      reservations: [{ ...baseRow, wa_eve_cleaning_sent_at: "2026-07-12 00:05:00" }],
      contacts: { "casa-brisa:cleaning": [cleanerRow] },
    });
    const actions: Actions = [];
    await runEveningStaff(makeEnv(db), WA_ENV, "2026-07-13", true, actions);
    expect(actions).toHaveLength(0);
    expect(calls.some((c) => /FROM property_contacts/i.test(c.sql))).toBe(false);
  });

  it("sin contactos de limpieza → skip silencioso (no error, queda anotado)", async () => {
    const { db } = makeDb({ reservations: [baseRow], contacts: {} });
    const actions: Actions = [];
    await runEveningStaff(makeEnv(db), WA_ENV, "2026-07-13", true, actions);
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe("skipped");
    expect(actions[0].detail).toContain("Sin contactos de limpieza");
  });

  it("dryRun NUNCA escribe en la base (ni UPDATE ni whatsapp_messages)", async () => {
    const { db, calls } = makeDb({
      reservations: [baseRow],
      contacts: { "casa-brisa:cleaning": [cleanerRow] },
    });
    await runEveningStaff(makeEnv(db), WA_ENV, "2026-07-13", true, []);
    expect(calls.some((c) => /UPDATE reservations/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /whatsapp_messages/i.test(c.sql))).toBe(false);
  });
});

describe("runMorningStaff — desde RECORDATORIOS-0712 avisa SOLO a seguridad", () => {
  it("no manda checkin_dia_limpieza aunque haya contactos de limpieza", async () => {
    const { db, calls } = makeDb({
      reservations: [baseRow],
      contacts: {
        "casa-brisa:cleaning": [cleanerRow],
        "casa-brisa:security": [guardRow],
      },
    });
    const actions: Actions = [];
    await runMorningStaff(makeEnv(db), WA_ENV, "2026-07-13", true, actions);

    expect(actions.some((a) => a.action.includes("checkin_dia_limpieza"))).toBe(false);
    expect(actions.some((a) => a.action.includes("checkin_dia_seguridad"))).toBe(true);

    // Solo consultó el rol security — limpieza ya no le pertenece a este hito.
    const contactRoles = calls
      .filter((c) => /FROM property_contacts/i.test(c.sql))
      .map((c) => c.binds[1]);
    expect(contactRoles).toEqual(["security"]);
  });
});

describe("reservations-confirmed — contrato del fallback pre-migración 0041", () => {
  it("el SELECT completo incluye las columnas de la víspera", () => {
    expect(SELECT_FULL).toContain("wa_eve_cleaning_sent_at");
    expect(SELECT_FULL).toContain("wa_eve_cleaning_error");
  });
  it("el SELECT legacy las excluye pero sigue bien formado (el dashboard no muere)", () => {
    expect(SELECT_LEGACY).not.toContain("wa_eve_cleaning");
    // La línea anterior y la siguiente quedaron bien cosidas (sin coma colgante).
    expect(SELECT_LEGACY).toMatch(/wa_phone_capture_sent_at,\s*tr\.amount/);
    expect(SELECT_LEGACY).toContain("tr_decision");
    expect(SELECT_LEGACY).not.toMatch(/,\s*FROM/i);
  });
});
