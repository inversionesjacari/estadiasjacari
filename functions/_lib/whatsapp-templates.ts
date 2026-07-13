/// <reference types="@cloudflare/workers-types" />
//
// Wrappers para los 6 templates UTILITY operativos (Sprint 1).
//
// El template `checkin_instructions` (T-1 día huésped, con PDF) se sigue
// gestionando en `whatsapp.ts` (función `sendCheckinReminderWhatsApp`) porque
// requiere upload de media a Meta — flujo de 2 pasos distinto a los demás.
//
// Los templates de este archivo son texto puro (sin media) con N variables:
//
//   1. confirmacion_whatsapp_capturado   — al detectar # del huésped
//   3. checkin_dia_huesped               — día llegada, huésped, 10 AM HN
//   4. checkin_dia_limpieza              — día llegada, limpieza (solo manual;
//                                          el aviso automático a limpieza es el 8)
//   5. checkin_dia_seguridad             — día llegada, seguridad, 7 AM HN
//   6. checkout_dia_huesped              — día salida, huésped, 10 AM HN
//   7. checkout_dia_limpieza             — día salida, limpieza, 11:30 AM HN
//   8. limpieza_aviso_entrada            — VÍSPERA de llegada, limpieza, 6 PM HN
//
// Los nombres EXACTOS de los templates deben coincidir con los registrados
// en Meta. El idioma `es` se mantiene consistente con el template existente
// `checkin_instructions`.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { fetchWithTimeout, TIMEOUT } from "./fetch";
import { isValidE164 } from "./phone";

const GRAPH_API_BASE = "https://graph.facebook.com/v25.0";
const TEMPLATE_LANG = "es";

export interface WhatsAppTemplatesEnv {
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

export interface SendTemplateResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Función genérica: enviar un template SIN media (solo texto en variables)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Envía un template UTILITY pre-aprobado de Meta a un número en E.164 sin '+'.
 * Solo soporta templates con BODY de variables texto. Para templates con header
 * tipo document/image/video usar las funciones específicas de `whatsapp.ts`.
 *
 * Nunca lanza excepción — devuelve `{ok:false, error}` si algo falla.
 */
export async function sendTextTemplate(
  templateName: string,
  toPhone: string,
  bodyVariables: string[],
  env: WhatsAppTemplatesEnv,
): Promise<SendTemplateResult> {
  // Validar config
  if (!env.WHATSAPP_ACCESS_TOKEN) {
    return { ok: false, error: "Falta env var WHATSAPP_ACCESS_TOKEN" };
  }
  if (!env.WHATSAPP_PHONE_NUMBER_ID) {
    return { ok: false, error: "Falta env var WHATSAPP_PHONE_NUMBER_ID" };
  }
  if (!toPhone || !isValidE164(toPhone)) {
    return {
      ok: false,
      error: `Teléfono destino inválido: "${toPhone}" (esperado E.164 sin '+', 8-15 dígitos)`,
    };
  }

  // Construir payload Meta Cloud API
  const components: Array<{
    type: string;
    parameters?: Array<{ type: string; text: string }>;
  }> = [];

  if (bodyVariables.length > 0) {
    components.push({
      type: "body",
      parameters: bodyVariables.map((v) => ({
        type: "text",
        text: String(v ?? ""), // null/undefined → "" para no romper el envío
      })),
    });
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toPhone,
    type: "template",
    template: {
      name: templateName,
      language: { code: TEMPLATE_LANG },
      ...(components.length > 0 ? { components } : {}),
    },
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
    return {
      ok: false,
      error: `Send template "${templateName}" timeout/red: ${(err as Error).message}`,
    };
  }

  const bodyText = await resp.text();
  if (!resp.ok) {
    return {
      ok: false,
      error: `Send template "${templateName}" HTTP ${resp.status}: ${bodyText.slice(0, 500)}`,
    };
  }

  let parsed: {
    messages?: Array<{ id?: string }>;
    error?: { message?: string; code?: number };
  };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      ok: false,
      error: `Send template "${templateName}" JSON inválido: ${bodyText.slice(0, 200)}`,
    };
  }

  if (parsed.error) {
    return {
      ok: false,
      error: `Meta error ${parsed.error.code ?? "?"} (${templateName}): ${parsed.error.message ?? "desconocido"}`,
    };
  }

  const messageId = parsed.messages?.[0]?.id;
  if (!messageId) {
    return {
      ok: false,
      error: `Meta sin message id (${templateName}): ${bodyText.slice(0, 200)}`,
    };
  }

  return { ok: true, messageId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wrappers tipados — uno por template
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Template 1 — confirmacion_whatsapp_capturado
 *
 * Trigger: al detectar el número de WhatsApp del huésped por primera vez
 * (parser de la respuesta del huésped al Scheduled Message de Airbnb).
 *
 * Variables:
 *   {{1}} = nombre del huésped (ej. "Wander Jeremias")
 *   {{2}} = nombre de la propiedad (ej. "Casa Brisa")
 *   {{3}} = fecha de check-in en español (ej. "29 de mayo")
 *   {{4}} = fecha de check-out en español (ej. "1 de junio")
 */
export interface ConfirmacionWaCapturadoData {
  toPhone: string;
  guestName: string;
  propertyName: string;
  checkInDateEs: string;
  checkOutDateEs: string;
}

export function sendConfirmacionWhatsappCapturado(
  data: ConfirmacionWaCapturadoData,
  env: WhatsAppTemplatesEnv,
): Promise<SendTemplateResult> {
  return sendTextTemplate(
    "confirmacion_whatsapp_capturado",
    data.toPhone,
    [data.guestName, data.propertyName, data.checkInDateEs, data.checkOutDateEs],
    env,
  );
}

/**
 * Template 3 — checkin_dia_huesped
 *
 * Trigger: cron 9 AM HN del día del check-in.
 *
 * Variables:
 *   {{1}} = nombre del huésped
 *   {{2}} = nombre de la propiedad
 *   {{3}} = ciudad (La Ceiba / Tela / Tegucigalpa)
 */
export interface CheckinDiaHuespedData {
  toPhone: string;
  guestName: string;
  propertyName: string;
  city: string;
}

export function sendCheckinDiaHuesped(
  data: CheckinDiaHuespedData,
  env: WhatsAppTemplatesEnv,
): Promise<SendTemplateResult> {
  return sendTextTemplate(
    "checkin_dia_huesped",
    data.toPhone,
    [data.guestName, data.propertyName, data.city],
    env,
  );
}

/**
 * Template 4 — checkin_dia_limpieza
 *
 * Trigger: cron 7 AM HN del día del check-in. Se envía a cada contacto activo
 * de la propiedad con role='cleaning'.
 *
 * Variables:
 *   {{1}} = nombre del personal de limpieza
 *   {{2}} = nombre de la propiedad
 *   {{3}} = fecha de salida en español (ej. "1 de junio")
 */
export interface CheckinDiaLimpiezaData {
  toPhone: string;
  cleanerName: string;
  propertyName: string;
  checkOutDateEs: string;
}

export function sendCheckinDiaLimpieza(
  data: CheckinDiaLimpiezaData,
  env: WhatsAppTemplatesEnv,
): Promise<SendTemplateResult> {
  return sendTextTemplate(
    "checkin_dia_limpieza",
    data.toPhone,
    [data.cleanerName, data.propertyName, data.checkOutDateEs],
    env,
  );
}

/**
 * Template 5 — checkin_dia_seguridad
 *
 * Trigger: cron 7 AM HN del día del check-in. Se envía a cada contacto activo
 * de la propiedad con role='security'.
 *
 * El guardia cubre varias propiedades con un mismo número y no distingue casa;
 * por eso el mensaje solo lleva el titular del grupo + la fecha de salida.
 *
 * Variables:
 *   {{1}} = nombre completo del titular de la reserva
 *   {{2}} = fecha de salida en español (ej. "2 de junio")
 */
export interface CheckinDiaSeguridadData {
  toPhone: string;
  guestFullName: string;
  checkOutDateEs: string;
}

export function sendCheckinDiaSeguridad(
  data: CheckinDiaSeguridadData,
  env: WhatsAppTemplatesEnv,
): Promise<SendTemplateResult> {
  return sendTextTemplate(
    "checkin_dia_seguridad",
    data.toPhone,
    [data.guestFullName, data.checkOutDateEs],
    env,
  );
}

/**
 * Propiedades cuya SEGURIDAD recibe el aviso ENRIQUECIDO (template
 * `seguridad_llegada`, más datos) en vez del `checkin_dia_seguridad` genérico.
 * Villa B11 (garita propia del Hotel Palma Real) pide identificar al huésped;
 * su garita necesita entrada, salida y cantidad de personas (César 2026-07-13).
 * Ampliar este set para sumar más propiedades a futuro.
 */
export const SECURITY_ENRICHED_SLUGS = new Set<string>(["villa-b11-palma-real"]);

/**
 * Template 5b — seguridad_llegada (aviso a seguridad ENRIQUECIDO, FASE 1)
 *
 * Trigger: cron 7 AM HN del día del check-in, SOLO para propiedades en
 * SECURITY_ENRICHED_SLUGS. Se envía a cada contacto activo con role='security'.
 * A diferencia de checkin_dia_seguridad, lleva propiedad + fechas + cantidad de
 * personas (lo que la garita necesita para autorizar el ingreso). La FOTO de la
 * identidad es FASE 2 (requiere un template con header de imagen aparte).
 *
 * Variables:
 *   {{1}} = nombre de la propiedad (ej. "Villa B11 — Palma Real")
 *   {{2}} = nombre completo del titular
 *   {{3}} = fecha de ENTRADA en español (ej. "14 de julio")
 *   {{4}} = fecha de SALIDA en español (ej. "16 de julio")
 *   {{5}} = cantidad de huéspedes (ej. "6")
 */
export interface SeguridadLlegadaData {
  toPhone: string;
  propertyName: string;
  guestFullName: string;
  checkInDateEs: string;
  checkOutDateEs: string;
  guestCount: number;
}

export function sendSeguridadLlegada(
  data: SeguridadLlegadaData,
  env: WhatsAppTemplatesEnv,
): Promise<SendTemplateResult> {
  return sendTextTemplate(
    "seguridad_llegada",
    data.toPhone,
    [
      data.propertyName,
      data.guestFullName,
      data.checkInDateEs,
      data.checkOutDateEs,
      String(data.guestCount),
    ],
    env,
  );
}

/**
 * Template 6 — checkout_dia_huesped
 *
 * Trigger: cron 9 AM HN del día del checkout.
 *
 * Variables:
 *   {{1}} = nombre del huésped
 *   {{2}} = nombre de la propiedad
 */
export interface CheckoutDiaHuespedData {
  toPhone: string;
  guestName: string;
  propertyName: string;
}

export function sendCheckoutDiaHuesped(
  data: CheckoutDiaHuespedData,
  env: WhatsAppTemplatesEnv,
): Promise<SendTemplateResult> {
  return sendTextTemplate(
    "checkout_dia_huesped",
    data.toPhone,
    [data.guestName, data.propertyName],
    env,
  );
}

/**
 * Template 7 — checkout_dia_limpieza
 *
 * Trigger: cron 11:30 AM HN del día del checkout. Se envía a cada contacto
 * activo de la propiedad con role='cleaning'.
 *
 * Variables:
 *   {{1}} = nombre del personal de limpieza
 *   {{2}} = nombre de la propiedad
 *   {{3}} = fecha del próximo check-in en español (o "sin reserva próxima")
 */
export interface CheckoutDiaLimpiezaData {
  toPhone: string;
  cleanerName: string;
  propertyName: string;
  nextCheckInLabel: string;
}

export function sendCheckoutDiaLimpieza(
  data: CheckoutDiaLimpiezaData,
  env: WhatsAppTemplatesEnv,
): Promise<SendTemplateResult> {
  return sendTextTemplate(
    "checkout_dia_limpieza",
    data.toPhone,
    [data.cleanerName, data.propertyName, data.nextCheckInLabel],
    env,
  );
}

/**
 * Template 8 — limpieza_aviso_entrada
 *
 * Trigger: cron 6 PM HN de la VÍSPERA del check-in (hito evening-staff de
 * whatsapp-operations). Se envía a cada contacto activo de la propiedad con
 * role='cleaning' para que el personal planifique con un día de anticipación.
 * Decisión César 2026-07-12: este aviso REEMPLAZA al de las 7 AM del día-de
 * para limpieza (checkin_dia_limpieza queda solo para disparo manual).
 *
 * Variables:
 *   {{1}} = nombre del personal de limpieza
 *   {{2}} = fecha de entrada en español (ej. "13 de julio")
 *   {{3}} = nombre de la propiedad
 *   {{4}} = fecha de salida en español (ej. "15 de julio")
 */
export interface LimpiezaAvisoEntradaData {
  toPhone: string;
  cleanerName: string;
  checkInDateEs: string;
  propertyName: string;
  checkOutDateEs: string;
}

export function sendLimpiezaAvisoEntrada(
  data: LimpiezaAvisoEntradaData,
  env: WhatsAppTemplatesEnv,
): Promise<SendTemplateResult> {
  return sendTextTemplate(
    "limpieza_aviso_entrada",
    data.toPhone,
    [data.cleanerName, data.checkInDateEs, data.propertyName, data.checkOutDateEs],
    env,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de formato de fecha en español (usado por wrappers)
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** Convierte "2026-05-29" → "29 de mayo". */
export function formatDateShortEs(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} de ${MONTHS_ES[m - 1]}`;
}
