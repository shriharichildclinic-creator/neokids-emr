-- Historical Records Phase 2 — attachment metadata + manual ordering.
--
-- Additive only, matches the pattern of every prior migration in this
-- folder: new nullable/defaulted columns on an existing table, no data
-- loss, no rename, safe to run against a live database.
--
-- `attachmentType`  — doctor-chosen category ("Lab Report", "Scan",
--                      "Prescription", etc.), independent of the
--                      auto-detected `kind` (mime-derived: PDF/IMAGE/...).
-- `notes`           — optional free-text note per attachment.
-- `sortOrder`        — manual ordering set by the doctor via the
--                      Edit modal's reorder controls; defaults to 0 so
--                      existing rows keep their current createdAt order
--                      until explicitly reordered.
ALTER TABLE `previous_record_attachments`
  ADD COLUMN `attachmentType` VARCHAR(191) NULL,
  ADD COLUMN `notes` VARCHAR(2000) NULL,
  ADD COLUMN `sortOrder` INT NOT NULL DEFAULT 0;

CREATE INDEX `previous_record_attachments_recordId_sortOrder_idx`
  ON `previous_record_attachments` (`recordId`, `sortOrder`);
