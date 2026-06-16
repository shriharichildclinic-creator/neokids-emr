-- =====================================================================
-- NeoKidsPro EMR — Bug 2 / Bug 5 migration
-- ---------------------------------------------------------------------
-- Purpose:
--   * Bug 2  — allow siblings on the SAME parent phone number.
--     The legacy schema had `UNIQUE (phone)` on `patients`, which blocked
--     a second child being booked under the same parent number. Uniqueness
--     is now enforced application-side on (phone + lower(name)).
--   * Bug 5 — make sure all clinical fields (weight/height/pastHistory/
--     allergies/investigations) exist on `prescriptions`, since the
--     prescription form now writes them. Adds them only if missing.
--
-- Idempotent: SAFE to run multiple times.
-- Tested on MySQL 8.0 and MariaDB 10.5+.
--
-- Run with:
--   mysql -u appuser -p neokidspro < docs/bug2-bug5-migration.sql
-- =====================================================================

USE neokidspro;

-- ─────────────────────────────────────────────────────────────────────
-- 1. patients.phone — drop legacy UNIQUE, add composite + plain index
-- ─────────────────────────────────────────────────────────────────────

-- Drop UNIQUE index on phone if it exists (different MySQL/Prisma versions
-- name it differently — handle all the known variants).
SET @drop_sql := NULL;
SELECT CONCAT('ALTER TABLE patients DROP INDEX ', INDEX_NAME)
INTO   @drop_sql
FROM   information_schema.STATISTICS
WHERE  TABLE_SCHEMA = DATABASE()
  AND  TABLE_NAME   = 'patients'
  AND  COLUMN_NAME  = 'phone'
  AND  NON_UNIQUE   = 0
LIMIT 1;

SET @drop_sql := IFNULL(@drop_sql, 'SELECT "no unique index on patients.phone — skipping" AS info');
PREPARE stmt FROM @drop_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Ensure non-unique plain index on phone (for fast `WHERE phone = ?`).
SET @has_phone_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'patients'
    AND INDEX_NAME   = 'patients_phone_idx'
);
SET @sql := IF(@has_phone_idx = 0,
  'CREATE INDEX patients_phone_idx ON patients (phone)',
  'SELECT "patients_phone_idx already exists — skipping" AS info'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Ensure composite index (phone, name) — used by the per-child sibling lookup.
SET @has_pn_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'patients'
    AND INDEX_NAME   = 'patients_phone_name_idx'
);
SET @sql := IF(@has_pn_idx = 0,
  'CREATE INDEX patients_phone_name_idx ON patients (phone, name)',
  'SELECT "patients_phone_name_idx already exists — skipping" AS info'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ─────────────────────────────────────────────────────────────────────
-- 2. prescriptions — add Bug 3/5 clinical columns if missing
-- ─────────────────────────────────────────────────────────────────────

-- weight
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='prescriptions' AND COLUMN_NAME='weight');
SET @sql := IF(@c = 0,
  'ALTER TABLE prescriptions ADD COLUMN weight VARCHAR(32) NULL AFTER chiefComplaint',
  'SELECT "prescriptions.weight already exists" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- height
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='prescriptions' AND COLUMN_NAME='height');
SET @sql := IF(@c = 0,
  'ALTER TABLE prescriptions ADD COLUMN height VARCHAR(32) NULL AFTER weight',
  'SELECT "prescriptions.height already exists" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- pastHistory
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='prescriptions' AND COLUMN_NAME='pastHistory');
SET @sql := IF(@c = 0,
  'ALTER TABLE prescriptions ADD COLUMN pastHistory TEXT NULL AFTER height',
  'SELECT "prescriptions.pastHistory already exists" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- allergies
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='prescriptions' AND COLUMN_NAME='allergies');
SET @sql := IF(@c = 0,
  'ALTER TABLE prescriptions ADD COLUMN allergies TEXT NULL AFTER diagnosis',
  'SELECT "prescriptions.allergies already exists" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- investigations
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='prescriptions' AND COLUMN_NAME='investigations');
SET @sql := IF(@c = 0,
  'ALTER TABLE prescriptions ADD COLUMN investigations TEXT NULL AFTER allergies',
  'SELECT "prescriptions.investigations already exists" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─────────────────────────────────────────────────────────────────────
-- 3. notification_logs — make sure the `direction` column exists
-- ─────────────────────────────────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='notification_logs' AND COLUMN_NAME='direction');
SET @sql := IF(@c = 0,
  'ALTER TABLE notification_logs ADD COLUMN direction VARCHAR(16) NULL AFTER template',
  'SELECT "notification_logs.direction already exists" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Final sanity check — show resulting indexes/columns
-- ─────────────────────────────────────────────────────────────────────
SELECT 'Done. Verify with the queries below.' AS info;

-- Verify there is NO unique index on patients.phone any more:
-- SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patients';

-- Verify prescriptions has all new columns:
-- SHOW COLUMNS FROM prescriptions;
