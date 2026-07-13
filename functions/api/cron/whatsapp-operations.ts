/// <reference types="@cloudflare/workers-types" />
//
// POST /api/cron/whatsapp-operations?hito=<hito>
//
// Cron orquestador de los templates UTILITY operativos de WhatsApp.
// Disparado por el Worker `estadia-jacari-cron` en 4 horarios distintos del día
// (hora Honduras, UTC-6 sin daylight saving):
//
//   ┌──────────────┬──────────────┬─────────────────────────────────────────────┐
//   │ Hito         │ Hora HN      │ Qué hace                                     │
//   ├──────────────┼──────────────┼─────────────────────────────────────────────┤
//   │ evening-staff   │ 6:05 PM   │ Avisa a personal LIMPIEZA de las propiedades │
//   │                 │ (víspera) │ con CHECK-IN MAÑANA (limpieza_aviso_entrada).│
//   │ morning-staff   │ 7:00 AM   │ Avisa a SEGURIDAD de las propiedades con     │
//   │                 │           │ CHECK-IN hoy. (Limpieza ya NO va acá — se    │
//   │                 │           │ movió a evening-staff, César 2026-07-12.)    │
//   │ morning-guests  │ 10:00 AM  │ Mensaje al huésped con CHECK-IN hoy +        │
//   │                 │           │ mensaje al huésped con CHECKOUT hoy.         │
//   │ checkout-cleaning│11:30 AM  │ Avisa a personal limpieza de las             │
//   │                 │           │ propiedades con CHECKOUT hoy.                │
//   └──────────────┴──────────────┴─────────────────────────────────────────────┘
//
// El template T-1 día del huésped (`checkin_instructions` con PDF) lo sigue
// disparando el cron existente `/api/cron/checkin-reminders` a las 6 PM HN.
// Este endpoint NO lo toca.
//
// TODAS LAS CONFIRMADAS (César, 2026-07-12): el cron procesa toda reserva con
// status='confirmed' sin importar el source (Airbnb, web, WhatsApp, manual) —
// 'confirmed' ya implica pago verificado. Las 'pending' (depósito 50% / por
// verificar) NO se automatizan; se disparan a mano desde /inbox/reservas
// (endpoint cookie reservation-send-message) cuando corresponda.
//
// Cada envío real deja fila en `whatsapp_messages` vía logOutboundTemplate
// (wa-log.ts) → el callback de Meta actualiza sent→delivered→read→failed y la
// card "📬 Salud de entrega" del inbox lo ve.
//
// Auth: Authorization: Bearer <CRON_SECRET>
//
// Query params:
//   ?hito=evening-staff|morning-staff|morning-guests|checkout-cleaning (requerido)
//   ?date=YYYY-MM-DD  (opcional; fecha del check-in/out a procesar — para
//                      evening-staff el default es MAÑANA HN, para el resto HOY)
//   ?dryRun=1         (opcional, no envía nada)
//
// Idempotencia: cada wrapper revisa `wa_*_sent_at IS NULL` antes de enviar.
// Si Meta retorna error, se guarda en `wa_*_error` y se reintenta al día
// siguiente (las reservas con check-in pasado no aplican porque salen del
// WHERE check_in = TODAY).
//
// Respuesta SIEMPRE 200 con cuerpo JSON detallado (ok=true incluso si algunos
// envíos individuales fallaron — el detalle lista cada uno).
//

import { todayHn, hnDatePlusDays } from "../../_lib/dates";
import { normalizePhone, isValidE164 } from "../../_lib/phone";
import { getCleaningContacts, getSecurityContacts } from "../../_lib/property-contacts";
import { checkRateLimit, getClientIp } from "../../_lib/rate-limit";
import { requireBearerAuth } from "../../_lib/admin-auth";
import { withCronMonitor } from "../../_lib/cron-monitor";
import { logOutboundTemplate } from "../../_lib/wa-log";
import {
  sendCheckinDiaHuesped,
  sendCheckinDiaSeguridad,
  sendCheckoutDiaHuesped,
  sendCheckoutDiaLimpieza,
  sendLimpiezaAvisoEntrada,
  formatDateShortEs,
  type SendTemplateResult,
} from "../../_lib/whatsapp-templates";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

export const VALID_HITOS = [
  "evening-staff",
  "morning-staff",
  "morning-guests",
  "checkout-cleaning",
] as const;

type Hito = (typeof VALID_HITOS)[number];

/**
 * Fecha objetivo del hito (el check_in/check_out a procesar). Para evening-staff
 * (víspera 6 PM) el default es MAÑANA HN; para los demás hitos, HOY HN. Un
 * ?date=YYYY-MM-DD válido siempre manda (útil para pruebas/dry-run).
 * Pura (con relojes inyectables) y exportada para test.
 */
export function resolveTargetDate(
  hito: Hito,
  dateParam: string | null,
  clock: { today: () => string; tomorrow: () => string } = {
    today: todayHn,
    tomorrow: () => hnDatePlusDays(1),
  },
): string {
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return dateParam;
  return hito === "evening-staff" ? clock.tomorrow() : clock.today();
}

interface ReservationRow {
  id: number;
  property_slug: string;
  check_in: string;
  check_out: string;
  guest_name: string | null;
  guest_phone: string | null;
  guest_count: number | null;
  wa_arrival_guest_sent_at: string | null;
  wa_arrival_cleaning_sent_at: string | null;
  wa_arrival_security_sent_at: string | null;
  wa_departure_guest_sent_at: string | null;
  wa_departure_cleaning_sent_at: string | null;
  wa_eve_cleaning_sent_at: string | null;
}

interface ActionResult {
  reservationId: number;
  slug: string;
  action: string;
  status: "sent" | "skipped" | "failed";
  detail?: string;
}

const PROPERTY_NAMES: Record<string, string> = {
  "villa-b11-palma-real": "Villa B11 — Palma Real",
  "casa-brisa": "Casa Brisa",
  "casa-marea": "Casa Marea",
  "centro-morazan": "Centro Morazán",
  "casa-lara-townhouse": "Casa Lara Townhouse",
  "la-florida": "La Florida",
};

const PROPERTY_CITIES: Record<string, string> = {
  "villa-b11-palma-real": "La Ceiba",
  "casa-brisa": "Tela",
  "casa-marea": "Tela",
  "centro-morazan": "Tegucigalpa",
  "casa-lara-townhouse": "Tegucigalpa",
  "la-florida": "Tegucigalpa",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export const onRequestPost: PagesFunction<Env> = (context) => {
  // El key incluye el hito (4 hitos diarios distintos por el mismo endpoint).
  // El watchdog los vigila con skipIfNeverRan: hasta que el hito corra por
  // primera vez (César re-pega el cron-worker) no genera alertas falsas.
  const hito = new URL(context.request.url).searchParams.get("hito") || "unknown";
  return withCronMonitor(context.env, `cron_whatsapp_operations_${hito}`, () => handlePost(context));
};

const handlePost: PagesFunction<Env> = async ({ request, env }) => {
  // 1. Auth (timing-safe Bearer compare via helper compartido)
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  // 1b. Rate limit por IP — defensa adicional si CRON_SECRET se filtra.
  // 30/min holgado para los 3 hitos diarios + tests manuales.
  const ip = getClientIp(request);
  const rl = await checkRateLimit(env, {
    endpoint: "cron/whatsapp-operations",
    ip,
    max: 30,
    windowSec: 60,
  });
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `Rate limit excedido: ${rl.currentCount} en 60s. Reintenta en ${rl.retryAfterSec}s.`,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(rl.retryAfterSec),
        },
      },
    );
  }

  // 2. Parse query
  const url = new URL(request.url);
  const hito = url.searchParams.get("hito") as Hito | null;
  if (!hito || !(VALID_HITOS as readonly string[]).includes(hito)) {
    return json(
      {
        ok: false,
        error: `Query param 'hito' requerido. Valores válidos: ${VALID_HITOS.join(", ")}. Recibido: ${hito}`,
      },
      400,
    );
  }
  const dryRun = url.searchParams.get("dryRun") === "1";
  const targetDate = resolveTargetDate(hito, url.searchParams.get("date"));

  // 3. Sin config Meta → no podemos enviar nada. Devolvemos info útil pero
  //    no es error (puede ser que el sistema aún no está configurado).
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return json({
      ok: true,
      hito,
      targetDate,
      dryRun,
      skipped: "Meta WhatsApp no configurado (falta WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID)",
      actions: [],
    });
  }

  const waEnv = {
    WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
  };

  // 4. Dispatch
  const actions: ActionResult[] = [];
  try {
    if (hito === "evening-staff") {
      await runEveningStaff(env, waEnv, targetDate, dryRun, actions);
    } else if (hito === "morning-staff") {
      await runMorningStaff(env, waEnv, targetDate, dryRun, actions);
    } else if (hito === "morning-guests") {
      await runMorningGuests(env, waEnv, targetDate, dryRun, actions);
    } else if (hito === "checkout-cleaning") {
      await runCheckoutCleaning(env, waEnv, targetDate, dryRun, actions);
    }
  } catch (err) {
    return json(
      {
        ok: false,
        hito,
        targetDate,
        error: `Error general procesando hito: ${(err as Error).message}`,
        actionsCompleted: actions,
      },
      500,
    );
  }

  const sent = actions.filter((a) => a.status === "sent").length;
  const failed = actions.filter((a) => a.status === "failed").length;
  const skipped = actions.filter((a) => a.status === "skipped").length;

  return json({
    ok: true,
    hito,
    targetDate,
    dryRun,
    total: actions.length,
    sent,
    failed,
    skipped,
    actions,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Hito 0: evening-staff (6:05 PM HN, VÍSPERA)
// Avisa a personal LIMPIEZA de las propiedades con CHECK-IN MAÑANA, para que
// planifiquen con un día de anticipación (César, 2026-07-12). Reemplaza al
// aviso matutino a limpieza que vivía en morning-staff.
// ─────────────────────────────────────────────────────────────────────────────

export async function runEveningStaff(
  env: Env,
  waEnv: { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
  targetDate: string,
  dryRun: boolean,
  actions: ActionResult[],
): Promise<void> {
  // targetDate = el CHECK-IN de mañana (lo resuelve resolveTargetDate).
  const reservations = await fetchArrivals(env.DB, targetDate);

  for (const r of reservations) {
    if (r.wa_eve_cleaning_sent_at) continue;

    const propertyName = PROPERTY_NAMES[r.property_slug] || r.property_slug;
    const cleaners = await getCleaningContacts(r.property_slug, env.DB);
    if (cleaners.length === 0) {
      actions.push({
        reservationId: r.id,
        slug: r.property_slug,
        action: "limpieza_aviso_entrada",
        status: "skipped",
        detail: "Sin contactos de limpieza activos para esta propiedad",
      });
      continue;
    }

    const results: SendTemplateResult[] = [];
    for (const c of cleaners) {
      if (!isValidE164(c.phoneE164)) {
        results.push({ ok: false, error: `Teléfono inválido del contacto: ${c.phoneE164}` });
        continue;
      }
      if (dryRun) {
        results.push({ ok: true, messageId: "DRY_RUN" });
        actions.push({
          reservationId: r.id,
          slug: r.property_slug,
          action: `limpieza_aviso_entrada → ${c.name} (${c.phoneE164})`,
          status: "sent",
          detail: "dryRun",
        });
        continue;
      }
      const res = await sendLimpiezaAvisoEntrada(
        {
          toPhone: c.phoneE164,
          cleanerName: c.name,
          checkInDateEs: formatDateShortEs(r.check_in),
          propertyName,
          checkOutDateEs: formatDateShortEs(r.check_out),
        },
        waEnv,
      );
      results.push(res);
      actions.push({
        reservationId: r.id,
        slug: r.property_slug,
        action: `limpieza_aviso_entrada → ${c.name} (${c.phoneE164})`,
        status: res.ok ? "sent" : "failed",
        detail: res.ok ? res.messageId : res.error,
      });
      await logSend(
        env,
        "tpl_limpieza_aviso_entrada",
        `🧹 Aviso víspera de check-in a limpieza — ${propertyName}`,
        r.id,
        res,
        c.phoneE164,
      );
    }
    await markBatchResult(
      env.DB,
      r.id,
      "wa_eve_cleaning_sent_at",
      "wa_eve_cleaning_error",
      results,
      dryRun,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hito 1: morning-staff (7 AM HN)
// Avisa a SEGURIDAD de las propiedades con CHECK-IN hoy. (El aviso a limpieza
// se movió a la víspera — hito evening-staff — por decisión de César 2026-07-12;
// checkin_dia_limpieza queda disponible solo para disparo manual.)
// ─────────────────────────────────────────────────────────────────────────────

export async function runMorningStaff(
  env: Env,
  waEnv: { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
  targetDate: string,
  dryRun: boolean,
  actions: ActionResult[],
): Promise<void> {
  const reservations = await fetchArrivals(env.DB, targetDate);

  for (const r of reservations) {
    const propertyName = PROPERTY_NAMES[r.property_slug] || r.property_slug;
    const guestFullName = r.guest_name || "Huésped sin nombre";
    const checkOutEs = formatDateShortEs(r.check_out);

    // ── Seguridad ─────────────────────────────────────────────────
    if (!r.wa_arrival_security_sent_at) {
      const guards = await getSecurityContacts(r.property_slug, env.DB);
      if (guards.length === 0) {
        actions.push({
          reservationId: r.id,
          slug: r.property_slug,
          action: "checkin_dia_seguridad",
          status: "skipped",
          detail: "Sin contactos de seguridad activos para esta propiedad",
        });
      } else {
        const results: SendTemplateResult[] = [];
        for (const g of guards) {
          if (!isValidE164(g.phoneE164)) {
            results.push({ ok: false, error: `Teléfono inválido del guardia: ${g.phoneE164}` });
            continue;
          }
          if (dryRun) {
            results.push({ ok: true, messageId: "DRY_RUN" });
            actions.push({
              reservationId: r.id,
              slug: r.property_slug,
              action: `checkin_dia_seguridad → ${g.name} (${g.phoneE164})`,
              status: "sent",
              detail: "dryRun",
            });
            continue;
          }
          const res = await sendCheckinDiaSeguridad(
            {
              toPhone: g.phoneE164,
              guestFullName,
              checkOutDateEs: checkOutEs,
            },
            waEnv,
          );
          results.push(res);
          actions.push({
            reservationId: r.id,
            slug: r.property_slug,
            action: `checkin_dia_seguridad → ${g.name} (${g.phoneE164})`,
            status: res.ok ? "sent" : "failed",
            detail: res.ok ? res.messageId : res.error,
          });
          await logSend(
            env,
            "tpl_checkin_dia_seguridad",
            `🛡️ Aviso de check-in a seguridad — ${propertyName}`,
            r.id,
            res,
            g.phoneE164,
          );
        }
        await markBatchResult(
          env.DB,
          r.id,
          "wa_arrival_security_sent_at",
          "wa_arrival_security_error",
          results,
          dryRun,
        );
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hito 2: morning-guests (10 AM HN)
// Mensaje al huésped con CHECK-IN hoy + mensaje al huésped con CHECKOUT hoy.
// ─────────────────────────────────────────────────────────────────────────────

async function runMorningGuests(
  env: Env,
  waEnv: { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
  targetDate: string,
  dryRun: boolean,
  actions: ActionResult[],
): Promise<void> {
  // ── Llegadas hoy ──────────────────────────────────────────────────
  const arrivals = await fetchArrivals(env.DB, targetDate);
  for (const r of arrivals) {
    if (r.wa_arrival_guest_sent_at) continue;
    await sendToGuest(
      env,
      waEnv,
      r,
      "arrival",
      (toPhone, guestName, propertyName) =>
        sendCheckinDiaHuesped(
          {
            toPhone,
            guestName,
            propertyName,
            city: PROPERTY_CITIES[r.property_slug] || "Honduras",
          },
          waEnv,
        ),
      "wa_arrival_guest_sent_at",
      "wa_arrival_guest_error",
      "checkin_dia_huesped",
      dryRun,
      actions,
    );
  }

  // ── Salidas hoy ───────────────────────────────────────────────────
  const departures = await fetchDepartures(env.DB, targetDate);
  for (const r of departures) {
    if (r.wa_departure_guest_sent_at) continue;
    await sendToGuest(
      env,
      waEnv,
      r,
      "departure",
      (toPhone, guestName, propertyName) =>
        sendCheckoutDiaHuesped(
          { toPhone, guestName, propertyName },
          waEnv,
        ),
      "wa_departure_guest_sent_at",
      "wa_departure_guest_error",
      "checkout_dia_huesped",
      dryRun,
      actions,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hito 3: checkout-cleaning (11:30 AM HN)
// Avisa al personal de limpieza que la propiedad está libre.
// ─────────────────────────────────────────────────────────────────────────────

async function runCheckoutCleaning(
  env: Env,
  waEnv: { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
  targetDate: string,
  dryRun: boolean,
  actions: ActionResult[],
): Promise<void> {
  const departures = await fetchDepartures(env.DB, targetDate);

  for (const r of departures) {
    if (r.wa_departure_cleaning_sent_at) continue;

    const propertyName = PROPERTY_NAMES[r.property_slug] || r.property_slug;
    const nextLabel = await getNextCheckInLabel(env.DB, r.property_slug, targetDate);

    const cleaners = await getCleaningContacts(r.property_slug, env.DB);
    if (cleaners.length === 0) {
      actions.push({
        reservationId: r.id,
        slug: r.property_slug,
        action: "checkout_dia_limpieza",
        status: "skipped",
        detail: "Sin contactos de limpieza activos",
      });
      continue;
    }

    const results: SendTemplateResult[] = [];
    for (const c of cleaners) {
      if (!isValidE164(c.phoneE164)) {
        results.push({ ok: false, error: `Teléfono inválido: ${c.phoneE164}` });
        continue;
      }
      if (dryRun) {
        results.push({ ok: true, messageId: "DRY_RUN" });
        actions.push({
          reservationId: r.id,
          slug: r.property_slug,
          action: `checkout_dia_limpieza → ${c.name} (${c.phoneE164})`,
          status: "sent",
          detail: "dryRun",
        });
        continue;
      }
      const res = await sendCheckoutDiaLimpieza(
        {
          toPhone: c.phoneE164,
          cleanerName: c.name,
          propertyName,
          nextCheckInLabel: nextLabel,
        },
        waEnv,
      );
      results.push(res);
      actions.push({
        reservationId: r.id,
        slug: r.property_slug,
        action: `checkout_dia_limpieza → ${c.name} (${c.phoneE164})`,
        status: res.ok ? "sent" : "failed",
        detail: res.ok ? res.messageId : res.error,
      });
      await logSend(
        env,
        "tpl_checkout_dia_limpieza",
        `🧹 Aviso de check-out a limpieza — ${propertyName}`,
        r.id,
        res,
        c.phoneE164,
      );
    }
    await markBatchResult(
      env.DB,
      r.id,
      "wa_departure_cleaning_sent_at",
      "wa_departure_cleaning_error",
      results,
      dryRun,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers compartidos
// ─────────────────────────────────────────────────────────────────────────────

// Sin filtro de source (César, 2026-07-12): 'confirmed' ya implica pago
// verificado, así que Airbnb, web y directas se automatizan por igual. La
// idempotencia por wa_*_sent_at evita dobles con los disparos inline del
// paypal-webhook (reservas directas del mismo día) y con los manuales.
async function fetchArrivals(db: D1Database, targetDate: string): Promise<ReservationRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, property_slug, check_in, check_out, guest_name, guest_phone, guest_count,
              wa_arrival_guest_sent_at, wa_arrival_cleaning_sent_at, wa_arrival_security_sent_at,
              wa_departure_guest_sent_at, wa_departure_cleaning_sent_at, wa_eve_cleaning_sent_at
         FROM reservations
        WHERE status = 'confirmed'
          AND check_in = ?`,
    )
    .bind(targetDate)
    .all<ReservationRow>();
  return results ?? [];
}

async function fetchDepartures(db: D1Database, targetDate: string): Promise<ReservationRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, property_slug, check_in, check_out, guest_name, guest_phone, guest_count,
              wa_arrival_guest_sent_at, wa_arrival_cleaning_sent_at, wa_arrival_security_sent_at,
              wa_departure_guest_sent_at, wa_departure_cleaning_sent_at, wa_eve_cleaning_sent_at
         FROM reservations
        WHERE status = 'confirmed'
          AND check_out = ?`,
    )
    .bind(targetDate)
    .all<ReservationRow>();
  return results ?? [];
}

/**
 * Busca la próxima reserva confirmada en la misma propiedad después de la fecha
 * dada (exclusiva). Devuelve label en español para el template de limpieza.
 */
async function getNextCheckInLabel(
  db: D1Database,
  slug: string,
  afterDate: string,
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT check_in
         FROM reservations
        WHERE property_slug = ?
          AND status IN ('confirmed', 'pending')
          AND check_in > ?
        ORDER BY check_in ASC
        LIMIT 1`,
    )
    .bind(slug, afterDate)
    .first<{ check_in: string }>();
  if (!row?.check_in) return "sin reserva próxima";
  return formatDateShortEs(row.check_in);
}

/**
 * Envía template al huésped. Maneja: validación teléfono, dryRun, marca en D1.
 */
async function sendToGuest(
  env: Env,
  _waEnv: { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
  r: ReservationRow,
  phase: "arrival" | "departure",
  sendFn: (toPhone: string, guestName: string, propertyName: string) => Promise<SendTemplateResult>,
  sentAtColumn: string,
  errorColumn: string,
  templateLabel: string,
  dryRun: boolean,
  actions: ActionResult[],
): Promise<void> {
  const propertyName = PROPERTY_NAMES[r.property_slug] || r.property_slug;
  const guestName = (r.guest_name || "huésped").split(" ")[0]; // solo primer nombre, más personal

  if (!r.guest_phone) {
    actions.push({
      reservationId: r.id,
      slug: r.property_slug,
      action: templateLabel,
      status: "skipped",
      detail: "Reserva sin guest_phone (huésped no compartió WhatsApp)",
    });
    return;
  }
  const { e164 } = normalizePhone(r.guest_phone);
  if (!isValidE164(e164)) {
    actions.push({
      reservationId: r.id,
      slug: r.property_slug,
      action: templateLabel,
      status: "failed",
      detail: `Teléfono inválido: ${r.guest_phone} → ${e164}`,
    });
    return;
  }

  if (dryRun) {
    actions.push({
      reservationId: r.id,
      slug: r.property_slug,
      action: `${templateLabel} → ${guestName} (${e164})`,
      status: "sent",
      detail: "dryRun",
    });
    return;
  }

  const res = await sendFn(e164, guestName, propertyName);
  actions.push({
    reservationId: r.id,
    slug: r.property_slug,
    action: `${templateLabel} → ${guestName} (${e164})`,
    status: res.ok ? "sent" : "failed",
    detail: res.ok ? res.messageId : res.error,
  });
  await logSend(
    env,
    `tpl_${templateLabel}`,
    phase === "arrival"
      ? `🏠 Aviso día de check-in al huésped — ${propertyName}`
      : `🧳 Aviso día de check-out al huésped — ${propertyName}`,
    r.id,
    res,
    e164,
  );

  try {
    if (res.ok) {
      await env.DB.prepare(
        `UPDATE reservations
            SET ${sentAtColumn} = datetime('now'),
                ${errorColumn} = NULL,
                updated_at = datetime('now')
          WHERE id = ?`,
      )
        .bind(r.id)
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE reservations
            SET ${errorColumn} = ?,
                updated_at = datetime('now')
          WHERE id = ?`,
      )
        .bind((res.error ?? "desconocido").slice(0, 1000), r.id)
        .run();
    }
  } catch (dbErr) {
    console.error(
      `[whatsapp-operations] Error actualizando D1 (id=${r.id}, col=${sentAtColumn}):`,
      (dbErr as Error).message,
    );
  }
}

/**
 * Fila rastreable en whatsapp_messages por cada envío REAL (nunca en dryRun —
 * los caminos de dryRun hacen `continue` antes de llegar acá). Con el wamid,
 * el callback de Meta actualiza sent→delivered→read→failed y el envío aparece
 * en la card "📬 Salud de entrega". Fail-soft: logOutboundTemplate nunca lanza.
 */
async function logSend(
  env: Env,
  rule: string,
  summary: string,
  reservationId: number,
  res: SendTemplateResult,
  toPhone: string,
): Promise<void> {
  if (!env.WHATSAPP_PHONE_NUMBER_ID) return;
  await logOutboundTemplate(env.DB, {
    fromPhone: env.WHATSAPP_PHONE_NUMBER_ID,
    toPhone,
    rule,
    summary,
    reservationId,
    ok: res.ok,
    messageId: res.messageId ?? null,
    error: res.error ?? null,
  });
}

/**
 * Marca el resultado de un envío en lote (N contactos por reserva).
 * Considera "exitoso" si AL MENOS UNO se envió OK (criterio defensivo:
 * algo es mejor que nada para la operación). Los errores específicos
 * van al campo de error para visibilidad.
 */
async function markBatchResult(
  db: D1Database,
  reservationId: number,
  sentAtColumn: string,
  errorColumn: string,
  results: SendTemplateResult[],
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  const anyOk = results.some((r) => r.ok);
  const errors = results.filter((r) => !r.ok).map((r) => r.error).filter(Boolean);

  try {
    if (anyOk) {
      await db
        .prepare(
          `UPDATE reservations
              SET ${sentAtColumn} = datetime('now'),
                  ${errorColumn} = ?,
                  updated_at = datetime('now')
            WHERE id = ?`,
        )
        .bind(errors.length > 0 ? errors.join(" | ").slice(0, 1000) : null, reservationId)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE reservations
              SET ${errorColumn} = ?,
                  updated_at = datetime('now')
            WHERE id = ?`,
        )
        .bind((errors.join(" | ") || "todos los envíos fallaron").slice(0, 1000), reservationId)
        .run();
    }
  } catch (dbErr) {
    console.error(
      `[whatsapp-operations] Error markBatchResult (id=${reservationId}):`,
      (dbErr as Error).message,
    );
  }
}
