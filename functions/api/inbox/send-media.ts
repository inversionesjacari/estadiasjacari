/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/send-media  (multipart/form-data)
//
// César sube una imagen o video desde el inbox y lo enviamos al cliente por
// WhatsApp. Campos del form:
//   file     — el archivo (image/* o video/* soportado por WhatsApp)
//   phone    — destino E.164 sin '+'
//   caption  — texto opcional debajo del archivo
//
// Flujo: subir a Meta (media_id) → enviar por media_id → loggear en D1 → pausar
// el bot (un humano tomó la conversación, igual que /api/inbox/send).
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { uploadMediaToMeta, sendMediaById, type MediaKind } from "../../_lib/whatsapp";
import { isValidE164 } from "../../_lib/phone";
import { pauseBot } from "../../_lib/bot-pause";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  INBOX_PASSWORD?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

// Límites de Meta (con margen): imagen 5MB, video 16MB.
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_VIDEO = 16 * 1024 * 1024;

// Tipos que WhatsApp acepta. (Los .mov del iPhone = video/quicktime NO entran;
// hay que mandarlos como MP4. Se avisa con un error claro.)
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/3gpp"]);

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return json({ ok: false, error: "WhatsApp Cloud API no configurado" }, 500);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "Body no es multipart/form-data" }, 400);
  }

  const phone = (form.get("phone") as string | null)?.trim();
  const caption = (form.get("caption") as string | null)?.trim() || undefined;
  const file = form.get("file");

  if (!phone || !isValidE164(phone)) {
    return json({ ok: false, error: "phone inválido (E.164 sin '+')" }, 400);
  }
  if (!file || typeof file === "string") {
    return json({ ok: false, error: "Falta el archivo" }, 400);
  }

  const blob = file as unknown as File;
  const mime = blob.type || "application/octet-stream";

  // Determinar kind + validar tipo/tamaño
  let kind: MediaKind;
  let maxBytes: number;
  if (IMAGE_MIMES.has(mime)) {
    kind = "image";
    maxBytes = MAX_IMAGE;
  } else if (VIDEO_MIMES.has(mime)) {
    kind = "video";
    maxBytes = MAX_VIDEO;
  } else {
    return json({ ok: false, error: `Tipo no soportado: ${mime}. Usá JPG, PNG, WEBP o MP4.` }, 400);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength === 0) return json({ ok: false, error: "Archivo vacío" }, 400);
  if (bytes.byteLength > maxBytes) {
    return json(
      { ok: false, error: `Archivo muy grande (${(bytes.byteLength / 1048576).toFixed(1)}MB). Máx ${kind === "image" ? "5" : "16"}MB.` },
      400,
    );
  }

  const filename = (blob.name && blob.name.length > 0 ? blob.name : `archivo.${kind === "image" ? "jpg" : "mp4"}`).slice(0, 120);

  // 1. Subir a Meta
  const up = await uploadMediaToMeta(bytes, mime, filename, env);
  if (!up.ok || !up.mediaId) {
    return json({ ok: false, error: up.error ?? "No se pudo subir el archivo a WhatsApp" }, 502);
  }

  // 2. Enviar por media_id
  const send = await sendMediaById(phone, kind, up.mediaId, env, { caption });

  // 3. Loggear en whatsapp_messages (siempre, ok o no)
  try {
    await env.DB.prepare(
      `INSERT INTO whatsapp_messages
         (meta_message_id, direction, from_phone, to_phone, body, matched_rule, escalated, status, media_type, media_id, media_mime, media_filename)
       VALUES (?, 'out', ?, ?, ?, 'manual_inbox', 0, ?, ?, ?, ?, ?)`,
    )
      .bind(
        send.messageId ?? null,
        env.WHATSAPP_PHONE_NUMBER_ID,
        phone,
        send.ok ? (caption ?? "") : `[FAILED] media\n\nERROR: ${send.error}`,
        send.ok ? "sent" : "failed",
        kind,
        up.mediaId,
        mime,
        filename,
      )
      .run();
  } catch (logErr) {
    console.error("Error guardando media saliente:", (logErr as Error).message);
  }

  if (!send.ok) {
    return json({ ok: false, error: send.error }, 502);
  }

  // Un humano tomó la conversación → pausar el bot (igual que /api/inbox/send).
  await pauseBot(phone, "manual_inbox", env.DB);

  return json({ ok: true, phone, messageId: send.messageId, mediaId: up.mediaId, kind });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
