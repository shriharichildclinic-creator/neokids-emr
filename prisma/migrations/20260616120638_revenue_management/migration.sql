-- CreateTable
CREATE TABLE `admins` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `admins_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctors` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `specialization` VARCHAR(191) NOT NULL DEFAULT 'Pediatrician',
    `qualification` VARCHAR(191) NULL,
    `experience` INTEGER NOT NULL DEFAULT 0,
    `bio` TEXT NULL,
    `clinicName` VARCHAR(191) NULL,
    `clinicAddress` TEXT NULL,
    `clinicMapUrl` TEXT NULL,
    `clinicLat` DECIMAL(10, 7) NULL,
    `clinicLng` DECIMAL(10, 7) NULL,
    `photoUrl` VARCHAR(191) NULL,
    `consultationModes` VARCHAR(191) NOT NULL DEFAULT 'BOTH',
    `onlineConsultFee` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `physicalConsultFee` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `availableFromOnline` VARCHAR(191) NULL,
    `availableToOnline` VARCHAR(191) NULL,
    `availableFromOffline` VARCHAR(191) NULL,
    `availableToOffline` VARCHAR(191) NULL,
    `workingDays` VARCHAR(191) NOT NULL DEFAULT 'MON,TUE,WED,THU,FRI,SAT',
    `slotDuration` INTEGER NOT NULL DEFAULT 15,
    `isAvailable` BOOLEAN NOT NULL DEFAULT true,
    `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
    `deletedAt` DATETIME(3) NULL,
    `consults` INTEGER NOT NULL DEFAULT 0,
    `revenue` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `clinicSharePercent` DECIMAL(5, 2) NOT NULL DEFAULT 25.00,
    `doctorSharePercent` DECIMAL(5, 2) NOT NULL DEFAULT 75.00,
    `tdsPercent` DECIMAL(5, 2) NOT NULL DEFAULT 10.00,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `doctors_email_key`(`email`),
    INDEX `doctors_deletedAt_idx`(`deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `patients` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `dateOfBirth` DATETIME(3) NULL,
    `gender` VARCHAR(191) NULL,
    `parentName` VARCHAR(191) NULL,
    `address` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `patients_phone_idx`(`phone`),
    INDEX `patients_phone_name_idx`(`phone`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `appointments` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `primaryProblem` TEXT NOT NULL,
    `date` DATE NOT NULL,
    `startTime` VARCHAR(191) NOT NULL,
    `endTime` VARCHAR(191) NOT NULL,
    `consultationType` VARCHAR(191) NOT NULL,
    `feeAtBooking` DECIMAL(10, 2) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `paymentStatus` VARCHAR(191) NOT NULL DEFAULT 'UNPAID',
    `cashfreeOrderId` VARCHAR(191) NULL,
    `cashfreePaymentId` VARCHAR(191) NULL,
    `meetLink` TEXT NULL,
    `meetEventId` VARCHAR(191) NULL,
    `invoiceUrl` VARCHAR(191) NULL,
    `prescriptionUrl` VARCHAR(191) NULL,
    `rescheduleReason` TEXT NULL,
    `rescheduledAt` DATETIME(3) NULL,
    `rescheduledFromId` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `settlementId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `appointments_date_doctorId_idx`(`date`, `doctorId`),
    INDEX `appointments_patientId_idx`(`patientId`),
    INDEX `appointments_status_idx`(`status`),
    INDEX `appointments_expiresAt_idx`(`expiresAt`),
    INDEX `appointments_doctorId_paymentStatus_date_idx`(`doctorId`, `paymentStatus`, `date`),
    INDEX `appointments_settlementId_idx`(`settlementId`),
    UNIQUE INDEX `appointments_doctorId_date_startTime_key`(`doctorId`, `date`, `startTime`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `prescriptions` (
    `id` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `chiefComplaint` TEXT NOT NULL,
    `weight` VARCHAR(191) NULL,
    `height` VARCHAR(191) NULL,
    `pastHistory` TEXT NULL,
    `diagnosis` TEXT NOT NULL,
    `allergies` TEXT NULL,
    `investigations` TEXT NULL,
    `medications` JSON NOT NULL,
    `advice` TEXT NULL,
    `followUpDate` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `prescriptions_appointmentId_key`(`appointmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_logs` (
    `id` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NULL,
    `channel` VARCHAR(191) NOT NULL,
    `recipient` VARCHAR(191) NOT NULL,
    `template` VARCHAR(191) NOT NULL,
    `direction` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL,
    `payload` JSON NULL,
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notification_logs_appointmentId_idx`(`appointmentId`),
    INDEX `notification_logs_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `password_tokens` (
    `id` VARCHAR(191) NOT NULL,
    `userType` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `purpose` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `password_tokens_tokenHash_key`(`tokenHash`),
    INDEX `password_tokens_userType_userId_purpose_idx`(`userType`, `userId`, `purpose`),
    INDEX `password_tokens_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_settlements` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `periodMonth` INTEGER NOT NULL,
    `periodYear` INTEGER NOT NULL,
    `periodStart` DATE NOT NULL,
    `periodEnd` DATE NOT NULL,
    `clinicSharePercent` DECIMAL(5, 2) NOT NULL,
    `doctorSharePercent` DECIMAL(5, 2) NOT NULL,
    `tdsPercent` DECIMAL(5, 2) NOT NULL,
    `totalConsultations` INTEGER NOT NULL DEFAULT 0,
    `totalRevenue` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `clinicShareAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `doctorGrossAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `tdsAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `doctorNetAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'GENERATED',
    `paidAt` DATETIME(3) NULL,
    `paymentReference` VARCHAR(191) NULL,
    `paymentMode` VARCHAR(191) NULL,
    `paymentNotes` TEXT NULL,
    `processedById` VARCHAR(191) NULL,
    `invoiceNumber` VARCHAR(191) NULL,
    `invoiceUrl` VARCHAR(191) NULL,
    `invoiceGeneratedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `doctor_settlements_invoiceNumber_key`(`invoiceNumber`),
    INDEX `doctor_settlements_periodYear_periodMonth_idx`(`periodYear`, `periodMonth`),
    INDEX `doctor_settlements_status_idx`(`status`),
    INDEX `doctor_settlements_doctorId_status_idx`(`doctorId`, `status`),
    UNIQUE INDEX `doctor_settlements_doctorId_periodYear_periodMonth_key`(`doctorId`, `periodYear`, `periodMonth`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_patientId_fkey` FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_settlementId_fkey` FOREIGN KEY (`settlementId`) REFERENCES `doctor_settlements`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `prescriptions` ADD CONSTRAINT `prescriptions_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `appointments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctor_settlements` ADD CONSTRAINT `doctor_settlements_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
