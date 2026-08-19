-- 0046: Pipeline de PROPIETARIOS (expansión, modelo B — 2026-08-17)
--
-- César activó la expansión: dueños que ofrecen su propiedad para que la
-- administremos. El bot ya los captura (flujo owner_inquiry → owner_lead_handoff,
-- mismo día) pero el lead moría en el chat: no había DÓNDE vivir ni cómo
-- clasificarlo por etapas. Esta tabla es el embudo de puertas nuevas.
--
-- Etapas (stage): nuevo → contactado → llamada → evaluacion → firmado
--                 (o descartado en cualquier punto, con razón).
--
-- Fuente (source): 'bot' = el handoff lo insertó solo; 'manual' = cargado desde
-- el inbox (un dueño que llegó por Instagram, referido, etc.).
--
-- NO hay UNIQUE en phone: un mismo dueño puede ofrecer DOS propiedades (dos
-- filas). El dedup de la inserción automática lo hace el código: no inserta si
-- ya existe un lead ABIERTO (ni firmado ni descartado) para ese teléfono.

CREATE TABLE IF NOT EXISTS owner_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- E.164 sin '+' (igual que whatsapp_messages) — linkea al chat del inbox.
  phone TEXT NOT NULL,
  -- Nombre del dueño (editable a mano; el bot no siempre lo tiene).
  name TEXT,
  -- Ubicación de la propiedad. Arranca con el texto CRUDO del chat (puede traer
  -- las 3 respuestas juntas); César la limpia al editar.
  location TEXT,
  -- ¿Ya está activa en Airbnb u otras plataformas? 'si' | 'no' | NULL (no dijo).
  on_platform TEXT,
  -- ¿Aceptó coordinar una llamada? 'si' | 'no' | NULL.
  call_ok TEXT,
  -- Etapa del embudo (ver arriba). El server valida el catálogo.
  stage TEXT NOT NULL DEFAULT 'nuevo',
  -- Notas libres del equipo (qué se habló, condiciones tentativas, próximos pasos).
  notes TEXT,
  -- Por qué se descartó (solo con stage='descartado') — para aprender qué leads no sirven.
  discarded_reason TEXT,
  -- 'bot' | 'manual'.
  source TEXT NOT NULL DEFAULT 'bot',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Cuándo cambió de etapa por última vez (para ver leads estancados).
  stage_changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- El pipeline se lee agrupado por etapa y ordenado por actividad.
CREATE INDEX IF NOT EXISTS idx_owner_leads_stage ON owner_leads (stage, updated_at DESC);
-- El dedup del bot busca "¿ya hay un lead abierto para este teléfono?".
CREATE INDEX IF NOT EXISTS idx_owner_leads_phone ON owner_leads (phone);
