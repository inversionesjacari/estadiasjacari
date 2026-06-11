/// <reference types="@cloudflare/workers-types" />
//
// POST /api/admin/send-whatsapp-manual
//
// Endpoint privado para disparar manualmente CUALQUIER template operativo de
// WhatsApp a una reserva o a un teléfono ad-hoc, sin esperar al cron. Útil
// para casos sueltos: reenvíos, re-tests, propiedades sin contactos staff
// registrados aún, etc.
//
// Auth: Authorization: Bearer <CRON_SECRET>  (mismo secret del cron + test-email)
//
// Body JSON — DOS modos:
//
// Modo A — por reserva (idempotente; respeta wa_*_sent_at):
//   {
//     "template": "checkin_dia_huesped"|"checkin_dia_limpieza"|"checkin_dia_seguridad"|
//                 "checkout_dia_huesped"|"checkout_dia_limpieza"|"confirmacion_whatsapp_capturado",
//     "reservationId": 42,
//     "force": false   // si true, ignora el wa_*_sent_at y reenvía
//   }
//
// Modo B — ad-hoc (NO idempotente, NO actualiza D1):
//   {
//     "template": "<mismo set de arriba>",
//     "toPhone":  "+50488390145",            // requerido en modo B
//     "vars": ["César","Casa Brisa","Tela"]   // requerido — variables en orden {{1}},{{2}},...
//   }
//
// El endpoint detecta el modo por presencia de reservationId vs toPhone.
//
// Rate limit: 10 requests por 60s por IP (mismo patrón que test-email y test-whatsapp).
//

import { normalizePhone, isValidE164 } from "../../_lib/phone";
import { todayHn } from "../../_lib/dates";
import { checkRateLimit, getClientIp } from "../../_lib/rate-limit";
import { requireBearerAuth } from "../../_lib/admin-auth";
import { getCleaningContacts, getSecurityContacts } from "../../_lib/property-contacts";
import {
  sendCheckinDiaHuesped,
  sendCheckinDiaLimpieza,
  sendCheckinDiaSeguridad,
  sendCheckoutDiaHuesped,
  sendCheckoutDiaLimpieza,
  sendConfirmacionWhatsappCapturado,
  sendTextTemplate,
  formatDateShortEs,
  type SendTemplateResult,
} from "../../_lib/whatsapp-templates";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

type TemplateName =
  | "checkin_dia_huesped"
  | "checkin_dia_limpieza"
  | "checkin_dia_seguridad"
  | "checkout_dia_huesped"
  | "checkout_dia_limpieza"
  | "confirmacion_whatsapp_capturado";

const VALID_TEMPLATES: TemplateName[] = [
  "checkin_dia_huesped",
  "checkin_dia_limpieza",
  "checkin_dia_seguridad",
  "checkout_dia_huesped",
  "checkout_dia_limpieza",
  "confirmacion_whatsapp_capturado",
];

interface RequestBody {
  template?: TemplateName;
  reservationId?: number;
  toPhone?: string;
  vars?: string[];
  force?: boolean;
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
  wa_phone_capture_sent_at: string | null;
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

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // 1. Auth (timing-safe Bearer compare via helper compartido)
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  // 2. Rate limit
  const ip = getClientIp(request);
  const rl = await checkRateLimit(env, {
    endpoint: "admin/send-whatsapp-manual",
    ip,
    max: 10,
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

  // 3. Validar config Meta
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return json({
      ok: false,
      error: "Faltan env vars WHATSAPP_ACCESS_TOKEN y/o WHATSAPP_PHONE_NUMBER_ID",
    }, 500);
  }

  // 4. Parse body
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch (err) {
    return json({ ok: false, error: `Body no es JSON: ${(err as Error).message}` }, 400);
  }

  if (!body.template || !VALID_TEMPLATES.includes(body.template)) {
    return json({
      ok: false,
      error: `template inválido. Válidos: ${VALID_TEMPLATES.join(", ")}`,
    }, 400);
  }

  const waEnv = {
    WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
  };

  // 5. Dispatch — Modo A (reservationId) o Modo B (toPhone + vars)
  if (body.reservationId) {
    return handleByReservation(body, env, waEnv);
  } else if (body.toPhone && body.vars) {
    return handleAdHoc(body, waEnv);
  } else {
    return json({
      ok: false,
      error: "Body debe incluir 'reservationId' (modo A) o 'toPhone' + 'vars' (modo B).",
    }, 400);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Modo A — Enviar template a una reserva específica (lee D1, idempotente)
// ─────────────────────────────────────────────────────────────────────────────

async function handleByReservation(
  body: RequestBody,
  env: Env,
  waEnv: { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
): Promise<Response> {
  const reservationId = body.reservationId!;
  const template = body.template!;
  const force = body.force === true;

  // Cargar la reserva
  const r = await env.DB.prepare(
    `SELECT id, property_slug, check_in, check_out, guest_name, guest_phone, guest_count,
            wa_arrival_guest_sent_at, wa_arrival_cleaning_sent_at, wa_arrival_security_sent_at,
            wa_departure_guest_sent_at, wa_departure_cleaning_sent_at, wa_phone_capture_sent_at
       FROM reservations
      WHERE id = ?`,
  )
    .bind(reservationId)
    .first<ReservationRow>();

  if (!r) {
    return json({ ok: false, error: `Reserva id=${reservationId} no encontrada` }, 404);
  }

  const propertyName = PROPERTY_NAMES[r.property_slug] || r.property_slug;
  const city = PROPERTY_CITIES[r.property_slug] || "Honduras";

  // Mapear template → (sentAtColumn, errorColumn, builder)
  const ops: Record<
    TemplateName,
    {
      sentAtColumn: keyof ReservationRow;
      errorColumn: string;
      run: () => Promise<{ results: SendTemplateResult[]; detail: string }>;
    }
  > = {
    checkin_dia_huesped: {
      sentAtColumn: "wa_arrival_guest_sent_at",
      errorColumn: "wa_arrival_guest_error",
      run: async () => runGuestTemplate(r, env, waEnv, "arrival", propertyName, city),
    },
    checkout_dia_huesped: {
      sentAtColumn: "wa_departure_guest_sent_at",
      errorColumn: "wa_departure_guest_error",
      run: async () => runGuestTemplate(r, env, waEnv, "departure", propertyName, city),
    },
    checkin_dia_limpieza: {
      sentAtColumn: "wa_arrival_cleaning_sent_at",
      errorColumn: "wa_arrival_cleaning_error",
      run: async () => runStaffTemplate(r, env, waEnv, "cleaning", "arrival", propertyName),
    },
    checkout_dia_limpieza: {
      sentAtColumn: "wa_departure_cleaning_sent_at",
      errorColumn: "wa_departure_cleaning_error",
      run: async () => runStaffTemplate(r, env, waEnv, "cleaning", "departure", propertyName),
    },
    checkin_dia_seguridad: {
      sentAtColumn: "wa_arrival_security_sent_at",
      errorColumn: "wa_arrival_security_error",
      run: async () => runStaffTemplate(r, env, waEnv, "security", "arrival", propertyName),
    },
    confirmacion_whatsapp_capturado: {
      sentAtColumn: "wa_phone_capture_sent_at",
      errorColumn: "wa_phone_capture_error",
      run: async () => runConfirmationTemplate(r, waEnv, propertyName),
    },
  };

  const op = ops[template];

  // Idempotencia (a menos que force=true)
  if (!force && r[op.sentAtColumn]) {
    return json({
      ok: true,
      skipped: true,
      reason: `Template "${template}" ya se envió a esta reserva el ${r[op.sentAtColumn]}. Usar "force": true para reenviar.`,
      reservationId,
    });
  }

  // Ejecutar
  const { results, detail } = await op.run();
  const anyOk = results.some((res) => res.ok);
  const errors = results
    .filter((res) => !res.ok)
    .map((res) => res.error)
    .filter(Boolean);

  // Persistir en D1
  try {
    if (anyOk) {
      await env.DB.prepare(
        `UPDATE reservations
            SET ${op.sentAtColumn} = datetime('now'),
                ${op.errorColumn} = ?,
                updated_at = datetime('now')
          WHERE id = ?`,
      )
        .bind(errors.length > 0 ? errors.join(" | ").slice(0, 1000) : null, reservationId)
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE reservations
            SET ${op.errorColumn} = ?,
                updated_at = datetime('now')
          WHERE id = ?`,
      )
        .bind((errors.join(" | ") || "todos los envíos fallaron").slice(0, 1000), reservationId)
        .run();
    }
  } catch (dbErr) {
    console.error("Error actualizando D1:", (dbErr as Error).message);
  }

  return json({
    ok: anyOk,
    template,
    reservationId,
    propertyName,
    detail,
    results: results.map((r) => ({ ok: r.ok, messageId: r.messageId, error: r.error })),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Modo B — Ad-hoc (no toca D1)
// ─────────────────────────────────────────────────────────────────────────────

async function handleAdHoc(
  body: RequestBody,
  waEnv: { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
): Promise<Response> {
  const template = body.template!;
  const { e164 } = normalizePhone(body.toPhone!);
  if (!isValidE164(e164)) {
    return json({
      ok: false,
      error: `toPhone inválido: "${body.toPhone}" → "${e164}"`,
    }, 400);
  }
  const vars = body.vars ?? [];

  const result = await sendTextTemplate(template, e164, vars, waEnv);
  return json({
    ok: result.ok,
    mode: "ad-hoc",
    template,
    toPhone: e164,
    vars,
    messageId: result.messageId,
    error: result.error,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Builders por tipo de template (compartidos entre cron y este admin endpoint
// — duplicación intencional para mantener el admin independiente del cron).
// ─────────────────────────────────────────────────────────────────────────────

async function runGuestTemplate(
  r: ReservationRow,
  _env: Env,
  waEnv: { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
  phase: "arrival" | "departure",
  propertyName: string,
  city: string,
): Promise<{ results: SendTemplateResult[]; detail: string }> {
  if (!r.guest_phone) {
    return { results: [{ ok: false, error: "Reserva sin guest_phone" }], detail: "skip" };
  }
  const { e164 } = normalizePhone(r.guest_phone);
  if (!isValidE164(e164)) {
    return { results: [{ ok: false, error: `Teléfono inválido: ${r.guest_phone}` }], detail: "skip" };
  }
  const firstName = (r.guest_name || "huésped").split(" ")[0];
  let res: SendTemplateResult;
  if (phase === "arrival") {
    res = await sendCheckinDiaHuesped({ toPhone: e164, guestName: firstName, propertyName, city }, waEnv);
  } else {
    res = await sendCheckoutDiaHuesped({ toPhone: e164, guestName: firstName, propertyName }, waEnv);
  }
  return { results: [res], detail: `1 envío a ${firstName} (${e164})` };
}

async function runStaffTemplate(
  r: ReservationRow,
  env: Env,
  waEnv: { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
  role: "cleaning" | "security",
  phase: "arrival" | "departure",
  propertyName: string,
): Promise<{ results: SendTemplateResult[]; detail: string }> {
  const contacts = role === "cleaning"
    ? await getCleaningContacts(r.property_slug, env.DB)
    : await getSecurityContacts(r.property_slug, env.DB);

  if (contacts.length === 0) {
    return {
      results: [{ ok: false, error: `Sin contactos activos para role=${role} en ${r.property_slug}` }],
      detail: "skip",
    };
  }

  const results: SendTemplateResult[] = [];
  for (const c of contacts) {
    if (!isValidE164(c.phoneE164)) {
      results.push({ ok: false, error: `Teléfono inválido: ${c.phoneE164}` });
      continue;
    }
    if (role === "cleaning" && phase === "arrival") {
      results.push(await sendCheckinDiaLimpieza(
        {
          toPhone: c.phoneE164,
          cleanerName: c.name,
          propertyName,
          numberOfGuests: String(r.guest_count ?? 1),
          checkOutDateEs: formatDateShortEs(r.check_out),
        },
        waEnv,
      ));
    } else if (role === "cleaning" && phase === "departure") {
      // Para checkout, calcular el próximo check-in (igual que en el cron)
      const nextLabel = await getNextCheckInLabel(env.DB, r.property_slug, todayHn());
      results.push(await sendCheckoutDiaLimpieza(
        {
          toPhone: c.phoneE164,
          cleanerName: c.name,
          propertyName,
          nextCheckInLabel: nextLabel,
        },
        waEnv,
      ));
    } else if (role === "security" && phase === "arrival") {
      results.push(await sendCheckinDiaSeguridad(
        {
          toPhone: c.phoneE164,
          propertyName,
          guestFullName: r.guest_name || "Huésped sin nombre",
          numberOfGuests: String(r.guest_count ?? 1),
        },
        waEnv,
      ));
    } else {
      // No hay template "checkout_dia_seguridad" — saltar
      results.push({ ok: false, error: `Combinación role=${role} phase=${phase} no implementada` });
    }
  }
  return { results, detail: `${contacts.length} contactos ${role}` };
}

async function runConfirmationTemplate(
  r: ReservationRow,
  waEnv: { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
  propertyName: string,
): Promise<{ results: SendTemplateResult[]; detail: string }> {
  if (!r.guest_phone) {
    return { results: [{ ok: false, error: "Reserva sin guest_phone" }], detail: "skip" };
  }
  const { e164 } = normalizePhone(r.guest_phone);
  if (!isValidE164(e164)) {
    return { results: [{ ok: false, error: `Teléfono inválido: ${r.guest_phone}` }], detail: "skip" };
  }
  const firstName = (r.guest_name || "huésped").split(" ")[0];
  const res = await sendConfirmacionWhatsappCapturado(
    {
      toPhone: e164,
      guestName: firstName,
      propertyName,
      checkInDateEs: formatDateShortEs(r.check_in),
      checkOutDateEs: formatDateShortEs(r.check_out),
    },
    waEnv,
  );
  return { results: [res], detail: `confirmación a ${firstName} (${e164})` };
}

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
