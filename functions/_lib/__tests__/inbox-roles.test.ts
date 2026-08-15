import { describe, it, expect } from "vitest";
import {
  buildLoginCookie,
  requireInboxAuth,
  requireOwner,
  type InboxAuthEnv,
} from "../inbox-auth";
import { redactMoney, payStateOf } from "../inbox-roles";

// Roles del inbox (2026-08-15, entra Isaías Rivera a gestionar el bot).
//
// La promesa del cambio es UNA: el empleado entra al inbox y a Reservas, pero la
// plata del negocio no le llega — ni la ve, ni la mueve. Estos tests fijan esa
// invariante por la API pública, que es donde puede romperse de verdad:
//   - quién entra con cada contraseña,
//   - que un staff no pueda pasar por owner (ni con la cookie en la mano),
//   - que los montos NO viajen en la respuesta (no que el front los esconda).

const OWNER_PW = "clave-del-dueno";
const STAFF_PW = "clave-de-isaias";

const ENV: InboxAuthEnv = {
  INBOX_PASSWORD: OWNER_PW,
  STAFF_PASSWORD: STAFF_PW,
  INBOX_SESSION_SECRET: "sesion-dedicado-1",
  CRON_SECRET: "cron-compartido",
};

function cookieHeaderFrom(setCookie: string): string {
  return setCookie.split(";")[0];
}

function reqWith(cookie: string): Request {
  return new Request("https://estadiasjacari.com/inbox", { headers: { cookie } });
}

async function loginAs(password: string, env: InboxAuthEnv = ENV): Promise<string> {
  const res = await buildLoginCookie(password, env);
  expect(res.ok).toBe(true);
  return cookieHeaderFrom(res.setCookie!);
}

describe("inbox-auth — dos contraseñas, dos roles", () => {
  it("A · la contraseña del dueño entra como owner", async () => {
    const res = await buildLoginCookie(OWNER_PW, ENV);
    expect(res.ok).toBe(true);
    expect(res.session).toEqual({ role: "owner", user: "Propietario" });
  });

  it("B · la contraseña del empleado entra como staff, con su nombre", async () => {
    const res = await buildLoginCookie(STAFF_PW, ENV);
    expect(res.ok).toBe(true);
    expect(res.session?.role).toBe("staff");
    expect(res.session?.user).toBe("Isaías Rivera");
  });

  it("C · STAFF_NAME manda sobre el default (y se lee al verificar, no al firmar)", async () => {
    const env = { ...ENV, STAFF_NAME: "Otro Empleado" };
    const cookie = await loginAs(STAFF_PW, env);
    const auth = await requireInboxAuth(reqWith(cookie), env);
    expect(auth.session?.user).toBe("Otro Empleado");
  });

  it("D · contraseña que no es ninguna de las dos → rechazada", async () => {
    const res = await buildLoginCookie("cualquier-otra", ENV);
    expect(res.ok).toBe(false);
    expect(res.setCookie).toBeUndefined();
  });

  it("E · sin STAFF_PASSWORD seteada no existe el rol staff (estado previo al cambio)", async () => {
    const envSinStaff: InboxAuthEnv = { INBOX_PASSWORD: OWNER_PW, INBOX_SESSION_SECRET: "s1" };
    expect((await buildLoginCookie(STAFF_PW, envSinStaff)).ok).toBe(false);
    expect((await buildLoginCookie(OWNER_PW, envSinStaff)).ok).toBe(true);
  });

  it("F · si las dos contraseñas fueran iguales, gana owner (falla del lado de César)", async () => {
    const env: InboxAuthEnv = { ...ENV, STAFF_PASSWORD: OWNER_PW };
    const res = await buildLoginCookie(OWNER_PW, env);
    expect(res.session?.role).toBe("owner");
  });
});

describe("inbox-auth — requireOwner", () => {
  it("G · el dueño pasa", async () => {
    const cookie = await loginAs(OWNER_PW);
    const auth = await requireOwner(reqWith(cookie), ENV);
    expect(auth.ok).toBe(true);
  });

  it("H · el empleado recibe 403 (NO 401: la sesión es válida, no hay que desloguearlo)", async () => {
    const cookie = await loginAs(STAFF_PW);
    const auth = await requireOwner(reqWith(cookie), ENV);
    expect(auth.ok).toBe(false);
    expect(auth.response!.status).toBe(403);
    const body = (await auth.response!.json()) as { code?: string };
    expect(body.code).toBe("forbidden_role");
  });

  it("I · sin cookie sigue siendo 401 (no confundir 'no entraste' con 'no te toca')", async () => {
    const auth = await requireOwner(new Request("https://estadiasjacari.com/inbox"), ENV);
    expect(auth.response!.status).toBe(401);
  });

  it("J · un staff no puede ascenderse editando el payload: la firma se rompe", async () => {
    const cookie = await loginAs(STAFF_PW);
    const token = cookie.slice("inbox_session=".length);
    const [payloadB64, sig] = token.split(".");
    const payload = JSON.parse(atob(payloadB64)) as { createdAt: number; role: string };
    expect(payload.role).toBe("staff"); // el rol vive DENTRO del token firmado

    // Mismo token, rol reescrito a owner, firma original (lo único que podría
    // hacer alguien con la cookie en la mano).
    const forjado = `${btoa(JSON.stringify({ ...payload, role: "owner" })).replace(/=+$/, "")}.${sig}`;
    const auth = await requireInboxAuth(reqWith(`inbox_session=${forjado}`), ENV);
    expect(auth.ok).toBe(false); // firma inválida → ni siquiera entra
  });

  it("K · token viejo (pre-roles, sin `role`) se lee como owner → la sesión viva de César no se cae", async () => {
    // Réplica exacta de un token de antes del cambio: payload solo con createdAt.
    const payloadB64 = btoa(JSON.stringify({ createdAt: Date.now() })).replace(/=+$/, "");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(ENV.INBOX_SESSION_SECRET!),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const raw = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64)));
    let bin = "";
    for (const b of raw) bin += String.fromCharCode(b);
    const sig = btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

    const auth = await requireOwner(reqWith(`inbox_session=${payloadB64}.${sig}`), ENV);
    expect(auth.ok).toBe(true);
    expect(auth.session?.role).toBe("owner");
  });
});

describe("inbox-roles — la plata no viaja", () => {
  const OWNER = { role: "owner" as const, user: "Propietario" };
  const STAFF = { role: "staff" as const, user: "Isaías Rivera" };

  const FILA = {
    id: 7,
    guest_name: "Ana",
    amount_usd: 210,
    total_hnl: 5000,
    paid_hnl: 2500,
    tr_amount: 2500,
    tr_expected_hnl: 5000,
    source: "whatsapp_transfer",
    status: "pending",
  };

  it("L · al dueño le llega la fila intacta y SIN pay_state (nada cambia para César)", () => {
    const [out] = redactMoney([FILA], OWNER);
    expect(out).toEqual(FILA);
    expect("pay_state" in out).toBe(false);
  });

  it("M · al empleado NO le llega ni un monto — ni siquiera enmascarado", () => {
    const [out] = redactMoney([FILA], STAFF) as Record<string, unknown>[];
    for (const campo of ["amount_usd", "total_hnl", "paid_hnl", "tr_amount", "tr_expected_hnl"]) {
      expect(out[campo]).toBeNull();
    }
    // Lo que sí necesita para trabajar sigue ahí.
    expect(out.guest_name).toBe("Ana");
    expect(out.pay_state).toBe("deposit");
    // Y ningún número sobreviviente en el JSON serializado.
    expect(JSON.stringify(out)).not.toContain("5000");
    expect(JSON.stringify(out)).not.toContain("2500");
  });

  it("N · sin sesión se REDACTA igual: solo el owner ve números, nunca se filtra por omisión", () => {
    // Un endpoint nuevo que se olvide de pasar `auth.session` tiene que fallar
    // hacia el lado seguro: César ve guiones (se reporta al toque) en vez de que
    // el empleado vea la plata (nadie se entera).
    const [out] = redactMoney([FILA], undefined) as Record<string, unknown>[];
    expect(out.total_hnl).toBeNull();
    expect(out.pay_state).toBe("deposit");
  });

  it("O · redactMoney no muta la fila original", () => {
    const fila = { ...FILA };
    redactMoney([fila], STAFF);
    expect(fila.total_hnl).toBe(5000);
  });

  it("P · pay_state dice la verdad sin decir el monto", () => {
    expect(payStateOf({ total_hnl: 5000, paid_hnl: 5000 })).toBe("paid");
    expect(payStateOf({ total_hnl: 5000, paid_hnl: 6000 })).toBe("paid"); // pagó de más
    expect(payStateOf({ total_hnl: 5000, paid_hnl: 1000 })).toBe("deposit");
    expect(payStateOf({ total_hnl: 5000, paid_hnl: 0 })).toBe("unpaid");
    expect(payStateOf({ total_hnl: 5000, paid_hnl: null })).toBe("unpaid");
    // Sin libro en Lempiras: PayPal confirmado SÍ está cobrado…
    expect(payStateOf({ status: "confirmed", source: "website" })).toBe("paid");
    // …pero transferencia/manual NO se declara pagada de gratis (caso Sandra).
    expect(payStateOf({ status: "confirmed", source: "whatsapp_transfer" })).toBe("verify");
    expect(payStateOf({ status: "confirmed", source: "manual", tr_amount: 900 })).toBe("deposit");
    // El estado de la reserva manda sobre el pago.
    expect(payStateOf({ status: "cancelled", total_hnl: 5000, paid_hnl: 5000 })).toBe("cancelled");
    expect(payStateOf({ status: "refunded", total_hnl: 5000, paid_hnl: 5000 })).toBe("refunded");
  });

  it("Q · una reserva PAGADA por transferencia no se le muestra al empleado como 'por verificar'", () => {
    // Es el bug que justifica mandar pay_state: si el front re-derivara el estado
    // con los montos ya borrados, esta fila (pagada completa) se leería mal y el
    // empleado saldría a cobrarle a alguien que ya pagó.
    const pagadaPorTransferencia = { total_hnl: 4000, paid_hnl: 4000, source: "whatsapp_transfer", status: "confirmed" };
    const [out] = redactMoney([pagadaPorTransferencia], STAFF) as Record<string, unknown>[];
    expect(out.pay_state).toBe("paid");
    expect(payStateOf(out)).toBe("verify"); // ← lo que daría re-derivarlo sin los montos
  });
});
