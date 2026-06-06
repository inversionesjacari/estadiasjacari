/// <reference types="@cloudflare/workers-types" />
//
// Verificación de firma para webhooks de Meta (WhatsApp Cloud API, Graph API).
//
// Meta firma CADA webhook POST con HMAC-SHA256 usando el App Secret. La firma
// llega en el header `x-hub-signature-256: sha256=<hex>`. Sin verificación,
// CUALQUIERA que descubra la URL del webhook puede POSTear payloads falsos y
// disparar emails de escalación, respuestas del bot a números arbitrarios y
// filas basura en D1.
//
// App Secret: Meta Developers → App → Settings → Basic → App Secret.
// Es DISTINTO del Access Token (ese caduca, el App Secret es permanente).
// Es DISTINTO del Webhook Verify Token (ese solo se usa en el GET handshake).
//
// Crítico: la firma se computa sobre el RAW body, no sobre el JSON parseado.
// JSON.parse + JSON.stringify pueden cambiar whitespace y order de keys →
// firma diferente. Siempre leer request.text() ANTES de parsear.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

/**
 * Comparación timing-safe de dos strings hexadecimales.
 * Variante específica para hex porque la firma de Meta es hex de 64 chars
 * (SHA-256 → 32 bytes → 64 hex). Misma lógica que `admin-auth.ts` y
 * `inbox-auth.ts` pero mantenida local para no acoplar este helper.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifica que el body recibido fue firmado por Meta usando nuestro App Secret.
 *
 * @param rawBody          Cuerpo del request TAL CUAL llegó (request.text()).
 * @param signatureHeader  Valor del header `x-hub-signature-256` (formato
 *                          "sha256=<64-hex>" o solo "<64-hex>").
 * @param appSecret        WHATSAPP_APP_SECRET (env var).
 * @returns true si la firma matchea; false si no, o si el header tiene formato inválido.
 */
export async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string,
  appSecret: string,
): Promise<boolean> {
  // Meta puede enviar "sha256=abc..." o "abc..." según versión. Acepta ambos.
  const expected = signatureHeader.replace(/^sha256=/i, "").toLowerCase();

  // Validar formato: 64 hex chars (sha256 = 256 bits = 32 bytes = 64 hex)
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return false;
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const sigHex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqualHex(sigHex, expected);
}
