/// <reference types="@cloudflare/workers-types" />
//
// Auth simple para el dashboard `/inbox`.
//
// Flujo:
//   1. POST /api/inbox/login  con { password } → si matchea INBOX_PASSWORD,
//      setea cookie HttpOnly + SameSite=Lax con el token (= sha256 del
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
//   - Cookie: HttpOnly + Secure + SameSite=Lax
//   - Token = HMAC-SHA256(payload, secret) donde payload = `${createdAt}`
//   - Expiración: 30 días (re-login después)
//   - No expone INBOX_PASSWORD en ningún lado (solo se compara hash al login)
//
// SECRET DE FIRMA (Fase 5.1 del plan maestro, 2026-07-13):
//   Los tokens se firman con `INBOX_SESSION_SECRET` (un secret DEDICADO al inbox),
//   con fallback transicional a `CRON_SECRET`:
//     - Firmar (login nuevo): usa INBOX_SESSION_SECRET si existe, si no CRON_SECRET.
//     - Verificar: acepta la firma contra INBOX_SESSION_SECRET **o** CRON_SECRET
//       (fallback) → cuando César setee el secret dedicado, las sesiones ya
//       firmadas con CRON_SECRET siguen válidas hasta expirar (sin logout masivo).
//   Por qué: hasta hoy el MISMO CRON_SECRET firmaba la cookie del inbox (PII de
//   clientes) Y era el Bearer de todos los /api/cron y /api/admin. Rotar el secret
//   compartido (quedó expuesto el 2026-07-11) deslogueaba el inbox. Con un secret
//   dedicado, rotar CRON_SECRET ya no toca la sesión del inbox.
//   Migración limpia: una semana después de que César setee INBOX_SESSION_SECRET
//   y rote CRON_SECRET, QUITAR el fallback a CRON_SECRET del verify (ver
//   `03_documentos/runbook-rotacion-secretos.md`). El Bearer de /admin y /cron
//   NO cambia: sigue en CRON_SECRET (ver `_lib/admin-auth.ts`).
//
// Por qué SameSite=Lax y no Strict (César, 2026-07-12): la alerta de WhatsApp
// abre el inbox con un link (`/inbox?c=...`). Con Strict, el navegador NO manda
// la cookie de sesión en una navegación que viene de OTRO sitio (WhatsApp) → el
// inbox lo ve deslogueado y le vuelve a pedir contraseña CADA vez, aunque la
// sesión siga viva. Lax SÍ manda la cookie en navegaciones top-level GET (tocar
// un link) pero la sigue reteniendo en POST/fetch cross-site → la protección
// anti-CSRF de las mutaciones (responder, pausar) se mantiene: esas son POST y
// nunca viajan cross-site. Único efecto: tocar la alerta abre el inbox ya
// logueado, sin contraseña.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

const COOKIE_NAME = "inbox_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

export interface InboxAuthEnv {
  CRON_SECRET?: string;
  /** Secret DEDICADO para firmar la cookie de sesión del inbox (Fase 5.1).
   *  Si falta, se cae a CRON_SECRET (transición). Ver header del archivo. */
  INBOX_SESSION_SECRET?: string;
  INBOX_PASSWORD?: string;
}

/**
 * Secret con el que se FIRMAN los tokens de sesión NUEVOS.
 * Preferimos INBOX_SESSION_SECRET (dedicado); mientras César no lo setee, caemos
 * a CRON_SECRET → el inbox sigue funcionando idéntico a antes del cambio.
 */
function primarySigningSecret(env: InboxAuthEnv): string | undefined {
  return env.INBOX_SESSION_SECRET || env.CRON_SECRET || undefined;
}

/**
 * Secrets aceptados al VERIFICAR un token, en orden de preferencia. Incluye
 * CRON_SECRET como FALLBACK TRANSICIONAL: cuando se setee INBOX_SESSION_SECRET,
 * las sesiones ya firmadas con CRON_SECRET siguen válidas hasta expirar (sin
 * logout masivo). Quitar el fallback una semana después de rotar (ver runbook).
 */
function acceptedVerifySecrets(env: InboxAuthEnv): string[] {
  const secrets: string[] = [];
  if (env.INBOX_SESSION_SECRET) secrets.push(env.INBOX_SESSION_SECRET);
  if (env.CRON_SECRET && env.CRON_SECRET !== env.INBOX_SESSION_SECRET) {
    secrets.push(env.CRON_SECRET);
  }
  return secrets;
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
  const secret = primarySigningSecret(env);
  if (!secret) throw new Error("INBOX_SESSION_SECRET o CRON_SECRET requerido");
  const payload: SessionPayload = { createdAt: Date.now() };
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=+$/, "");
  const sig = await hmacSign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

async function verifySessionToken(
  token: string,
  env: InboxAuthEnv,
): Promise<{ ok: boolean; reason?: string }> {
  const secrets = acceptedVerifySecrets(env);
  if (secrets.length === 0) {
    return { ok: false, reason: "Secret de sesión no configurado" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "Formato token inválido" };
  const [payloadB64, sig] = parts;
  // La firma vale si coincide contra CUALQUIERA de los secrets aceptados
  // (fallback transicional INBOX_SESSION_SECRET → CRON_SECRET).
  let sigOk = false;
  for (const secret of secrets) {
    const expectedSig = await hmacSign(payloadB64, secret);
    if (await timingSafeEqual(sig, expectedSig)) {
      sigOk = true;
      break;
    }
  }
  if (!sigOk) {
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
  if (!primarySigningSecret(env)) {
    return { ok: false, error: "INBOX_SESSION_SECRET/CRON_SECRET no configurado" };
  }
  // Timing-safe compare de las contraseñas
  if (!(await timingSafeEqual(password, env.INBOX_PASSWORD))) {
    return { ok: false, error: "Contraseña incorrecta" };
  }

  const token = await buildSessionToken(env);
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const setCookie = `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
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
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
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
