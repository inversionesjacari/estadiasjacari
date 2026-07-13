/// <reference types="@cloudflare/workers-types" />
//
// guest-id-store.ts — Guardado de la foto de IDENTIDAD del huésped en R2.
//
// La garita de Villa B11 pide la ID del huésped (Fase 2). El binario NO va en
// D1: se guarda en un bucket R2 PRIVADO nuevo (binding GUEST_IDS, bucket
// 'estadias-jacari-guest-ids') y en `reservations` queda solo la key + mime.
//
// Es dato PII sensible → bucket privado (Cloudflare no lo sirve por HTTP; solo
// las Pages Functions con el binding lo leen). Se sirve únicamente por el proxy
// autenticado /api/inbox/reservation-id (cookie del inbox). En el envío a la
// garita (Fase 2b) se re-sube a Meta con uploadMediaToMeta para un media_id
// fresco (el media_id entrante de Meta expira ~14 días).
//
// FAIL-SOFT: si el binding GUEST_IDS aún no está configurado en el dashboard,
// las funciones no lanzan — devuelven false/null para que el resto siga vivo.
//
// Carpeta `_lib/` (prefijo underscore) NO es ruteable como endpoint.
//

export interface GuestIdEnv {
  GUEST_IDS?: R2Bucket;
}

/** Meta (header image de template) solo acepta JPG y PNG. Restringimos a eso. */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

export const GUEST_ID_ACCEPTED_MIMES = new Set(Object.keys(EXT_BY_MIME));
export const GUEST_ID_MAX_BYTES = 5 * 1024 * 1024; // 5MB (límite de Meta para imagen)

export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? "bin";
}

/** Key estable por reserva: reemplaza la ID anterior al re-subir. */
export function guestIdKey(reservationId: number, mime: string): string {
  return `guest-ids/res-${reservationId}.${extForMime(mime)}`;
}

/** Sube (o reemplaza) la foto de ID. Devuelve false si no hay binding. */
export async function putGuestId(
  env: GuestIdEnv,
  key: string,
  bytes: ArrayBuffer | Uint8Array,
  mime: string,
): Promise<boolean> {
  if (!env.GUEST_IDS) return false;
  await env.GUEST_IDS.put(key, bytes, { httpMetadata: { contentType: mime } });
  return true;
}

/** Lee la foto de ID (bytes + mime). null si no hay binding o no existe. */
export async function getGuestId(
  env: GuestIdEnv,
  key: string,
): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
  if (!env.GUEST_IDS) return null;
  const obj = await env.GUEST_IDS.get(key);
  if (!obj) return null;
  return {
    bytes: await obj.arrayBuffer(),
    mime: obj.httpMetadata?.contentType || "application/octet-stream",
  };
}

/** Borra la foto de ID (best-effort). */
export async function deleteGuestId(env: GuestIdEnv, key: string): Promise<void> {
  if (!env.GUEST_IDS) return;
  try {
    await env.GUEST_IDS.delete(key);
  } catch (err) {
    console.error("guest-id-store: error borrando de R2:", (err as Error).message);
  }
}
