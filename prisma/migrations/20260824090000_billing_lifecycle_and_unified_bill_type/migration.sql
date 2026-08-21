-- v4.1.0 — Unified billing engine + bill lifecycle.
-- 1. PharmacyBill gains a `billType` so receptionists create consultation /
--    service bills in the SAME engine (PHARMACY | CONSULT | SERVICE).
-- 2. DRAFT -> PAID lifecycle: new bills are DRAFT (editable) until marked paid
--    (locked). Existing rows keep their historical 'PAID' value.
-- 3. Edit/audit snapshot columns on PharmacyBill and updatedAt on bill items,
--    so a paid-bill lock plus editable-draft history are both traceable.

ALTER TABLE `pharmacy_bills`
  ADD COLUMN `billType` VARCHAR(191) NOT NULL DEFAULT 'PHARMACY',
  ADD COLUMN `paidAt` DATETIME(3) NULL,
  ADD COLUMN `paidById` VARCHAR(191) NULL,
  ADD COLUMN `paidByRole` VARCHAR(191) NULL,
  ADD COLUMN `editedAt` DATETIME(3) NULL,
  ADD COLUMN `editedById` VARCHAR(191) NULL,
  ADD COLUMN `editedByRole` VARCHAR(191) NULL,
  ADD COLUMN `editCount` INT NOT NULL DEFAULT 0,
  ADD COLUMN `edits` JSON NULL;

ALTER TABLE `pharmacy_bills`
  MODIFY COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'DRAFT';

ALTER TABLE `pharmacy_bill_items`
  ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

CREATE INDEX `pb_type_idx` ON `pharmacy_bills`(`billType`);
CREATE INDEX `pb_status_idx` ON `pharmacy_bills`(`status`);
