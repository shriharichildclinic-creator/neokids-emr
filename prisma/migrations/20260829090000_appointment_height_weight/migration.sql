-- Child height/weight captured on the public booking form for OFFLINE
-- (in-clinic) appointments only — see booking-widget.html's #bw-hw-row.
ALTER TABLE `appointments` ADD COLUMN `heightCm` DECIMAL(5, 1) NULL;
ALTER TABLE `appointments` ADD COLUMN `weightKg` DECIMAL(5, 1) NULL;
