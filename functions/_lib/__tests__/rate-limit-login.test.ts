import { describe, it, expect, beforeEach } from "vitest";
import {
  peekRateLimit,
  recordRateLimitEvent,
  clearRateLimit,
  type RateLimitEnv,
} from "../rate-limit";

// Rate limit del login: SOLO cuentan los intentos fallidos (2026-08-15).
//
// El bug que arregla: `checkRateLimit` cobraba el cupo ANTES de mirar la
// contraseña, así que entrar bien también gastaba tiro. Con César, Eduardo e
// Isaías en la misma oficina —una sola IP pública para Cloudflare— el tercero en
// conectarse se comía un 429 sin haberse equivocado nunca, y eso frenó el
// entrenamiento de Isaías.
//
// La invariante que fijan estos tests es la que importa en la vida real:
// **entrar bien nunca deja a nadie afuera.**

const ENDPOINT = "inbox/login";
const IP = "190.53.1.10"; // la IP de la oficina, compartida por los tres
const MAX = 10;

/**
 * D1 de mentira, en memoria. Solo entiende las tres consultas que usa el módulo
 * (contar / insertar / borrar) — alcanza para fijar el comportamiento sin
 * levantar una base de verdad.
 */
function fakeDb(): { env: RateLimitEnv; rows: Array<{ endpoint: string; ip: string }> } {
  const rows: Array<{ endpoint: string; ip: string }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) { bound = args; return stmt; },
          async first<T>(): Promise<T> {
            const [endpoint, ip] = bound as string[];
            const cnt = rows.filter((r) => r.endpoint === endpoint && r.ip === ip).length;
            return { cnt } as T;
          },
          async run() {
            const [endpoint, ip] = bound as string[];
            if (/^INSERT/i.test(sql.trim())) rows.push({ endpoint, ip });
            else if (/^DELETE/i.test(sql.trim()) && bound.length === 2) {
              for (let i = rows.length - 1; i >= 0; i--) {
                if (rows[i].endpoint === endpoint && rows[i].ip === ip) rows.splice(i, 1);
              }
            }
            return {};
          },
        };
        return stmt;
      },
    },
  } as unknown as RateLimitEnv;
  return { env, rows };
}

/** Réplica del flujo de `login.ts`: mirar → validar → anotar solo si falló. */
async function intentarLogin(
  env: RateLimitEnv,
  acierta: boolean,
  ip = IP,
): Promise<"ok" | "401" | "429"> {
  const rl = await peekRateLimit(env, { endpoint: ENDPOINT, ip, max: MAX, windowSec: 60 });
  if (!rl.allowed) return "429";
  if (!acierta) {
    await recordRateLimitEvent(env, ENDPOINT, ip);
    return "401";
  }
  await clearRateLimit(env, ENDPOINT, ip);
  return "ok";
}

describe("rate limit del login — solo cuentan los fallidos", () => {
  let db: ReturnType<typeof fakeDb>;
  beforeEach(() => { db = fakeDb(); });

  it("A · 30 logins CORRECTOS seguidos desde la misma IP: ninguno se bloquea", async () => {
    // El caso de la oficina: los tres entrando y saliendo toda la mañana.
    for (let i = 0; i < 30; i++) {
      expect(await intentarLogin(db.env, true)).toBe("ok");
    }
  });

  it("B · el que adivina mal SÍ topa: al fallo 11 recibe 429", async () => {
    for (let i = 0; i < MAX; i++) {
      expect(await intentarLogin(db.env, false)).toBe("401");
    }
    expect(await intentarLogin(db.env, false)).toBe("429");
  });

  it("C · acertar borra los fallos acumulados (no se le hereda el cupo al siguiente)", async () => {
    // Isaías tipea mal 9 veces…
    for (let i = 0; i < 9; i++) await intentarLogin(db.env, false);
    expect(db.rows.length).toBe(9);
    // …y a la décima acierta.
    expect(await intentarLogin(db.env, true)).toBe("ok");
    expect(db.rows.length).toBe(0);
    // Ahora Eduardo entra desde la misma oficina con el cupo limpio.
    expect(await intentarLogin(db.env, true)).toBe("ok");
  });

  it("D · quien está bloqueado NO se desbloquea con la contraseña correcta de otro", async () => {
    // Importa: si el 429 se pudiera saltar acertando, un atacante que roba la
    // clave del inbox limpiaría su propio rastro. Bloqueado es bloqueado hasta
    // que pase la ventana — `peek` corta ANTES de mirar la contraseña.
    for (let i = 0; i < MAX; i++) await intentarLogin(db.env, false);
    expect(await intentarLogin(db.env, true)).toBe("429");
    expect(db.rows.length).toBe(MAX); // no se limpió nada
  });

  it("E · el bloqueo es por IP: la casa de Eduardo no paga por la oficina", async () => {
    for (let i = 0; i < MAX; i++) await intentarLogin(db.env, false, "190.53.1.10");
    expect(await intentarLogin(db.env, false, "190.53.1.10")).toBe("429");
    expect(await intentarLogin(db.env, true, "181.115.2.77")).toBe("ok");
  });

  it("F · peek NO incrementa: mirar el contador diez veces no gasta cupo", async () => {
    for (let i = 0; i < 10; i++) {
      await peekRateLimit(db.env, { endpoint: ENDPOINT, ip: IP, max: MAX, windowSec: 60 });
    }
    expect(db.rows.length).toBe(0);
  });

  it("G · si D1 se cae, se deja pasar (fail-open): nadie queda afuera por un problema nuestro", async () => {
    const envRoto = {
      DB: { prepare() { throw new Error("D1 caída"); } },
    } as unknown as RateLimitEnv;
    const rl = await peekRateLimit(envRoto, { endpoint: ENDPOINT, ip: IP, max: MAX, windowSec: 60 });
    expect(rl.allowed).toBe(true);
    // Y las escrituras no explotan tampoco.
    await expect(recordRateLimitEvent(envRoto, ENDPOINT, IP)).resolves.toBeUndefined();
    await expect(clearRateLimit(envRoto, ENDPOINT, IP)).resolves.toBeUndefined();
  });
});
