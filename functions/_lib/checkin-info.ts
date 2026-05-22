/// <reference types="@cloudflare/workers-types" />
//
// getCheckinInfo(slug, env) — obtiene la info de check-in de una propiedad
// (wifi, accesos, instrucciones de llegada, contacto local).
//
// FUENTE DE VERDAD: un Google Sheet que edita el dueño, expuesto de forma
// PRIVADA mediante un Apps Script Web App protegido con un secreto. El script
// devuelve JSON solo si `?secret=` coincide (los códigos de puerta NUNCA quedan
// públicos). Ver `scripts/google-apps-script-checkin.gs` para el código a pegar.
//
// RESILIENCIA: en cada lectura exitosa volcamos el resultado a la tabla D1
// `property_checkin_info` (cache). Si el Sheet no responde (Google caído, mala
// config, etc.), usamos esa copia para no dejar al huésped sin sus datos.
//
// Esta función es reutilizable: hoy la usa el recordatorio por correo (Correo #2)
// y mañana la usará el envío por WhatsApp (Fase 5).
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

export interface CheckinInfo {
  slug: string;
  propertyName?: string;
  wifiNetwork?: string;
  wifiPassword?: string;
  accessInstructions?: string;
  arrivalInstructions?: string;
  localContactName?: string;
  localContactPhone?: string;
  extraNotes?: string;
}

export interface CheckinInfoEnv {
  DB: D1Database;
  SHEET_WEBHOOK_URL?: string;
  SHEET_WEBHOOK_SECRET?: string;
}

export interface CheckinInfoResult {
  info: CheckinInfo | null;
  source: "sheet" | "cache" | "none";
  error?: string;
}

/** Forma cruda (snake_case) que devuelve el Apps Script y que guarda D1. */
interface RawCheckinRow {
  slug?: string;
  property_name?: string;
  wifi_network?: string;
  wifi_password?: string;
  access_instructions?: string;
  arrival_instructions?: string;
  local_contact_name?: string;
  local_contact_phone?: string;
  extra_notes?: string;
}

/** Normaliza un valor de celda a string limpio o undefined. */
function clean(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

function rawToCheckinInfo(slug: string, raw: RawCheckinRow): CheckinInfo {
  return {
    slug,
    propertyName: clean(raw.property_name),
    wifiNetwork: clean(raw.wifi_network),
    wifiPassword: clean(raw.wifi_password),
    accessInstructions: clean(raw.access_instructions),
    arrivalInstructions: clean(raw.arrival_instructions),
    localContactName: clean(raw.local_contact_name),
    localContactPhone: clean(raw.local_contact_phone),
    extraNotes: clean(raw.extra_notes),
  };
}

/** Sincroniza la fila leída del Sheet a la tabla cache `property_checkin_info`. */
async function upsertCache(
  db: D1Database,
  slug: string,
  raw: RawCheckinRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO property_checkin_info
         (slug, property_name, wifi_network, wifi_password, access_instructions,
          arrival_instructions, local_contact_name, local_contact_phone,
          extra_notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(slug) DO UPDATE SET
         property_name        = excluded.property_name,
         wifi_network         = excluded.wifi_network,
         wifi_password        = excluded.wifi_password,
         access_instructions  = excluded.access_instructions,
         arrival_instructions = excluded.arrival_instructions,
         local_contact_name   = excluded.local_contact_name,
         local_contact_phone  = excluded.local_contact_phone,
         extra_notes          = excluded.extra_notes,
         updated_at           = datetime('now')`,
    )
    .bind(
      slug,
      clean(raw.property_name) ?? null,
      clean(raw.wifi_network) ?? null,
      clean(raw.wifi_password) ?? null,
      clean(raw.access_instructions) ?? null,
      clean(raw.arrival_instructions) ?? null,
      clean(raw.local_contact_name) ?? null,
      clean(raw.local_contact_phone) ?? null,
      clean(raw.extra_notes) ?? null,
    )
    .run();
}

/** Lee la copia cacheada de D1 (fallback cuando el Sheet no responde). */
async function readCache(
  db: D1Database,
  slug: string,
): Promise<CheckinInfo | null> {
  const row = await db
    .prepare(`SELECT * FROM property_checkin_info WHERE slug = ?`)
    .bind(slug)
    .first<RawCheckinRow>();
  if (!row) return null;
  return rawToCheckinInfo(slug, row);
}

/**
 * Obtiene la info de check-in para un slug. Intenta el Sheet primero (y refresca
 * la cache D1); si falla, devuelve la cache. Nunca lanza excepción.
 */
export async function getCheckinInfo(
  slug: string,
  env: CheckinInfoEnv,
): Promise<CheckinInfoResult> {
  let sheetError: string | undefined;

  // 1. Intentar leer del Sheet (vía Apps Script privado).
  if (env.SHEET_WEBHOOK_URL && env.SHEET_WEBHOOK_SECRET) {
    try {
      const url = new URL(env.SHEET_WEBHOOK_URL);
      url.searchParams.set("secret", env.SHEET_WEBHOOK_SECRET);
      url.searchParams.set("slug", slug);

      const resp = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "follow", // Apps Script Web Apps redirigen a googleusercontent
      });

      const bodyText = await resp.text();
      if (!resp.ok) {
        sheetError = `Sheet HTTP ${resp.status}: ${bodyText.slice(0, 200)}`;
      } else {
        const parsed = JSON.parse(bodyText) as {
          ok?: boolean;
          info?: RawCheckinRow;
          error?: string;
        };
        if (parsed.ok && parsed.info && clean(parsed.info.slug)) {
          // Refrescar cache y devolver.
          try {
            await upsertCache(env.DB, slug, parsed.info);
          } catch (cacheErr) {
            // No es fatal — pudimos leer el Sheet igual.
            console.error("No se pudo refrescar cache check-in:", cacheErr);
          }
          return { info: rawToCheckinInfo(slug, parsed.info), source: "sheet" };
        }
        sheetError =
          parsed.error || `Sheet sin fila para slug "${slug}"`;
      }
    } catch (err) {
      sheetError = `Error leyendo Sheet: ${(err as Error).message}`;
    }
  } else {
    sheetError = "Faltan SHEET_WEBHOOK_URL y/o SHEET_WEBHOOK_SECRET";
  }

  // 2. Fallback: cache D1.
  try {
    const cached = await readCache(env.DB, slug);
    if (cached) {
      return { info: cached, source: "cache", error: sheetError };
    }
  } catch (err) {
    sheetError = `${sheetError ?? ""} · cache D1 también falló: ${(err as Error).message}`;
  }

  // 3. Sin datos en ningún lado.
  return { info: null, source: "none", error: sheetError };
}
