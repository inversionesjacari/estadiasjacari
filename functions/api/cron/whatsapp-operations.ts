/// <reference types="@cloudflare/workers-types" />
//
// POST /api/cron/whatsapp-operations?hito=<hito>
//
// Cron orquestador de los 6 templates UTILITY operativos de WhatsApp.
// Disparado por el Worker `estadia-jacari-cron` en 3 horarios distintos del día
// (hora Honduras, UTC-6 sin daylight saving):
//
//   ┌──────────────┬──────────────┬─────────────────────────────────────────────┐
//   │ Hito         │ Hora HN      │ Qué hace                                     │
//   ├──────────────┼──────────────┼─────────────────────────────────────────────┤
//   │ morning-staff   │ 7:00 AM   │ Avisa a personal limpieza + seguridad de     │
//   │                 │           │ las propiedades con CHECK-IN hoy.            │
//   │ morning-guests  │ 9:00 AM   │ Mensaje al huésped con CHECK-IN hoy +        │
//   │                 │           │ mensaje al huésped con CHECKOUT hoy.         │
//   │ checkout-cleaning│11:30 AM  │ Avisa a personal limpieza de las             │
//   │                 │           │ propiedades con CHECKOUT hoy.                │
//   └──────────────┴──────────────┴─────────────────────────────────────────────┘
//
// El template T-1 día del huésped (`checkin_instructions` con PDF) lo sigue
// disparando el cron existente `/api/cron/checkin-reminders` a las 6 PM HN.
// Este endpoint NO lo toca.
//
// Auth: Authorization: Bearer <CRON_SECRET>
//
// Query params:
//   ?hito=morning-staff|morning-guests|checkout-cleaning  (requerido)
//   ?date=YYYY-MM-DD                                       (opcional, override de "hoy")
//   ?dryRun=1                                              (opcional, no envía nada)
//
// Idempotencia: cada wrapper revisa `wa_*_sent_at IS NULL` antes de enviar.
// Si Meta retorna error, se guarda en `wa_*_error` y se reintenta al día
// siguiente (las reservas con check-in pasado no aplican porque salen del
// WHERE check_in = TODAY).
//
// Respuesta SIEMPRE 200 con cuerpo JSON detallado (ok=true incluso si algunos
// envíos individuales fallaron — el detalle lista cada uno).
//

import { todayHn } from "../../_lib/dates";
import { normalizePhone, isValidE164 } from "../../_lib/phone";
import { getCleaningContacts, getSecurityContacts } from "../../_lib/property-contacts";
import { checkRateLimit, getClientIp } from "../../_lib/rate-limit";
import { requireBearerAuth } from "../../_lib/admin-auth";
import {
  sendCheckinDiaHuesped,
  sendCheckinDiaLimpieza,
  sendCheckinDiaSeguridad,
  sendCheckoutDiaHuesped,
  sendCheckoutDiaLimpieza,
  formatDateShortEs,
  type SendTemplateResult,
} from "../../_lib/whatsapp-templates";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

type Hito = "morning-staff" | "morning-guests" | "checkout-cleaning";

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

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
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
  if (!hito || !["morning-staff", "morning-guests", "checkout-cleaning"].includes(hito)) {
    return json(
      {
        ok: false,
        error: `Query param 'hito' requerido. Valores válidos: morning-staff, morning-guests, checkout-cleaning. Recibido: ${hito}`,
      },
      400,
    );
  }
  const dryRun = url.searchParams.get("dryRun") === "1";
  const dateParam = url.searchParams.get("date");
  const targetDate =
    dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : todayHn();

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
    if (hito === "morning-staff") {
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
// Hito 1: morning-staff (7 AM HN)
// Avisa a personal limpieza + seguridad de las propiedades con CHECK-IN hoy.
// ─────────────────────────────────────────────────────────────────────────────

async function runMorningStaff(
  env: Env,
  waEnv: { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
  targetDate: string,
  dryRun: boolean,
  actions: ActionResult[],
): Promise<void> {
  const reservations = await fetchArrivalsToday(env.DB, targetDate);

  for (const r of reservations) {
    const propertyName = PROPERTY_NAMES[r.property_slug] || r.property_slug;
    const guestFullName = r.guest_name || "Huésped sin nombre";
    const guestCount = String(r.guest_count ?? 1);
    const checkOutEs = formatDateShortEs(r.check_out);

    // ── Limpieza ──────────────────────────────────────────────────
    if (!r.wa_arrival_cleaning_sent_at) {
      const cleaners = await getCleaningContacts(r.property_slug, env.DB);
      if (cleaners.length === 0) {
        actions.push({
          reservationId: r.id,
          slug: r.property_slug,
          action: "checkin_dia_limpieza",
          status: "skipped",
          detail: "Sin contactos de limpieza activos para esta propiedad",
        });
      } else {
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
              action: `checkin_dia_limpieza → ${c.name} (${c.phoneE164})`,
              status: "sent",
              detail: "dryRun",
            });
            continue;
          }
          const res = await sendCheckinDiaLimpieza(
            {
              toPhone: c.phoneE164,
              cleanerName: c.name,
              propertyName,
              numberOfGuests: guestCount,
              checkOutDateEs: checkOutEs,
            },
            waEnv,
          );
          results.push(res);
          actions.push({
            reservationId: r.id,
            slug: r.property_slug,
            action: `checkin_dia_limpieza → ${c.name} (${c.phoneE164})`,
            status: res.ok ? "sent" : "failed",
            detail: res.ok ? res.messageId : res.error,
          });
        }
        await markBatchResult(
          env.DB,
          r.id,
          "wa_arrival_cleaning_sent_at",
          "wa_arrival_cleaning_error",
          results,
          dryRun,
        );
      }
    }

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
              propertyName,
              guestFullName,
              numberOfGuests: guestCount,
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
// Hito 2: morning-guests (9 AM HN)
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
  const arrivals = await fetchArrivalsToday(env.DB, targetDate);
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
  const departures = await fetchDeparturesToday(env.DB, targetDate);
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
  const departures = await fetchDeparturesToday(env.DB, targetDate);

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

async function fetchArrivalsToday(db: D1Database, targetDate: string): Promise<ReservationRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, property_slug, check_in, check_out, guest_name, guest_phone, guest_count,
              wa_arrival_guest_sent_at, wa_arrival_cleaning_sent_at, wa_arrival_security_sent_at,
              wa_departure_guest_sent_at, wa_departure_cleaning_sent_at
         FROM reservations
        WHERE status = 'confirmed'
          AND check_in = ?`,
    )
    .bind(targetDate)
    .all<ReservationRow>();
  return results ?? [];
}

async function fetchDeparturesToday(db: D1Database, targetDate: string): Promise<ReservationRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, property_slug, check_in, check_out, guest_name, guest_phone, guest_count,
              wa_arrival_guest_sent_at, wa_arrival_cleaning_sent_at, wa_arrival_security_sent_at,
              wa_departure_guest_sent_at, wa_departure_cleaning_sent_at
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
  _phase: "arrival" | "departure",
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
