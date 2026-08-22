-- Adds an optional profile photo to Admin, Receptionist and Pharmacy
-- accounts, matching what Doctor already had (Doctor.photoUrl). Each is
-- set the same way: self-upload via POST /:role/profile-image, or (for
-- Receptionist/Pharmacy) admin-set via the staff edit modal — mirroring
-- the existing doctor profile-image flow.

ALTER TABLE `admins`
  ADD COLUMN `photoUrl` VARCHAR(191) NULL;

ALTER TABLE `receptionists`
  ADD COLUMN `photoUrl` VARCHAR(191) NULL;

ALTER TABLE `pharmacy_users`
  ADD COLUMN `photoUrl` VARCHAR(191) NULL;
