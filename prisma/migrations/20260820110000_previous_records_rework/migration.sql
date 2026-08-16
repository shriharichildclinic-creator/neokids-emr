ALTER TABLE `doctors`
  ADD COLUMN `canAddPreviousRecords` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `previous_records` (
  `id` VARCHAR(191) NOT NULL,
  `doctorId` VARCHAR(191) NOT NULL,
  `patientId` VARCHAR(191) NOT NULL,
  `recordDate` DATE NOT NULL,
  `diagnosis` TEXT NULL,
  `notes` TEXT NULL,
  `treatment` TEXT NULL,
  `medications` TEXT NULL,
  `attachmentUrl` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `previous_records_doctorId_patientId_recordDate_idx`(`doctorId`, `patientId`, `recordDate`),
  INDEX `previous_records_patientId_recordDate_idx`(`patientId`, `recordDate`),
  CONSTRAINT `previous_records_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `previous_records_patientId_fkey` FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
