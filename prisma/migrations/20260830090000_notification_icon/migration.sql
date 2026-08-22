-- Notification avatar/icon — whoever the notification is actually about
-- (e.g. the doctor who cancelled an appointment), not the recipient.
ALTER TABLE `notifications` ADD COLUMN `iconUrl` VARCHAR(191) NULL;
