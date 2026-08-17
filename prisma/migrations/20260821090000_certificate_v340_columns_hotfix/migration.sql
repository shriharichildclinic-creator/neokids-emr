-- v3.4.0 certificate columns — forward-fix migration.
--
-- The original 20260817120000_certificate_v340_rework migration was
-- written in Postgres syntax against this MySQL database and ordered
-- before the migration that creates `medical_certificates`, so it
-- never actually added these columns. That broken migration file has
-- been deleted from prisma/migrations.
--
-- IMPORTANT: this is a NEW migration folder, not an edit of an
-- existing one. Prisma tracks applied migrations by folder name in
-- the `_prisma_migrations` table — editing the SQL inside an
-- already-applied migration folder does nothing on a live database,
-- because `prisma migrate deploy` skips any migration name it has
-- already recorded as applied. Adding these columns must happen as a
-- brand-new migration so Prisma actually runs it forward.
ALTER TABLE `medical_certificates`
  ADD COLUMN `durationType` VARCHAR(191) NULL,
  ADD COLUMN `certificateDate` DATETIME(3) NULL,
  ADD COLUMN `consultationType` VARCHAR(191) NULL;
