/// <reference types="@cloudflare/workers-types" />
//
// Lógica compartida para disparar UN template operativo de WhatsApp a una
// reserva específica (Modo A "por reserva"). La reutilizan:
//   - functions/api/admin/send-whatsapp-manual.ts   (auth Bearer CRON_SECRET)
//   - functions/api/inbox/reservation-send-message.ts (auth cookie del inbox)
//
// Idempotente: respeta la columna wa_*_sent_at de la reserva salvo `force=true`.
// Marca el resultado en D1 (sent_at en éxito, error en falla). `dryRun=true`
// valida teléfono/contactos y ruteo SIN enviar a Meta ni tocar D1.
//
// Devuelve un objeto transport-agnóstico { ok, status, body }; cada endpoint lo
// envuelve en su propia Response. Así el helper no conoce el mecanismo de auth.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { normalizePhone, isValidE164 } from "./phone";
import { todayHn } from "./dates";
import { getCleaningContacts, getSecurityContacts } from "./property-contacts";
import {
  sendCheckinDiaHuesped,
  sendCheckinDiaLimpieza,
  sendCheckinDiaSeguridad,
  sendCheckoutDiaHuesped,
  sendCheckoutDiaLimpieza,
  sendConfirmacionWhatsappCapturado,
  formatDateShortEs,
  type SendTemplateResult,
} from "./whatsapp-templates";

export interface DispatchEnv {
  DB: D1Database;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

export type DispatchTemplateName =
  | "checkin_dia_huesped"
  | "checkin_dia_limpieza"
  | "checkin_dia_seguridad"
  | "checkout_dia_huesped"
  | "checkout_dia_limpieza"
  | "confirmacion_whatsapp_capturado";

export const VALID_TEMPLATES: DispatchTemplateName[] = [
  "checkin_dia_huesped",
  "checkin_dia_limpieza",
  "checkin_dia_seguridad",
  "checkout_dia_huesped",
  "checkout_dia_limpieza",
  "confirmacion_whatsapp_capturado",
];

export interface DispatchResult {
  ok: boolean;
  status: number; // status HTTP sugerido para el caller
  body: Record<string, unknown>;
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

interface DispatchParams {
  reservationId: number;
  template: DispatchTemplateName;
  force?: boolean;
  dryRun?: boolean;
}

/**
 * Dispara un template operativo a una reserva. Único punto de verdad para los
 * dos endpoints (admin Bearer + inbox cookie). No lanza excepción salvo error de
 * red dentro de los wrappers de Meta (que devuelven {ok:false}).
 */
export async function dispatchTemplateToReservation(
  params: DispatchParams,
  env: DispatchEnv,
): Promise<DispatchResult> {
  const { reservationId, template } = params;
  const force = params.force === true;
  const dryRun = params.dryRun === true;

  if (!VALID_TEMPLATES.includes(template)) {
    return {
      ok: false,
      status: 400,
      body: { ok: false, error: `template inválido. Válidos: ${VALID_TEMPLATES.join(", ")}` },
    };
  }

  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: "Faltan env vars WHATSAPP_ACCESS_TOKEN y/o WHATSAPP_PHONE_NUMBER_ID" },
    };
  }

  const waEnv = {
    WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
  };

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
    return { ok: false, status: 404, body: { ok: false, error: `Reserva id=${reservationId} no encontrada` } };
  }

  const propertyName = PROPERTY_NAMES[r.property_slug] || r.property_slug;
  const city = PROPERTY_CITIES[r.property_slug] || "Honduras";

  // Mapear template → (columna sent_at, columna error, builder)
  const ops: Record<
    DispatchTemplateName,
    {
      sentAtColumn: keyof ReservationRow;
      errorColumn: string;
      run: () => Promise<{ results: SendTemplateResult[]; detail: string }>;
    }
  > = {
    checkin_dia_huesped: {
      sentAtColumn: "wa_arrival_guest_sent_at",
      errorColumn: "wa_arrival_guest_error",
      run: async () => runGuestTemplate(r, dryRun, waEnv, "arrival", propertyName, city),
    },
    checkout_dia_huesped: {
      sentAtColumn: "wa_departure_guest_sent_at",
      errorColumn: "wa_departure_guest_error",
      run: async () => runGuestTemplate(r, dryRun, waEnv, "departure", propertyName, city),
    },
    checkin_dia_limpieza: {
      sentAtColumn: "wa_arrival_cleaning_sent_at",
      errorColumn: "wa_arrival_cleaning_error",
      run: async () => runStaffTemplate(r, dryRun, env, waEnv, "cleaning", "arrival", propertyName),
    },
    checkout_dia_limpieza: {
      sentAtColumn: "wa_departure_cleaning_sent_at",
      errorColumn: "wa_departure_cleaning_error",
      run: async () => runStaffTemplate(r, dryRun, env, waEnv, "cleaning", "departure", propertyName),
    },
    checkin_dia_seguridad: {
      sentAtColumn: "wa_arrival_security_sent_at",
      errorColumn: "wa_arrival_security_error",
      run: async () => runStaffTemplate(r, dryRun, env, waEnv, "security", "arrival", propertyName),
    },
    confirmacion_whatsapp_capturado: {
      sentAtColumn: "wa_phone_capture_sent_at",
      errorColumn: "wa_phone_capture_error",
      run: async () => runConfirmationTemplate(r, dryRun, waEnv, propertyName),
    },
  };

  const op = ops[template];

  // Idempotencia (a menos que force=true). En dryRun mostramos el aviso pero no
  // bloqueamos: es útil ver el preview aunque ya se haya enviado.
  if (!force && !dryRun && r[op.sentAtColumn]) {
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        skipped: true,
        reason: `Template "${template}" ya se envió a esta reserva el ${r[op.sentAtColumn]}. Usar "force": true para reenviar.`,
        reservationId,
      },
    };
  }

  // Ejecutar el builder (envía a Meta salvo dryRun)
  const { results, detail } = await op.run();
  const anyOk = results.some((res) => res.ok);
  const errors = results
    .filter((res) => !res.ok)
    .map((res) => res.error)
    .filter(Boolean);

  // Persistir en D1 (nunca en dryRun)
  if (!dryRun) {
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
      console.error("[whatsapp-dispatch] Error actualizando D1:", (dbErr as Error).message);
    }
  }

  return {
    ok: anyOk,
    status: 200,
    body: {
      ok: anyOk,
      template,
      reservationId,
      propertyName,
      dryRun,
      detail,
      results: results.map((res) => ({ ok: res.ok, messageId: res.messageId, error: res.error })),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Builders por tipo de template
// ─────────────────────────────────────────────────────────────────────────────

async function runGuestTemplate(
  r: ReservationRow,
  dryRun: boolean,
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

  if (dryRun) {
    return {
      results: [{ ok: true, messageId: "DRY_RUN" }],
      detail: `(dryRun) ${phase === "arrival" ? "checkin" : "checkout"} a ${firstName} (${e164})`,
    };
  }

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
  dryRun: boolean,
  env: DispatchEnv,
  waEnv: { WHATSAPP_ACCESS_TOKEN: string; WHATSAPP_PHONE_NUMBER_ID: string },
  role: "cleaning" | "security",
  phase: "arrival" | "departure",
  propertyName: string,
): Promise<{ results: SendTemplateResult[]; detail: string }> {
  const contacts =
    role === "cleaning"
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
    if (dryRun) {
      results.push({ ok: true, messageId: "DRY_RUN" });
      continue;
    }
    if (role === "cleaning" && phase === "arrival") {
      results.push(
        await sendCheckinDiaLimpieza(
          {
            toPhone: c.phoneE164,
            cleanerName: c.name,
            propertyName,
            numberOfGuests: String(r.guest_count ?? 1),
            checkOutDateEs: formatDateShortEs(r.check_out),
          },
          waEnv,
        ),
      );
    } else if (role === "cleaning" && phase === "departure") {
      const nextLabel = await getNextCheckInLabel(env.DB, r.property_slug, todayHn());
      results.push(
        await sendCheckoutDiaLimpieza(
          { toPhone: c.phoneE164, cleanerName: c.name, propertyName, nextCheckInLabel: nextLabel },
          waEnv,
        ),
      );
    } else if (role === "security" && phase === "arrival") {
      results.push(
        await sendCheckinDiaSeguridad(
          {
            toPhone: c.phoneE164,
            propertyName,
            guestFullName: r.guest_name || "Huésped sin nombre",
            numberOfGuests: String(r.guest_count ?? 1),
          },
          waEnv,
        ),
      );
    } else {
      // No existe "checkout_dia_seguridad" — combinación no soportada.
      results.push({ ok: false, error: `Combinación role=${role} phase=${phase} no implementada` });
    }
  }
  return { results, detail: `${contacts.length} contactos ${role}${dryRun ? " (dryRun)" : ""}` };
}

async function runConfirmationTemplate(
  r: ReservationRow,
  dryRun: boolean,
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

  if (dryRun) {
    return { results: [{ ok: true, messageId: "DRY_RUN" }], detail: `(dryRun) confirmación a ${firstName} (${e164})` };
  }

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

async function getNextCheckInLabel(db: D1Database, slug: string, afterDate: string): Promise<string> {
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
