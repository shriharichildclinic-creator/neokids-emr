-- Audit finding #6: atomic reminder-claim dedup.
-- A NULL-able composite unique key does NOT dedup on MySQL (NULLs are
-- distinct), so the claim uses a dedicated non-null claimKey column.
-- processReminders inserts claimKey = `reminder_claim_<apptId>_<type>`;
-- the losing concurrent tick gets a P2002 and skips. Idempotent.
--
-- MySQL 8 does NOT support "CREATE INDEX ... IF NOT EXISTS" (Error 1064),
-- and relying on "ADD COLUMN IF NOT EXISTS" alone still leaves the index
-- statement unsafe to re-run. This version checks INFORMATION_SCHEMA and
-- only executes each DDL statement if it hasn't already been applied, so
-- it is safe to re-run against a database left in any partial state by
-- the previous failed migration.

-- 1) Add `claimKey` column if it does not already exist
SET @col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'notification_logs'
    AND COLUMN_NAME = 'claimKey'
);

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE `notification_logs` ADD COLUMN `claimKey` VARCHAR(191) NULL',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2) Add unique index on `claimKey` if it does not already exist
SET @idx_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'notification_logs'
    AND INDEX_NAME = 'unique_reminder_claim'
);

SET @ddl := IF(
  @idx_exists = 0,
  'CREATE UNIQUE INDEX `unique_reminder_claim` ON `notification_logs` (`claimKey`)',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
