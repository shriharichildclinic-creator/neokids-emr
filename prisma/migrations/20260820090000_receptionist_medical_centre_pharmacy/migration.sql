-- v4.0.0 — Receptionist, Medical Centre & Pharmacy module
CREATE TABLE `medical_centres` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `address` TEXT NULL,
  `phone` VARCHAR(191) NULL,
  `email` VARCHAR(191) NULL,
  `city` VARCHAR(191) NULL,
  `state` VARCHAR(191) NULL,
  `pincode` VARCHAR(191) NULL,
  `mapUrl` TEXT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `receptionists` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `passwordHash` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
  `canManageConsultations` BOOLEAN NOT NULL DEFAULT TRUE,
  `canManagePharmacy` BOOLEAN NOT NULL DEFAULT FALSE,
  `canIssueCertificates` BOOLEAN NOT NULL DEFAULT FALSE,
  `mustChangePassword` BOOLEAN NOT NULL DEFAULT FALSE,
  `deletedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `receptionists_email_key`(`email`),
  INDEX `receptionists_deletedAt_idx`(`deletedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `receptionist_assignments` (
  `id` VARCHAR(191) NOT NULL,
  `receptionistId` VARCHAR(191) NOT NULL,
  `doctorId` VARCHAR(191) NOT NULL,
  `medicalCentreId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `receptionist_assignments_unique`(`receptionistId`, `doctorId`, `medicalCentreId`),
  INDEX `receptionist_assignments_doctorId_idx`(`doctorId`),
  INDEX `receptionist_assignments_medicalCentreId_idx`(`medicalCentreId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `ra_receptionist_fk` FOREIGN KEY (`receptionistId`) REFERENCES `receptionists`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ra_doctor_fk` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ra_centre_fk` FOREIGN KEY (`medicalCentreId`) REFERENCES `medical_centres`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `pharmacy_users` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `passwordHash` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
  `medicalCentreId` VARCHAR(191) NULL,
  `mustChangePassword` BOOLEAN NOT NULL DEFAULT FALSE,
  `deletedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `pharmacy_users_email_key`(`email`),
  INDEX `pharmacy_users_deletedAt_idx`(`deletedAt`),
  INDEX `pharmacy_users_medicalCentreId_idx`(`medicalCentreId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `pu_centre_fk` FOREIGN KEY (`medicalCentreId`) REFERENCES `medical_centres`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `pharmacy_user_doctors` (
  `id` VARCHAR(191) NOT NULL,
  `pharmacyUserId` VARCHAR(191) NOT NULL,
  `doctorId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `pud_unique`(`pharmacyUserId`, `doctorId`),
  INDEX `pud_doctorId_idx`(`doctorId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `pud_user_fk` FOREIGN KEY (`pharmacyUserId`) REFERENCES `pharmacy_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `pud_doctor_fk` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `consultation_invoices` (
  `id` VARCHAR(191) NOT NULL,
  `invoiceNumber` VARCHAR(191) NOT NULL,
  `appointmentId` VARCHAR(191) NOT NULL,
  `doctorId` VARCHAR(191) NOT NULL,
  `patientId` VARCHAR(191) NOT NULL,
  `receptionistId` VARCHAR(191) NULL,
  `medicalCentreId` VARCHAR(191) NULL,
  `amount` DECIMAL(10, 2) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'PAID',
  `paymentMethod` VARCHAR(191) NOT NULL DEFAULT 'CASH',
  `notes` TEXT NULL,
  `pdfUrl` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `consultation_invoices_invoiceNumber_key`(`invoiceNumber`),
  UNIQUE INDEX `consultation_invoices_appointmentId_key`(`appointmentId`),
  INDEX `ci_doctor_idx`(`doctorId`),
  INDEX `ci_centre_idx`(`medicalCentreId`),
  INDEX `ci_patient_idx`(`patientId`),
  INDEX `ci_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `ci_receptionist_fk` FOREIGN KEY (`receptionistId`) REFERENCES `receptionists`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `ci_centre_fk` FOREIGN KEY (`medicalCentreId`) REFERENCES `medical_centres`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `pharmacy_items` (
  `id` VARCHAR(191) NOT NULL,
  `medicalCentreId` VARCHAR(191) NULL,
  `name` VARCHAR(191) NOT NULL,
  `batchNumber` VARCHAR(191) NULL,
  `unit` VARCHAR(191) NOT NULL DEFAULT 'strip',
  `mrp` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `purchasePrice` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `sellingPrice` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `stock` INT NOT NULL DEFAULT 0,
  `expiryDate` DATETIME(3) NULL,
  `manufacturer` VARCHAR(191) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX `pi_centre_idx`(`medicalCentreId`),
  INDEX `pi_name_idx`(`name`),
  INDEX `pi_expiry_idx`(`expiryDate`),
  PRIMARY KEY (`id`),
  CONSTRAINT `pi_centre_fk` FOREIGN KEY (`medicalCentreId`) REFERENCES `medical_centres`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `pharmacy_bills` (
  `id` VARCHAR(191) NOT NULL,
  `billNumber` VARCHAR(191) NOT NULL,
  `medicalCentreId` VARCHAR(191) NULL,
  `patientId` VARCHAR(191) NULL,
  `prescriptionId` VARCHAR(191) NULL,
  `doctorId` VARCHAR(191) NULL,
  `createdById` VARCHAR(191) NULL,
  `createdByRole` VARCHAR(191) NULL,
  `customerName` VARCHAR(191) NULL,
  `customerPhone` VARCHAR(191) NULL,
  `subtotal` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `discount` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `tax` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `total` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `paymentMethod` VARCHAR(191) NOT NULL DEFAULT 'CASH',
  `status` VARCHAR(191) NOT NULL DEFAULT 'PAID',
  `pdfUrl` VARCHAR(191) NULL,
  `notes` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `pharmacy_bills_billNumber_key`(`billNumber`),
  INDEX `pb_centre_idx`(`medicalCentreId`),
  INDEX `pb_patient_idx`(`patientId`),
  INDEX `pb_doctor_idx`(`doctorId`),
  INDEX `pb_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `pb_centre_fk` FOREIGN KEY (`medicalCentreId`) REFERENCES `medical_centres`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `pharmacy_bill_items` (
  `id` VARCHAR(191) NOT NULL,
  `billId` VARCHAR(191) NOT NULL,
  `itemId` VARCHAR(191) NULL,
  `name` VARCHAR(191) NOT NULL,
  `quantity` INT NOT NULL,
  `unitPrice` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `total` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `pbi_bill_idx`(`billId`),
  INDEX `pbi_item_idx`(`itemId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `pbi_bill_fk` FOREIGN KEY (`billId`) REFERENCES `pharmacy_bills`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `pbi_item_fk` FOREIGN KEY (`itemId`) REFERENCES `pharmacy_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `staff_audit_logs` (
  `id` VARCHAR(191) NOT NULL,
  `actorId` VARCHAR(191) NOT NULL,
  `actorRole` VARCHAR(191) NOT NULL,
  `actorName` VARCHAR(191) NULL,
  `action` VARCHAR(191) NOT NULL,
  `entityType` VARCHAR(191) NULL,
  `entityId` VARCHAR(191) NULL,
  `summary` VARCHAR(191) NULL,
  `meta` JSON NULL,
  `medicalCentreId` VARCHAR(191) NULL,
  `doctorId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `sal_actor_idx`(`actorId`),
  INDEX `sal_role_idx`(`actorRole`),
  INDEX `sal_action_idx`(`action`),
  INDEX `sal_entity_idx`(`entityType`, `entityId`),
  INDEX `sal_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `appointments`
  ADD COLUMN `arrivedAt` DATETIME(3) NULL,
  ADD COLUMN `medicalCentreId` VARCHAR(191) NULL,
  ADD COLUMN `createdByReceptionistId` VARCHAR(191) NULL;

ALTER TABLE `appointments`
  ADD CONSTRAINT `appt_receptionist_fk` FOREIGN KEY (`createdByReceptionistId`) REFERENCES `receptionists`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `appt_centre_idx` ON `appointments`(`medicalCentreId`);
CREATE INDEX `appt_createdByRec_idx` ON `appointments`(`createdByReceptionistId`);
CREATE INDEX `appt_arrivedAt_idx` ON `appointments`(`arrivedAt`);

ALTER TABLE `prescriptions`
  ADD COLUMN `createdById` VARCHAR(191) NULL,
  ADD COLUMN `createdByRole` VARCHAR(191) NULL;

ALTER TABLE `medical_certificates`
  ADD COLUMN `issuedById` VARCHAR(191) NULL,
  ADD COLUMN `issuedByRole` VARCHAR(191) NULL;