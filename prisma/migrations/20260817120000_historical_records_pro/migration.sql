-- v3.4.3 Historical Records Professional EMR rework
ALTER TABLE `previous_records`
  ADD COLUMN `title` VARCHAR(191) NULL,
  ADD COLUMN `recordType` VARCHAR(64) NULL,
  ADD COLUMN `pdfUrl` VARCHAR(512) NULL,
  ADD COLUMN `pdfGeneratedAt` DATETIME NULL,
  ADD COLUMN `shareToken` VARCHAR(128) NULL,
  ADD COLUMN `shareTokenExpiresAt` DATETIME NULL,
  ADD COLUMN `lastSharedAt` DATETIME NULL,
  ADD COLUMN `lastSharedVia` VARCHAR(32) NULL,
  ADD COLUMN `deletedAt` DATETIME NULL,
  ADD UNIQUE INDEX `previous_records_shareToken_key`(`shareToken`),
  ADD INDEX `previous_records_deletedAt_idx`(`deletedAt`);

CREATE TABLE `previous_record_attachments` (
  `id` VARCHAR(191) NOT NULL,
  `recordId` VARCHAR(191) NOT NULL,
  `filename` VARCHAR(255) NOT NULL,
  `originalName` VARCHAR(255) NOT NULL,
  `mimeType` VARCHAR(128) NOT NULL,
  `sizeBytes` INTEGER NOT NULL DEFAULT 0,
  `label` VARCHAR(255) NULL,
  `kind` VARCHAR(32) NULL,
  `storagePath` VARCHAR(512) NOT NULL,
  `uploadedById` VARCHAR(191) NULL,
  `uploadedByRole` VARCHAR(32) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `previous_record_attachments_recordId_idx`(`recordId`),
  CONSTRAINT `previous_record_attachments_recordId_fkey` FOREIGN KEY (`recordId`) REFERENCES `previous_records`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Migrate legacy single attachment into first attachment row
INSERT INTO `previous_record_attachments`
  (`id`,`recordId`,`filename`,`originalName`,`mimeType`,`sizeBytes`,`label`,`kind`,`storagePath`,`createdAt`,`updatedAt`)
SELECT UUID(), pr.`id`,
  SUBSTRING_INDEX(pr.`attachmentUrl`,'/',-1),
  SUBSTRING_INDEX(pr.`attachmentUrl`,'/',-1),
  'application/octet-stream', 0, 'Legacy Attachment', 'LEGACY',
  SUBSTRING_INDEX(pr.`attachmentUrl`,'/',-1), NOW(3), NOW(3)
FROM `previous_records` pr
WHERE pr.`attachmentUrl` IS NOT NULL AND pr.`attachmentUrl` <> '';
