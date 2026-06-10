/// <reference types="@cloudflare/workers-types" />
//
// GET /api/inbox/media?id=<media_id>
//
// Proxy autenticado para servir el media (notas de voz, imágenes, video, docs)
// que mandan los clientes por WhatsApp — y el que sube César desde el inbox.
// Meta NO expone el archivo públicamente: hay que resolver el media_id a una URL
// temporal y descargar el binario, ambas llamadas con el token de Meta. Por eso
// este proxy: el inbox (solo César, vía cookie de sesión) pide
// /api/inbox/media?id=... y devolvemos el binario.
//
// Flujo:
//   1. GET graph.facebook.com/v25.0/{media_id}  (Bearer) → { url, mime_type }
//   2. GET esa url                              (Bearer) → binario
//   3. responder el binario con su content-type
//
// El media_id de Meta expira (~14 días para entrantes). Pasado eso, el paso 1
// devuelve 404 — aceptable para el inbox en vivo (histórico a R2 = fuera de MVP).

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { fetchWithTimeout, TIMEOUT } from "../../_lib/fetch";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  INBOX_PASSWORD?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
}

const GRAPH_API_BASE = "https://graph.facebook.com/v25.0";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  if (!env.WHATSAPP_ACCESS_TOKEN) {
    return new Response("WhatsApp no configurado", { status: 500 });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^\d{5,25}$/.test(id)) {
    return new Response("Param 'id' inválido", { status: 400 });
  }

  const token = env.WHATSAPP_ACCESS_TOKEN;

  // 1. Resolver el media_id → URL temporal + mime
  let metaResp: Response;
  try {
    metaResp = await fetchWithTimeout(
      `${GRAPH_API_BASE}/${id}`,
      { headers: { Authorization: `Bearer ${token}` } },
      TIMEOUT.CRITICAL,
    );
  } catch (err) {
    return new Response(`Error resolviendo media: ${(err as Error).message}`, { status: 502 });
  }
  if (!metaResp.ok) {
    return new Response(`Meta media lookup HTTP ${metaResp.status}`, { status: 502 });
  }

  let meta: { url?: string; mime_type?: string };
  try {
    meta = (await metaResp.json()) as { url?: string; mime_type?: string };
  } catch {
    return new Response("Meta media JSON inválido", { status: 502 });
  }
  if (!meta.url) {
    return new Response("Media no disponible (puede haber expirado)", { status: 404 });
  }

  // 2. Descargar el binario (también con Bearer — la URL de lookaside lo exige)
  let binResp: Response;
  try {
    binResp = await fetchWithTimeout(
      meta.url,
      { headers: { Authorization: `Bearer ${token}` } },
      TIMEOUT.CRITICAL,
    );
  } catch (err) {
    return new Response(`Error descargando media: ${(err as Error).message}`, { status: 502 });
  }
  if (!binResp.ok || !binResp.body) {
    return new Response(`Media download HTTP ${binResp.status}`, { status: 502 });
  }

  // 3. Stream del binario con su content-type. Cache privado (requiere sesión).
  const contentType =
    meta.mime_type || binResp.headers.get("content-type") || "application/octet-stream";
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "private, max-age=86400");
  const len = binResp.headers.get("content-length");
  if (len) headers.set("Content-Length", len);

  return new Response(binResp.body, { status: 200, headers });
};
