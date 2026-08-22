-- Patient Registration Scope fix.
--
-- BUG: a patient registered through the Receptionist module could not be
-- found in search immediately afterwards. Receptionist patient visibility
-- ("scope") was derived purely from existing appointments and medical
-- certificates for the receptionist's assigned doctors. A freshly
-- registered patient has neither, so they fell outside scope and were
-- invisible to search until a first appointment linked them.
--
-- FIX: record an explicit registration linkage the moment a receptionist
-- (or a pharmacy user) creates a patient, so the patient enters scope
-- straight away. The linkage also carries the medical centre for reporting.

CREATE TABLE `patient_registrations` (
  `id`              VARCHAR(191) NOT NULL,
  `patientId`       VARCHAR(191) NOT NULL,
  `receptionistId`  VARCHAR(191) NULL,
  `pharmacyUserId`  VARCHAR(191) NULL,
  `medicalCentreId` VARCHAR(191) NULL,
  `createdAt`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `patient_registrations_patientId_receptionistId_key`(`patientId`, `receptionistId`),
  UNIQUE INDEX `patient_registrations_patientId_pharmacyUserId_key`(`patientId`, `pharmacyUserId`),
  INDEX `patient_registrations_receptionistId_idx`(`receptionistId`),
  INDEX `patient_registrations_pharmacyUserId_idx`(`pharmacyUserId`),
  INDEX `patient_registrations_patientId_idx`(`patientId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `patient_registrations`
  ADD CONSTRAINT `patient_registrations_patientId_fkey`
    FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `patient_registrations`
  ADD CONSTRAINT `patient_registrations_receptionistId_fkey`
    FOREIGN KEY (`receptionistId`) REFERENCES `receptionists`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `patient_registrations`
  ADD CONSTRAINT `patient_registrations_pharmacyUserId_fkey`
    FOREIGN KEY (`pharmacyUserId`) REFERENCES `pharmacy_users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
