/// <reference types="@cloudflare/workers-types" />
//
// outbound-dedup.ts — Anti-duplicado de salientes en ráfagas de concurrencia.
//
// El webhook ya tiene "última palabra gana": si mientras procesa un mensaje llega
// otro MÁS NUEVO del mismo cliente, no responde (responde el del mensaje nuevo).
// Pero eso solo cubre el caso en que el segundo mensaje ya está INSERTADO cuando el
// primero hace su chequeo. Cuando el segundo llega DESPUÉS de que el primero ya
// respondió (mensajes con segundos de diferencia), ambos webhooks pasan el chequeo
// y mandan la MISMA respuesta → doble burbuja (chat Méndez, 11-jul: fotos ×2,
// check-in ×2, "no disponible" ×2, comprobante ×2).
//
// Complemento determinístico: antes de enviar, miramos el ÚLTIMO saliente de texto
// a ese cliente; si ya le mandamos el MISMO `matched_rule` + mismo `body` hace muy
// poco (ventana corta), no reenviamos. Es puro y testeable: recibe la fila ya leída.
//
// Carpeta `_lib/` (prefijo underscore) NO es ruteable como endpoint.
//

/** Fila del último saliente relevante, ya leída de `whatsapp_messages`. */
export interface LastOutbound {
  /** `matched_rule` de la fila saliente (puede ser null para escalaciones). */
  matchedRule: string | null;
  /** Cuerpo del mensaje saliente. */
  body: string;
  /** `created_at` convertido a epoch ms (ver parseSqliteUtcMs). */
  createdAtMs: number;
}

/**
 * Ventana por defecto: 2 min. Una ráfaga de concurrencia siempre cae dentro (los
 * duplicados llegan con segundos de diferencia). Más allá de 2 min, un mensaje
 * idéntico al mismo cliente es una repetición legítima y SÍ se manda.
 */
export const DUP_WINDOW_MS = 120_000;

/**
 * ¿El saliente candidato es un RE-ENVÍO verbatim de lo último que ya mandamos a
 * este cliente, dentro de la ventana? Conservador: solo suprime si coinciden EXACTO
 * `matched_rule` + `body` (trim) y el anterior es reciente. Nunca suprime cuerpos
 * vacíos (las filas de imagen se loggean con body="") ni por defecto sin fila previa.
 */
export function isDuplicateResend(
  prev: LastOutbound | null,
  candidate: { matchedRule: string | null; body: string },
  nowMs: number,
  windowMs: number = DUP_WINDOW_MS,
): boolean {
  if (!prev) return false;
  const prevBody = prev.body.trim();
  const candBody = candidate.body.trim();
  if (prevBody === "" || candBody === "") return false;
  if ((prev.matchedRule ?? "") !== (candidate.matchedRule ?? "")) return false;
  if (prevBody !== candBody) return false;
  const dt = nowMs - prev.createdAtMs;
  return dt >= 0 && dt <= windowMs;
}

/**
 * Convierte un `created_at` de SQLite ("YYYY-MM-DD HH:MM:SS", UTC, de `datetime('now')`)
 * a epoch ms. Devuelve null si no se puede parsear (el caller trata null como "sin dato"
 * → no deduplica, mejor reenviar que callar). Tolera un ISO ya con "T"/zona.
 */
export function parseSqliteUtcMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const trimmed = s.trim();
  const withT = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(withT);
  const iso = hasZone ? withT : withT + "Z";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
