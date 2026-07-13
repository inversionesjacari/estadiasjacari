/// <reference types="@cloudflare/workers-types" />
//
// /api/inbox/reservation-id — foto de IDENTIDAD del huésped para la garita.
//
//   POST   (multipart)  { reservationId, file } → guarda la foto en R2 + marca la reserva
//   GET    ?id=<resId>                          → sirve la foto (para verla en el inbox)
//   DELETE ?id=<resId>                          → borra la foto de R2 + limpia la reserva
//
// PII: bucket R2 privado; este endpoint (cookie del inbox) es la ÚNICA vía de
// acceso. La foto se re-sube a Meta al enviarla a la garita (Fase 2b).
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import {
  putGuestId,
  getGuestId,
  deleteGuestId,
  guestIdKey,
  GUEST_ID_ACCEPTED_MIMES,
  GUEST_ID_MAX_BYTES,
  type GuestIdEnv,
} from "../../_lib/guest-id-store";

interface Env extends GuestIdEnv {
  DB: D1Database;
  CRON_SECRET?: string;
  INBOX_PASSWORD?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function parseResId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── POST: subir/reemplazar la foto de ID ─────────────────────────────────────
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  if (!env.GUEST_IDS) {
    return json({ ok: false, error: "Almacenamiento de IDs no configurado (falta el bucket R2 GUEST_IDS)" }, 500);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "Body no es multipart/form-data" }, 400);
  }

  const reservationId = parseResId(form.get("reservationId"));
  if (reservationId === null) return json({ ok: false, error: "reservationId inválido" }, 400);

  const file = form.get("file");
  if (!file || typeof file === "string") return json({ ok: false, error: "Falta el archivo" }, 400);
  const blob = file as unknown as File;
  const mime = blob.type || "application/octet-stream";
  if (!GUEST_ID_ACCEPTED_MIMES.has(mime)) {
    return json({ ok: false, error: `Tipo no soportado: ${mime}. La identidad debe ser JPG o PNG (Meta no acepta otros para la garita).` }, 400);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength === 0) return json({ ok: false, error: "Archivo vacío" }, 400);
  if (bytes.byteLength > GUEST_ID_MAX_BYTES) {
    return json({ ok: false, error: `Archivo muy grande (${(bytes.byteLength / 1048576).toFixed(1)}MB). Máx 5MB.` }, 400);
  }

  // La reserva debe existir (y de paso limpiamos una key vieja de otro mime).
  const row = await env.DB.prepare(`SELECT security_id_key FROM reservations WHERE id = ?`)
    .bind(reservationId)
    .first<{ security_id_key: string | null }>();
  if (!row) return json({ ok: false, error: `Reserva id=${reservationId} no encontrada` }, 404);

  const key = guestIdKey(reservationId, mime);
  // Si había una key con OTRA extensión (jpg↔png), borrala para no dejar huérfanos.
  if (row.security_id_key && row.security_id_key !== key) {
    await deleteGuestId(env, row.security_id_key);
  }

  const stored = await putGuestId(env, key, bytes, mime);
  if (!stored) return json({ ok: false, error: "No se pudo guardar en R2" }, 502);

  try {
    await env.DB.prepare(
      `UPDATE reservations
          SET security_id_key = ?, security_id_mime = ?,
              security_id_captured_at = datetime('now'), security_id_source = 'inbox',
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(key, mime, reservationId)
      .run();
  } catch (dbErr) {
    return json({ ok: false, error: `Guardado en R2 pero falló D1: ${(dbErr as Error).message}` }, 500);
  }

  return json({ ok: true, reservationId, mime });
};

// ── GET ?id=<resId>: servir la foto para verla en el inbox ───────────────────
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  const reservationId = parseResId(new URL(request.url).searchParams.get("id"));
  if (reservationId === null) return json({ ok: false, error: "id inválido" }, 400);

  const row = await env.DB.prepare(`SELECT security_id_key, security_id_mime FROM reservations WHERE id = ?`)
    .bind(reservationId)
    .first<{ security_id_key: string | null; security_id_mime: string | null }>();
  if (!row?.security_id_key) return json({ ok: false, error: "Sin identidad cargada" }, 404);

  const obj = await getGuestId(env, row.security_id_key);
  if (!obj) return json({ ok: false, error: "Identidad no disponible en R2" }, 404);

  return new Response(obj.bytes, {
    status: 200,
    headers: {
      "Content-Type": row.security_id_mime || obj.mime,
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="identidad-reserva-${reservationId}.${obj.mime.includes("png") ? "png" : "jpg"}"`,
    },
  });
};

// ── DELETE ?id=<resId>: borrar la foto ───────────────────────────────────────
export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  const reservationId = parseResId(new URL(request.url).searchParams.get("id"));
  if (reservationId === null) return json({ ok: false, error: "id inválido" }, 400);

  const row = await env.DB.prepare(`SELECT security_id_key FROM reservations WHERE id = ?`)
    .bind(reservationId)
    .first<{ security_id_key: string | null }>();
  if (row?.security_id_key) await deleteGuestId(env, row.security_id_key);

  try {
    await env.DB.prepare(
      `UPDATE reservations
          SET security_id_key = NULL, security_id_mime = NULL,
              security_id_captured_at = NULL, security_id_source = NULL,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(reservationId)
      .run();
  } catch (dbErr) {
    return json({ ok: false, error: `Borrado de R2 pero falló D1: ${(dbErr as Error).message}` }, 500);
  }

  return json({ ok: true, reservationId });
};
