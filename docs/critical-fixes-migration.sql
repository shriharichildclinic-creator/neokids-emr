-- NeoKidsPro EMR critical fixes migration
ALTER TABLE admins
  ADD COLUMN mustChangePassword BOOLEAN NOT NULL DEFAULT FALSE AFTER name;

ALTER TABLE doctors
  ADD COLUMN mustChangePassword BOOLEAN NOT NULL DEFAULT FALSE AFTER isAvailable,
  ADD COLUMN deletedAt DATETIME NULL AFTER mustChangePassword,
  ADD INDEX idx_doctors_deletedAt (deletedAt);

ALTER TABLE appointments
  ADD COLUMN expiresAt DATETIME NULL AFTER rescheduledFromId,
  ADD COLUMN completedAt DATETIME NULL AFTER expiresAt,
  ADD COLUMN cancelledAt DATETIME NULL AFTER completedAt,
  ADD INDEX idx_appointments_expiresAt (expiresAt);

CREATE TABLE password_tokens (
  id VARCHAR(191) NOT NULL,
  userType VARCHAR(191) NOT NULL,
  userId VARCHAR(191) NOT NULL,
  purpose VARCHAR(191) NOT NULL,
  tokenHash VARCHAR(191) NOT NULL,
  expiresAt DATETIME(3) NOT NULL,
  usedAt DATETIME(3) NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY password_tokens_tokenHash_key (tokenHash),
  INDEX idx_password_tokens_lookup (userType, userId, purpose),
  INDEX idx_password_tokens_expiresAt (expiresAt)
);
