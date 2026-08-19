/// <reference types="@cloudflare/workers-types" />
//
// owner-leads.ts — Pipeline de PROPIETARIOS (expansión, modelo B — 2026-08-17).
//
// Un dueño que ofrece su propiedad para administración es el lead de mayor valor
// del negocio (cada puerta nueva = margen casi puro sobre infra ya pagada). Acá
// vive la lógica compartida del embudo: el catálogo de etapas, la inserción
// automática desde el handoff del bot (con dedup) y los helpers puros.
//
// Tabla: owner_leads (schema 0046). La UI vive en /inbox/propietarios y los
// endpoints en /api/inbox/owner-leads*.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

/** Etapas del embudo, EN ORDEN. `descartado` es terminal desde cualquier punto. */
export const OWNER_LEAD_STAGES = [
  "nuevo",       // el bot lo capturó (o se cargó a mano) — nadie lo tocó aún
  "contactado",  // el equipo ya le escribió/habló
  "llamada",     // llamada coordinada o hecha
  "evaluacion",  // viendo la propiedad / negociando condiciones
  "firmado",     // puerta ganada 🎉
  "descartado",  // no avanza (con razón, para aprender qué leads no sirven)
] as const;

export type OwnerLeadStage = (typeof OWNER_LEAD_STAGES)[number];

export function isOwnerLeadStage(v: unknown): v is OwnerLeadStage {
  return typeof v === "string" && (OWNER_LEAD_STAGES as readonly string[]).includes(v);
}

/** Etapas "abiertas" = el lead sigue vivo en el embudo. El dedup del bot solo
 *  mira estas: si el mismo dueño vuelve a escribir DESPUÉS de firmado/descartado,
 *  eso es un lead NUEVO (quizá otra propiedad), no un duplicado. */
export const OPEN_STAGES: readonly OwnerLeadStage[] = [
  "nuevo", "contactado", "llamada", "evaluacion",
];

export interface OwnerLeadRow {
  id: number;
  phone: string;
  name: string | null;
  location: string | null;
  on_platform: "si" | "no" | null;
  call_ok: "si" | "no" | null;
  stage: OwnerLeadStage;
  notes: string | null;
  discarded_reason: string | null;
  source: "bot" | "manual";
  created_at: string;
  updated_at: string;
  stage_changed_at: string;
}

/**
 * Inserta el lead que el bot acaba de calificar (turno 2 del flujo owner_inquiry).
 * Se llama desde el webhook cuando ruleName === "owner_lead_handoff".
 *
 * Dedup: si ya hay un lead ABIERTO para ese teléfono, NO crea otro — solo RELLENA
 * los campos de calificación que sigan vacíos y lo deja en su etapa actual: que el
 * dueño vuelva a escribirle al bot no lo regresa a "nuevo", no duplica la fila y
 * NO pisa lo que César ya curó a mano (revisión 18-ago: el texto crudo del último
 * mensaje — "sí, ya está en Airbnb" — pisaba la ubicación real capturada antes).
 *
 * Anti-carrera: el INSERT re-chequea "no hay lead abierto" DENTRO del mismo
 * statement (WHERE NOT EXISTS) — dos webhooks concurrentes con mensajes distintos
 * del mismo dueño ya no pueden colar dos filas 'nuevo' (TOCTOU del SELECT+INSERT).
 *
 * Fail-soft: NUNCA throws — un error de D1 no puede tumbar la respuesta del
 * webhook (el dueño igual recibe su mensaje; la alerta a César igual sale).
 */
export async function upsertOwnerLeadFromBot(
  db: D1Database,
  data: {
    phone: string;
    location: string | null;
    onPlatform: "si" | "no" | null;
    callOk: "si" | "no" | null;
  },
): Promise<void> {
  // Mismo tope que el alta manual del API — una columna, un invariante.
  const location = data.location ? data.location.slice(0, 200) : null;
  const openIn = OPEN_STAGES.map(() => "?").join(",");
  try {
    const open = await db
      .prepare(
        `SELECT id FROM owner_leads
          WHERE phone = ? AND stage IN (${openIn})
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(data.phone, ...OPEN_STAGES)
      .first<{ id: number }>();

    if (open) {
      // COALESCE(campo, ?): rellena SOLO lo vacío — el dato ya guardado (del bot o
      // curado a mano en el inbox) gana sobre el texto crudo del último mensaje.
      await db
        .prepare(
          `UPDATE owner_leads
              SET location    = COALESCE(location, ?),
                  on_platform = COALESCE(on_platform, ?),
                  call_ok     = COALESCE(call_ok, ?),
                  updated_at  = datetime('now')
            WHERE id = ?`,
        )
        .bind(location, data.onPlatform, data.callOk, open.id)
        .run();
      return;
    }

    await db
      .prepare(
        `INSERT INTO owner_leads (phone, location, on_platform, call_ok, stage, source)
         SELECT ?, ?, ?, ?, 'nuevo', 'bot'
          WHERE NOT EXISTS (
            SELECT 1 FROM owner_leads WHERE phone = ? AND stage IN (${openIn})
          )`,
      )
      .bind(data.phone, location, data.onPlatform, data.callOk, data.phone, ...OPEN_STAGES)
      .run();
  } catch (err) {
    // Best-effort con rastro (patrón B8: fail-soft SIN registrar = fail-silent).
    try {
      await db
        .prepare(`INSERT INTO bot_trace (phone, stage, detail) VALUES (?, 'OWNER_LEAD_SAVE_FAIL', ?)`)
        .bind(data.phone, String((err as Error).message).slice(0, 300))
        .run();
    } catch { /* best-effort */ }
  }
}
