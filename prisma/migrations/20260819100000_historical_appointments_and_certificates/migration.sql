-- ─────────────────────────────────────────────────────────────────────
-- Feature 1: Historical / Manual Appointment Records
-- Feature 2: Medical Certificate Generator
-- Feature 3: Doctor Digital Signature Management
--
-- This migration is ADDITIVE only — every column added is nullable or
-- has a default matching the previous behavior. No existing rows are
-- rewritten. Every prior workflow (booking, prescription, invoice,
-- appointment lifecycle) continues to function unchanged.
-- ─────────────────────────────────────────────────────────────────────

-- Feature 3: Doctor signature & registration number
ALTER TABLE `doctors`
  ADD COLUMN `signatureUrl` VARCHAR(191) NULL,
  ADD COLUMN `registrationNumber` VARCHAR(191) NULL;

-- Feature 1: Historical / manual appointment fields
ALTER TABLE `appointments`
  ADD COLUMN `source` VARCHAR(191) NOT NULL DEFAULT 'NEOKIDSPRO',
  ADD COLUMN `reasonForVisit` TEXT NULL,
  ADD COLUMN `diagnosis` TEXT NULL,
  ADD COLUMN `followUpDate` DATETIME(3) NULL,
  ADD COLUMN `manualPrescriptionUrl` VARCHAR(191) NULL,
  ADD COLUMN `addedById` VARCHAR(191) NULL,
  ADD COLUMN `addedByRole` VARCHAR(191) NULL;

CREATE INDEX `appointments_source_idx` ON `appointments`(`source`);

-- Feature 1A: Prescription source flag (for manually uploaded historical prescriptions)
ALTER TABLE `prescriptions`
  ADD COLUMN `source` VARCHAR(191) NOT NULL DEFAULT 'NEOKIDSPRO';

-- Feature 2: Medical Certificates
-- NOTE: durationType / certificateDate / consultationType (v3.4.0) are
-- included directly in this CREATE TABLE. They used to live in a
-- separate later migration (20260817120000_certificate_v340_rework)
-- written in Postgres syntax against this MySQL database, and ordered
-- BEFORE this migration (which creates the table). Both problems broke
-- certificate creation with "Invalid input for database operation" /
-- PrismaClientValidationError. That migration has been removed; the
-- columns are now created here, atomically, with the table itself.
CREATE TABLE `medical_certificates` (
  `id` VARCHAR(191) NOT NULL,
  `certificateNumber` VARCHAR(191) NOT NULL,
  `appointmentId` VARCHAR(191) NULL,
  `patientId` VARCHAR(191) NOT NULL,
  `doctorId` VARCHAR(191) NOT NULL,
  `templateKey` VARCHAR(191) NOT NULL DEFAULT 'GENERAL',
  `diagnosis` TEXT NULL,
  `reason` TEXT NOT NULL,
  `restDays` INT NULL,
  `fromDate` DATETIME(3) NULL,
  `toDate` DATETIME(3) NULL,
  `additionalNotes` TEXT NULL,
  `durationType` VARCHAR(191) NULL,
  `certificateDate` DATETIME(3) NULL,
  `consultationType` VARCHAR(191) NULL,
  `patientNameSnapshot` VARCHAR(191) NOT NULL,
  `patientAgeSnapshot` VARCHAR(191) NULL,
  `patientGenderSnapshot` VARCHAR(191) NULL,
  `pdfUrl` VARCHAR(191) NULL,
  `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `medical_certificates_certificateNumber_key`(`certificateNumber`),
  INDEX `medical_certificates_doctorId_idx`(`doctorId`),
  INDEX `medical_certificates_patientId_idx`(`patientId`),
  INDEX `medical_certificates_appointmentId_idx`(`appointmentId`),
  INDEX `medical_certificates_issuedAt_idx`(`issuedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `medical_certificates`
  ADD CONSTRAINT `medical_certificates_appointmentId_fkey`
    FOREIGN KEY (`appointmentId`) REFERENCES `appointments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `medical_certificates_patientId_fkey`
    FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `medical_certificates_doctorId_fkey`
    FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
