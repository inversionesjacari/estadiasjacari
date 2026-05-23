/// <reference types="@cloudflare/workers-types" />
//
// Lee el PDF de bienvenida de una propiedad desde el bucket R2 PRIVADO
// `estadias-jacari-checkin-pdfs`, bindeado como `CHECKIN_PDFS` en Pages
// (Settings → Bindings → R2 bucket).
//
// Convención de filename: `<slug>.pdf` exacto (los slugs viven en
// `src/data/properties.ts`). Ej: `casa-brisa.pdf`.
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
  error?: string;
}

/**
 * Lee el PDF de check-in para un slug. Nunca lanza excepción.
 */
export async function getCheckinPdf(
  slug: string,
  env: CheckinPdfEnv,
): Promise<PdfResult> {
  if (!env.CHECKIN_PDFS) {
    return { found: false, error: "Binding CHECKIN_PDFS no configurado" };
  }
  const key = `${slug}.pdf`;
  try {
    const obj = await env.CHECKIN_PDFS.get(key);
    if (!obj) {
      return {
        found: false,
        error: `No hay PDF en R2 para slug "${slug}" (key=${key})`,
      };
    }
    const buf = await obj.arrayBuffer();
    return {
      found: true,
      bytes: new Uint8Array(buf),
      filename: `instrucciones-checkin-${slug}.pdf`,
      sizeBytes: buf.byteLength,
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
