/// <reference types="@cloudflare/workers-types" />
//
// /api/inbox/owner-leads — Pipeline de PROPIETARIOS (expansión, modelo B).
//
// GET  → lista completa del embudo (todas las etapas) + conteos.
// POST → { action: "create" | "update" | "stage", ... } — alta manual, edición
//        de campos y movimiento de etapa.
//
// Sin plata en juego: acá no hay montos ni comisiones (la negociación es de la
// LLAMADA, nunca del sistema), así que el STAFF también puede gestionar el
// embudo — mover etapas y anotar es trabajo operativo, no financiero.
// Protegido con la cookie de sesión del inbox (cualquier rol).
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { isValidE164, normalizePhone } from "../../_lib/phone";
import {
  OWNER_LEAD_STAGES,
  isOwnerLeadStage,
  type OwnerLeadRow,
} from "../../_lib/owner-leads";

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

/** Normaliza un "si"/"no" del body (cualquier otra cosa → null). */
function siNo(v: unknown): "si" | "no" | null {
  return v === "si" || v === "no" ? v : null;
}

/** Coerción segura de un campo string del body. El body es JSON arbitrario de un
 *  cliente autenticado: un null o un número en un campo string no puede reventar
 *  la función con un 500 crudo (revisión 18-ago: `null.trim()` explotaba FUERA
 *  del try). No-string → "" (mismo efecto que campo vacío). */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — el embudo completo
// ─────────────────────────────────────────────────────────────────────────────

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  try {
    // OJO: esta query SÍ es polleada (la página refresca cada 30s por pestaña
    // visible), así que lleva tope — regla post-saturación de D1 del 17-ago. Un
    // embudo humano no junta 400 leads vivos; si un día el LIMIT muerde, lo que
    // faltan no son filas sino archivar descartados viejos.
    const res = await env.DB
      .prepare(
        `SELECT id, phone, name, location, on_platform, call_ok, stage, notes,
                discarded_reason, source, created_at, updated_at, stage_changed_at
           FROM owner_leads
          ORDER BY updated_at DESC
          LIMIT 400`,
      )
      .all<OwnerLeadRow>();

    const leads = res.results ?? [];
    const counts: Record<string, number> = {};
    for (const s of OWNER_LEAD_STAGES) counts[s] = 0;
    for (const l of leads) counts[l.stage] = (counts[l.stage] ?? 0) + 1;

    return json({ ok: true, leads, counts, stages: OWNER_LEAD_STAGES });
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST — create | update | stage
// ─────────────────────────────────────────────────────────────────────────────

interface PostBody {
  action?: "create" | "update" | "stage";
  id?: number;
  phone?: string;
  name?: string;
  location?: string;
  onPlatform?: string;
  callOk?: string;
  notes?: string;
  stage?: string;
  discardedReason?: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }

  // ── Alta manual (dueño que llegó por Instagram, referido, en persona…) ─────
  if (body.action === "create") {
    // normalizePhone es el contrato de la casa: "99887766" (8 dígitos locales,
    // como se escriben en Honduras) → "50499887766". Sin esto, el link 💬 al chat
    // y el dedup del bot (que comparan contra el E.164 completo de Meta) quedaban
    // rotos para siempre en esa fila (revisión 18-ago).
    const phone = normalizePhone(str(body.phone)).e164;
    if (!phone || !isValidE164(phone)) {
      return json({ ok: false, error: "Teléfono inválido (ej: 99887766 o 50499887766)" }, 400);
    }
    const name = str(body.name).trim().slice(0, 120) || null;
    const location = str(body.location).trim().slice(0, 200) || null;
    const notes = str(body.notes).trim().slice(0, 1000) || null;

    try {
      const r = await env.DB
        .prepare(
          `INSERT INTO owner_leads (phone, name, location, on_platform, call_ok, notes, stage, source)
           VALUES (?, ?, ?, ?, ?, ?, 'nuevo', 'manual')`,
        )
        .bind(phone, name, location, siNo(body.onPlatform), siNo(body.callOk), notes)
        .run();
      return json({ ok: true, id: r.meta.last_row_id });
    } catch (err) {
      return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
    }
  }

  // Para update/stage hace falta el id.
  const id = typeof body.id === "number" && Number.isInteger(body.id) && body.id > 0 ? body.id : null;
  if (!id) return json({ ok: false, error: "Falta el id del lead" }, 400);

  // ── Edición de campos (nombre, ubicación, calificación, notas) ─────────────
  if (body.action === "update") {
    // Solo pisa los campos PRESENTES en el body (undefined = no tocar). Un string
    // vacío sí borra (César limpiando un campo). Sin campos → no-op honesto.
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.name !== undefined) { sets.push("name = ?"); binds.push(str(body.name).trim().slice(0, 120) || null); }
    if (body.location !== undefined) { sets.push("location = ?"); binds.push(str(body.location).trim().slice(0, 200) || null); }
    if (body.onPlatform !== undefined) { sets.push("on_platform = ?"); binds.push(siNo(body.onPlatform)); }
    if (body.callOk !== undefined) { sets.push("call_ok = ?"); binds.push(siNo(body.callOk)); }
    if (body.notes !== undefined) { sets.push("notes = ?"); binds.push(str(body.notes).trim().slice(0, 1000) || null); }
    if (sets.length === 0) return json({ ok: false, error: "Nada que actualizar" }, 400);

    sets.push("updated_at = datetime('now')");
    try {
      const r = await env.DB
        .prepare(`UPDATE owner_leads SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...binds, id)
        .run();
      if (!r.meta.changes) return json({ ok: false, error: "Lead no encontrado" }, 404);
      return json({ ok: true, id });
    } catch (err) {
      return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
    }
  }

  // ── Movimiento de etapa ────────────────────────────────────────────────────
  if (body.action === "stage") {
    if (!isOwnerLeadStage(body.stage)) {
      return json({ ok: false, error: `Etapa inválida: ${String(body.stage).slice(0, 30)}` }, 400);
    }
    // La razón de descarte solo viaja (y solo se guarda) al descartar; al mover a
    // cualquier otra etapa se LIMPIA — un lead revivido no arrastra su epitafio.
    const discardedReason =
      body.stage === "descartado"
        ? str(body.discardedReason).trim().slice(0, 300) || null
        : null;

    try {
      const r = await env.DB
        .prepare(
          `UPDATE owner_leads
              SET stage = ?, discarded_reason = ?,
                  stage_changed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?`,
        )
        .bind(body.stage, discardedReason, id)
        .run();
      if (!r.meta.changes) return json({ ok: false, error: "Lead no encontrado" }, 404);
      return json({ ok: true, id, stage: body.stage });
    } catch (err) {
      return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
    }
  }

  return json({ ok: false, error: "action inválida (create | update | stage)" }, 400);
};
