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
  const status = String(body.status ?? "confirmed").trim();

  // ── Validación ────────────────────────────────────────────────────────────
  if (!SLUGS.has(property_slug)) return json({ ok: false, error: "Elegí una propiedad válida." }, 400);
  if (!ISO_DATE.test(check_in) || !ISO_DATE.test(check_out)) return json({ ok: false, error: "Revisá las fechas (usá el selector)." }, 400);
  if (check_out <= check_in) return json({ ok: false, error: "La salida tiene que ser después de la llegada." }, 400);
  if (!guest_name && !guest_phone_raw) return json({ ok: false, error: "Poné al menos el nombre o el teléfono del huésped." }, 400);
  if (status !== "confirmed" && status !== "pending") return json({ ok: false, error: "Estado inválido." }, 400);

  const guestCountNum = Number(body.guest_count);
  const guest_count = Number.isFinite(guestCountNum) && guestCountNum > 0 ? Math.round(guestCountNum) : null;
  const amountNum = Number(body.amount_usd);
  const amount_usd = Number.isFinite(amountNum) && amountNum >= 0 ? amountNum : null;
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

    const res = await env.DB.prepare(
      `INSERT INTO reservations
         (property_slug, check_in, check_out, guest_name, guest_phone, guest_phone_normalized,
          guest_count, amount_usd, source, status, paypal_order_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
    ).bind(
      property_slug, check_in, check_out, guest_name || null, guest_phone, guest_phone_normalized,
      guest_count, amount_usd, status, paypal_order_id,
    ).run();
    return json({ ok: true, id: res.meta?.last_row_id ?? null });
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
  }
};
