/// <reference types="@cloudflare/workers-types" />
//
// owner-copilot.ts — MODO PROPIETARIO: cuando César o Eduardo le escriben al
// bot, no son leads — son los dueños. Este módulo es (1) la fuente ÚNICA de
// "quiénes son los dueños" para todo el lado inbound (webhook, métricas,
// followups) y (2) el COPILOTO interno que les responde: cotizaciones/fichas/
// fotos listas para REENVIAR a huéspedes, e info operativa que un huésped
// jamás vería (marcada "🔒 interno").
//
// Arquitectura (plan 2026-07-25): el LLM solo CLASIFICA y extrae (action +
// campos); las MANOS son un dispatcher determinístico que ejecuta con las
// herramientas reales (buildQuote, availability, D1). Regla de la casa que acá
// también manda: el LLM JAMÁS tiene la última palabra sobre plata.
//
// owner-alerts.ts importa OWNER_PHONES de acá (destinatarios de alertas =
// dueños reconocidos en la entrada; una sola lista, cero drift).
//
// Memoria multi-turno: getConversationHistory (whatsapp_messages). El copiloto
// NUNCA lee ni escribe conversation_state → cero followups, cero embudo.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import type { PropertySlug } from "./quote-extractor";
import { normalizePhone, isValidE164 } from "./phone";
import { VALID_PROPERTIES, ISO_DATE } from "./llm-schema";
import { buildQuote, formatQuoteMessage, PROPERTY_PRICING } from "./quote-builder";
import { buildPricingMap, buildKnowledgeBaseText } from "./kb-store";
import { checkRangeAvailable, checkGemelasAvailable, type AvailabilityEnv } from "./availability";
import { buildPropertyCard } from "./property-catalog";
import { getPropertyPhotos, getGalleryUrl, getCatalogUrl } from "./property-photos";
import { overlapSlugs, slugPlaceholders } from "./slug-overlap";
import { callOpenAIJson } from "./openai";
import { callWorkersAIJson, type AIMessage, type WorkersAIEnv } from "./workers-ai";
import { getConversationHistory, fechaEnPalabras } from "./conversational-bot";
import { createPayPalOrder, type PayPalEnv } from "./paypal-checkout";
import { buildTransferMessageHNL, buildTransferMessageUSD } from "./bank-transfer";
import { T } from "./i18n";

// ─────────────────────────────────────────────────────────────────────────────
// Identidad
// ─────────────────────────────────────────────────────────────────────────────

/** Dueños de Estadías Jacarí (E.164 sin '+'): César + Eduardo. Confirmados por
 *  César el 2026-07-25 para el modo propietario. */
export const OWNER_PHONES = ["50497649035", "50498035697"] as const;

/** ¿El teléfono es de un dueño? Tolera el '+' inicial y espacios. */
export function isOwnerPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const normalized = phone.replace(/[\s+]/g, "");
  return (OWNER_PHONES as readonly string[]).includes(normalized);
}

/** Literal SQL para `NOT IN (...)` en queries de métricas/followups. Seguro de
 *  interpolar: constantes de módulo, jamás input de usuario. */
export const OWNER_PHONES_SQL = OWNER_PHONES.map((p) => `'${p}'`).join(",");

// ─────────────────────────────────────────────────────────────────────────────
// STAFF (2026-08-20, entra Isaías al copiloto)
//
// El copiloto ahora atiende DOS roles: "owner" (César/Eduardo — todo) y "staff"
// (empleados — disponibilidad, tarifas/cotizaciones, fichas, fotos y links de
// pago; SIN resumen del mes ni nada que huela a ingresos del negocio; los
// montos custom en links de pago también les están vedados).
//
// Los teléfonos del staff NO van hardcodeados: viven en la env var STAFF_PHONES
// (lista separada por comas, con o sin '+'), así César suma o borra empleados
// sin tocar código. Cambiarla requiere un redeploy de Pages (Retry deployment).
// Sin la variable seteada, el rol staff NO existe y todo queda como antes.
// ─────────────────────────────────────────────────────────────────────────────

export type CopilotRole = "owner" | "staff";

export interface CopilotIdentityEnv {
  /** Teléfonos del staff, separados por coma (ej. "50412345678, +504 8765-4321"). */
  STAFF_PHONES?: string;
  /** Nombre a mostrar del empleado (mismo default que el inbox). */
  STAFF_NAME?: string;
}

/** Parsea STAFF_PHONES a E.164 pelado (solo dígitos). Dedup, y los dueños se
 *  filtran: si César se lista a sí mismo por error, sigue siendo owner.
 *
 *  FORMATO: separado por COMAS (cada entrada puede traer '+', espacios y
 *  guiones internos). OJO adversaria 2026-08-20: una lista separada solo por
 *  ESPACIOS concatenaría todos los números en un token gigante — el tope de 15
 *  dígitos (máximo E.164) lo descarta en vez de crear un "teléfono" fantasma. */
export function staffPhonesFromEnv(env: CopilotIdentityEnv): string[] {
  if (!env.STAFF_PHONES) return [];
  const out: string[] = [];
  for (const piece of env.STAFF_PHONES.split(/[,;]+/)) {
    const digits = piece.replace(/\D/g, "");
    // 8-15 dígitos = un teléfono plausible (E.164 topea en 15); basura fuera de
    // rango se ignora en silencio (una env var rota no debe tumbar el webhook).
    if (digits.length >= 8 && digits.length <= 15 && !out.includes(digits) && !(OWNER_PHONES as readonly string[]).includes(digits)) {
      out.push(digits);
    }
  }
  return out;
}

/** ¿El teléfono es de un empleado? Tolera '+', espacios y guiones (se compara
 *  por dígitos, igual que el parser de la env var). */
export function isStaffPhone(phone: string | null | undefined, env: CopilotIdentityEnv): boolean {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "");
  return digits.length > 0 && staffPhonesFromEnv(env).includes(digits);
}

/** Rol del copiloto para este teléfono, o null si es un lead normal.
 *  Owner se evalúa PRIMERO: ante cualquier ambigüedad gana el rol con más
 *  acceso para César, nunca al revés. */
export function copilotRoleFor(phone: string | null | undefined, env: CopilotIdentityEnv): CopilotRole | null {
  if (isOwnerPhone(phone)) return "owner";
  if (isStaffPhone(phone, env)) return "staff";
  return null;
}

/** Literal SQL `'a','b',...` con dueños + staff, para los `NOT IN (...)` de
 *  métricas/inbox/followups: los chats del equipo con el copiloto no son leads.
 *  Seguro de interpolar: staffPhonesFromEnv reduce cada entrada a SOLO dígitos
 *  (nada inyectable), y los dueños son constantes de módulo. */
export function nonLeadPhonesSql(env: CopilotIdentityEnv): string {
  const all = [...OWNER_PHONES, ...staffPhonesFromEnv(env)];
  return all.map((p) => `'${p}'`).join(",");
}

// ─────────────────────────────────────────────────────────────────────────────
// Esquema del LLM (el cerebro solo clasifica/extrae)
// ─────────────────────────────────────────────────────────────────────────────

export type CopilotAction =
  | "quote"           // cotización completa reenviable
  | "property_card"   // ficha de la propiedad
  | "photos"          // fotos + link a galería
  | "payment_link"    // link PayPal para el HUÉSPED (B5)
  | "transfer_info"   // datos de transferencia con monto (B5)
  | "availability"    // disponibilidad con detalle interno
  | "ops_today"       // llegadas/salidas hoy y mañana
  | "ops_month"       // reservas del mes
  | "kb_answer"       // respuesta libre desde la KB (sin plata)
  | "clarify";        // falta un dato → preguntar

const VALID_ACTIONS: CopilotAction[] = [
  "quote", "property_card", "photos", "payment_link", "transfer_info",
  "availability", "ops_today", "ops_month", "kb_answer", "clarify",
];

export interface CopilotFields {
  action: CopilotAction;
  property: PropertySlug | null;
  checkIn: string | null;
  checkOut: string | null;
  guests: number | null;
  adults: number | null;
  children: number | null;
  /** Monto USD explícito para payment_link (0 < x ≤ 10000). */
  amountUsd: number | null;
  /** Monto HNL explícito para transfer_info (0 < x ≤ 500000). */
  amountHnl: number | null;
  /** Teléfono del CLIENTE (E.164 normalizado) para payment_link. */
  guestPhone: string | null;
  /** Solo lo usan kb_answer / clarify. */
  reply: string | null;
}

const EMPTY_COPILOT_FIELDS: CopilotFields = {
  action: "clarify",
  property: null,
  checkIn: null,
  checkOut: null,
  guests: null,
  adults: null,
  children: null,
  amountUsd: null,
  amountHnl: null,
  guestPhone: null,
  reply: null,
};

/** Valida y sanitiza el JSON del LLM del copiloto. Nunca throws. Acción
 *  desconocida → clarify; campos inválidos → null (anotados en problems). */
export function validateCopilotOutput(raw: unknown): { ok: boolean; problems: string[]; fields: CopilotFields } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: ["output no es objeto JSON"], fields: { ...EMPTY_COPILOT_FIELDS } };
  }
  const d = raw as Record<string, unknown>;
  const problems: string[] = [];

  const action: CopilotAction = VALID_ACTIONS.includes(d.action as CopilotAction)
    ? (d.action as CopilotAction)
    : "clarify";
  if (d.action != null && action === "clarify" && d.action !== "clarify") {
    problems.push(`action desconocida: ${String(d.action).slice(0, 40)}`);
  }

  const property =
    typeof d.property === "string" && VALID_PROPERTIES.includes(d.property as PropertySlug)
      ? (d.property as PropertySlug)
      : null;
  if (d.property != null && property === null) problems.push(`property inválida: ${String(d.property).slice(0, 60)}`);

  const iso = (v: unknown): string | null => (typeof v === "string" && ISO_DATE.test(v) ? v : null);
  const checkIn = iso(d.checkIn);
  const checkOut = iso(d.checkOut);
  if (d.checkIn != null && !checkIn) problems.push("checkIn no-ISO");
  if (d.checkOut != null && !checkOut) problems.push("checkOut no-ISO");

  const num = (v: unknown, min: number, max: number): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > min && v <= max ? v : null;
  // Redondear ANTES de validar el rango (adversaria C3: guests=0.4 pasaba el
  // ">0" y redondeaba a 0 después — un 0 rompe el custom_id de PayPal).
  const count = (v: unknown, min: number, max: number): number | null => {
    const r = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN;
    return Number.isFinite(r) && r > min && r <= max ? r : null;
  };
  const guests = count(d.guests, 0, 30);
  const adults = count(d.adults, 0, 30);
  const children = count(d.children, -1, 30);
  const amountUsd = num(d.amountUsd, 0, 10_000);
  const amountHnl = num(d.amountHnl, 0, 500_000);

  // guestPhone: normalizar a E.164; basura → null (el gate de payment_link exige válido).
  let guestPhone: string | null = null;
  if (typeof d.guestPhone === "string" && d.guestPhone.trim()) {
    const norm = normalizePhone(d.guestPhone);
    if (norm.e164 && isValidE164(norm.e164)) guestPhone = norm.e164;
    else problems.push(`guestPhone inválido: ${String(d.guestPhone).slice(0, 30)}`);
  }

  const reply = typeof d.reply === "string" && d.reply.trim().length > 0 ? d.reply.trim() : null;

  return {
    ok: true,
    problems,
    fields: { action, property, checkIn, checkOut, guests, adults, children, amountUsd, amountHnl, guestPhone, reply },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt del copiloto
// ─────────────────────────────────────────────────────────────────────────────

export function buildCopilotSystemPrompt(
  todayIso: string,
  kbText: string,
  role: CopilotRole = "owner",
  staffName?: string,
): string {
  const quienEs =
    role === "staff"
      ? `Sos el ASISTENTE INTERNO del equipo de Estadías Jacarí.
El que escribe es ${staffName || "un miembro del STAFF"} (empleado del negocio), NO un
huésped. Jamás lo saludes como bot de ventas, jamás le vendas, jamás le pidas
"confirmar la reserva". Lo asistís para atender clientes: disponibilidad,
tarifas, fichas, fotos y links de pago. Los RESÚMENES del negocio (reservas del
mes, ingresos) son SOLO de los dueños: si los pide, usá action "clarify" con un
reply que diga que esa vista es del dueño. (El sistema igual lo bloquea por
código — esto es solo para responder con gracia.)`
      : `Sos el ASISTENTE INTERNO de los dueños de Estadías Jacarí (César y Eduardo).
El que escribe es un DUEÑO del negocio, NO un huésped. Jamás lo saludes como bot de
ventas, jamás le vendas, jamás le pidas "confirmar la reserva".`;
  return `${quienEs}

HOY es ${fechaEnPalabras(todayIso)} (${todayIso}, zona GMT-6 Honduras).

Tu trabajo: clasificar QUÉ necesita el dueño y extraer los datos, en JSON. El
sistema (no vos) ejecuta el cálculo con el cotizador y la base real.

ACCIONES (campo "action"):
- "quote": pide cotizar una estadía (propiedad + fechas + personas). El sistema
  arma el mensaje EXACTO que se le manda al huésped.
- "property_card": pide la ficha/info de una propiedad para reenviar.
- "photos": pide fotos de una propiedad.
- "payment_link": pide un LINK DE PAGO PayPal para un cliente. Necesita
  propiedad+fechas+personas Y el teléfono del CLIENTE (guestPhone). Si falta
  cualquiera → action "clarify" pidiéndolo.
- "transfer_info": pide los datos de la cuenta bancaria / transferencia. Si dio
  un monto, extraelo (amountHnl o amountUsd).
- "availability": pregunta si una propiedad está libre en unas fechas (respuesta
  interna con detalle, no para reenviar).
- "ops_today": pregunta quién llega/sale hoy o mañana.
- "ops_month": pregunta por las reservas del mes.
- "kb_answer": pregunta general que se responde con la base de conocimiento de
  abajo (amenidades, políticas, direcciones, cómo funciona algo). Poné la
  respuesta en "reply", concisa y lista para reenviar si aplica.
- "clarify": falta un dato para ejecutar lo pedido. Poné la pregunta en "reply".

REGLA DE ORO (repetida a propósito): NUNCA digas vos un precio, total, depósito
ni monto. Si la consulta involucra plata → action quote/payment_link/
transfer_info y el sistema calcula. Tu "reply" solo se usa en kb_answer y
clarify, y ahí NO puede haber montos inventados.

Valle de Ángeles es un VENUE DE EVENTOS: jamás se cotiza por noche. Si piden
cotizarlo → kb_answer explicando que eventos se cotizan aparte según tipo/fecha/
personas ("desde", sin precio cerrado).

El historial trae los turnos previos: completá campos con lo ya dicho (si ayer
dijo "Casa Brisa" y hoy dice "del 2 al 6 de octubre", la propiedad sigue siendo
casa-brisa). Slugs válidos: ${VALID_PROPERTIES.join(", ")}.

Fechas SIEMPRE en ISO YYYY-MM-DD futuras (si dice "el 2 de octubre", es el
próximo 2 de octubre). Respondé SOLO el JSON:
{"action": "...", "property": null, "checkIn": null, "checkOut": null,
 "guests": null, "adults": null, "children": null, "amountUsd": null,
 "amountHnl": null, "guestPhone": null, "reply": null}

── BASE DE CONOCIMIENTO (la misma que usa el bot de ventas) ──
${kbText}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters puros (testeables)
// ─────────────────────────────────────────────────────────────────────────────

export interface OpsReservationRow {
  property_slug: string;
  guest_name: string | null;
  guest_phone: string | null;
  check_in: string;
  check_out: string;
  status: string;
  source: string;
  total_hnl: number | null;
  paid_hnl: number | null;
  amount_usd: number | null;
}

function propName(slug: string): string {
  return PROPERTY_PRICING[slug as PropertySlug]?.name ?? slug;
}

function fmtGuest(r: OpsReservationRow): string {
  const who = r.guest_name?.trim() || "(sin nombre)";
  const tel = r.guest_phone ? ` · ${r.guest_phone}` : "";
  const src = r.source === "airbnb" || r.source === "airbnb_ical" ? " · Airbnb" : "";
  return `${who}${tel}${src}`;
}

/** Llegadas y salidas de hoy y mañana — SIEMPRE interno (PII de huéspedes). */
export function formatOpsToday(rows: OpsReservationRow[], todayIso: string, tomorrowIso: string): string {
  const arrToday = rows.filter((r) => r.check_in === todayIso);
  const arrTomorrow = rows.filter((r) => r.check_in === tomorrowIso);
  const depToday = rows.filter((r) => r.check_out === todayIso);
  const depTomorrow = rows.filter((r) => r.check_out === tomorrowIso);
  const block = (title: string, list: OpsReservationRow[], dateField: "check_in" | "check_out") =>
    list.length === 0
      ? `${title}: nadie`
      : `${title}:\n` +
        list
          .map((r) => `  • ${propName(r.property_slug)} — ${fmtGuest(r)} (${dateField === "check_in" ? `sale ${r.check_out}` : `llegó ${r.check_in}`}${r.status === "pending" ? " · ⚠️ PENDING" : ""})`)
          .join("\n");
  return [
    `🔒 interno · Operación de hoy (${todayIso}) y mañana:`,
    block("🛬 Llegan HOY", arrToday, "check_in"),
    block("🛫 Salen HOY", depToday, "check_out"),
    block("🛬 Llegan MAÑANA", arrTomorrow, "check_in"),
    block("🛫 Salen MAÑANA", depTomorrow, "check_out"),
  ].join("\n\n");
}

/** Reservas con llegada en el mes — SIEMPRE interno. */
export function formatOpsMonth(rows: OpsReservationRow[], monthLabel: string): string {
  if (rows.length === 0) return `🔒 interno · ${monthLabel}: sin reservas con llegada este mes.`;
  const byProp = new Map<string, OpsReservationRow[]>();
  for (const r of rows) {
    const list = byProp.get(r.property_slug) ?? [];
    list.push(r);
    byProp.set(r.property_slug, list);
  }
  const lines: string[] = [`🔒 interno · ${monthLabel}: ${rows.length} reserva${rows.length === 1 ? "" : "s"} con llegada en el mes.`];
  for (const [slug, list] of byProp) {
    lines.push(
      `\n*${propName(slug)}* (${list.length}):\n` +
        list
          .map((r) => `  • ${r.check_in}→${r.check_out} — ${fmtGuest(r)}${r.status === "pending" ? " · ⚠️ PENDING" : ""}`)
          .join("\n"),
    );
  }
  return lines.join("\n");
}

/** Red anti-precio para kb_answer: si el texto del LLM trae montos, se marca.
 *  Ojo: \b no existe antes de "$" (no es carácter de palabra) → grupo aparte. */
export function replyHasMoney(reply: string): boolean {
  return /(\b(HNL|L\.?|USD)|\$)\s?\d/i.test(reply);
}

// ─────────────────────────────────────────────────────────────────────────────
// El copiloto
// ─────────────────────────────────────────────────────────────────────────────

export interface CopilotReply {
  text: string;
  images?: string[];
  previewUrl?: boolean;
}

export interface CopilotResult {
  replies: CopilotReply[];
  traceAction: string;
  /** Solo staff: cuando genera un link de pago, el webhook manda esta alerta a
   *  los DUEÑOS (oversight de plata: César se entera de cada link del staff).
   *  Se compone acá (que tiene los datos) pero se ENVÍA en el webhook, para no
   *  crear un import circular owner-copilot ↔ owner-alerts. */
  staffAlert?: { tipo: string; cliente: string; detalle: string; guestPhone: string };
}

export type CopilotEnv = WorkersAIEnv & AvailabilityEnv & PayPalEnv & CopilotIdentityEnv & { DB: D1Database };

function isoAddDays(iso: string, days: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime() + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** Entrada principal del copiloto: mensaje del dueño/staff → replies listas para mandar. */
export async function handleOwnerCopilot(
  phone: string,
  text: string,
  todayIso: string,
  env: CopilotEnv,
  // SIN default a propósito: olvidar el rol en un call site futuro sería un
  // fail-open de permisos (staff tratado como owner). Que NO compile.
  role: CopilotRole,
): Promise<CopilotResult> {
  // 1. Cerebro: clasificar + extraer (historial de whatsapp_messages = memoria).
  const [kbText, history] = await Promise.all([
    buildKnowledgeBaseText(env.DB),
    getConversationHistory(phone, env.DB, 12),
  ]);
  const messages: AIMessage[] = [
    { role: "system", content: buildCopilotSystemPrompt(todayIso, kbText, role, env.STAFF_NAME) },
    ...history,
    { role: "user", content: text.slice(0, 1000) },
  ];
  let llm = await callOpenAIJson<Record<string, unknown>>(messages, env, { temperature: 0.1, maxTokens: 500 });
  if (!llm.ok) {
    llm = await callWorkersAIJson<Record<string, unknown>>(messages, env, { temperature: 0.1, maxTokens: 500 });
  }
  if (!llm.ok || !llm.data) {
    // A un dueño se le dice la verdad técnica — jamás silencio, jamás escalación.
    return {
      replies: [{ text: `El copiloto no pudo pensar (LLM caído: ${(llm.error ?? "sin detalle").slice(0, 120)}). Reintentá en unos minutos.` }],
      traceAction: "llm_down",
    };
  }
  const { fields, problems } = validateCopilotOutput(llm.data);

  // 2. Manos: dispatcher determinístico.
  const result = await dispatchCopilotAction(fields, text, todayIso, env, role);
  if (problems.length > 0) result.traceAction += ` [schema: ${problems.join("; ").slice(0, 120)}]`;
  return result;
}

/** Exportada para tests: las MANOS del copiloto (el LLM solo clasifica).
 *  El ROL se aplica ACÁ, en código — jamás confiamos en que el prompt alcance. */
export async function dispatchCopilotAction(
  f: CopilotFields,
  rawText: string,
  todayIso: string,
  env: CopilotEnv,
  role: CopilotRole,
): Promise<CopilotResult> {
  // ── Frontera de rol: lo que el staff NO puede, se corta ANTES del switch ──
  if (role === "staff" && f.action === "ops_month") {
    // "Reservas del mes" = volumen del negocio → solo dueños (pedido explícito
    // de César 2026-08-20). La operación de HOY/mañana sí es del staff (es su
    // trabajo coordinar llegadas); el agregado mensual no.
    return {
      replies: [{ text: "🔒 El resumen del mes es una vista del dueño. Lo tuyo: disponibilidad, cotizaciones, fichas, fotos, links de pago y la operación de hoy/mañana." }],
      traceAction: "staff_blocked_ops_month",
    };
  }

  switch (f.action) {
    // ── Cotización reenviable ────────────────────────────────────────────────
    case "quote": {
      const missing: string[] = [];
      if (!f.property) missing.push("la propiedad");
      if (!f.checkIn || !f.checkOut) missing.push("las fechas (llegada y salida)");
      if (!f.guests && !f.adults) missing.push("cuántas personas");
      if (missing.length > 0) {
        return {
          replies: [{ text: `Para cotizar me falta ${missing.join(" y ")}.` }],
          traceAction: "quote_clarify",
        };
      }
      const guests = f.guests ?? (f.adults ?? 0) + (f.children ?? 0);
      const pricingMap = await buildPricingMap(env.DB);
      const quote = await buildQuote(
        { property: f.property!, checkIn: f.checkIn!, checkOut: f.checkOut!, guests, adults: f.adults, children: f.children },
        env.DB,
        pricingMap,
      );
      if (!quote) {
        return { replies: [{ text: "No pude armar la cotización (propiedad desconocida para el cotizador)." }], traceAction: "quote_fail" };
      }
      // Disponibilidad real (Airbnb iCal + D1) — el mismo par que usa el bot.
      const avail = f.property === "las-gemelas-tela"
        ? await checkGemelasAvailable(f.checkIn!, f.checkOut!, env)
        : await checkRangeAvailable(f.property!, f.checkIn!, f.checkOut!, env);
      const airbnbBusy = avail.verified && !avail.available;

      const forwardable = formatQuoteMessage(
        quote,
        { property: f.property!, checkIn: f.checkIn!, checkOut: f.checkOut!, guests, adults: f.adults, children: f.children },
        "es",
      );
      const internalBits: string[] = [];
      if (airbnbBusy) {
        internalBits.push(`⛔ OJO: Airbnb marca OCUPADO (${avail.conflictDates.slice(0, 4).join(", ")}${avail.conflictDates.length > 4 ? "…" : ""}) — NO reenvíes esta cotización sin liberar las fechas.`);
      } else if (!avail.verified) {
        internalBits.push("⚠️ No pude verificar el iCal de Airbnb ahora — confirmá el calendario antes de cerrar.");
      } else if (quote.available) {
        internalBits.push("✅ Verificado libre en Airbnb + D1.");
      }
      if (quote.minNightsRequired) internalBits.push(`La estadía viola el mínimo de ${quote.minNightsRequired} noches (${quote.seasonName}).`);
      if (quote.exceedsCapacity) internalBits.push(`El grupo supera el cupo (${quote.capacity}).`);
      if ((quote.seasonNights ?? 0) > 0 && quote.available) internalBits.push(`Incluye ${quote.seasonNights} noche(s) de ${quote.seasonName} a HNL ${quote.seasonRateHNL?.toLocaleString("es-HN")}.`);
      return {
        replies: [
          { text: forwardable },
          { text: `🔒 interno: ${internalBits.join(" ")}\nDepósito 50%: HNL ${quote.depositHNL.toLocaleString("es-HN")} (≈ USD ${quote.depositUSD.toFixed(2)}).` },
        ],
        traceAction: airbnbBusy ? "quote_airbnb_busy" : "quote_ok",
      };
    }

    // ── Ficha / fotos ────────────────────────────────────────────────────────
    case "property_card": {
      if (!f.property) {
        return { replies: [{ text: `¿De cuál propiedad? Catálogo completo: ${getCatalogUrl()}`, previewUrl: false }], traceAction: "card_clarify" };
      }
      const card = buildPropertyCard(f.property, "es");
      return {
        replies: [{ text: card || `Ficha: ${getGalleryUrl(f.property)}`, previewUrl: true }],
        traceAction: "card_ok",
      };
    }
    case "photos": {
      if (!f.property) {
        return { replies: [{ text: `¿De cuál propiedad querés fotos? Catálogo: ${getCatalogUrl()}` }], traceAction: "photos_clarify" };
      }
      const photos = getPropertyPhotos(f.property);
      if (photos.length === 0) {
        return { replies: [{ text: `No tengo galería cargada de esa propiedad — su ficha: ${getGalleryUrl(f.property)}`, previewUrl: true }], traceAction: "photos_link" };
      }
      return {
        replies: [{ text: `📸 ${propName(f.property)} — galería completa: ${getGalleryUrl(f.property)}`, images: photos }],
        traceAction: "photos_ok",
      };
    }

    // ── Disponibilidad con detalle interno ───────────────────────────────────
    case "availability": {
      if (!f.property || !f.checkIn || !f.checkOut) {
        return { replies: [{ text: "Decime propiedad y fechas (llegada/salida) y te digo si está libre." }], traceAction: "avail_clarify" };
      }
      const avail = f.property === "las-gemelas-tela"
        ? await checkGemelasAvailable(f.checkIn, f.checkOut, env)
        : await checkRangeAvailable(f.property, f.checkIn, f.checkOut, env);
      // ¿Quién ocupa? (solo dueños ven esto)
      let occupants = "";
      try {
        const blockSlugs = overlapSlugs(f.property);
        const rows = await env.DB.prepare(
          `SELECT property_slug, guest_name, guest_phone, check_in, check_out, status, source
             FROM reservations
            WHERE property_slug IN (${slugPlaceholders(blockSlugs)})
              AND status IN ('confirmed','pending')
              AND NOT (check_out <= ? OR check_in >= ?)
            ORDER BY check_in LIMIT 6`,
        ).bind(...blockSlugs, f.checkIn, f.checkOut).all<OpsReservationRow>();
        const list = rows.results ?? [];
        if (list.length > 0) {
          occupants = "\nEn D1 pisan esas fechas:\n" + list.map((r) => `  • ${propName(r.property_slug)} ${r.check_in}→${r.check_out} — ${fmtGuest(r)} (${r.status})`).join("\n");
        }
      } catch { /* best-effort */ }
      const verdict = !avail.verified
        ? `⚠️ No pude leer el iCal de Airbnb — esto es solo D1.`
        : avail.available
          ? `✅ LIBRE del ${f.checkIn} al ${f.checkOut}.`
          : `⛔ OCUPADO (${avail.conflictDates.slice(0, 5).join(", ")}${avail.conflictDates.length > 5 ? "…" : ""}).`;
      return {
        replies: [{ text: `🔒 interno · ${propName(f.property)}: ${verdict}${occupants}` }],
        traceAction: "avail_ok",
      };
    }

    // ── Operación ────────────────────────────────────────────────────────────
    case "ops_today": {
      const tomorrow = isoAddDays(todayIso, 1);
      try {
        const rows = await env.DB.prepare(
          `SELECT property_slug, guest_name, guest_phone, check_in, check_out, status, source, total_hnl, paid_hnl, amount_usd
             FROM reservations
            WHERE status IN ('confirmed','pending')
              AND (check_in IN (?1, ?2) OR check_out IN (?1, ?2))
            ORDER BY check_in`,
        ).bind(todayIso, tomorrow).all<OpsReservationRow>();
        return {
          replies: [{ text: formatOpsToday(rows.results ?? [], todayIso, tomorrow) }],
          traceAction: "ops_today_ok",
        };
      } catch (err) {
        return { replies: [{ text: `No pude leer las reservas: ${(err as Error).message.slice(0, 100)}` }], traceAction: "ops_today_fail" };
      }
    }
    case "ops_month": {
      const monthStart = todayIso.slice(0, 7) + "-01";
      const [y, m] = todayIso.split("-").map(Number);
      const nextMonthStart = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
      const label = `${MONTHS_ES[m - 1]} ${y}`;
      try {
        const rows = await env.DB.prepare(
          `SELECT property_slug, guest_name, guest_phone, check_in, check_out, status, source, total_hnl, paid_hnl, amount_usd
             FROM reservations
            WHERE status IN ('confirmed','pending') AND check_in >= ? AND check_in < ?
            ORDER BY property_slug, check_in`,
        ).bind(monthStart, nextMonthStart).all<OpsReservationRow>();
        return {
          replies: [{ text: formatOpsMonth(rows.results ?? [], label) }],
          traceAction: "ops_month_ok",
        };
      } catch (err) {
        return { replies: [{ text: `No pude leer las reservas: ${(err as Error).message.slice(0, 100)}` }], traceAction: "ops_month_fail" };
      }
    }

    // ── Plata: link de pago PayPal para el HUÉSPED ───────────────────────────
    // Gates DUROS en código (no en el prompt): sin teléfono del cliente válido
    // y ≠ dueños, createPayPalOrder NO se llama. El custom_id wa:<phone>|… es
    // lo que hace que la reserva y la confirmación post-pago le lleguen al
    // CLIENTE (paypal-wa-capture: anti-solape atómico + estado pending con el
    // depósito — no depende de conversation_state, verificado 25-jul).
    case "payment_link": {
      // HNL presente → rechazo SIEMPRE, aunque el LLM haya "ayudado" llenando
      // también amountUsd con una conversión propia (adversaria C4: el LLM
      // jamás tiene la última palabra sobre plata — un TC inventado es plata).
      if (f.amountHnl != null) {
        return {
          replies: [{ text: "PayPal cobra en DÓLARES (no acepta HNL). Decime el monto en USD explícito, o pedime la cotización y uso el depósito del 50% que calcula el sistema." }],
          traceAction: "paylink_hnl_rejected",
        };
      }
      // STAFF: el monto lo fija SIEMPRE el sistema (depósito 50% del cotizador).
      // Un monto custom es una decisión de plata del dueño — y de paso cierra el
      // agujero de un link por menos plata de la que corresponde.
      if (role === "staff" && f.amountUsd != null) {
        return {
          replies: [{ text: "🔒 El monto del link lo fija el sistema (depósito 50% del cotizador). Pedime el link sin monto y lo genero con el depósito correcto; si hace falta un monto especial, eso lo maneja César." }],
          traceAction: "paylink_staff_custom_rejected",
        };
      }
      const missing: string[] = [];
      if (!f.property) missing.push("la propiedad");
      if (!f.checkIn || !f.checkOut) missing.push("las fechas");
      if (!f.guests && !f.adults) missing.push("cuántas personas");
      if (!f.guestPhone) missing.push("el TELÉFONO del cliente (para que la confirmación le llegue a él, no a vos)");
      if (missing.length > 0) {
        return {
          replies: [{ text: `Para el link de pago me falta ${missing.join(", ")}.` }],
          traceAction: "paylink_clarify",
        };
      }
      if (isOwnerPhone(f.guestPhone)) {
        return {
          replies: [{ text: "Ese es el número de un DUEÑO — necesito el del CLIENTE: la reserva y la confirmación de pago se atribuyen a ese teléfono." }],
          traceAction: "paylink_owner_phone_rejected",
        };
      }
      // También se rechaza el teléfono de un empleado (para AMBOS roles): una
      // reserva atribuida al staff es una reserva que no le llega a nadie real.
      if (isStaffPhone(f.guestPhone, env)) {
        return {
          replies: [{ text: "Ese es el número de un miembro del EQUIPO — necesito el del CLIENTE: la reserva y la confirmación de pago se atribuyen a ese teléfono." }],
          traceAction: "paylink_staff_phone_rejected",
        };
      }
      const guests = f.guests ?? (f.adults ?? 0) + (f.children ?? 0);
      const pricingMap = await buildPricingMap(env.DB);
      const quote = await buildQuote(
        { property: f.property!, checkIn: f.checkIn!, checkOut: f.checkOut!, guests, adults: f.adults, children: f.children },
        env.DB,
        pricingMap,
      );
      if (!quote) {
        return { replies: [{ text: "No pude cotizar esa propiedad — sin cotización no genero link." }], traceAction: "paylink_quote_fail" };
      }
      if (!quote.available) {
        const why = quote.minNightsRequired
          ? `viola el mínimo de ${quote.minNightsRequired} noches (${quote.seasonName})`
          : quote.exceedsCapacity
            ? `el grupo supera el cupo (${quote.capacity})`
            : "las fechas figuran OCUPADAS en D1";
        return {
          replies: [{ text: `🔒 interno: NO generé el link — ${why}. Cobrar fechas inválidas es plata que después hay que devolver.` }],
          traceAction: "paylink_blocked_unavailable",
        };
      }
      // Airbnb también (el mismo doble chequeo del flujo de leads).
      const avail = f.property === "las-gemelas-tela"
        ? await checkGemelasAvailable(f.checkIn!, f.checkOut!, env)
        : await checkRangeAvailable(f.property!, f.checkIn!, f.checkOut!, env);
      if (avail.verified && !avail.available) {
        return {
          replies: [{ text: `🔒 interno: NO generé el link — Airbnb marca OCUPADO (${avail.conflictDates.slice(0, 4).join(", ")}). Liberá el calendario primero.` }],
          traceAction: "paylink_blocked_airbnb",
        };
      }
      const amountUsd = f.amountUsd ?? quote.depositUSD;
      const order = await createPayPalOrder(
        {
          amountUsd,
          propertySlug: f.property!,
          propertyName: quote.propertyName,
          checkIn: f.checkIn!,
          checkOut: f.checkOut!,
          guests,
          guestPhone: f.guestPhone!, // ← el CLIENTE (gate de arriba lo garantiza)
        },
        env,
      );
      if (!order.ok || !order.approvalUrl) {
        return {
          replies: [{ text: `PayPal no me dio el link: ${(order.error ?? "sin detalle").slice(0, 150)}` }],
          traceAction: "paylink_paypal_fail",
        };
      }
      // Reenviable: si el monto es el depósito estándar, el MISMO mensaje que
      // manda el bot (T.paypalLink); monto custom → texto simple sin "50%".
      const isStandardDeposit = f.amountUsd == null || Math.abs(amountUsd - quote.depositUSD) < 0.01;
      const forwardable = isStandardDeposit
        ? T.paypalLink(
            "es",
            quote.depositHNL.toLocaleString("es-HN"),
            quote.depositUSD.toFixed(2),
            order.approvalUrl,
            quote.balanceHNL.toLocaleString("es-HN"),
          )
        : `¡Listo! El pago es de USD ${amountUsd.toFixed(2)}. Podés pagar acá:\n\n👉 ${order.approvalUrl}\n\nApenas se acredite te llega la confirmación automática ✅`;
      const internal =
        `🔒 interno: link para el cliente ${f.guestPhone} · ${quote.propertyName} ${f.checkIn}→${f.checkOut} · USD ${amountUsd.toFixed(2)}` +
        (isStandardDeposit ? ` (depósito 50% estándar).` : ` (monto CUSTOM — el depósito estándar sería USD ${quote.depositUSD.toFixed(2)}).`) +
        ` Cuando pague: reserva pending + confirmación automática al cliente por WhatsApp y correo.` +
        ` ⚠️ Si el cliente NUNCA le ha escrito al bot, el WhatsApp puede no llegarle (ventana de Meta) — si falla te llega alerta para que se la reenvíes vos.` +
        (!avail.verified ? " ⚠️ iCal de Airbnb no verificado — chequeá el calendario." : "");
      return {
        replies: [{ text: forwardable }, { text: internal }],
        traceAction: "paylink_ok",
        // Oversight de plata: si el link lo generó el STAFF, los dueños se
        // enteran por WhatsApp (regla de la casa: sobre plata, avisar siempre).
        // El webhook lo envía con notifyOwners; acá solo se compone.
        ...(role === "staff"
          ? {
              staffAlert: {
                tipo: "Staff generó link de pago",
                cliente: `Cliente ${f.guestPhone}`,
                detalle: `${env.STAFF_NAME || "Staff"}: ${quote.propertyName} ${f.checkIn}→${f.checkOut} · USD ${amountUsd.toFixed(2)} (depósito 50%)`,
                guestPhone: f.guestPhone!,
              },
            }
          : {}),
      };
    }

    // ── Plata: datos de transferencia con monto ──────────────────────────────
    // MISMOS candados de rol que payment_link (adversaria 2026-08-20, cazado
    // por 4 lentes independientes): sin esto, el staff esquivaba el control del
    // depósito pidiendo "la cuenta para X lempiras" — mismo agujero, otro canal
    // de cobro. Staff: solo el depósito que calcula el cotizador, y con alerta
    // a los dueños. Owner: igual que siempre.
    case "transfer_info": {
      if (role === "staff" && (f.amountHnl != null || f.amountUsd != null)) {
        return {
          replies: [{ text: "🔒 El monto de una transferencia lo fija el sistema (depósito 50% del cotizador). Pasame propiedad+fechas+personas y te doy los datos con el monto correcto; montos especiales los maneja César." }],
          traceAction: "transfer_staff_custom_rejected",
        };
      }
      if (f.amountHnl != null) {
        return { replies: [{ text: buildTransferMessageHNL(f.amountHnl, "es") }], traceAction: "transfer_hnl_ok" };
      }
      if (f.amountUsd != null) {
        return { replies: [{ text: buildTransferMessageUSD(f.amountUsd, "es") }], traceAction: "transfer_usd_ok" };
      }
      // Sin monto explícito pero con datos de estadía → depósito del cotizador.
      if (f.property && f.checkIn && f.checkOut && (f.guests || f.adults)) {
        const guests = f.guests ?? (f.adults ?? 0) + (f.children ?? 0);
        const pricingMap = await buildPricingMap(env.DB);
        const quote = await buildQuote(
          { property: f.property, checkIn: f.checkIn, checkOut: f.checkOut, guests, adults: f.adults, children: f.children },
          env.DB,
          pricingMap,
        );
        if (quote && quote.available) {
          // Doble chequeo de Airbnb, el MISMO de payment_link (adversaria round
          // 2, 2026-08-20): buildQuote solo mira D1 — un bloqueo manual del
          // calendario de Airbnb jamás llega a D1, y emitir instrucciones de
          // cobro por fechas invendibles es plata que después hay que devolver
          // A MANO (clase de incidente del 19-ago). Aplica a AMBOS roles.
          const avail = f.property === "las-gemelas-tela"
            ? await checkGemelasAvailable(f.checkIn, f.checkOut, env)
            : await checkRangeAvailable(f.property, f.checkIn, f.checkOut, env);
          if (avail.verified && !avail.available) {
            return {
              replies: [{ text: `🔒 interno: NO paso los datos de transferencia — Airbnb marca OCUPADO (${avail.conflictDates.slice(0, 4).join(", ")}${avail.conflictDates.length > 4 ? "…" : ""}). Liberá el calendario primero.` }],
              traceAction: "transfer_blocked_airbnb",
            };
          }
          return {
            replies: [
              { text: buildTransferMessageHNL(quote.depositHNL, "es") },
              { text: `🔒 interno: depósito 50% de ${quote.propertyName} ${f.checkIn}→${f.checkOut} (total HNL ${quote.totalHNL.toLocaleString("es-HN")}).${!avail.verified ? " ⚠️ iCal de Airbnb no verificado — chequeá el calendario antes de confirmar." : ""}` },
            ],
            traceAction: "transfer_quote_ok",
            // Oversight de plata, simétrico al del link de PayPal: los dueños
            // ven cada instrucción de cobro que el staff emite.
            ...(role === "staff"
              ? {
                  staffAlert: {
                    tipo: "Staff pasó datos de transferencia",
                    cliente: "Cliente por transferencia",
                    detalle: `${env.STAFF_NAME || "Staff"}: ${quote.propertyName} ${f.checkIn}→${f.checkOut} · depósito HNL ${quote.depositHNL.toLocaleString("es-HN")}`,
                    guestPhone: "",
                  },
                }
              : {}),
          };
        }
      }
      return {
        replies: [{ text: "¿De cuánto es la transferencia? Decime el monto (HNL o USD), o pasame propiedad+fechas+personas y uso el depósito del 50%." }],
        traceAction: "transfer_clarify",
      };
    }

    // ── KB / clarify ─────────────────────────────────────────────────────────
    case "kb_answer": {
      const reply = f.reply ?? "¿Me repetís la pregunta?";
      const guard = replyHasMoney(reply)
        ? "\n\n🔒 interno: este texto trae montos salidos de la KB, no del cotizador — verificá antes de reenviar."
        : "";
      return { replies: [{ text: reply + guard }], traceAction: "kb_answer" };
    }
    case "clarify":
    default:
      return {
        replies: [{
          text: f.reply ?? (role === "staff"
            ? "¿Qué necesitás? Puedo cotizar, ver disponibilidad, pasar fichas/fotos, generar un link de pago o decirte quién llega hoy y mañana."
            : "¿Qué necesitás? Puedo cotizar, pasar fichas/fotos, ver disponibilidad, o decirte quién llega hoy y cómo va el mes."),
        }],
        traceAction: "clarify",
      };
  }
}
