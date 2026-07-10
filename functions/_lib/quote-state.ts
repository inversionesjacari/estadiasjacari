/// <reference types="@cloudflare/workers-types" />
//
// Gestión del estado de conversación para el quote flow.
//
// Tabla: conversation_state (schema 0010)
//   - Key: phone (E.164 sin '+')
//   - state: máquina de estados ('awaiting_quote_data', 'quote_provided',
//     'awaiting_payment')
//   - data: JSON con QuoteData (lo que ya sabemos del huésped)
//   - expires_at: 48h después del último update — auto-cleanup
//
// Diseño:
//   - getState() devuelve null si no existe o está expirado
//   - upsertState() crea o actualiza con UPSERT atómico
//   - clearState() borra cuando termina el flow
//   - cleanupExpired() opportunistic cleanup, 5% de las requests
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import type { QuoteData } from "./quote-extractor";

export type ConvState =
  | "awaiting_quote_data"
  | "quote_provided"
  | "awaiting_payment_method"
  | "awaiting_paypal_capture"
  | "awaiting_transfer_proof"
  // Lead de EVENTO (Valle de Ángeles): el bot ya preguntó tipo/fecha/personas;
  // la PRÓXIMA respuesta del cliente se deriva al equipo (handoff + pausa).
  | "event_inquiry";

export interface ConversationStateRow {
  phone: string;
  state: ConvState;
  data: QuoteData;
  updatedAt: string;
}

/** Estado inicial vacío — todos los campos null. */
export function emptyQuoteData(): QuoteData {
  return {
    checkIn: null,
    checkOut: null,
    guests: null,
    property: null,
    city: null,
  };
}

/**
 * Lee el estado actual de un número.
 *
 * @returns null si no hay estado o si está expirado (limpia automáticamente).
 */
export async function getState(
  phone: string,
  db: D1Database,
): Promise<ConversationStateRow | null> {
  try {
    const row = await db
      .prepare(
        `SELECT phone, state, data, updated_at
           FROM conversation_state
          WHERE phone = ?
            AND expires_at > datetime('now')`,
      )
      .bind(phone)
      .first<{
        phone: string;
        state: string;
        data: string | null;
        updated_at: string;
      }>();

    if (!row) return null;

    let parsedData: QuoteData = emptyQuoteData();
    if (row.data) {
      try {
        parsedData = { ...emptyQuoteData(), ...JSON.parse(row.data) };
      } catch {
        // data corrupto — tratar como vacío
      }
    }
    return {
      phone: row.phone,
      state: row.state as ConvState,
      data: parsedData,
      updatedAt: row.updated_at,
    };
  } catch (err) {
    console.error("getState error:", (err as Error).message);
    return null;
  }
}

/**
 * Crea o actualiza el estado (UPSERT atómico).
 * Resetea expires_at a +48h en cada update.
 */
export async function upsertState(
  phone: string,
  state: ConvState,
  data: QuoteData,
  db: D1Database,
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO conversation_state (phone, state, data, expires_at)
           VALUES (?, ?, ?, datetime('now', '+48 hours'))
         ON CONFLICT(phone) DO UPDATE SET
           state      = excluded.state,
           data       = excluded.data,
           updated_at = datetime('now'),
           expires_at = datetime('now', '+48 hours')`,
      )
      .bind(phone, state, JSON.stringify(data))
      .run();
    return true;
  } catch (err) {
    console.error("upsertState error:", (err as Error).message);
    return false;
  }
}

/** Borra el estado de un número (cuando el flow termina). */
export async function clearState(
  phone: string,
  db: D1Database,
): Promise<void> {
  try {
    await db.prepare(`DELETE FROM conversation_state WHERE phone = ?`).bind(phone).run();
  } catch (err) {
    console.error("clearState error:", (err as Error).message);
  }
}

/**
 * Limpieza oportunista de filas expiradas. Llamar con probabilidad 5%
 * dentro del webhook para no acumular basura sin necesitar un cron.
 */
export async function cleanupExpired(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(`DELETE FROM conversation_state WHERE expires_at < datetime('now')`)
      .run();
  } catch {
    // best-effort
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de UI/textos — qué falta y cómo pedirlo
// ─────────────────────────────────────────────────────────────────────────────

/** Lista de campos que aún faltan para poder cotizar. */
export function missingFields(data: QuoteData): {
  fechas: boolean;
  huespedes: boolean;
  propiedad: boolean;
} {
  return {
    fechas: !data.checkIn || !data.checkOut,
    huespedes: !data.guests,
    propiedad: !data.property,
  };
}

/** ¿Tenemos todo lo necesario para cotizar? */
export function isQuoteDataComplete(data: QuoteData): boolean {
  const m = missingFields(data);
  return !m.fechas && !m.huespedes && !m.propiedad;
}

/**
 * Construye un mensaje amable preguntando por los datos que faltan.
 * Si la ciudad ya está pero no la propiedad específica, ofrece las opciones
 * disponibles en esa ciudad.
 */
export function buildAskForMissingMessage(data: QuoteData): string {
  const m = missingFields(data);
  const lines: string[] = ["¡Casi! Solo me falta:"];

  if (m.fechas && !data.checkIn) {
    lines.push("📅 Fechas de llegada y salida");
  } else if (m.fechas && data.checkIn && !data.checkOut) {
    lines.push("📅 Fecha de salida (¿cuántas noches?)");
  }
  if (m.huespedes) {
    lines.push("👥 Cuántos huéspedes serán en total");
  }
  if (m.propiedad) {
    if (data.city === "Tela") {
      lines.push(
        "🏖️ Cuál propiedad de Tela: *Casa Brisa* o *Casa Marea* (también podemos rentarte ambas juntas para hasta 12 personas)",
      );
    } else if (data.city === "Tegucigalpa") {
      lines.push(
        "🏙️ Cuál propiedad de Tegucigalpa: *Centro Morazán* (4 personas), *Casa Lara Townhouse* (4 personas) o *La Florida* (3 personas)",
      );
    } else if (data.city === "La Ceiba") {
      lines.push("🏝️ Confirmame: Villa B11 en Hotel Palma Real (La Ceiba)");
    } else {
      lines.push(
        "🏡 En qué ciudad: La Ceiba (Villa B11), Tela (Casa Brisa o Casa Marea), o Tegucigalpa (Centro Morazán, Casa Lara o La Florida)",
      );
    }
  }

  return lines.join("\n");
}

/** Mensaje inicial abierto — primer contacto.
 *  Abierto a propósito: el que escribe puede ser un lead nuevo, un huésped
 *  con reserva activa (incluso desde otro número), o una consulta general.
 *  Dejamos que el cliente diga qué necesita y el bot enruta desde ahí. */
export const INITIAL_QUOTE_MESSAGE = `¡Hola! Gracias por escribir a Estadías Jacarí 🌴

¿En qué podemos servirte?`;
