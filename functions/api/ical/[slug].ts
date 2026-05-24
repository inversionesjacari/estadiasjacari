/// <reference types="@cloudflare/workers-types" />
//
// GET /api/ical/<slug>.ics  →  text/calendar (VCALENDAR válido per RFC 5545)
//
// Expone las reservas pagadas en el sitio (D1, status pending|confirmed) como
// archivo iCal. El dueño importa esta URL en cada listing de Airbnb como
// "Calendario externo" para que Airbnb bloquee automáticamente las fechas
// que ya vendimos por nuestro propio sitio.
//
// Cierra el loop bidireccional de Fase 1-3:
//   - Antes: Airbnb → Sitio (via availability endpoint que lee iCal de Airbnb)
//   - Ahora: Sitio → Airbnb (via ESTE endpoint que Airbnb consulta)
//
// URL pública. NO expone PII (ni nombre, ni email, ni teléfono del huésped) —
// solo rangos de fechas con SUMMARY genérico. Esto permite que Airbnb la
// consulte sin restricciones y mitiga el riesgo de scraping de datos privados.
//
// Slugs aceptados (deben coincidir con src/data/properties.ts):
//   villa-b11-palma-real, casa-brisa, casa-marea,
//   centro-morazan, casa-lara-townhouse, la-florida
//
// Convenciones iCal:
//   - DTSTART (inclusivo) = check_in
//   - DTEND (exclusivo)   = check_out
//   - VALUE=DATE para eventos de día completo (sin hora)
//   - Line endings: CRLF (\r\n) per RFC 5545
//

interface Env {
  DB: D1Database;
}

interface ReservationRow {
  paypal_order_id: string;
  check_in: string;          // YYYY-MM-DD
  check_out: string;         // YYYY-MM-DD
  updated_at: string;        // "YYYY-MM-DD HH:MM:SS"
}

const PROPERTY_NAMES: Record<string, string> = {
  "villa-b11-palma-real": "Villa B11 — Palma Real",
  "casa-brisa": "Casa Brisa",
  "casa-marea": "Casa Marea",
  "centro-morazan": "Centro Morazán",
  "casa-lara-townhouse": "Casa Lara Townhouse",
  "la-florida": "La Florida",
};

/** "2026-05-23" → "20260523" (formato DATE de iCal). */
function toIcalDate(yyyymmdd: string): string {
  return yyyymmdd.replace(/-/g, "");
}

/** "2026-05-23 14:05:00" o ISO → "20260523T140500Z" (formato DATE-TIME UTC). */
function toIcalDateTime(sqlDatetime: string): string {
  // Acepta "YYYY-MM-DD HH:MM:SS" (D1 default) o ISO 8601
  const clean = sqlDatetime.replace("T", " ").replace("Z", "").trim();
  const [date, time] = clean.split(" ");
  if (!date || !time) {
    // Fallback al momento actual si el formato es inesperado
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  }
  return `${toIcalDate(date)}T${time.replace(/:/g, "")}Z`;
}

/** Escape per RFC 5545 §3.3.11 — backslash, coma, punto y coma, salto de línea. */
function icalEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold de líneas largas a 75 octetos per RFC 5545 §3.1 (CRLF + espacio). */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (i === 0) {
      parts.push(line.slice(0, 75));
      i = 75;
    } else {
      // Continuation lines start with a single space
      parts.push(" " + line.slice(i, i + 74));
      i += 74;
    }
  }
  return parts.join("\r\n");
}

export const onRequestGet: PagesFunction<Env> = async ({ params, env }) => {
  // 1. Aceptar slug con o sin sufijo ".ics"
  const raw = String(params.slug ?? "");
  const slug = raw.replace(/\.ics$/i, "");

  const propertyName = PROPERTY_NAMES[slug];
  if (!propertyName) {
    return new Response(`Slug "${slug}" no registrado.`, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!env.DB) {
    return new Response("Binding DB no configurado", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // 2. Reservas activas (no históricas, no refunded/cancelled)
  const todayIso = new Date().toISOString().slice(0, 10);
  let rows: ReservationRow[] = [];
  try {
    const result = await env.DB.prepare(
      `SELECT paypal_order_id, check_in, check_out, updated_at
         FROM reservations
        WHERE property_slug = ?
          AND status IN ('pending', 'confirmed')
          AND check_out >= ?
        ORDER BY check_in ASC`,
    )
      .bind(slug, todayIso)
      .all<ReservationRow>();
    rows = result.results ?? [];
  } catch (err) {
    return new Response(
      `Error consultando D1: ${(err as Error).message}`,
      { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  // 3. Construir VCALENDAR
  const nowDtstamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const calName = `${propertyName} — Reservas Estadías Jacarí`;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Estadias Jacari//Reservations//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    foldLine(`X-WR-CALNAME:${icalEscape(calName)}`),
    foldLine(`NAME:${icalEscape(calName)}`),
    "X-WR-TIMEZONE:America/Tegucigalpa",
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];

  for (const r of rows) {
    const uid = `reservation-${r.paypal_order_id}@estadiasjacari.com`;
    const dtstamp = r.updated_at ? toIcalDateTime(r.updated_at) : nowDtstamp;
    lines.push("BEGIN:VEVENT");
    lines.push(foldLine(`UID:${uid}`));
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${toIcalDate(r.check_in)}`);
    lines.push(`DTEND;VALUE=DATE:${toIcalDate(r.check_out)}`);
    lines.push(foldLine(`SUMMARY:${icalEscape("Reservado (Estadías Jacarí)")}`));
    lines.push("TRANSP:OPAQUE");
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  const body = lines.join("\r\n") + "\r\n";

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      // Filename sugerido si alguien descarga el archivo
      "Content-Disposition": `inline; filename="${slug}.ics"`,
      // Cache moderado: Airbnb consulta cada cierto tiempo, 5 min es suficiente
      // para que cambios se propaguen rápido sin pegarle a D1 en cada request.
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
};
