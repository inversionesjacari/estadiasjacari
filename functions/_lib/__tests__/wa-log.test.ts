import { describe, expect, it } from "vitest";
import { logOutboundTemplate } from "../wa-log";

/** Stub mínimo de D1 que graba las llamadas (patrón: sin mocks de framework). */
function makeDbStub() {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
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

const base = {
  fromPhone: "1234567890",
  toPhone: "50499998888",
  rule: "checkin_reminder",
  summary: "📋 Instrucciones check-in + PDF — Villa B11 (15 jul)",
};

describe("logOutboundTemplate", () => {
  it("envío OK → fila status 'sent' con wamid y summary como body", async () => {
    const { db, calls } = makeDbStub();
    await logOutboundTemplate(db, {
      ...base,
      reservationId: 42,
      ok: true,
      messageId: "wamid.OK123",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("INSERT OR IGNORE INTO whatsapp_messages");
    const [wamid, resId, from, to, body, rule, status] = calls[0].binds;
    expect(wamid).toBe("wamid.OK123");
    expect(resId).toBe(42);
    expect(from).toBe(base.fromPhone);
    expect(to).toBe(base.toPhone);
    expect(body).toBe(base.summary);
    expect(rule).toBe("checkin_reminder");
    expect(status).toBe("sent");
  });

  it("envío FALLIDO → status 'failed', body con [FAILED] + error, wamid null", async () => {
    const { db, calls } = makeDbStub();
    await logOutboundTemplate(db, {
      ...base,
      ok: false,
      messageId: null,
      error: "HTTP 400 :: template no aprobado",
    });
    const [wamid, resId, , , body, , status] = calls[0].binds;
    expect(wamid).toBeNull();
    expect(resId).toBeNull(); // sin reservationId → null
    expect(body).toContain("[FAILED]");
    expect(body).toContain(base.summary);
    expect(body).toContain("template no aprobado");
    expect(status).toBe("failed");
  });

  it("dry-run (messageId DRY_RUN) → NO toca la base", async () => {
    const { db, calls } = makeDbStub();
    await logOutboundTemplate(db, { ...base, ok: true, messageId: "DRY_RUN" });
    expect(calls).toHaveLength(0);
  });

  it("excepción de D1 → NO propaga (fail-soft: la telemetría nunca rompe el envío)", async () => {
    const db = {
      prepare() {
        throw new Error("D1 caída");
      },
    } as unknown as D1Database;
    await expect(
      logOutboundTemplate(db, { ...base, ok: true, messageId: "wamid.X" }),
    ).resolves.toBeUndefined();
  });
});
