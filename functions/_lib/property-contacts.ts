/// <reference types="@cloudflare/workers-types" />
//
// Lectura de la tabla `property_contacts` (limpieza + seguridad por propiedad).
// Tabla creada en schema/0008_property_contacts.sql.
//
// El cron `whatsapp-operations` la usa para resolver, dado un slug:
//   - getCleaningContacts(slug) → lista de personas a notificar como limpieza
//   - getSecurityContacts(slug) → lista de personas a notificar como seguridad
//
// Si una propiedad NO tiene contacto registrado para un rol, devolvemos []
// (vacío) — el caller hace skip silencioso. NO es error; muchas propiedades
// solo tienen limpieza, no seguridad propia (la del condominio se autogestiona).
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

export type ContactRole = "cleaning" | "security";

export interface PropertyContact {
  id: number;
  slug: string;
  role: ContactRole;
  name: string;
  /** E.164 sin '+' (ej. "50432925998"). Listo para enviar a Meta. */
  phoneE164: string;
  active: boolean;
  notes: string | null;
}

interface ContactRow {
  id: number;
  slug: string;
  role: string;
  name: string;
  phone_e164: string;
  active: number;
  notes: string | null;
}

/**
 * Devuelve los contactos activos de una propiedad para un rol específico.
 * Lista vacía si no hay ninguno (no es error).
 */
export async function getPropertyContacts(
  slug: string,
  role: ContactRole,
  db: D1Database,
): Promise<PropertyContact[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT id, slug, role, name, phone_e164, active, notes
           FROM property_contacts
          WHERE slug = ?
            AND role = ?
            AND active = 1
          ORDER BY id ASC`,
      )
      .bind(slug, role)
      .all<ContactRow>();

    return (results ?? []).map((row) => ({
      id: row.id,
      slug: row.slug,
      role: row.role as ContactRole,
      name: row.name,
      phoneE164: row.phone_e164,
      active: row.active === 1,
      notes: row.notes,
    }));
  } catch (err) {
    console.error(
      `[property-contacts] Error consultando D1 (slug=${slug}, role=${role}):`,
      (err as Error).message,
    );
    return [];
  }
}

/** Atajo: contactos de limpieza activos. */
export async function getCleaningContacts(
  slug: string,
  db: D1Database,
): Promise<PropertyContact[]> {
  return getPropertyContacts(slug, "cleaning", db);
}

/** Atajo: contactos de seguridad activos. */
export async function getSecurityContacts(
  slug: string,
  db: D1Database,
): Promise<PropertyContact[]> {
  return getPropertyContacts(slug, "security", db);
}
