-- v3.4.0 — Medical certificate rework
-- Adds duration semantics (single-day vs range) and the consultation-mode
-- snapshot used to adapt the PDF layout (teleconsultation vs clinic visit).
-- All columns are nullable/optional so existing rows migrate cleanly and
-- keep rendering exactly as before (NULL durationType → DATE_RANGE).

ALTER TABLE "medical_certificates"
  ADD COLUMN IF NOT EXISTS "durationType"      TEXT,
  ADD COLUMN IF NOT EXISTS "certificateDate"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "consultationType"  TEXT;
