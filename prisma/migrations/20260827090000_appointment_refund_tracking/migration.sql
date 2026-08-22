-- Adds Cashfree refund tracking to appointments — admin-initiated refunds
-- (see admin.controller.js exports.refundAppointment) record the gateway's
-- refund id and timestamp here; paymentStatus flips to REFUNDED separately.
ALTER TABLE `appointments` ADD COLUMN `refundId` VARCHAR(191) NULL;
ALTER TABLE `appointments` ADD COLUMN `refundedAt` DATETIME(3) NULL;
