-- Audit finding #6: atomic reminder-claim dedup.
-- A NULL-able composite unique key does NOT dedup on MySQL (NULLs are
-- distinct), so the claim uses a dedicated non-null claimKey column.
-- processReminders inserts claimKey = `reminder_claim_<apptId>_<type>`;
-- the losing concurrent tick gets a P2002 and skips. Idempotent.
ALTER TABLE `notification_logs`
  ADD COLUMN IF NOT EXISTS `claimKey` VARCHAR(191) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS `unique_reminder_claim`
  ON `notification_logs` (`claimKey`);
