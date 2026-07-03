-- 0034_conversation_tags_autotag.sql
--
-- Auto-etiquetado de conversaciones. `tagged_by` distingue quién puso la etiqueta:
--   'manual' = César la puso a mano en el inbox (NUNCA se sobrescribe automáticamente).
--   'auto'   = la puso el clasificador (determinístico o IA); se puede re-clasificar.
-- Así el auto-tag mantiene todo al día sin pisar lo que César ya revisó.
--
-- SQLite no soporta ADD COLUMN IF NOT EXISTS: si ya existe, ignorá el error de esa línea.

ALTER TABLE conversation_tags ADD COLUMN tagged_by TEXT NOT NULL DEFAULT 'manual';
