/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/reservation-create
//
// Carga MANUAL de una reserva al registro: reservas directas, o una que el bot
// hizo antes de que existiera el registro y no quedó guardada. Inserta en
// `reservations` con source='manual'. Como cualquier reserva, BLOQUEA el
// calendario (availability lee de esta tabla). Protegido con la cookie del inbox.
//
// paypal_order_id es NOT NULL UNIQUE en el esquema → para una reserva sin PayPal
// generamos un id sintético único ("manual-<uuid>").
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { normalizePhone } from "../../_lib/phone";
import { overlapSlugs, slugPlaceholders } from "../../_lib/slug-overlap";

interface Env {
  DB: D1Database;
  INBOX_PASSWORD?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const SLUGS = new Set([
  "villa-b11-palma-real", "casa-brisa", "casa-marea",
  "centro-morazan", "casa-lara-townhouse", "la-florida", "las-gemelas-tela",
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Nombres legibles para el texto del aviso de solape (mapa local, como el
// PROPERTY_NAMES de whatsapp-dispatch/paypal-webhook).
const PROPERTY_NAMES: Record<string, string> = {
  "villa-b11-palma-real": "Villa B11 — Palma Real",
  "casa-brisa": "Casa Brisa",
  "casa-marea": "Casa Marea",
  "centro-morazan": "Centro Morazán",
  "casa-lara-townhouse": "Casa Lara Townhouse",
  "la-florida": "La Florida",
  "las-gemelas-tela": "Las Gemelas (Tela)",
};

export interface OverlapRow {
  property_slug: string;
  check_in: string;
  check_out: string;
  guest_name: string | null;
  status: string;
}

/**
 * Reservas activas que se PISAN con [check_in, check_out) — incluyendo el
 * inventario cruzado del combo Las Gemelas ↔ Brisa/Marea (overlapSlugs).
 *
 * Por defecto es ADVISORY (la alta manual advierte, no bloquea): si la consulta
 * falla, devuelve [] para que un error acá nunca frene la carga.
 *
 * `strict: true` invierte esa semántica: relanza el error en vez de tragarlo.
 * La reactivación de una reserva cancelada lo usa como GATE anti-doble-booking
 * (es la ÚNICA barrera: no hay UNIQUE de fechas en el esquema), y ahí un error
 * de lectura NO debe pasar como "sin solape" — mejor negar la reactivación y
 * pedir reintentar que re-crear un doble booking en silencio.
 */
export async function findOverlappingReservations(
  db: D1Database,
  property_slug: string,
  check_in: string,
  check_out: string,
  opts: { strict?: boolean } = {},
): Promise<OverlapRow[]> {
  const slugs = overlapSlugs(property_slug);
  try {
    const res = await db.prepare(
      `SELECT property_slug, check_in, check_out, guest_name, status
         FROM reservations
        WHERE property_slug IN (${slugPlaceholders(slugs)})
          AND status IN ('pending','confirmed')
          AND check_in < ? AND check_out > ?
        ORDER BY check_in LIMIT 4`,
    ).bind(...slugs, check_out, check_in).all<OverlapRow>();
    return res.results ?? [];
  } catch (err) {
    if (opts.strict) throw err;
    return [];
  }
}

/**
 * Texto del aviso cuando la reserva nueva se solapa con otras activas; null si
 * no hay solape. La reserva se guarda IGUAL: César a veces registra algo que ya
 * sabe (por eso advertir y no bloquear) — el aviso le deja decidir si es una
 * doble venta de verdad.
 */
export function buildOverlapWarning(createdSlug: string, rows: OverlapRow[]): string | null {
  if (rows.length === 0) return null;
  const items = rows.slice(0, 3).map((r) => {
    const name = PROPERTY_NAMES[r.property_slug] ?? r.property_slug;
    const who = r.guest_name ? ` de ${r.guest_name}` : "";
    const st = r.status === "confirmed" ? "confirmada" : "por verificar";
    return `${name} ${r.check_in} → ${r.check_out}${who} (${st})`;
  });
  const extra = rows.length > 3 ? " …y hay más" : "";
  // El único cruce entre slugs distintos es el combo (ver slug-overlap.ts).
  const comboNote = rows.some((r) => r.property_slug !== createdSlug)
    ? " Acordate: Las Gemelas ocupa Casa Brisa + Casa Marea."
    : "";
  const others = rows.length === 1 ? "otra reserva activa" : "otras reservas activas";
  return `⚠️ Se guardó, pero se pisa con ${others}: ${items.join(" · ")}${extra}. Revisá que no sea una doble venta.${comboNote}`;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }

  const property_slug = String(body.property_slug ?? "").trim();
  const check_in = String(body.check_in ?? "").trim();
  const check_out = String(body.check_out ?? "").trim();
  const guest_name = String(body.guest_name ?? "").trim();
  const guest_phone_raw = String(body.guest_phone ?? "").trim();
  // Fecha en que el cliente RESERVÓ (opcional). Es lo que define en qué mes cuenta
  // como "conseguida" para marketing. Si no se pone, se usa hoy (cuándo se cargó).
  const booked_at_raw = String(body.booked_at ?? "").trim();
  const created_at = ISO_DATE.test(booked_at_raw) ? `${booked_at_raw} 12:00:00` : null;

  // ── Validación ────────────────────────────────────────────────────────────
  if (!SLUGS.has(property_slug)) return json({ ok: false, error: "Elegí una propiedad válida." }, 400);
  if (!ISO_DATE.test(check_in) || !ISO_DATE.test(check_out)) return json({ ok: false, error: "Revisá las fechas (usá el selector)." }, 400);
  if (check_out <= check_in) return json({ ok: false, error: "La salida tiene que ser después de la llegada." }, 400);
  if (!guest_name && !guest_phone_raw) return json({ ok: false, error: "Poné al menos el nombre o el teléfono del huésped." }, 400);

  const guestCountNum = Number(body.guest_count);
  const guest_count = Number.isFinite(guestCountNum) && guestCountNum > 0 ? Math.round(guestCountNum) : null;

  // Montos en Lempiras: total = precio de la estadía; paid = lo pagado hasta ahora.
  const totalNum = Number(body.total_hnl);
  const total_hnl = Number.isFinite(totalNum) && totalNum > 0 ? totalNum : null;
  const paidNum = Number(body.paid_hnl);
  const paid_hnl = Number.isFinite(paidNum) && paidNum >= 0 ? paidNum : 0;
  if (total_hnl !== null && paid_hnl > total_hnl) {
    return json({ ok: false, error: "El pagado no puede ser mayor al total." }, 400);
  }
  if (paid_hnl > 0 && total_hnl === null) {
    return json({ ok: false, error: "Poné el total para registrar el pago." }, 400);
  }
  // Estado derivado del pago: pagado completo → confirmed; falta saldo → pending.
  const status = total_hnl !== null && paid_hnl >= total_hnl ? "confirmed" : "pending";
  const guest_phone = guest_phone_raw || null;
  const guest_phone_normalized = guest_phone_raw ? (normalizePhone(guest_phone_raw).e164 || null) : null;
  // Si pusieron teléfono pero no tiene dígitos válidos, avisar (no guardar basura).
  if (guest_phone_raw && !guest_phone_normalized) {
    return json({ ok: false, error: "El teléfono no parece válido (revisá los números)." }, 400);
  }
  // id sintético único (paypal_order_id es NOT NULL UNIQUE). Usamos crypto.getRandomValues
  // (garantizado en el runtime de Workers) en vez de crypto.randomUUID para no depender de él.
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const paypal_order_id = `manual-${rand}`;

  try {
    // Anti-duplicado: si ya hay una reserva activa para esa propiedad EN esas mismas
    // fechas, no la cargamos otra vez (evita duplicados por reintento o doble envío).
    const dup = await env.DB.prepare(
      `SELECT id FROM reservations
         WHERE property_slug = ? AND check_in = ? AND check_out = ?
           AND status IN ('pending','confirmed') LIMIT 1`,
    ).bind(property_slug, check_in, check_out).first<{ id: number }>();
    if (dup) {
      return json({ ok: false, error: "Ya hay una reserva cargada para esa propiedad en esas fechas." }, 409);
    }

    // Aviso de SOLAPE (no bloquea): el guard de arriba solo caza el duplicado
    // EXACTO; acá detectamos cualquier cruce de fechas con otra reserva activa
    // (incluyendo el combo Las Gemelas ↔ Brisa/Marea) y lo devolvemos como
    // advertencia — la reserva se guarda igual. Va ANTES del INSERT para no
    // contarse a sí misma.
    const overlaps = await findOverlappingReservations(env.DB, property_slug, check_in, check_out);
    const warning = buildOverlapWarning(property_slug, overlaps);

    const res = await env.DB.prepare(
      `INSERT INTO reservations
         (property_slug, check_in, check_out, guest_name, guest_phone, guest_phone_normalized,
          guest_count, total_hnl, paid_hnl, source, status, paypal_order_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, COALESCE(?, datetime('now')))`,
    ).bind(
      property_slug, check_in, check_out, guest_name || null, guest_phone, guest_phone_normalized,
      guest_count, total_hnl, paid_hnl, status, paypal_order_id, created_at,
    ).run();
    return json({ ok: true, id: res.meta?.last_row_id ?? null, warning });
  } catch (err) {
    const msg = (err as Error).message || "";
    if (/no such column|total_hnl|paid_hnl/i.test(msg)) {
      return json({ ok: false, error: "Falta aplicar la actualización de la base (columnas de pago en LPS). Pegá en Cloudflare el SQL que te pasé y reintentá." }, 500);
    }
    return json({ ok: false, error: `D1: ${msg}` }, 500);
  }
};
