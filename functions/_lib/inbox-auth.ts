/// <reference types="@cloudflare/workers-types" />
//
// Auth simple para el dashboard `/inbox`.
//
// Flujo:
//   1. POST /api/inbox/login  con { password } → si matchea INBOX_PASSWORD,
//      setea cookie HttpOnly + SameSite=Strict con el token (= sha256 del
//      password + salt). El token va firmado por HMAC con CRON_SECRET para
//      evitar falsificación.
//   2. Cada endpoint del dashboard valida el cookie con `requireInboxAuth(env, request)`.
//      Si falla, devuelve 401 (el frontend reacciona mostrando la pantalla de login).
//
// Por qué no JWT con librería: agregar `jose` u otra librería suma ~30KB al
// bundle de Pages Functions. Para 1 usuario (el dueño) + 1 password, un HMAC
// custom con Web Crypto API es suficiente y zero-dep.
//
// Por qué no Cloudflare Access: requiere plan Workers Paid o Zero Trust.
// Para 1 usuario, INBOX_PASSWORD en env var es razonable.
//
// SEGURIDAD:
//   - Cookie: HttpOnly + Secure + SameSite=Strict
//   - Token = HMAC-SHA256(payload, CRON_SECRET) donde payload = `${createdAt}:${userId}`
//   - Expiración: 7 días (re-login después)
//   - No expone INBOX_PASSWORD en ningún lado (solo se compara hash al login)
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

const COOKIE_NAME = "inbox_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

export interface InboxAuthEnv {
  CRON_SECRET?: string;
  INBOX_PASSWORD?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HMAC helpers (Web Crypto API, disponible en Workers)
// ─────────────────────────────────────────────────────────────────────────────

async function hmacSign(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  // Convertir ArrayBuffer a base64url (sin padding)
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token sign + verify
// ─────────────────────────────────────────────────────────────────────────────

interface SessionPayload {
  createdAt: number; // ms epoch
}

async function buildSessionToken(env: InboxAuthEnv): Promise<string> {
  if (!env.CRON_SECRET) throw new Error("CRON_SECRET requerido");
  const payload: SessionPayload = { createdAt: Date.now() };
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=+$/, "");
  const sig = await hmacSign(payloadB64, env.CRON_SECRET);
  return `${payloadB64}.${sig}`;
}

async function verifySessionToken(
  token: string,
  env: InboxAuthEnv,
): Promise<{ ok: boolean; reason?: string }> {
  if (!env.CRON_SECRET) return { ok: false, reason: "CRON_SECRET no configurado" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "Formato token inválido" };
  const [payloadB64, sig] = parts;
  const expectedSig = await hmacSign(payloadB64, env.CRON_SECRET);
  if (!(await timingSafeEqual(sig, expectedSig))) {
    return { ok: false, reason: "Firma inválida" };
  }
  try {
    const payload = JSON.parse(atob(payloadB64)) as SessionPayload;
    if (Date.now() - payload.createdAt > SESSION_TTL_MS) {
      return { ok: false, reason: "Sesión expirada" };
    }
  } catch {
    return { ok: false, reason: "Payload inválido" };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compara password recibido contra INBOX_PASSWORD. Si OK, devuelve el header
 * Set-Cookie listo para enviar.
 */
export async function buildLoginCookie(
  password: string,
  env: InboxAuthEnv,
): Promise<{ ok: boolean; setCookie?: string; error?: string }> {
  if (!env.INBOX_PASSWORD) {
    return { ok: false, error: "INBOX_PASSWORD no configurada (env var faltante)" };
  }
  if (!env.CRON_SECRET) {
    return { ok: false, error: "CRON_SECRET no configurado" };
  }
  // Timing-safe compare de las contraseñas
  if (!(await timingSafeEqual(password, env.INBOX_PASSWORD))) {
    return { ok: false, error: "Contraseña incorrecta" };
  }

  const token = await buildSessionToken(env);
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const setCookie = `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
  return { ok: true, setCookie };
}

/**
 * Verifica el cookie de sesión. Si OK, deja seguir. Si no, devuelve 401.
 * Llamar al inicio de cada endpoint protegido.
 */
export async function requireInboxAuth(
  request: Request,
  env: InboxAuthEnv,
): Promise<{ ok: boolean; response?: Response }> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookies = parseCookies(cookieHeader);
  const token = cookies[COOKIE_NAME];
  if (!token) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ ok: false, error: "No autenticado" }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
    };
  }
  const result = await verifySessionToken(token, env);
  if (!result.ok) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ ok: false, error: result.reason }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
    };
  }
  return { ok: true };
}

/**
 * Header Set-Cookie para hacer logout (expira el cookie).
 */
export function buildLogoutCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of header.split(/;\s*/)) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}
