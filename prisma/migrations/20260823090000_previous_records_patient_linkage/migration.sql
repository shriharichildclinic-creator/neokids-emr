-- Previous Records — Patient Linkage fix.
--
-- BUG: after the v3.4.6 UI refactor there was no way to record whether
-- a previous/historical record belonged to an existing NeoKidsPro
-- patient or to a patient who existed only before the EMR (a "legacy"
-- patient). `patientId` was NOT NULL, so the API silently required an
-- existing directory patient for every record and doctors had no
-- manual-entry fallback — this migration makes that linkage explicit
-- and optional in both directions.
--
-- 1) `patientId` becomes nullable — a record no longer strictly
--    requires a directory patient.
-- 2) The FK is recreated with ON DELETE SET NULL instead of RESTRICT,
--    so removing a patient from the directory can never fail/cascade
--    into wiping a doctor's clinical record history.
-- 3) `patientSource` flags which branch a record is in ('EXISTING' or
--    'LEGACY'). Existing rows all get 'EXISTING' since they all
--    currently carry a real patientId.
-- 4) `legacyPatient*` columns hold the manually-entered identity for
--    LEGACY records (name/phone/DOB/gender/guardian/notes).

ALTER TABLE `previous_records`
  DROP FOREIGN KEY `previous_records_patientId_fkey`;

ALTER TABLE `previous_records`
  MODIFY COLUMN `patientId` VARCHAR(191) NULL,
  ADD COLUMN `patientSource` VARCHAR(16) NOT NULL DEFAULT 'EXISTING',
  ADD COLUMN `legacyPatientName` VARCHAR(191) NULL,
  ADD COLUMN `legacyPatientPhone` VARCHAR(32) NULL,
  ADD COLUMN `legacyPatientDob` DATE NULL,
  ADD COLUMN `legacyPatientGender` VARCHAR(16) NULL,
  ADD COLUMN `legacyPatientGuardian` VARCHAR(191) NULL,
  ADD COLUMN `legacyPatientNotes` TEXT NULL,
  ADD INDEX `previous_records_patientSource_idx`(`patientSource`);

ALTER TABLE `previous_records`
  ADD CONSTRAINT `previous_records_patientId_fkey`
    FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every pre-existing row has a real patientId, so it is by
-- definition an 'EXISTING' record. The column default already covers
-- this, but set it explicitly for clarity/idempotency.
UPDATE `previous_records` SET `patientSource` = 'EXISTING' WHERE `patientId` IS NOT NULL;
