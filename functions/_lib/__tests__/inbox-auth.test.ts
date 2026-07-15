import { describe, it, expect, vi } from "vitest";
import {
  buildLoginCookie,
  requireInboxAuth,
  buildLogoutCookie,
  type InboxAuthEnv,
} from "../inbox-auth";

// Fase 5.1 del plan maestro (2026-07-13): la cookie de sesión del inbox se firma
// con un secret DEDICADO (INBOX_SESSION_SECRET) en vez del CRON_SECRET compartido,
// con FALLBACK TRANSICIONAL a CRON_SECRET para que rotar el secret compartido
// (quedó expuesto el 11-jul) NO desloguee el inbox donde vive la PII de clientes.
//
// Estos tests prueban el contrato por la API pública (buildLoginCookie firma;
// requireInboxAuth verifica). El escenario B es EL que justifica la fase.

const PW = "clave-del-inbox";

/** Extrae `inbox_session=<token>` del header Set-Cookie para reusarlo como Cookie. */
function cookieHeaderFrom(setCookie: string): string {
  return setCookie.split(";")[0];
}

function reqWith(cookie: string): Request {
  return new Request("https://estadiasjacari.com/inbox", { headers: { cookie } });
}

async function login(env: InboxAuthEnv): Promise<string> {
  const res = await buildLoginCookie(PW, env);
  expect(res.ok).toBe(true);
  expect(res.setCookie).toBeTruthy();
  return cookieHeaderFrom(res.setCookie!);
}

describe("inbox-auth — secret dedicado con fallback transicional (Fase 5.1)", () => {
  it("A · secret dedicado: firma y verifica el round-trip completo", async () => {
    const env: InboxAuthEnv = {
      INBOX_PASSWORD: PW,
      INBOX_SESSION_SECRET: "sesion-dedicado-1",
      CRON_SECRET: "cron-compartido",
    };
    const cookie = await login(env);
    const auth = await requireInboxAuth(reqWith(cookie), env);
    expect(auth.ok).toBe(true);
  });

  it("B · fallback transicional: sesión firmada con CRON_SECRET sigue válida tras setear el secret dedicado (NO desloguea al rotar)", async () => {
    // Estado PRE-5.1: solo existe CRON_SECRET → el token se firma con él.
    const envViejo: InboxAuthEnv = { INBOX_PASSWORD: PW, CRON_SECRET: "cron-compartido" };
    const cookieViejo = await login(envViejo);

    // César setea el secret dedicado (deja CRON_SECRET intacto todavía).
    const envConDedicado: InboxAuthEnv = {
      INBOX_PASSWORD: PW,
      INBOX_SESSION_SECRET: "sesion-dedicado-1",
      CRON_SECRET: "cron-compartido",
    };
    const auth = await requireInboxAuth(reqWith(cookieViejo), envConDedicado);
    expect(auth.ok).toBe(true); // ← el fallback lo mantiene logueado
  });

  it("C · sin secret dedicado (transición): CRON_SECRET firma y verifica igual que antes", async () => {
    const env: InboxAuthEnv = { INBOX_PASSWORD: PW, CRON_SECRET: "cron-compartido" };
    const cookie = await login(env);
    const auth = await requireInboxAuth(reqWith(cookie), env);
    expect(auth.ok).toBe(true);
  });

  it("D · tokens nuevos usan el secret dedicado: sobreviven a que CRON_SECRET desaparezca", async () => {
    const env: InboxAuthEnv = {
      INBOX_PASSWORD: PW,
      INBOX_SESSION_SECRET: "sesion-dedicado-1",
      CRON_SECRET: "cron-compartido",
    };
    const cookie = await login(env);
    // Simula el estado post-limpieza: ya no hay CRON_SECRET en el env del inbox.
    const envSinCron: InboxAuthEnv = { INBOX_PASSWORD: PW, INBOX_SESSION_SECRET: "sesion-dedicado-1" };
    const auth = await requireInboxAuth(reqWith(cookie), envSinCron);
    expect(auth.ok).toBe(true);
  });

  it("E · tras setear dedicado Y rotar CRON_SECRET, una sesión vieja (cron viejo) se invalida → re-login", async () => {
    const envViejo: InboxAuthEnv = { INBOX_PASSWORD: PW, CRON_SECRET: "cron-VIEJO" };
    const cookieViejo = await login(envViejo);

    const envRotado: InboxAuthEnv = {
      INBOX_PASSWORD: PW,
      INBOX_SESSION_SECRET: "sesion-dedicado-1",
      CRON_SECRET: "cron-NUEVO", // rotado a otro valor
    };
    const auth = await requireInboxAuth(reqWith(cookieViejo), envRotado);
    expect(auth.ok).toBe(false); // firma inválida contra ambos secrets → 401
    expect(auth.response?.status).toBe(401);
  });

  it("F · firma manipulada → 401", async () => {
    const env: InboxAuthEnv = { INBOX_PASSWORD: PW, INBOX_SESSION_SECRET: "sesion-dedicado-1" };
    const cookie = await login(env);
    const tampered = cookie.slice(0, -3) + "xyz"; // corrompe la firma
    const auth = await requireInboxAuth(reqWith(tampered), env);
    expect(auth.ok).toBe(false);
    expect(auth.response?.status).toBe(401);
  });

  it("G · sin cookie → 401", async () => {
    const env: InboxAuthEnv = { INBOX_PASSWORD: PW, INBOX_SESSION_SECRET: "sesion-dedicado-1" };
    const auth = await requireInboxAuth(new Request("https://estadiasjacari.com/inbox"), env);
    expect(auth.ok).toBe(false);
    expect(auth.response?.status).toBe(401);
  });

  it("H · sin ningún secret (ni dedicado ni cron) → el login falla, no firma a ciegas", async () => {
    const env: InboxAuthEnv = { INBOX_PASSWORD: PW };
    const res = await buildLoginCookie(PW, env);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/SECRET/i);
  });

  it("I · contraseña incorrecta → login falla (usa INBOX_PASSWORD, no el secret)", async () => {
    const env: InboxAuthEnv = { INBOX_PASSWORD: PW, INBOX_SESSION_SECRET: "sesion-dedicado-1" };
    const res = await buildLoginCookie("clave-equivocada", env);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/incorrecta/i);
  });

  it("J · sesión expirada (>30 días) → 401", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const env: InboxAuthEnv = { INBOX_PASSWORD: PW, INBOX_SESSION_SECRET: "sesion-dedicado-1" };
      const cookie = await login(env);
      vi.setSystemTime(new Date("2026-03-01T00:00:00Z")); // +59 días
      const auth = await requireInboxAuth(reqWith(cookie), env);
      expect(auth.ok).toBe(false);
      expect(auth.response?.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("K · logout expira la cookie", () => {
    expect(buildLogoutCookie()).toContain("Max-Age=0");
  });
});
