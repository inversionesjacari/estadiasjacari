/// <reference types="@cloudflare/workers-types" />
//
// Cliente Meta WhatsApp Cloud API v25.0 para enviar el recordatorio de check-in
// (mismo PDF + misma info que el Correo #2) como mensaje de WhatsApp.
//
// Flujo de 2 pasos (Meta no permite mandar PDF inline):
//   1. POST /{PHONE_NUMBER_ID}/media → sube el PDF, devuelve media_id (válido 30 días).
//   2. POST /{PHONE_NUMBER_ID}/messages → manda template `checkin_instructions`
//      con el media_id en el header (tipo document) + 3 variables en el body.
//
// El template DEBE estar pre-aprobado por Meta (categoría UTILITY, idioma `es`).
// Si Meta lo rechaza o el nombre no coincide, el API devuelve 400 — el caller
// debe manejarlo como "no se pudo notificar por WhatsApp, pero el email sí salió".
//
// Reusa `getCheckinInfo()` + `getCheckinPdf()` que ya existen — este módulo solo
// se ocupa del transporte WhatsApp, no de obtener la data.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { fetchWithTimeout, TIMEOUT } from "./fetch";
import { isValidE164 } from "./phone";

const GRAPH_API_BASE = "https://graph.facebook.com/v25.0";
const TEMPLATE_NAME = "checkin_instructions";
const TEMPLATE_LANG = "es";

export interface WhatsAppEnv {
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  /** ID del catálogo de WhatsApp (Commerce Manager) para mensajes de producto. */
  WHATSAPP_CATALOG_ID?: string;
}

export interface WhatsAppReminderData {
  /** Teléfono destino en E.164 sin '+' (ej. "50488390145"). */
  toPhone: string;
  /** Nombre del huésped (variable {{1}} del template). */
  guestName: string;
  /** Nombre de la propiedad (variable {{2}} del template). */
  propertyName: string;
  /** Fecha del check-in en español (variable {{3}}). Ej. "hoy" o "mañana, 26 de mayo". */
  checkInDateEs: string;
  /** PDF de bienvenida (mismo que se adjunta al Correo #2). */
  pdfBytes: Uint8Array;
  /** Nombre del archivo PDF tal como lo verá el huésped en WhatsApp. */
  pdfFilename: string;
}

export interface WhatsAppResult {
  ok: boolean;
  /** ID del mensaje devuelto por Meta (útil para tracking / debugging). */
  messageId?: string;
  /** ID del media que subimos (debug — el media_id expira en 30 días). */
  mediaId?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 1 — Upload del PDF a Meta Media
// ─────────────────────────────────────────────────────────────────────────────

interface UploadResult {
  ok: boolean;
  mediaId?: string;
  error?: string;
}

async function uploadPdfToMeta(
  bytes: Uint8Array,
  filename: string,
  env: { token: string; phoneNumberId: string },
): Promise<UploadResult> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  // Blob preserva el filename en el upload (Meta lo respeta para el download).
  // El cast a BodyInit es porque las definiciones de TS del Workers runtime
  // marcan File en vez de Blob, pero ambos son ArrayBufferView-compatible.
  // Cast a ArrayBuffer: Workers runtime nunca usa SharedArrayBuffer,
  // pero el tipo genérico Uint8Array<ArrayBufferLike> no lo garantiza en TS.
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
  form.append("file", blob, filename);

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${GRAPH_API_BASE}/${env.phoneNumberId}/media`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.token}`,
          // NO setear Content-Type — FormData lo arma con su boundary.
        },
        body: form,
      },
      TIMEOUT.CRITICAL,
    );
  } catch (err) {
    return { ok: false, error: `Upload Meta timeout/red: ${(err as Error).message}` };
  }

  const bodyText = await resp.text();
  if (!resp.ok) {
    return {
      ok: false,
      error: `Upload Meta HTTP ${resp.status}: ${bodyText.slice(0, 500)}`,
    };
  }

  let parsed: { id?: string };
  try {
    parsed = JSON.parse(bodyText) as { id?: string };
  } catch {
    return { ok: false, error: `Upload Meta JSON inválido: ${bodyText.slice(0, 200)}` };
  }

  if (!parsed.id) {
    return { ok: false, error: `Upload Meta sin id en respuesta: ${bodyText.slice(0, 200)}` };
  }

  return { ok: true, mediaId: parsed.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 2 — Enviar el template con header document + 3 variables
// ─────────────────────────────────────────────────────────────────────────────

interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

async function sendTemplate(
  data: WhatsAppReminderData,
  mediaId: string,
  env: { token: string; phoneNumberId: string },
): Promise<SendResult> {
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: data.toPhone,
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: TEMPLATE_LANG },
      components: [
        {
          type: "header",
          parameters: [
            {
              type: "document",
              document: {
                id: mediaId,
                filename: data.pdfFilename,
              },
            },
          ],
        },
        {
          type: "body",
          parameters: [
            { type: "text", text: data.guestName },
            { type: "text", text: data.propertyName },
            { type: "text", text: data.checkInDateEs },
          ],
        },
      ],
    },
  };

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${GRAPH_API_BASE}/${env.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      TIMEOUT.CRITICAL,
    );
  } catch (err) {
    return { ok: false, error: `Send Meta timeout/red: ${(err as Error).message}` };
  }

  const bodyText = await resp.text();
  if (!resp.ok) {
    return {
      ok: false,
      error: `Send Meta HTTP ${resp.status}: ${bodyText.slice(0, 500)}`,
    };
  }

  let parsed: {
    messages?: Array<{ id?: string }>;
    error?: { message?: string; code?: number };
  };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: `Send Meta JSON inválido: ${bodyText.slice(0, 200)}` };
  }

  if (parsed.error) {
    return {
      ok: false,
      error: `Send Meta error ${parsed.error.code ?? "?"}: ${parsed.error.message ?? "desconocido"}`,
    };
  }

  const messageId = parsed.messages?.[0]?.id;
  if (!messageId) {
    return { ok: false, error: `Send Meta sin message id: ${bodyText.slice(0, 200)}` };
  }

  return { ok: true, messageId };
}

// ─────────────────────────────────────────────────────────────────────────────
// API pública: combina upload + send
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manda el recordatorio de check-in por WhatsApp (template UTILITY pre-aprobado
 * `checkin_instructions` con header PDF + 3 variables).
 *
 * Nunca lanza excepción — devuelve WhatsAppResult con ok=false y `error` legible
 * si algo falla (config, upload, template rechazado por Meta, red, etc.).
 */
export async function sendCheckinReminderWhatsApp(
  data: WhatsAppReminderData,
  env: WhatsAppEnv,
): Promise<WhatsAppResult> {
  // 1. Validar config
  if (!env.WHATSAPP_ACCESS_TOKEN) {
    return { ok: false, error: "Falta env var WHATSAPP_ACCESS_TOKEN" };
  }
  if (!env.WHATSAPP_PHONE_NUMBER_ID) {
    return { ok: false, error: "Falta env var WHATSAPP_PHONE_NUMBER_ID" };
  }

  // 2. Validar destinatario
  if (!data.toPhone || !isValidE164(data.toPhone)) {
    return {
      ok: false,
      error: `Teléfono destino inválido: "${data.toPhone}" (esperado E.164 sin '+', 8-15 dígitos)`,
    };
  }

  // 3. Validar PDF
  if (!data.pdfBytes || data.pdfBytes.byteLength === 0) {
    return { ok: false, error: "PDF vacío — no se puede mandar WhatsApp sin documento" };
  }

  const cred = {
    token: env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
  };

  // 4. Subir PDF a Meta
  const upload = await uploadPdfToMeta(data.pdfBytes, data.pdfFilename, cred);
  if (!upload.ok || !upload.mediaId) {
    return { ok: false, error: upload.error ?? "Upload de PDF falló sin detalle" };
  }

  // 5. Mandar template
  const send = await sendTemplate(data, upload.mediaId, cred);
  if (!send.ok) {
    return {
      ok: false,
      mediaId: upload.mediaId,
      error: send.error ?? "Envío de template falló sin detalle",
    };
  }

  return { ok: true, mediaId: upload.mediaId, messageId: send.messageId };
}

const MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// ─────────────────────────────────────────────────────────────────────────────
// Envío de texto libre (Fase 7 — bot inbound)
// ─────────────────────────────────────────────────────────────────────────────
//
// Meta permite enviar texto libre (sin template aprobado) SOLO dentro de la
// ventana de 24h después de que el usuario nos haya escrito. El bot siempre
// está en esa ventana porque acaba de recibir el mensaje del huésped, así que
// esta función cubre el 100% de las respuestas del bot.
// ─────────────────────────────────────────────────────────────────────────────

export interface SendTextResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Envía un mensaje de texto plano (no template) al huésped.
 * Solo funciona dentro de la ventana de 24h después del último mensaje del usuario.
 *
 * @param toPhone E.164 sin '+'
 * @param text texto a enviar (Meta soporta hasta 4096 caracteres)
 * @param previewUrl si true, Meta genera la tarjeta de previsualización del primer
 *   link del texto (ej. un link de Google Maps → miniatura del mapa con el pin).
 *   Default false (igual que el comportamiento histórico de Meta).
 */
export async function sendTextMessage(
  toPhone: string,
  text: string,
  env: WhatsAppEnv,
  previewUrl = false,
): Promise<SendTextResult> {
  if (!env.WHATSAPP_ACCESS_TOKEN) {
    return { ok: false, error: "Falta env var WHATSAPP_ACCESS_TOKEN" };
  }
  if (!env.WHATSAPP_PHONE_NUMBER_ID) {
    return { ok: false, error: "Falta env var WHATSAPP_PHONE_NUMBER_ID" };
  }
  if (!toPhone || !isValidE164(toPhone)) {
    return { ok: false, error: `Teléfono inválido: "${toPhone}"` };
  }
  if (!text || text.trim().length === 0) {
    return { ok: false, error: "Texto vacío" };
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toPhone,
    type: "text",
    text: { body: text.slice(0, 4096), preview_url: previewUrl }, // hard cap Meta
  };

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${GRAPH_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      TIMEOUT.CRITICAL,
    );
  } catch (err) {
    return { ok: false, error: `Send text timeout/red: ${(err as Error).message}` };
  }

  const bodyText = await resp.text();
  if (!resp.ok) {
    return { ok: false, error: `Send text HTTP ${resp.status}: ${bodyText.slice(0, 500)}` };
  }

  let parsed: { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: `Send text JSON inválido: ${bodyText.slice(0, 200)}` };
  }

  if (parsed.error) {
    return {
      ok: false,
      error: `Send text Meta error ${parsed.error.code ?? "?"}: ${parsed.error.message ?? "desconocido"}`,
    };
  }

  const messageId = parsed.messages?.[0]?.id;
  if (!messageId) {
    return { ok: false, error: `Send text sin message id: ${bodyText.slice(0, 200)}` };
  }

  return { ok: true, messageId };
}

/**
 * Envía una imagen por su URL pública (HTTPS) al huésped.
 * Solo funciona dentro de la ventana de 24h. Meta descarga la imagen del link.
 *
 * @param toPhone  E.164 sin '+'
 * @param imageUrl URL pública HTTPS de la imagen (jpg/png, máx 5MB)
 * @param caption  Texto opcional debajo de la imagen
 */
export async function sendImageMessage(
  toPhone: string,
  imageUrl: string,
  env: WhatsAppEnv,
  caption?: string,
): Promise<SendTextResult> {
  if (!env.WHATSAPP_ACCESS_TOKEN) {
    return { ok: false, error: "Falta env var WHATSAPP_ACCESS_TOKEN" };
  }
  if (!env.WHATSAPP_PHONE_NUMBER_ID) {
    return { ok: false, error: "Falta env var WHATSAPP_PHONE_NUMBER_ID" };
  }
  if (!toPhone || !isValidE164(toPhone)) {
    return { ok: false, error: `Teléfono inválido: "${toPhone}"` };
  }
  if (!imageUrl || !/^https:\/\//i.test(imageUrl)) {
    return { ok: false, error: `URL de imagen inválida (requiere HTTPS): "${imageUrl}"` };
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toPhone,
    type: "image",
    image: caption
      ? { link: imageUrl, caption: caption.slice(0, 1024) }
      : { link: imageUrl },
  };

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${GRAPH_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      TIMEOUT.CRITICAL,
    );
  } catch (err) {
    return { ok: false, error: `Send image timeout/red: ${(err as Error).message}` };
  }

  const bodyText = await resp.text();
  if (!resp.ok) {
    return { ok: false, error: `Send image HTTP ${resp.status}: ${bodyText.slice(0, 500)}` };
  }

  let parsed: { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: `Send image JSON inválido: ${bodyText.slice(0, 200)}` };
  }

  if (parsed.error) {
    return {
      ok: false,
      error: `Send image Meta error ${parsed.error.code ?? "?"}: ${parsed.error.message ?? "desconocido"}`,
    };
  }

  const messageId = parsed.messages?.[0]?.id;
  if (!messageId) {
    return { ok: false, error: `Send image sin message id: ${bodyText.slice(0, 200)}` };
  }

  return { ok: true, messageId };
}

/**
 * POST genérico de un mensaje ya armado a /messages. Centraliza el fetch +
 * parseo + manejo de error (mismo patrón que sendTextMessage). Devuelve el
 * messageId de Meta o un error legible.
 */
async function postWhatsAppMessage(
  payload: Record<string, unknown>,
  env: WhatsAppEnv,
  label: string,
): Promise<SendTextResult> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${GRAPH_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      TIMEOUT.CRITICAL,
    );
  } catch (err) {
    return { ok: false, error: `${label} timeout/red: ${(err as Error).message}` };
  }

  const bodyText = await resp.text();
  if (!resp.ok) {
    return { ok: false, error: `${label} HTTP ${resp.status}: ${bodyText.slice(0, 500)}` };
  }

  let parsed: { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: `${label} JSON inválido: ${bodyText.slice(0, 200)}` };
  }

  if (parsed.error) {
    return {
      ok: false,
      error: `${label} Meta error ${parsed.error.code ?? "?"}: ${parsed.error.message ?? "desconocido"}`,
    };
  }

  const messageId = parsed.messages?.[0]?.id;
  if (!messageId) {
    return { ok: false, error: `${label} sin message id: ${bodyText.slice(0, 200)}` };
  }
  return { ok: true, messageId };
}

/**
 * Envía una TARJETA NATIVA de producto del catálogo de WhatsApp (Single Product
 * Message): imagen + nombre + precio + botón "Ver", todo dibujado por WhatsApp.
 * Requiere catálogo conectado al número + el producto cargado con su content ID
 * (= retailerId). Solo dentro de la ventana de 24h.
 *
 * @param toPhone     E.164 sin '+'
 * @param retailerId  content ID del producto en el catálogo (= slug de la propiedad)
 * @param bodyText    texto opcional que aparece ARRIBA de la tarjeta
 * @param footerText  texto opcional al pie (máx 60 chars)
 */
export async function sendProductMessage(
  toPhone: string,
  retailerId: string,
  env: WhatsAppEnv,
  bodyText?: string,
  footerText?: string,
): Promise<SendTextResult> {
  if (!env.WHATSAPP_ACCESS_TOKEN) {
    return { ok: false, error: "Falta env var WHATSAPP_ACCESS_TOKEN" };
  }
  if (!env.WHATSAPP_PHONE_NUMBER_ID) {
    return { ok: false, error: "Falta env var WHATSAPP_PHONE_NUMBER_ID" };
  }
  if (!env.WHATSAPP_CATALOG_ID) {
    return { ok: false, error: "Falta env var WHATSAPP_CATALOG_ID" };
  }
  if (!toPhone || !isValidE164(toPhone)) {
    return { ok: false, error: `Teléfono inválido: "${toPhone}"` };
  }
  if (!retailerId || retailerId.trim().length === 0) {
    return { ok: false, error: "Falta retailerId (content ID del producto)" };
  }

  const interactive: Record<string, unknown> = {
    type: "product",
    action: {
      catalog_id: env.WHATSAPP_CATALOG_ID,
      product_retailer_id: retailerId,
    },
  };
  if (bodyText && bodyText.trim().length > 0) {
    interactive.body = { text: bodyText.slice(0, 1024) };
  }
  if (footerText && footerText.trim().length > 0) {
    interactive.footer = { text: footerText.slice(0, 60) };
  }

  return postWhatsAppMessage(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toPhone,
      type: "interactive",
      interactive,
    },
    env,
    "Send product",
  );
}

/**
 * Envía un mensaje con BOTONES nativos de respuesta rápida (interactive reply
 * buttons). Máx 3 botones; título ≤20 chars (Meta los rechaza si se pasan) —
 * acá se truncan defensivamente. Mismo patrón y mismo retorno (SendTextResult)
 * que sendProductMessage/sendTextMessage, así el webhook loggea igual. Solo dentro
 * de la ventana de 24h. Ver button-map.ts para los ids y su mapeo al pipeline.
 */
export async function sendButtonsMessage(
  toPhone: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
  env: WhatsAppEnv,
): Promise<SendTextResult> {
  if (!env.WHATSAPP_ACCESS_TOKEN) {
    return { ok: false, error: "Falta env var WHATSAPP_ACCESS_TOKEN" };
  }
  if (!env.WHATSAPP_PHONE_NUMBER_ID) {
    return { ok: false, error: "Falta env var WHATSAPP_PHONE_NUMBER_ID" };
  }
  if (!toPhone || !isValidE164(toPhone)) {
    return { ok: false, error: `Teléfono inválido: "${toPhone}"` };
  }
  if (!bodyText || bodyText.trim().length === 0) {
    return { ok: false, error: "Texto vacío" };
  }
  const clean = (buttons ?? [])
    .filter((b) => b && b.id && b.title)
    .slice(0, 3) // Meta: máximo 3 reply buttons
    .map((b) => ({
      type: "reply",
      reply: {
        id: String(b.id).slice(0, 256),
        title: [...String(b.title)].slice(0, 20).join(""), // code-point-safe ≤20
      },
    }));
  if (clean.length === 0) {
    return { ok: false, error: "Sin botones válidos" };
  }

  return postWhatsAppMessage(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toPhone,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText.slice(0, 1024) },
        action: { buttons: clean },
      },
    },
    env,
    "Send buttons",
  );
}

export interface CatalogProduct {
  id: string;
  retailerId: string;
  name?: string;
  /** "in stock" / "out of stock" etc. según lo reporta Meta. */
  availability?: string;
  /** URL de la imagen PRINCIPAL que Meta tiene guardada para el producto. */
  imageUrl?: string;
  /** Imágenes ADICIONALES (galería que se ve al abrir la tarjeta; máx 10). */
  additionalImageUrls?: string[];
  /** "approved" / "pending" / "rejected" / "outdated" — elegibilidad para product messages. */
  reviewStatus?: string;
  /** "DIRECT_UPLOAD_SUCCESS" / "OUTDATED" / "FETCH_FAILED"… — estado de la imagen que causa el "obsoleto". */
  imageFetchStatus?: string;
  /** "published" / "staging" — si no está published, no sale en la tarjeta. */
  visibility?: string;
}

export interface ListCatalogProductsResult {
  ok: boolean;
  products?: CatalogProduct[];
  error?: string;
}

/**
 * Lista los productos que Meta tiene REALMENTE cargados en `env.WHATSAPP_CATALOG_ID`,
 * consultando la Graph API directo (fuente de verdad, no la UI de Commerce
 * Manager — un item puede verse "Disponible" ahí y aun así vivir en OTRO
 * catalog_id que no es el que el bot usa). Usado por el diagnóstico
 * `/api/admin/catalog-check` para confirmar, retailerId por retailerId, si
 * `sendProductMessage` debería poder encontrarlo.
 */
export async function listCatalogProducts(
  env: WhatsAppEnv,
  tokenOverride?: string,
): Promise<ListCatalogProductsResult> {
  // El token de WhatsApp (whatsapp_business_messaging) NO puede leer el Catalog
  // API — devuelve #100. Para eso se pasa `tokenOverride` = un System User token
  // con `catalog_management` (env CATALOG_ADMIN_TOKEN). Sin override, usa el de
  // WhatsApp (sirve para confirmar el catalog_id aunque el listado falle).
  const token = tokenOverride || env.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    return { ok: false, error: "Falta token (WHATSAPP_ACCESS_TOKEN o CATALOG_ADMIN_TOKEN)" };
  }
  if (!env.WHATSAPP_CATALOG_ID) {
    return { ok: false, error: "Falta env var WHATSAPP_CATALOG_ID" };
  }

  const headers = { Authorization: `Bearer ${token}` };
  const products: CatalogProduct[] = [];
  let url: string | undefined =
    `${GRAPH_API_BASE}/${env.WHATSAPP_CATALOG_ID}/products?fields=id,retailer_id,name,availability,image_url,additional_image_urls,review_status,image_fetch_status,visibility&limit=200`;

  // Tope de 5 páginas (1000 productos) — de sobra para un catálogo de 7 casas;
  // solo existe para no quedar en loop infinito si Meta devuelve paging raro.
  for (let page = 0; page < 5 && url; page++) {
    let resp: Response;
    try {
      resp = await fetchWithTimeout(url, { headers }, TIMEOUT.STANDARD);
    } catch (err) {
      return { ok: false, error: `Timeout/red listando catálogo: ${(err as Error).message}` };
    }

    const bodyText = await resp.text();
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}: ${bodyText.slice(0, 500)}` };
    }

    let parsed: {
      data?: Array<{
        id: string;
        retailer_id?: string;
        name?: string;
        availability?: string;
        image_url?: string;
        additional_image_urls?: string[];
        review_status?: string;
        image_fetch_status?: string;
        visibility?: string;
      }>;
      paging?: { next?: string };
      error?: { message?: string; code?: number };
    };
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return { ok: false, error: `JSON inválido: ${bodyText.slice(0, 200)}` };
    }
    if (parsed.error) {
      return {
        ok: false,
        error: `Meta error ${parsed.error.code ?? "?"}: ${parsed.error.message ?? "desconocido"}`,
      };
    }

    for (const item of parsed.data ?? []) {
      products.push({
        id: item.id,
        retailerId: item.retailer_id ?? "",
        name: item.name,
        availability: item.availability,
        imageUrl: item.image_url,
        additionalImageUrls: item.additional_image_urls,
        reviewStatus: item.review_status,
        imageFetchStatus: item.image_fetch_status,
        visibility: item.visibility,
      });
    }
    url = parsed.paging?.next;
  }

  return { ok: true, products };
}

export interface UpdateProductImageResult {
  ok: boolean;
  /** Respuesta cruda de Meta (para diagnosticar la forma exacta si algo falla). */
  metaResponse?: unknown;
  error?: string;
}

/**
 * Cambia la imagen PRINCIPAL y (opcional) la GALERÍA de UN producto del catálogo
 * (nodo ProductItem): `POST /{productItemId}` con `image_url` + `additional_image_urls`.
 * Síncrono — Meta responde éxito/fallo al toque. Requiere un token con
 * `catalog_management` (el de WhatsApp NO sirve, da #100).
 *
 * @param productItemId       fbid del producto (campo `id` de listCatalogProducts, NO el retailer_id)
 * @param imageUrl            URL absoluta y pública de la portada principal (debe responder 200)
 * @param token               System User token con catalog_management (env CATALOG_ADMIN_TOKEN)
 * @param additionalImageUrls hasta 10 URLs adicionales (la galería al abrir la tarjeta). Opcional.
 */
export async function updateProductImage(
  productItemId: string,
  imageUrl: string,
  token: string,
  additionalImageUrls?: string[],
): Promise<UpdateProductImageResult> {
  if (!token) return { ok: false, error: "Falta token de catálogo" };
  if (!productItemId) return { ok: false, error: "Falta productItemId" };
  if (!imageUrl) return { ok: false, error: "Falta imageUrl" };

  const params: Record<string, string> = { image_url: imageUrl };
  if (additionalImageUrls && additionalImageUrls.length > 0) {
    // Los arrays en el Graph API (form-urlencoded) van como JSON string. Meta
    // permite hasta 10 imágenes adicionales; cortamos defensivamente.
    params.additional_image_urls = JSON.stringify(additionalImageUrls.slice(0, 10));
  }

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${GRAPH_API_BASE}/${productItemId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          // Las escrituras del Graph API son form-urlencoded, no JSON.
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params).toString(),
      },
      TIMEOUT.CRITICAL,
    );
  } catch (err) {
    return { ok: false, error: `Timeout/red actualizando imagen: ${(err as Error).message}` };
  }

  const bodyText = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: `JSON inválido: ${bodyText.slice(0, 200)}` };
  }

  if (!resp.ok || (parsed as { error?: unknown })?.error) {
    const e = (parsed as { error?: { message?: string; code?: number } }).error;
    return {
      ok: false,
      metaResponse: parsed,
      error: e ? `Meta error ${e.code ?? "?"}: ${e.message ?? "desconocido"}` : `HTTP ${resp.status}`,
    };
  }

  // Meta responde `{ "success": true }` al actualizar un ProductItem.
  return { ok: true, metaResponse: parsed };
}

/**
 * Envía una UBICACIÓN nativa de WhatsApp (pin sobre el mapa, con nombre y
 * dirección). Se ve como cuando uno comparte su ubicación: miniatura del mapa,
 * tocable, abre la app de mapas del huésped para navegar. Solo dentro de la
 * ventana de 24h.
 */
export async function sendLocationMessage(
  toPhone: string,
  loc: { latitude: number; longitude: number; name: string; address: string },
  env: WhatsAppEnv,
): Promise<SendTextResult> {
  if (!env.WHATSAPP_ACCESS_TOKEN) return { ok: false, error: "Falta WHATSAPP_ACCESS_TOKEN" };
  if (!env.WHATSAPP_PHONE_NUMBER_ID) return { ok: false, error: "Falta WHATSAPP_PHONE_NUMBER_ID" };
  if (!toPhone || !isValidE164(toPhone)) return { ok: false, error: `Teléfono inválido: "${toPhone}"` };

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toPhone,
    type: "location",
    location: {
      latitude: loc.latitude,
      longitude: loc.longitude,
      name: loc.name.slice(0, 1000),
      address: loc.address.slice(0, 1000),
    },
  };

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${GRAPH_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      TIMEOUT.CRITICAL,
    );
  } catch (err) {
    return { ok: false, error: `Send location timeout/red: ${(err as Error).message}` };
  }

  const bodyText = await resp.text();
  if (!resp.ok) return { ok: false, error: `Send location HTTP ${resp.status}: ${bodyText.slice(0, 400)}` };

  let parsed: { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: `Send location JSON inválido: ${bodyText.slice(0, 200)}` };
  }
  if (parsed.error) return { ok: false, error: `Send location Meta error ${parsed.error.code ?? "?"}: ${parsed.error.message ?? "desconocido"}` };

  const messageId = parsed.messages?.[0]?.id;
  if (!messageId) return { ok: false, error: `Send location sin message id: ${bodyText.slice(0, 200)}` };

  return { ok: true, messageId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Media genérico — para lo que César sube desde el inbox (imágenes / videos /
// notas de voz / documentos). Flujo de 2 pasos, igual que el PDF de check-in:
//   1. uploadMediaToMeta → POST /{PHONE_NUMBER_ID}/media (FormData) → media_id
//   2. sendMediaById     → POST /{PHONE_NUMBER_ID}/messages con ese media_id
// Solo funciona dentro de la ventana de 24h del cliente (igual que el texto libre).
// ─────────────────────────────────────────────────────────────────────────────

export type MediaKind = "image" | "video" | "audio" | "document";

export interface UploadMediaResult {
  ok: boolean;
  mediaId?: string;
  error?: string;
}

/**
 * Sube un archivo binario a Meta Media y devuelve su media_id (válido ~30 días).
 * `mime` debe ser un tipo soportado por WhatsApp (image/jpeg, video/mp4, etc.).
 */
export async function uploadMediaToMeta(
  bytes: Uint8Array,
  mime: string,
  filename: string,
  env: WhatsAppEnv,
): Promise<UploadMediaResult> {
  if (!env.WHATSAPP_ACCESS_TOKEN) return { ok: false, error: "Falta WHATSAPP_ACCESS_TOKEN" };
  if (!env.WHATSAPP_PHONE_NUMBER_ID) return { ok: false, error: "Falta WHATSAPP_PHONE_NUMBER_ID" };
  if (!bytes || bytes.byteLength === 0) return { ok: false, error: "Archivo vacío" };

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
  form.append("file", blob, filename);

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${GRAPH_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/media`,
      { method: "POST", headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` }, body: form },
      TIMEOUT.CRITICAL,
    );
  } catch (err) {
    return { ok: false, error: `Upload media timeout/red: ${(err as Error).message}` };
  }

  const bodyText = await resp.text();
  if (!resp.ok) return { ok: false, error: `Upload media HTTP ${resp.status}: ${bodyText.slice(0, 400)}` };

  let parsed: { id?: string };
  try {
    parsed = JSON.parse(bodyText) as { id?: string };
  } catch {
    return { ok: false, error: `Upload media JSON inválido: ${bodyText.slice(0, 200)}` };
  }
  if (!parsed.id) return { ok: false, error: `Upload media sin id: ${bodyText.slice(0, 200)}` };

  return { ok: true, mediaId: parsed.id };
}

/**
 * Envía un media ya subido (por su media_id) al cliente. `kind` define el tipo
 * de mensaje de WhatsApp. `caption` aplica a image/video/document (audio no).
 * Solo dentro de la ventana de 24h del cliente.
 */
export async function sendMediaById(
  toPhone: string,
  kind: MediaKind,
  mediaId: string,
  env: WhatsAppEnv,
  opts?: { caption?: string; filename?: string },
): Promise<SendTextResult> {
  if (!env.WHATSAPP_ACCESS_TOKEN) return { ok: false, error: "Falta WHATSAPP_ACCESS_TOKEN" };
  if (!env.WHATSAPP_PHONE_NUMBER_ID) return { ok: false, error: "Falta WHATSAPP_PHONE_NUMBER_ID" };
  if (!toPhone || !isValidE164(toPhone)) return { ok: false, error: `Teléfono inválido: "${toPhone}"` };
  if (!mediaId) return { ok: false, error: "media_id vacío" };

  const caption = opts?.caption?.slice(0, 1024) || undefined;
  const mediaObj: Record<string, string> = { id: mediaId };
  if (kind !== "audio" && caption) mediaObj.caption = caption; // audio no acepta caption
  if (kind === "document" && opts?.filename) mediaObj.filename = opts.filename;

  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toPhone,
    type: kind,
    [kind]: mediaObj,
  };

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${GRAPH_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      TIMEOUT.CRITICAL,
    );
  } catch (err) {
    return { ok: false, error: `Send media timeout/red: ${(err as Error).message}` };
  }

  const bodyText = await resp.text();
  if (!resp.ok) return { ok: false, error: `Send media HTTP ${resp.status}: ${bodyText.slice(0, 400)}` };

  let parsed: { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: `Send media JSON inválido: ${bodyText.slice(0, 200)}` };
  }
  if (parsed.error) return { ok: false, error: `Send media Meta error ${parsed.error.code ?? "?"}: ${parsed.error.message ?? "desconocido"}` };

  const messageId = parsed.messages?.[0]?.id;
  if (!messageId) return { ok: false, error: `Send media sin message id: ${bodyText.slice(0, 200)}` };

  return { ok: true, messageId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: formato de fecha en español para la variable {{3}} del template.
// "2026-05-26" + checkIn=hoy → "hoy, 26 de mayo"
// "2026-05-26" + checkIn=mañana → "mañana, 26 de mayo"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construye la variable {{3}} del template. Si es hoy/mañana lo dice explícito
 * porque ayuda al huésped a leer el mensaje rápido en la notificación push.
 */
export function formatCheckinDateForTemplate(
  checkInISO: string,
  todayISO: string,
): string {
  const [y, m, d] = checkInISO.split("-").map(Number);
  if (!y || !m || !d) return checkInISO;
  const human = `${d} de ${MONTHS_ES[m - 1]}`;

  if (checkInISO === todayISO) {
    return `hoy, ${human}`;
  }
  // Calcular si es mañana sin crear Date completos (evitar drift de timezone).
  const todayParts = todayISO.split("-").map(Number);
  if (todayParts.length === 3) {
    const todayDate = new Date(Date.UTC(todayParts[0], todayParts[1] - 1, todayParts[2]));
    const checkDate = new Date(Date.UTC(y, m - 1, d));
    const diffDays = Math.round((checkDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 1) return `mañana, ${human}`;
  }
  return human;
}

// ─────────────────────────────────────────────────────────────────────────────
// Descargar un media ENTRANTE (foto del cliente) por su media_id.
// 2 pasos de la Graph API: GET /{mediaId} → URL temporal; GET esa URL (con el
// token) → bytes. Devuelve base64 + mime para mandárselo a un modelo de visión
// (lectura de comprobantes de transferencia).
// ─────────────────────────────────────────────────────────────────────────────

export async function downloadMedia(
  mediaId: string,
  env: { WHATSAPP_ACCESS_TOKEN?: string },
): Promise<{ ok: boolean; base64?: string; mime?: string; error?: string }> {
  if (!env.WHATSAPP_ACCESS_TOKEN) return { ok: false, error: "Falta WHATSAPP_ACCESS_TOKEN" };
  try {
    const metaResp = await fetchWithTimeout(
      `${GRAPH_API_BASE}/${mediaId}`,
      { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` } },
      TIMEOUT.CRITICAL,
    );
    if (!metaResp.ok) return { ok: false, error: `media meta HTTP ${metaResp.status}` };
    const meta = (await metaResp.json().catch(() => ({}))) as { url?: string; mime_type?: string };
    if (!meta.url) return { ok: false, error: "media sin url" };

    const fileResp = await fetchWithTimeout(
      meta.url,
      { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` } },
      TIMEOUT.CRITICAL,
    );
    if (!fileResp.ok) return { ok: false, error: `media file HTTP ${fileResp.status}` };
    const buf = await fileResp.arrayBuffer();
    return { ok: true, base64: arrayBufferToBase64(buf), mime: meta.mime_type ?? "image/jpeg" };
  } catch (err) {
    return { ok: false, error: `downloadMedia error: ${(err as Error).message}` };
  }
}

/** ArrayBuffer → base64 en chunks (evita el stack overflow de String.fromCharCode con buffers grandes). */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
