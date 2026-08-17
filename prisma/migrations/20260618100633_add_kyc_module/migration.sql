-- CreateTable
CREATE TABLE `doctor_kyc` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `aadhaarUrl` VARCHAR(191) NULL,
    `panUrl` VARCHAR(191) NULL,
    `cancelledChequeUrl` VARCHAR(191) NULL,
    `medicalRegCertUrl` VARCHAR(191) NULL,
    `kycStatus` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `rejectionReason` TEXT NULL,
    `verifiedAt` DATETIME(3) NULL,
    `verifiedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `doctor_kyc_doctorId_key`(`doctorId`),
    INDEX `doctor_kyc_kycStatus_idx`(`kycStatus`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `doctor_kyc` ADD CONSTRAINT `doctor_kyc_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
