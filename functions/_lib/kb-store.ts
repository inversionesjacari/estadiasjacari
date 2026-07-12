/// <reference types="@cloudflare/workers-types" />
//
// kb-store.ts — Lectura de la base de conocimiento desde D1.
//
// La KB vive en 3 tablas D1 (schema 0011): kb_properties, kb_policies, kb_faqs.
// Editable desde el panel /inbox/conocimiento.
//
// FALLBACK: si D1 falla o está vacío, usamos los datos hardcoded de
// property-kb.ts y quote-builder.ts como respaldo. Así el bot NUNCA se queda
// sin conocimiento, incluso si la tabla no se ha poblado o hay un error.
//
// Funciones públicas:
//   getProperties / getPolicies / getFaqs — lectura cruda (para el panel)
//   buildPricingMap   — Record<slug, PropertyPricing> para quote-builder
//   buildKnowledgeBaseText — texto markdown para el system prompt del LLM
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { PROPERTY_KNOWLEDGE_BASE } from "./property-kb";
import { PROPERTY_PRICING, type PropertyPricing } from "./quote-builder";
import type { PropertySlug, City } from "./quote-extractor";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

export interface KbProperty {
  slug: string;
  name: string;
  city: string;
  capacity: number;
  bedrooms: number | null;
  bathrooms: number | null;
  beds: string | null;
  priceNightHnl: number;
  cleaningHnl: number;
  priceNightUsd: number;
  cleaningUsd: number;
  aliases: string | null;
  amenities: string | null;
  pool: string | null;
  beach: string | null;
  pets: string | null;
  parking: string | null;
  tv: string | null;
  idealFor: string | null;
  notes: string | null;
  sortOrder: number;
  active: number;
}

export interface KbPolicy {
  key: string;
  label: string;
  value: string;
  sortOrder: number;
}

export interface KbFaq {
  id: number;
  question: string;
  answer: string;
  sortOrder: number;
  active: number;
}

export interface KbRule {
  id: number;
  rule: string;
  sortOrder: number;
  active: number;
}

interface KbPropertyRow {
  slug: string;
  name: string;
  city: string;
  capacity: number;
  bedrooms: number | null;
  bathrooms: number | null;
  beds: string | null;
  price_night_hnl: number;
  cleaning_hnl: number;
  price_night_usd: number;
  cleaning_usd: number;
  aliases: string | null;
  amenities: string | null;
  pool: string | null;
  beach: string | null;
  pets: string | null;
  parking: string | null;
  tv: string | null;
  ideal_for: string | null;
  notes: string | null;
  sort_order: number;
  active: number;
}

function rowToProperty(r: KbPropertyRow): KbProperty {
  return {
    slug: r.slug,
    name: r.name,
    city: r.city,
    capacity: r.capacity,
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    beds: r.beds,
    priceNightHnl: r.price_night_hnl,
    cleaningHnl: r.cleaning_hnl,
    priceNightUsd: r.price_night_usd,
    cleaningUsd: r.cleaning_usd,
    aliases: r.aliases,
    amenities: r.amenities,
    pool: r.pool,
    beach: r.beach,
    pets: r.pets,
    parking: r.parking,
    tv: r.tv,
    idealFor: r.ideal_for,
    notes: r.notes,
    sortOrder: r.sort_order,
    active: r.active,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas crudas (para el panel)
// ─────────────────────────────────────────────────────────────────────────────

/** Lee todas las propiedades de D1. Devuelve [] si falla (el caller decide fallback). */
export async function getProperties(db: D1Database): Promise<KbProperty[]> {
  try {
    const res = await db
      .prepare(
        `SELECT * FROM kb_properties ORDER BY sort_order ASC, name ASC`,
      )
      .all<KbPropertyRow>();
    return (res.results ?? []).map(rowToProperty);
  } catch (err) {
    console.error("getProperties error:", (err as Error).message);
    return [];
  }
}

export async function getPolicies(db: D1Database): Promise<KbPolicy[]> {
  try {
    const res = await db
      .prepare(
        `SELECT key, label, value, sort_order FROM kb_policies ORDER BY sort_order ASC`,
      )
      .all<{ key: string; label: string; value: string; sort_order: number }>();
    return (res.results ?? []).map((r) => ({
      key: r.key,
      label: r.label,
      value: r.value,
      sortOrder: r.sort_order,
    }));
  } catch (err) {
    console.error("getPolicies error:", (err as Error).message);
    return [];
  }
}

export async function getFaqs(db: D1Database): Promise<KbFaq[]> {
  try {
    const res = await db
      .prepare(
        `SELECT id, question, answer, sort_order, active
           FROM kb_faqs
          WHERE active = 1
          ORDER BY sort_order ASC, id ASC`,
      )
      .all<{
        id: number;
        question: string;
        answer: string;
        sort_order: number;
        active: number;
      }>();
    return (res.results ?? []).map((r) => ({
      id: r.id,
      question: r.question,
      answer: r.answer,
      sortOrder: r.sort_order,
      active: r.active,
    }));
  } catch (err) {
    console.error("getFaqs error:", (err as Error).message);
    return [];
  }
}

export async function getRules(db: D1Database): Promise<KbRule[]> {
  try {
    const res = await db
      .prepare(
        `SELECT id, rule, sort_order, active
           FROM kb_rules
          WHERE active = 1
          ORDER BY sort_order ASC, id ASC`,
      )
      .all<{ id: number; rule: string; sort_order: number; active: number }>();
    return (res.results ?? []).map((r) => ({
      id: r.id,
      rule: r.rule,
      sortOrder: r.sort_order,
      active: r.active,
    }));
  } catch (err) {
    console.error("getRules error:", (err as Error).message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat de fallback — el problema NO es caer al hardcode (es el diseño),
// es caer EN SILENCIO: si kb_properties está vacía (migración sin aplicar) o la
// query falla, el bot ignora el panel /inbox/conocimiento y nadie se entera
// (lección del deploy roto 2 semanas). Este latido lo hace visible: el watchdog
// lo chequea cada 30 min y avisa a los dueños con cooldown. Best-effort, nunca
// throws (mismo patrón que beat() de owner-alerts.ts). Nota: si D1 entera está
// caída el latido tampoco se escribe — ese escenario lo cubren las alertas de
// cron/bot_mudo, no esta.
// ─────────────────────────────────────────────────────────────────────────────

async function beatKbFallback(db: D1Database): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO system_heartbeat (key, last_at) VALUES ('kb_fallback_hardcode', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET last_at = datetime('now')`,
    ).run();
  } catch { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// buildPricingMap — para quote-builder (precio + capacidad)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Devuelve el mapa de precios/capacidad por slug, leído de D1.
 * Si D1 está vacío o falla, devuelve el PROPERTY_PRICING hardcoded.
 */
export async function buildPricingMap(
  db: D1Database,
): Promise<Record<PropertySlug, PropertyPricing>> {
  const props = await getProperties(db);
  if (props.length === 0) {
    await beatKbFallback(db);
    return PROPERTY_PRICING; // fallback al código
  }

  const map = { ...PROPERTY_PRICING }; // base con fallback por si falta alguna
  for (const p of props) {
    // Solo mapear slugs conocidos (los 6 fijos); ignorar cualquier extra
    if (!(p.slug in PROPERTY_PRICING)) continue;
    map[p.slug as PropertySlug] = {
      slug: p.slug as PropertySlug,
      name: p.name,
      city: p.city as City,
      capacity: p.capacity,
      pricePerNightHNL: p.priceNightHnl,
      cleaningFeeHNL: p.cleaningHnl,
      pricePerNightUSD: p.priceNightUsd,
      cleaningFeeUSD: p.cleaningUsd,
    };
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildKnowledgeBaseText — texto markdown para el system prompt del LLM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construye el texto de la base de conocimiento (markdown) desde D1.
 * Si D1 está vacío o falla, devuelve el PROPERTY_KNOWLEDGE_BASE hardcoded.
 */
export async function buildKnowledgeBaseText(db: D1Database): Promise<string> {
  const [props, policies, faqs, rules] = await Promise.all([
    getProperties(db),
    getPolicies(db),
    getFaqs(db),
    getRules(db),
  ]);

  // Si no hay propiedades en D1, usar el respaldo completo del código.
  // OJO: este return también DESCARTA policies/faqs/rules aunque tengan filas
  // (el respaldo hardcoded no tiene sección de reglas) — por eso el latido.
  if (props.length === 0) {
    await beatKbFallback(db);
    return PROPERTY_KNOWLEDGE_BASE;
  }

  const lines: string[] = [];
  lines.push("# Estadías Jacarí — Base de conocimiento para atención a huéspedes");
  lines.push("");
  lines.push(
    "Somos una empresa de alquileres turísticos en Honduras. Todas las propiedades son privadas y completamente equipadas.",
  );
  lines.push("");

  // Reglas del negocio PRIMERO (máxima prioridad — el dueño las definió)
  if (rules.length > 0) {
    lines.push("## ⚠️ REGLAS DEL NEGOCIO (máxima prioridad — seguilas SIEMPRE)");
    lines.push("");
    for (const r of rules) lines.push(`- ${r.rule}`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // Agrupar propiedades por ciudad. Todas INACTIVAS = otro "panel ignorado"
  // silencioso (el prompt queda sin ninguna propiedad): latido igual que el
  // fallback, pero SIN resucitar el hardcode — lo que el panel apagó, apagado
  // queda; solo lo hacemos visible.
  const activeProps = props.filter((x) => x.active === 1);
  if (activeProps.length === 0) await beatKbFallback(db);
  const byCity = new Map<string, KbProperty[]>();
  for (const p of activeProps) {
    const arr = byCity.get(p.city) ?? [];
    arr.push(p);
    byCity.set(p.city, arr);
  }

  for (const [city, cityProps] of byCity) {
    lines.push(`## Propiedades de ${city}`);
    lines.push("");
    for (const p of cityProps) {
      lines.push(`### ${p.name}`);
      lines.push(`- Slug interno: ${p.slug}`);
      if (p.aliases) lines.push(`- También conocida como: ${p.aliases}`);
      lines.push(`- Ciudad: ${p.city}`);
      lines.push(`- Capacidad: hasta ${p.capacity} huéspedes`);
      if (p.bedrooms != null) lines.push(`- Habitaciones: ${p.bedrooms}`);
      if (p.bathrooms != null) lines.push(`- Baños: ${p.bathrooms}`);
      if (p.beds) lines.push(`- Camas: ${p.beds}`);
      lines.push(
        `- Tarifa: L.${p.priceNightHnl.toLocaleString("es-HN")} por noche + L.${p.cleaningHnl.toLocaleString("es-HN")} de limpieza (≈ USD ${p.priceNightUsd}/noche + USD ${p.cleaningUsd} limpieza)`,
      );
      if (p.amenities) lines.push(`- Amenidades: ${p.amenities}`);
      if (p.pool) lines.push(`- Piscina: ${p.pool}`);
      if (p.beach) lines.push(`- Playa/mar: ${p.beach}`);
      if (p.parking) lines.push(`- Estacionamiento: ${p.parking}`);
      if (p.tv) lines.push(`- TV: ${p.tv}`);
      if (p.pets) lines.push(`- Mascotas: ${p.pets}`);
      if (p.idealFor) lines.push(`- Ideal para: ${p.idealFor}`);
      if (p.notes) lines.push(`- Nota: ${p.notes}`);
      lines.push("");
    }
  }

  // Políticas generales
  if (policies.length > 0) {
    lines.push("## Políticas generales");
    lines.push("");
    for (const pol of policies) {
      lines.push(`- ${pol.label}: ${pol.value}`);
    }
    lines.push("");
  }

  // FAQs
  if (faqs.length > 0) {
    lines.push("## Preguntas frecuentes");
    lines.push("");
    for (const f of faqs) {
      lines.push(`**${f.question}**`);
      lines.push(`→ ${f.answer}`);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
