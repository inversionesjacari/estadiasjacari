/// <reference types="@cloudflare/workers-types" />
//
// Lee el PDF de bienvenida de una propiedad desde el bucket R2 PRIVADO
// `estadias-jacari-checkin-pdfs`, bindeado como `CHECKIN_PDFS` en Pages
// (Settings → Bindings → R2 bucket).
//
// Convención de filename: el código acepta DOS variantes para evitar fricción
// si el dueño guarda los archivos con guion bajo (estilo Windows) o guion medio
// (estilo URL). Se intenta primero la versión canónica con guion medio (igual al
// slug) y si no existe se cae a la versión con guion bajo:
//   1. `<slug>.pdf`              ej. `casa-brisa.pdf`        ← canónico
//   2. `<slug.replace("-", "_")>.pdf`  ej. `casa_brisa.pdf`  ← fallback
//
// (El cliente sigue recibiendo siempre el adjunto con el nombre canónico
// `instrucciones-checkin-<slug>.pdf` con guion medio, independiente de cómo
// esté guardado en R2.)
//
// El bucket es PRIVADO — Cloudflare NO lo sirve por HTTP. Solo las Pages
// Functions con el binding pueden leer los objetos. Los códigos de puerta
// y contraseñas WiFi del PDF nunca quedan expuestos al internet.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

export interface CheckinPdfEnv {
  CHECKIN_PDFS?: R2Bucket;
}

export interface PdfResult {
  found: boolean;
  bytes?: Uint8Array;
  /** Nombre sugerido para el adjunto al cliente (ej. "instrucciones-checkin-casa-brisa.pdf"). */
  filename?: string;
  sizeBytes?: number;
  /** Key real usada en R2 (útil para debug — puede ser hyphen o underscore). */
  r2Key?: string;
  error?: string;
}

/**
 * Lee el PDF de check-in para un slug. Nunca lanza excepción.
 * Prueba hasta 2 keys: `<slug>.pdf` y `<slug_underscored>.pdf`.
 */
export async function getCheckinPdf(
  slug: string,
  env: CheckinPdfEnv,
): Promise<PdfResult> {
  if (!env.CHECKIN_PDFS) {
    return { found: false, error: "Binding CHECKIN_PDFS no configurado" };
  }

  const canonicalKey = `${slug}.pdf`;
  const underscoredKey = `${slug.replace(/-/g, "_")}.pdf`;
  // Dedupe en caso de que el slug ya no tenga guiones (igual key dos veces).
  const keysToTry = canonicalKey === underscoredKey
    ? [canonicalKey]
    : [canonicalKey, underscoredKey];

  try {
    for (const key of keysToTry) {
      const obj = await env.CHECKIN_PDFS.get(key);
      if (obj) {
        const buf = await obj.arrayBuffer();
        return {
          found: true,
          bytes: new Uint8Array(buf),
          filename: `instrucciones-checkin-${slug}.pdf`,
          sizeBytes: buf.byteLength,
          r2Key: key,
        };
      }
    }
    return {
      found: false,
      error: `No hay PDF en R2 para slug "${slug}" (intentadas: ${keysToTry.join(", ")})`,
    };
  } catch (err) {
    return { found: false, error: `Error leyendo R2: ${(err as Error).message}` };
  }
}

/**
 * Convierte bytes a base64 sin usar `Buffer` (no existe en Cloudflare Workers).
 *
 * Chunked en bloques de 8 KB para no exceder el límite de argumentos de
 * `String.fromCharCode` con archivos grandes (los PDFs de check-in pueden
 * ser de varios MB).
 */
export function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
